import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../worker/index.js';
import workerSource from '../../worker/index.js?raw';

const genericOrdersRoute = "if (path === '/api/orders' || /^\\/api\\/orders\\/[^/]+$/.test(path))";
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('worker production baseline', () => {
  it('routes bill and settlement requests before the generic orders route', () => {
    const genericRouteIndex = workerSource.indexOf(genericOrdersRoute);

    expect(genericRouteIndex).toBeGreaterThan(-1);
    expect(workerSource.indexOf("if (path === '/api/orders/bill')")).toBeLessThan(genericRouteIndex);
    expect(workerSource.indexOf("if (path === '/api/orders/settle')")).toBeLessThan(genericRouteIndex);
    expect(workerSource).not.toContain("path.startsWith('/api/orders/')");
  });

  it.each([
    ['DELETE', '/api/orders/bill'],
    ['PUT', '/api/orders/settle']
  ])('rejects %s %s before any Feishu request', async (method, path) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Feishu must not be called for unsupported methods')
    );

    const response = await worker.fetch(new Request(`https://example.test${path}`, { method }), configuredEnv);

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({ code: 405, message: 'Method Not Allowed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('normalizes status values in normal order responses', () => {
    const ordersHandler = workerSource.match(/async function handleOrders[\s\S]*?\n}\n\n\/\/ 统一开单/)?.[0];

    expect(ordersHandler).toContain('items.map(formatOrder).map(o => ({ ...o, status: statusFromFeishu(o.status) }))');
  });

  it('normalizes formatted Chinese statuses before internal comparisons', () => {
    expect(workerSource).toContain("statusFromFeishu(order.status) !== 'pending_bill'");
    expect(workerSource).toContain("statusFromFeishu(order.status) !== 'unsettled'");
    expect(workerSource).toContain("body.status === 'pending_bill' && statusFromFeishu(current.status) === 'settled'");
  });

  it('serves health checks before environment validation and Feishu token requests', async () => {
    expect(workerSource.indexOf("if (path === '/api/health')")).toBeLessThan(
      workerSource.indexOf("const requiredEnv = ['FEISHU_APP_ID'")
    );
    expect(workerSource.indexOf("if (path === '/api/health')")).toBeLessThan(
      workerSource.indexOf('const token = await getTenantToken(env)')
    );

    const response = await worker.fetch(new Request('https://example.test/api/health'), {});
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      code: 0,
      message: 'ok',
      data: { version: '3.0.1', service: 'seafood-billing-api' }
    });
  });
});
