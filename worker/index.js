// Cloudflare Workers 后端代码
// 作用：精确路由业务请求，并通过服务层访问现有 5 张飞书表

import { FeishuError, createFeishuClient } from './feishu-client.js';
import { statusFromFeishu, todayInShanghai } from './field-mappers.js';
import { corsHeaders, errorResponse, jsonResponse } from './response.js';
import {
  TOKEN_TTL_SECONDS,
  issueToken,
  readBearerToken,
  verifyToken
} from './auth.js';
import {
  AuthConfigurationError,
  LoginChallengeError,
  issueLoginChallenge,
  verifyLoginProof
} from './login-challenge.js';
import { checkLoginRateLimit } from './login-rate-limit.js';
import { createCustomersService } from './services/customers.js';
import { createOrdersService } from './services/orders.js';
import { createProductsService } from './services/products.js';
import { createPurchasesService } from './services/purchases.js';
import { createStatisticsService } from './services/statistics.js';
import { createSuppliersService } from './services/suppliers.js';
import { ValidationError } from './validation.js';

const REQUIRED_ENV = Object.freeze([
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_BASE_TOKEN',
  'TABLE_CUSTOMERS',
  'TABLE_SUPPLIERS',
  'TABLE_PRODUCTS',
  'TABLE_ORDERS',
  'TABLE_PURCHASES'
]);

const MAX_LOGIN_BODY_BYTES = 4096;

const DATA_SOURCE_TABLES = Object.freeze({
  customers: 'TABLE_CUSTOMERS',
  suppliers: 'TABLE_SUPPLIERS',
  products: 'TABLE_PRODUCTS',
  orders: 'TABLE_ORDERS',
  purchases: 'TABLE_PURCHASES'
});

function getToday() {
  return todayInShanghai();
}

function successResponse(data) {
  return jsonResponse({ code: 0, message: 'success', data });
}

function parseAllowedOrigins(value) {
  return String(value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function withHeaders(response, extraHeaders) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function assertEnvironment(env) {
  for (const key of REQUIRED_ENV) {
    if (!env[key]) throw new ValidationError(`缺少环境变量: ${key}`, 500);
  }
}

function methodNotAllowed() {
  return errorResponse('Method Not Allowed', 405);
}

function createServices(feishu, env) {
  return {
    customers: createCustomersService(feishu, env),
    suppliers: createSuppliersService(feishu, env),
    products: createProductsService(feishu, env),
    orders: createOrdersService(feishu, env),
    purchases: createPurchasesService(feishu, env),
    statistics: createStatisticsService(feishu, env)
  };
}

async function readJsonBody(request) {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null && /^\d+$/.test(contentLength.trim())) {
    const declaredBytes = Number(contentLength);
    if (declaredBytes > MAX_LOGIN_BODY_BYTES) {
      try {
        await request.body?.cancel();
      } catch {
        // The size error remains the stable client-facing response.
      }
      throw new ValidationError('请求体过大', 413);
    }
  }

  const reader = request.body?.getReader();
  if (!reader) throw new ValidationError('请求体必须是有效JSON');
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_LOGIN_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size error remains the stable client-facing response.
        }
        throw new ValidationError('请求体过大', 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('请求体必须是有效JSON');
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ValidationError('请求体必须是有效JSON');
  }
}

async function login(request, env) {
  const body = await readJsonBody(request);
  if (body && typeof body === 'object' && !Array.isArray(body) && 'password' in body) {
    throw new ValidationError('登录协议已更新，请刷新页面');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join(',') !== 'challengeToken,proof'
    || typeof body.challengeToken !== 'string'
    || body.challengeToken.length === 0
    || typeof body.proof !== 'string'
    || body.proof.length === 0) {
    throw new ValidationError('登录请求无效');
  }
  await verifyLoginProof(body, env);

  const nowMs = Date.now();
  const issuedAt = Math.floor(nowMs / 1000);
  return successResponse({
    token: await issueToken(env.AUTH_SECRET, nowMs),
    expiresIn: TOKEN_TTL_SECONDS,
    expiresAt: issuedAt + TOKEN_TTL_SECONDS
  });
}

async function rateLimitedLogin(request, env) {
  if (!await checkLoginRateLimit(request, env)) {
    return withHeaders(
      errorResponse('登录尝试过于频繁，请稍后再试', 429),
      { 'Retry-After': '60' }
    );
  }
  return login(request, env);
}

