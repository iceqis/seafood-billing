import { describe, expect, it } from 'vitest';
import workerSource from '../../worker/index.js?raw';

const genericOrdersRoute = "if (path === '/api/orders' || path.startsWith('/api/orders/'))";

describe('worker production baseline', () => {
  it('routes bill and settlement requests before the generic orders route', () => {
    const genericRouteIndex = workerSource.indexOf(genericOrdersRoute);

    expect(workerSource.indexOf("if (path === '/api/orders/bill')")).toBeLessThan(genericRouteIndex);
    expect(workerSource.indexOf("if (path === '/api/orders/settle')")).toBeLessThan(genericRouteIndex);
  });

  it('normalizes status values in normal order responses', () => {
    const ordersHandler = workerSource.match(/async function handleOrders[\s\S]*?\n}\n\n\/\/ 统一开单/)?.[0];

    expect(ordersHandler).toContain('items.map(formatOrder).map(o => ({ ...o, status: statusFromFeishu(o.status) }))');
  });

  it('serves health checks before requesting a Feishu tenant token', () => {
    expect(workerSource.indexOf("if (path === '/api/health')")).toBeLessThan(
      workerSource.indexOf('const token = await getTenantToken(env)')
    );
  });
});
