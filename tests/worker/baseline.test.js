import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../worker/index.js';

const configuredEnv = {
  FEISHU_APP_ID: 'app',
  FEISHU_APP_SECRET: 'secret',
  FEISHU_BASE_TOKEN: 'base',
  TABLE_CUSTOMERS: 'customers',
  TABLE_SUPPLIERS: 'suppliers',
  TABLE_PRODUCTS: 'products',
  TABLE_ORDERS: 'orders',
  TABLE_PURCHASES: 'purchases'
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('worker production baseline', () => {
  it.each([
    ['DELETE', '/api/orders/bill'],
    ['PUT', '/api/orders/settle']
  ])('rejects %s %s before any Feishu request', async (method, path) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Feishu must not be called for unsupported methods')
    );

    const response = await worker.fetch(new Request(`https://example.test${path}`, {
      method,
      headers: { Origin: 'https://allowed.example' }
    }), corsEnv);

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({ code: 405, message: 'Method Not Allowed' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.example');
    expect(response.headers.get('Vary')).toBe('Origin');
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

    expect(response.status).toBe(200);
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
    await expect(response.json()).resolves.toEqual({
      code: 0,
      message: 'ok',
      data: { version: '3.0.1', service: 'seafood-billing-api' }
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('normalizes order list statuses and sends Chinese status filters to Feishu', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => feishuResponse({ tenant_access_token: 'tenant-token' }))
      .mockImplementationOnce(() => feishuResponse({
        items: [{ record_id: 'rec1', fields: orderFields('未结算') }]
      }));

    const response = await worker.fetch(
      new Request('https://example.test/api/orders?status=unsettled'),
      configuredEnv
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0].status).toBe('unsettled');
    expect(decodeURIComponent(fetchSpy.mock.calls[1][0])).toContain('"状态","operator":"is","value":["未结算"]');
  });

  it('creates an order with a Chinese Feishu status and returns an English API status', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => feishuResponse({ tenant_access_token: 'tenant-token' }))
      .mockImplementationOnce(() => feishuResponse({ total: 0 }))
      .mockImplementationOnce(() => feishuResponse({
        record: { record_id: 'rec1', fields: orderFields('待发货') }
      }));

    const response = await worker.fetch(new Request('https://example.test/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: '测试客户', spec: '30头', orderWeight: 5 })
    }), configuredEnv);
    const responseBody = await response.json();
    const createBody = JSON.parse(fetchSpy.mock.calls[2][1].body);

    expect(createBody.fields['状态']).toBe('待发货');
    expect(responseBody.data.status).toBe('pending_ship');
  });

  it('updates a settled order using canonical comparisons and returns an English API status', async () => {
    const fetchSpy = mockOrderMutation('已结算', '未开单');

    const response = await worker.fetch(new Request('https://example.test/api/orders/XSD20260823001', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending_bill' })
    }), configuredEnv);
    const responseBody = await response.json();
    const updateBody = JSON.parse(fetchSpy.mock.calls[2][1].body);

    expect(updateBody.fields).toMatchObject({ 状态: '未开单', 是否结算: false });
    expect(responseBody.data.status).toBe('pending_bill');
  });

  it('accepts a Chinese target status and applies canonical settled-order rules', async () => {
    const fetchSpy = mockOrderMutation('已结算', '未开单');

    const response = await worker.fetch(new Request('https://example.test/api/orders/XSD20260823001', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: '未开单' })
    }), configuredEnv);
    const responseBody = await response.json();
    const updateBody = JSON.parse(fetchSpy.mock.calls[2][1].body);

    expect(response.status).toBe(200);
    expect(updateBody.fields).toMatchObject({ 状态: '未开单', 是否结算: false });
    expect(responseBody.data.status).toBe('pending_bill');
  });

  it('rejects an invalid order transition without updating Feishu', async () => {
    const fetchSpy = mockOrderRead('待发货');

    const response = await worker.fetch(new Request('https://example.test/api/orders/XSD20260823001', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'settled' })
    }), configuredEnv);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 409,
      message: expect.stringContaining('不允许的订单状态转换')
    });
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });

  it.each([
    [{ actualWeight: -1 }, '实际发货重量必须大于0'],
    [{ price: 'abc' }, '单价必须是有效数字']
  ])('rejects invalid order update numbers without writing to Feishu: %o', async (update, message) => {
    const fetchSpy = mockOrderRead('待发货');

    const response = await worker.fetch(new Request('https://example.test/api/orders/XSD20260823001', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update)
    }), configuredEnv);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 400, message });
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });

  it('allows pending_ship to shipped and writes the Chinese status to Feishu', async () => {
    const fetchSpy = mockOrderMutation('待发货', '已发货');

    const response = await worker.fetch(new Request('https://example.test/api/orders/XSD20260823001', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'shipped' })
    }), configuredEnv);
    const responseBody = await response.json();
    const updateBody = JSON.parse(fetchSpy.mock.calls[2][1].body);

    expect(response.status).toBe(200);
    expect(updateBody.fields['状态']).toBe('已发货');
    expect(responseBody.data.status).toBe('shipped');
  });

  it.each([
    [{ customer: '   ', spec: '30头', orderWeight: 5 }, '客户不能为空'],
    [{ customer: '测试客户', spec: '30头', orderWeight: 5, date: '2026/08/23' }, '日期格式必须为YYYY-MM-DD'],
    [{ customer: '测试客户', spec: '30头', orderWeight: -1 }, '报货重量必须大于0']
  ])('validates order creation before writing to Feishu: %o', async (order, message) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => feishuResponse({ tenant_access_token: 'tenant-token' }));

    const response = await worker.fetch(new Request('https://example.test/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    }), configuredEnv);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 400, message });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ supplier: '   ', spec: '30头', weight: 5, price: 20 }, '供应商不能为空'],
    [{ supplier: '供应商甲', spec: '30头', weight: 5, price: 20, date: '23-08-2026' }, '日期格式必须为YYYY-MM-DD'],
    [{ supplier: '供应商甲', spec: '30头', weight: -1, price: 20 }, '进货重量必须大于0'],
    [{ supplier: '供应商甲', spec: '30头', weight: 5, price: 'abc' }, '进货单价必须是有效数字']
  ])('validates purchase creation before writing to Feishu: %o', async (purchase, message) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => feishuResponse({ tenant_access_token: 'tenant-token' }));

    const response = await worker.fetch(new Request('https://example.test/api/purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(purchase)
    }), configuredEnv);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 400, message });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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

    const response = await worker.fetch(new Request(`https://example.test${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['XSD20260823001'] })
    }), configuredEnv);
    const responseBody = await response.json();
    const updateBody = JSON.parse(fetchSpy.mock.calls[2][1].body);

    expect(response.status).toBe(200);
    expect(updateBody.fields['状态']).toBe(updatedStatus);
    expect(responseBody.data).toMatchObject({ count: 1, totalAmount: 220 });
    expect(responseBody.data.orders[0].status).toBe(apiStatus);
  });
});