async function requireAuthentication(request, env) {
  if (!env.AUTH_SECRET) throw new ValidationError('缺少环境变量: AUTH_SECRET', 500);
  const token = readBearerToken(request);
  if (!token) throw new ValidationError('请先登录', 401);
  try {
    return await verifyToken(token, env.AUTH_SECRET);
  } catch (error) {
    throw new ValidationError(error.message, 401);
  }
}

async function checkDataSources(feishu, env) {
  const availability = {};
  for (const [name, envKey] of Object.entries(DATA_SOURCE_TABLES)) {
    try {
      await feishu.checkTable(env[envKey]);
      availability[name] = true;
    } catch (error) {
      if (!(error instanceof FeishuError)) throw error;
      availability[name] = false;
    }
  }
  return availability;
}

async function translateLegacyOrderUpdate(orders, id, body) {
  const targetStatus = body.status === undefined ? undefined : statusFromFeishu(body.status);
  const hasWeight = body.actualWeight !== undefined;
  const hasPrice = body.price !== undefined;

  if (hasWeight && !hasPrice && targetStatus === 'shipped') {
    return orders.ship(id, body.actualWeight);
  }
  if (!hasWeight && hasPrice && targetStatus === 'pending_bill') {
    return orders.price(id, body.price);
  }
  if (hasWeight && hasPrice && (targetStatus === undefined || targetStatus === 'pending_bill')) {
    return orders.edit(id, { actualWeight: body.actualWeight, price: body.price });
  }
  throw new ValidationError('不支持的订单更新操作');
}

async function routeProtectedRequest(request, env) {
  const url = new URL(request.url);
  const { pathname: path } = url;

  if ((path === '/api/orders/bill' || path === '/api/orders/settle') && request.method !== 'POST') {
    return methodNotAllowed();
  }
  const explicitOrderMatch = path.match(/^\/api\/orders\/([^/]+)\/(ship|price)$/);
  if (explicitOrderMatch && request.method !== 'PUT') return methodNotAllowed();

  assertEnvironment(env);
  const feishu = createFeishuClient(env);
  if (path === '/api/health/data-source') {
    if (request.method !== 'GET') return methodNotAllowed();
    return successResponse(await checkDataSources(feishu, env));
  }
  const services = createServices(feishu, env);

  if (path === '/api/customers') {
    if (request.method === 'GET') return successResponse(await services.customers.list());
    if (request.method === 'POST') return successResponse(await services.customers.create(await request.json()));
    return methodNotAllowed();
  }
  const customerMatch = path.match(/^\/api\/customers\/([^/]+)$/);
  if (customerMatch) {
    if (request.method !== 'DELETE') return methodNotAllowed();
    return successResponse(await services.customers.remove(decodeURIComponent(customerMatch[1])));
  }

  if (path === '/api/suppliers') {
    if (request.method === 'GET') return successResponse(await services.suppliers.list());
    if (request.method === 'POST') return successResponse(await services.suppliers.create(await request.json()));
    return methodNotAllowed();
  }
  const supplierMatch = path.match(/^\/api\/suppliers\/([^/]+)$/);
  if (supplierMatch) {
    if (request.method !== 'DELETE') return methodNotAllowed();
    return successResponse(await services.suppliers.remove(decodeURIComponent(supplierMatch[1])));
  }

  if (path === '/api/products') {
    if (request.method === 'GET') return successResponse(await services.products.list());
    if (request.method === 'POST') return successResponse(await services.products.create(await request.json()));
    return methodNotAllowed();
  }
  const productMatch = path.match(/^\/api\/products\/([^/]+)$/);
  if (productMatch) {
    if (request.method !== 'DELETE') return methodNotAllowed();
    return successResponse(await services.products.remove(decodeURIComponent(productMatch[1])));
  }

  if (path === '/api/orders/bill') {
    const body = await request.json();
    return successResponse(await services.orders.bill(body.ids, body.customer));
  }
  if (path === '/api/orders/settle') {
    const body = await request.json();
    return successResponse(await services.orders.settle(body.ids));
  }
  if (explicitOrderMatch) {
    const id = decodeURIComponent(explicitOrderMatch[1]);
    const operation = explicitOrderMatch[2];
    const body = await request.json();
    const result = operation === 'ship'
      ? await services.orders.ship(id, body.actualWeight)
      : await services.orders.price(id, body.price);
    return successResponse(result);
  }
  if (path === '/api/orders') {
    if (request.method === 'GET') {
      return successResponse(await services.orders.list({
        date: url.searchParams.get('date'),
        status: url.searchParams.get('status'),
        customer: url.searchParams.get('customer')
      }));
    }
    if (request.method === 'POST') {
      return successResponse(await services.orders.createPreorder(await request.json()));
    }
    return methodNotAllowed();
  }
  const orderMatch = path.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch) {
    const id = decodeURIComponent(orderMatch[1]);
    if (request.method === 'DELETE') return successResponse(await services.orders.remove(id));
    if (request.method === 'PUT') {
      return successResponse(await translateLegacyOrderUpdate(services.orders, id, await request.json()));
    }
    return methodNotAllowed();
  }

  if (path === '/api/purchases') {
    if (request.method === 'GET') {
      return successResponse(await services.purchases.list({ date: url.searchParams.get('date') }));
    }
    if (request.method === 'POST') {
      return successResponse(await services.purchases.create(await request.json()));
    }
    return methodNotAllowed();
  }
  const purchaseMatch = path.match(/^\/api\/purchases\/([^/]+)$/);
  if (purchaseMatch) {
    if (request.method !== 'DELETE') return methodNotAllowed();
    return successResponse(await services.purchases.remove(decodeURIComponent(purchaseMatch[1])));
  }

  if (path === '/api/stats/home') {
    if (request.method !== 'GET') return methodNotAllowed();
    return successResponse(await services.statistics.home(url.searchParams.get('date') || getToday()));
  }
  const detailMatch = path.match(/^\/api\/details\/([^/]+)$/);
  if (detailMatch) {
    if (request.method !== 'GET') return methodNotAllowed();
    return successResponse(await services.statistics.details(
      decodeURIComponent(detailMatch[1]),
      url.searchParams.get('date') || getToday()
    ));
  }

  return errorResponse('Not Found', 404);
}

