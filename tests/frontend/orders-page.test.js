import { describe, expect, it, vi } from 'vitest';
import { createOrdersPage, renderOrdersList } from '../../assets/js/pages/orders.js';

describe('orders page', () => {
  it('renders state-specific actions and treats names as text', () => {
    const container = document.createElement('div');
    const onShip = vi.fn();
    const onPrice = vi.fn();
    renderOrdersList(container, [
      {
        id: 'XSD1', customer: '<script>测试客户</script>', product: '基围虾',
        spec: '30头', orderWeight: 5, actualWeight: 0, status: 'pending_ship'
      },
      {
        id: 'XSD2', customer: '安全客户', product: '基围虾',
        spec: '40头', orderWeight: 6, actualWeight: 6, status: 'shipped'
      },
      { id: 'XSD3', customer: '不应显示', product: '基围虾', spec: '50头', status: 'settled' }
    ], { onShip, onPrice });

    expect(container.textContent).toContain('去发货');
    expect(container.textContent).toContain('去定价');
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>测试客户</script>');
    expect(container.textContent).not.toContain('不应显示');
    const buttons = container.querySelectorAll('button');
    buttons[0].click();
    buttons[1].click();
    expect(onShip).toHaveBeenCalledWith(expect.objectContaining({ id: 'XSD1' }));
    expect(onPrice).toHaveBeenCalledWith(expect.objectContaining({ id: 'XSD2' }));
  });

  it('loads the selected date through the orders route on page entry', async () => {
    document.body.innerHTML = '<section id="page-orders"><div class="card-header"><button class="btn"></button></div></section><input id="order-search"><input id="order-date"><div id="orders-list"></div><div id="loading-overlay"></div>';
    const get = vi.fn().mockResolvedValue([]);
    const page = createOrdersPage({ api: { get }, today: () => '2026-08-25', navigate: vi.fn() });
    await page.enter();
    expect(get).toHaveBeenCalledWith('/api/orders?date=2026-08-25&status=pending_ship%2Cshipped');
  });
});
