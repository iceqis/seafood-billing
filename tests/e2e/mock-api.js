import { createLoginProof } from '../../assets/js/auth-proof.js';

const TOKEN = 'e2e-signed-token';
const GOOD_PASSWORD = 'correct-shop-password';
const LOGIN_CHALLENGE = {
  challengeToken: 'cGF5bG9hZA.c2lnbmF0dXJl',
  salt: 'MDEyMzQ1Njc4OWFiY2RlZg==',
  iterations: 210000,
  hash: 'SHA-256',
  expiresAt: 2000000000
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function envelope(data, message = 'success', code = 0) {
  return { code, message, data };
}

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function requestJson(request) {
  try {
    return request.postDataJSON() || {};
  } catch {
    return {};
  }
}

export async function installMockApi(page, seed = {}) {
  const expectedProof = await createLoginProof(GOOD_PASSWORD, LOGIN_CHALLENGE, {
    nowMs: Date.now()
  });
  const state = {
    customers: clone(seed.customers || [{ name: '海鲜酒楼', phone: '13800000000', settlement: '现结', remark: '' }]),
    suppliers: clone(seed.suppliers || [{ name: '渔港供应商', phone: '13900000000', remark: '' }]),
    products: clone(seed.products || [{ name: '基围虾', specs: '30头,40头' }]),
    orders: clone(seed.orders || []),
    purchases: clone(seed.purchases || [])
  };
  const requests = [];
  const unknownRequests = [];
  const requestEntries = new WeakMap();
  const transitions = [];
  let nextOrder = 1;
  let nextPurchase = 1;

  function findOrder(id) {
    return state.orders.find((order) => order.id === id);
  }

  async function respond(route, status, body) {
    await route.fulfill({
      status,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(body)
    });
    const entry = requestEntries.get(route.request());
    if (entry) entry.resolution = 'fulfilled';
  }

  async function ok(route, data) {
    await respond(route, 200, envelope(data));
  }

  async function fail(route, status, message) {
    await respond(route, status, envelope(null, message, status));
  }

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const requestBody = ['POST', 'PUT', 'PATCH'].includes(method) ? await requestJson(request) : null;
    const entry = { method, path, search: url.search, authorization: request.headers().authorization || '', body: requestBody, handled: false, resolution: 'pending' };
    requests.push(entry);
    requestEntries.set(request, entry);

    if (path === '/api/auth/challenge' && method === 'GET') {
      entry.handled = true;
      return ok(route, LOGIN_CHALLENGE);
    }

    if (path === '/api/auth/login' && method === 'POST') {
      entry.handled = true;
      if (requestBody.challengeToken !== LOGIN_CHALLENGE.challengeToken
        || requestBody.proof !== expectedProof) {
        return fail(route, 401, '店铺密码错误');
      }
      return ok(route, { token: TOKEN, expiresIn: 2592000 });
    }

    if (path === '/api/health' && method === 'GET') {
      entry.handled = true;
      return ok(route, { status: 'ok' });
    }

    if (entry.authorization !== `Bearer ${TOKEN}`) {
      entry.handled = true;
      return fail(route, 401, '登录已过期');
    }

    if (path === '/api/health/data-source' && method === 'GET') {
      entry.handled = true;
      return ok(route, { customers: true, suppliers: true, products: true, orders: true, purchases: true });
    }

    if (path === '/api/customers' && method === 'GET') {
      entry.handled = true;
      return ok(route, clone(state.customers));
    }
    if (path === '/api/customers' && method === 'POST') {
      entry.handled = true;
      const body = await requestJson(request);
      state.customers.push({ name: body.name, phone: body.phone || '', settlement: body.settlement || '', remark: body.remark || '' });
      return ok(route, clone(state.customers.at(-1)));
    }
    if (path.startsWith('/api/customers/') && method === 'DELETE') {
      entry.handled = true;
      const name = decodeURIComponent(path.slice('/api/customers/'.length));
      state.customers = state.customers.filter((customer) => customer.name !== name);
      return ok(route, { deleted: true });
    }

    if (path === '/api/products' && method === 'GET') {
      entry.handled = true;
      return ok(route, clone(state.products));
    }
    if (path === '/api/products' && method === 'POST') {
      entry.handled = true;
      const body = await requestJson(request);
      state.products.push({ name: body.name, specs: body.specs || '' });
      return ok(route, clone(state.products.at(-1)));
    }
    if (path.startsWith('/api/products/') && method === 'DELETE') {
      entry.handled = true;
      const name = decodeURIComponent(path.slice('/api/products/'.length));
      state.products = state.products.filter((product) => product.name !== name);
      return ok(route, { deleted: true });
    }

    if (path === '/api/suppliers' && method === 'GET') {
      entry.handled = true;
      return ok(route, clone(state.suppliers));
    }
    if (path === '/api/suppliers' && method === 'POST') {
      entry.handled = true;
      const body = await requestJson(request);
      state.suppliers.push({ name: body.name, phone: body.phone || '', remark: body.remark || '' });
      return ok(route, clone(state.suppliers.at(-1)));
    }
    if (path.startsWith('/api/suppliers/') && method === 'DELETE') {
      entry.handled = true;
      const name = decodeURIComponent(path.slice('/api/suppliers/'.length));
      state.suppliers = state.suppliers.filter((supplier) => supplier.name !== name);
      return ok(route, { deleted: true });
    }

    if (path === '/api/purchases' && method === 'GET') {
      entry.handled = true;
      const date = url.searchParams.get('date');
      return ok(route, clone(state.purchases.filter((purchase) => !date || purchase.date === date)));
    }
    if (path === '/api/purchases' && method === 'POST') {
      entry.handled = true;
      const body = await requestJson(request);
      const purchase = { ...body, id: `CGD${String(nextPurchase++).padStart(3, '0')}`, amount: Number((Number(body.weight) * Number(body.price)).toFixed(2)) };
      state.purchases.push(purchase);
      return ok(route, clone(purchase));
    }
    if (path.startsWith('/api/purchases/') && method === 'DELETE') {
      entry.handled = true;
      const id = decodeURIComponent(path.slice('/api/purchases/'.length));
      state.purchases = state.purchases.filter((purchase) => purchase.id !== id);
      return ok(route, { deleted: true });
    }

    if (path === '/api/orders' && method === 'GET') {
      entry.handled = true;
      const date = url.searchParams.get('date');
      const customer = url.searchParams.get('customer');
      const statuses = (url.searchParams.get('status') || '').split(',').filter(Boolean);
      return ok(route, clone(state.orders.filter((order) => (
        (!date || order.date === date)
        && (!customer || order.customer === customer)
        && (!statuses.length || statuses.includes(order.status))
      ))));
    }
    if (path === '/api/orders' && method === 'POST') {
      entry.handled = true;
      const body = await requestJson(request);
      const order = {
        ...body,
        id: `XSD${String(nextOrder++).padStart(3, '0')}`,
        date: body.date || today(),
        actualWeight: 0,
        price: 0,
        amount: 0,
        status: 'pending_ship',
        settled: false
      };
      state.orders.push(order);
      transitions.push(order.status);
      return ok(route, clone(order));
    }

    const operationMatch = path.match(/^\/api\/orders\/([^/]+)\/(ship|price)$/);
    if (operationMatch && method === 'PUT') {
      entry.handled = true;
      const order = findOrder(decodeURIComponent(operationMatch[1]));
      const body = await requestJson(request);
      if (!order) return fail(route, 404, '订单不存在');
      if (operationMatch[2] === 'ship') {
        if (order.status !== 'pending_ship') return fail(route, 409, '订单状态不允许发货');
        order.actualWeight = Number(body.actualWeight);
        order.status = 'shipped';
      } else {
        if (order.status !== 'shipped') return fail(route, 409, '订单状态不允许定价');
        order.price = Number(body.price);
        order.amount = Number((order.actualWeight * order.price).toFixed(2));
        order.status = 'pending_bill';
      }
      transitions.push(order.status);
      return ok(route, clone(order));
    }

    if (path === '/api/orders/bill' && method === 'POST') {
      entry.handled = true;
      const body = await requestJson(request);
      const selected = state.orders.filter((order) => body.ids?.includes(order.id));
      if (!selected.length || selected.some((order) => order.status !== 'pending_bill' || order.customer !== body.customer)) return fail(route, 409, '统一开单状态不允许');
      selected.forEach((order) => { order.status = 'unsettled'; });
      transitions.push('unsettled');
      return ok(route, { successCount: selected.length, skippedCount: 0, reasons: [] });
    }

    if (path === '/api/orders/settle' && method === 'POST') {
      entry.handled = true;
      const body = await requestJson(request);
      const selected = state.orders.filter((order) => body.ids?.includes(order.id));
      if (!selected.length || selected.some((order) => order.status !== 'unsettled')) return fail(route, 409, '结算状态不允许');
      selected.forEach((order) => { order.status = 'settled'; order.settled = true; });
      transitions.push('settled');
      return ok(route, { successCount: selected.length, skippedCount: 0, reasons: [] });
    }

    const orderMatch = path.match(/^\/api\/orders\/([^/]+)$/);
    if (orderMatch && method === 'PUT') {
      entry.handled = true;
      const order = findOrder(decodeURIComponent(orderMatch[1]));
      const body = await requestJson(request);
      if (!order) return fail(route, 404, '订单不存在');
      Object.assign(order, body, { amount: Number((Number(body.actualWeight) * Number(body.price)).toFixed(2)), status: 'pending_bill', settled: false });
      return ok(route, clone(order));
    }
    if (orderMatch && method === 'DELETE') {
      entry.handled = true;
      const id = decodeURIComponent(orderMatch[1]);
      state.orders = state.orders.filter((order) => order.id !== id);
      return ok(route, { deleted: true });
    }

    if (path === '/api/stats/home' && method === 'GET') {
      entry.handled = true;
      const date = url.searchParams.get('date') || today();
      const sales = state.orders.filter((order) => order.date === date && ['unsettled', 'settled'].includes(order.status));
      const purchases = state.purchases.filter((purchase) => purchase.date === date);
      const month = date.slice(0, 7);
      return ok(route, {
        todaySales: sales.reduce((sum, order) => sum + order.amount, 0),
        todayDealCount: sales.length,
        todayPurchase: purchases.reduce((sum, purchase) => sum + purchase.amount, 0),
        monthSales: state.orders.filter((order) => order.date.startsWith(month) && ['unsettled', 'settled'].includes(order.status)).reduce((sum, order) => sum + order.amount, 0)
      });
    }

    const detailsMatch = path.match(/^\/api\/details\/(today-sales|today-deals|today-purchase|month-sales)$/);
    if (detailsMatch && method === 'GET') {
      entry.handled = true;
      const date = url.searchParams.get('date') || today();
      const month = date.slice(0, 7);
      const type = detailsMatch[1];
      const items = type === 'today-purchase'
        ? state.purchases.filter((purchase) => purchase.date === date)
        : state.orders.filter((order) => (type === 'month-sales' ? order.date.startsWith(month) : order.date === date) && ['unsettled', 'settled'].includes(order.status));
      const total = type === 'today-deals' ? items.length : items.reduce((sum, item) => sum + item.amount, 0);
      return ok(route, { count: items.length, total, items: clone(items) });
    }

    entry.handled = true;
    unknownRequests.push(`${method} ${path}${url.search}`);
    return fail(route, 404, '模拟 API 未实现该路由');
  });

  return {
    state,
    requests,
    unknownRequests,
    transitions,
    token: TOKEN,
    get forwardedRequests() { return requests.filter((request) => request.resolution !== 'fulfilled'); }
  };
}

export function expectNoProductionForward(expect, mock) {
  expect(mock.forwardedRequests, '模拟层不得转发到生产 Worker').toEqual([]);
  expect(mock.unknownRequests, '测试用到的 API 必须全部由严格 mock 处理').toEqual([]);
  expect(mock.requests.every((request) => request.handled)).toBe(true);
}