function responseForError(error) {
  if (error instanceof AuthConfigurationError) {
    console.error({ event: 'auth_configuration_invalid' });
    return errorResponse('登录服务配置异常', 503);
  }
  if (error instanceof LoginChallengeError) return errorResponse(error.message, error.status);
  if (error instanceof ValidationError) return errorResponse(error.message, error.status);
  if (error instanceof FeishuError) {
    console.error({
      event: 'feishu_request_failed',
      upstreamCode: error.upstreamCode ?? null,
      upstreamStatus: error.upstreamStatus ?? null
    });
    return errorResponse(error.message, 502);
  }
  console.error({
    event: 'unhandled_request_error',
    errorName: error instanceof Error ? error.name : 'UnknownError'
  });
  return errorResponse('服务器内部错误', 500);
}

export default {
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const cors = corsHeaders(
      request.headers.get('Origin') ?? '',
      parseAllowedOrigins(env.ALLOWED_ORIGINS)
    );

    let response;
    try {
      const origin = request.headers.get('Origin') ?? '';
      const originAllowed = origin && parseAllowedOrigins(env.ALLOWED_ORIGINS).includes(origin);

      if (request.method === 'OPTIONS') {
        response = originAllowed
          ? new Response(null, { headers: cors })
          : errorResponse('来源不允许', 403);
      } else if (origin && !originAllowed) {
        response = errorResponse('来源不允许', 403);
      } else if (url.pathname === '/api/health' && request.method === 'GET') {
        response = jsonResponse({
          code: 0,
          message: 'ok',
          data: {
            version: env.APP_VERSION || '3.2.0',
            service: 'seafood-billing-api'
          }
        });
      } else if (url.pathname === '/api/auth/challenge' && request.method === 'GET') {
        response = origin
          ? successResponse(await issueLoginChallenge(env))
          : errorResponse('来源不允许', 403);
      } else if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        response = origin
          ? await rateLimitedLogin(request, env)
          : errorResponse('来源不允许', 403);
      } else {
        await requireAuthentication(request, env);
        response = await routeProtectedRequest(request, env);
      }
    } catch (error) {
      response = responseForError(error);
    }

    response = withHeaders(response, { ...cors, 'X-Request-Id': requestId });
    console.log({
      requestId,
      method: request.method,
      path: url.pathname,
      status: response.status,
      durationMs: Date.now() - startedAt
    });
    return response;
  }
};
