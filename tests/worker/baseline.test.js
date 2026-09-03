import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../worker/index.js';
import { issueToken } from '../../worker/auth.js';

const AUTH_SECRET = 'baseline-auth-secret-with-at-least-32-characters';
let authorization;

const configuredEnv = {
  FEISHU_APP_ID: 'app',
  FEISHU_APP_SECRET: 'secret',
  FEISHU_BASE_TOKEN: 'base',
  TABLE_CUSTOMERS: 'customers',
  TABLE_SUPPLIERS: 'suppliers',
  TABLE_PRODUCTS: 'products',
  TABLE_ORDERS: 'orders',
  TABLE_PURCHASES: 'purchases',
  AUTH_SECRET
};
const corsEnv = {
  ...configuredEnv,
  ALLOWED_ORIGINS: ' https://allowed.example, https://other.example '
};

const orderFields = (status, overrides = {}) => ({
  订单编号: 'XSD20260823001',
  日期: '2026-08-23',
  客户: '测试客户',
  商品: '基围虾',
  规格: '30头',
  报货重量: 5,
  实际发货重量: 5.5,
  单价: 40,
  金额: 220,
  状态: status,
  是否结算: status === '已结算',
  ...overrides
});

function feishuResponse(data) {
  return Promise.resolve(new Response(JSON.stringify({ code: 0, data })));
}

function mockOrderMutation(currentStatus, updatedStatus) {
  return vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => feishuResponse({ tenant_access_token: 'tenant-token' }))
    .mockImplementationOnce(() => feishuResponse({
      items: [{ record_id: 'rec1', fields: orderFields(currentStatus) }]
    }))
    .mockImplementationOnce(() => feishuResponse({
      record: { record_id: 'rec1', fields: orderFields(updatedStatus) }
    }));
}

function mockOrderRead(currentStatus) {
  return vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => feishuResponse({ tenant_access_token: 'tenant-token' }))
    .mockImplementationOnce(() => feishuResponse({
      items: [{ record_id: 'rec1', fields: orderFields(currentStatus) }]
    }));
}

function fetchAsUser(request, env) {
  const headers = new Headers(request.headers);
  headers.set('Authorization', authorization);
  return worker.fetch(new Request(request, { headers }), env);
}

beforeAll(async () => {
  authorization = `Bearer ${await issueToken(AUTH_SECRET)}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('worker production baseline', () => {
  it.each([
    ['DELETE', '/api/orders/bill'],
    ['PUT', '/api/orders/settle'],
    ['POST', '/api/orders/XSD20260823001/ship'],
    ['POST', '/api/orders/XSD20260823001/price']
  ])('rejects %s %s before any Feishu request', async (method, path) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Feishu must not be called for unsupported methods')
    );

    const response = await fetchAsUser(new Request(`https://example.test${path}`, {
      method,
      headers: { Origin: 'https://allowed.example' }
    }), corsEnv);

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({ code: 405, message: 'Method Not Allowed' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.example');
    expect(response.headers.get('Vary')).toBe('Origin');
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows configured preflight origins without a Feishu request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Feishu must not be called for preflight requests')
    );

    const response = await worker.fetch(new Request('https://example.test/api/orders', {
      method: 'OPTIONS',
      headers: { Origin: 'https://allowed.example' }
    }), corsEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
    expect(response.headers.get('Vary')).toBe('Origin');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.example');
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not allow unconfigured preflight origins or call Feishu', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Feishu must not be called for preflight requests')
    );

    const response = await worker.fetch(new Request('https://example.test/api/orders', {
      method: 'OPTIONS',
      headers: { Origin: 'https://denied.example' }
    }), corsEnv);

    expect(response.status).toBe(403);
    expect(response.headers.get('Vary')).toBe('Origin');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves health checks before environment validation and Feishu token requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Feishu must not be called for health checks')
    );

    const response = await worker.fetch(new Request('https://example.test/api/health', {
      headers: { Origin: 'https://allowed.example' }
    }), { ALLOWED_ORIGINS: 'https://allowed.example' });

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.example');
    expect(response.headers.get('Vary')).toBe('Origin');
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    await expect(response.json()).resolves.toEqual({
      code: 0,
      message: 'ok',
      data: { version: '3.2.0', service: 'seafood-billing-api' }
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs only request metadata with the same response request ID', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/health'), {});
    const requestId = response.headers.get('X-Request-Id');

    expect(console.log).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(console.log).mock.calls[0][0];
    expect(Object.keys(entry).sort()).toEqual(['durationMs', 'method', 'path', 'requestId', 'status']);
    expect(entry).toMatchObject({ requestId, method: 'GET', path: '/api/health', status: 200 });
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('normalizes order list statuses and sends Chinese status filters to Feishu', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => feishuResponse({ tenant_access_token: 'tenant-token' }))
      .mockImplementationOnce(() => feishuResponse({
        items: [{ record_id: 'rec1', fields: orderFields('未结算') }]
      }));

    const response = await fetchAsUser(
      new Request('https://example.test/api/orders?status=unsettled'),
      configuredEnv
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0].status).toBe('unsettled');
    expect(String(fetchSpy.mock.calls[1][0])).toContain('/records/search?page_size=500');
    expect(fetchSpy.mock.calls[1][1].method).toBe('POST');
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({
      filter: {
        conjunction: 'and',
        conditions: [{ field_name: '状态', operator: 'is', value: ['未结算'] }]
      }
    });
  });

  it('creates an order with a Chinese Feishu status and returns an English API status', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => feishuResponse({ tenant_access_token: 'tenant-token' }))
      .mockImplementationOnce(() => feishuResponse({ items: [], has_more: false }))
      .mockImplementationOnce(() => feishuResponse({ items: [], has_more: false }))
      .mockImplementationOnce(() => feishuResponse({
        record: { record_id: 'rec1', fields: orderFields('待发货') }
      }))
      .mockImplementationOnce(() => feishuResponse({
        items: [{ record_id: 'rec1', fields: orderFields('待发货') }]
      }));

    const response = await fetchAsUser(new Request('https://example.test/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: '2026-08-23',
        customer: '测试客户',
        spec: '30头',
        orderWeight: 5
      })
    }), configuredEnv);
    const responseBody = await response.json();
    const createBody = JSON.parse(fetchSpy.mock.calls[3][1].body);

    expect(createBody.fields['状态']).toBe('待发货');
    expect(responseBody.data.status).toBe('pending_ship');
  });

  it('updates a settled order using canonical comparisons and returns an English API status', async () => {
    const fetchSpy = mockOrderMutation('已结算', '未开单');

    const response = await fetchAsUser(new Request('https://example.test/api/orders/XSD20260823001', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actualWeight: 5.5, price: 40, status: 'pending_bill' })
    }), configuredEnv);
    const responseBody = await response.json();
    const updateBody = JSON.parse(fetchSpy.mock.calls[2][1].body);

    expect(updateBody.fields).toMatchObject({ 状态: '未开单', 是否结算: false });
    expect(responseBody.data.status).toBe('pending_bill');
  });

  it('accepts a Chinese target status and applies canonical settled-order rules', async () => {
    const fetchSpy = mockOrderMutation('已结算', '未开单');

    const response = await fetchAsUser(new Request('https://example.test/api/orders/XSD20260823001', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actualWeight: 5.5, price: 40, status: '未开单' })
    }), configuredEnv);
    const responseBody = await response.json();
    const updateBody = JSON.parse(fetchSpy.mock.calls[2][1].body);

    expect(response.status).toBe(200);
    expect(updateBody.fields).toMatchObject({ 状态: '未开单', 是否结算: false });
    expect(responseBody.data.status).toBe('pending_bill');
  });

  it('rejects an invalid order transition without updating Feishu', async () => {
    const fetchSpy = mockOrderRead('已发货');

    const response = await fetchAsUser(new Request('https://example.test/api/orders/XSD20260823001/ship', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actualWeight: 5.5 })
    }), configuredEnv);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 409,
      message: expect.stringContaining('仅待发货订单可以发货')
    });
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });

  it.each([
    ['ship', { actualWeight: -1 }, '实际发货重量必须大于0'],
    ['price', { price: 'abc' }, '单价必须是有效数字']
  ])('rejects invalid order update numbers without writing to Feishu: %s %o', async (operation, update, message) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await fetchAsUser(new Request(`https://example.test/api/orders/XSD20260823001/${operation}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update)
    }), configuredEnv);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 400, message });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows pending_ship to shipped and writes the Chinese status to Feishu', async () => {
    const fetchSpy = mockOrderMutation('待发货', '已发货');

    const response = await fetchAsUser(new Request('https://example.test/api/orders/XSD20260823001', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actualWeight: 5.5, status: 'shipped' })
    }), configuredEnv);
    const responseBody = await response.json();
    const updateBody = JSON.parse(fetchSpy.mock.calls[2][1].body);

    expect(response.status).toBe(200);
    expect(updateBody.fields['状态']).toBe('已发货');
    expect(responseBody.data.status).toBe('shipped');
  });

  it('ships through the explicit route', async () => {
    const fetchSpy = mockOrderMutation('待发货', '已发货');

    const response = await fetchAsUser(new Request(
      'https://example.test/api/orders/XSD20260823001/ship',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actualWeight: 5.5 })
      }
    ), configuredEnv);
    const body = await response.json();
    const updateBody = JSON.parse(fetchSpy.mock.calls[2][1].body);

    expect(response.status).toBe(200);
    expect(updateBody.fields).toMatchObject({ 实际发货重量: 5.5, 状态: '已发货' });
    expect(body.data.status).toBe('shipped');
  });

  it('prices through the explicit route', async () => {
    const fetchSpy = mockOrderMutation('已发货', '未开单');

    const response = await fetchAsUser(new Request(
      'https://example.test/api/orders/XSD20260823001/price',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ price: 42 })
      }
    ), configuredEnv);
    const body = await response.json();
    const updateBody = JSON.parse(fetchSpy.mock.calls[2][1].body);

    expect(response.status).toBe(200);
    expect(updateBody.fields).toMatchObject({ 单价: 42, 金额: 231, 状态: '未开单' });
    expect(body.data.status).toBe('pending_bill');
  });

  it('rejects arbitrary legacy status updates without writing to Feishu', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await fetchAsUser(new Request('https://example.test/api/orders/XSD20260823001', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'settled' })
    }), configuredEnv);

    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps Feishu upstream failures to 502 with a request ID', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('bad gateway', { status: 502 })
    );

    const response = await fetchAsUser(new Request('https://example.test/api/orders'), configuredEnv);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: 502 });
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('maps Feishu network rejections to 502 with CORS, request ID, and status-only logging', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('connection failed with secret-token')
    );

    const response = await fetchAsUser(new Request('https://example.test/api/orders', {
      headers: { Origin: 'https://allowed.example' }
    }), corsEnv);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ code: 502, message: '飞书认证失败' });
    expect(JSON.stringify(body)).not.toContain('secret-token');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.example');
    const requestId = response.headers.get('X-Request-Id');
    expect(requestId).toBeTruthy();
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.log).mock.calls[0][0]).toMatchObject({ requestId, status: 502 });
  });

  it.each([
    [{ customer: '   ', spec: '30头', orderWeight: 5 }, '客户不能为空'],
    [{ customer: '测试客户', spec: '30头', orderWeight: 5, date: '2026/08/23' }, '日期格式必须为YYYY-MM-DD'],
    [{ customer: '测试客户', spec: '30头', orderWeight: -1 }, '报货重量必须大于0']
  ])('validates order creation before writing to Feishu: %o', async (order, message) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => feishuResponse({ tenant_access_token: 'tenant-token' }));

    const response = await fetchAsUser(new Request('https://example.test/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    }), configuredEnv);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 400, message });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [{ supplier: '   ', spec: '30头', weight: 5, price: 20 }, '供应商不能为空'],
    [{ supplier: '供应商甲', spec: '30头', weight: 5, price: 20, date: '23-08-2026' }, '日期格式必须为YYYY-MM-DD'],
    [{ supplier: '供应商甲', spec: '30头', weight: -1, price: 20 }, '进货重量必须大于0'],
    [{ supplier: '供应商甲', spec: '30头', weight: 5, price: 'abc' }, '进货单价必须是有效数字']
  ])('validates purchase creation before writing to Feishu: %o', async (purchase, message) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => feishuResponse({ tenant_access_token: 'tenant-token' }));

    const response = await fetchAsUser(new Request('https://example.test/api/purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(purchase)
    }), configuredEnv);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 400, message });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/orders/bill', '未开单', '未结算', 'unsettled'],
    ['/api/orders/settle', '未结算', '已结算', 'settled']
  ])('handles %s before the generic order route and preserves the status boundary', async (
    path,
    currentStatus,
    updatedStatus,
    apiStatus
  ) => {
    const fetchSpy = mockOrderMutation(currentStatus, updatedStatus);

    const response = await fetchAsUser(new Request(`https://example.test${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['XSD20260823001'],
        ...(path.endsWith('/bill') ? { customer: '测试客户' } : {})
      })
    }), configuredEnv);
    const responseBody = await response.json();
    const updateBody = JSON.parse(fetchSpy.mock.calls[2][1].body);

    expect(response.status).toBe(200);
    expect(updateBody.fields['状态']).toBe(updatedStatus);
    expect(responseBody.data).toMatchObject({ count: 1, totalAmount: 220 });
    expect(responseBody.data.orders[0].status).toBe(apiStatus);
  });

  it.each([
    ['/api/orders/bill', '未开单', '未结算', 'unsettled'],
    ['/api/orders/settle', '未结算', '已结算', 'settled']
  ])('reports partial %s writes and continues after the second update fails', async (
    path,
    currentStatus,
    updatedStatus,
    apiStatus
  ) => {
    const ids = ['XSD20260823001', 'XSD20260823002', 'XSD20260823003'];
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => feishuResponse({ tenant_access_token: 'tenant-token' }))
      .mockImplementationOnce(() => feishuResponse({
        items: ids.map((id, index) => ({
          record_id: `rec${index + 1}`,
          fields: orderFields(currentStatus, { 订单编号: id })
        }))
      }))
      .mockImplementationOnce(() => feishuResponse({
        record: { record_id: 'rec1', fields: orderFields(updatedStatus, { 订单编号: ids[0] }) }
      }))
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ code: 500 }))))
      .mockImplementationOnce(() => feishuResponse({
        record: { record_id: 'rec3', fields: orderFields(updatedStatus, { 订单编号: ids[2] }) }
      }));

    const response = await fetchAsUser(new Request(`https://example.test${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, ...(path.endsWith('/bill') ? { customer: '测试客户' } : {}) })
    }), configuredEnv);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      count: 2,
      successCount: 2,
      skippedCount: 1,
      orders: [{ id: ids[0], status: apiStatus }, { id: ids[2], status: apiStatus }],
      reasons: [{ id: ids[1], reason: '飞书更新失败' }]
    });
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(fetchSpy.mock.calls[4][0]).toContain('/records/rec3');
  });
});
