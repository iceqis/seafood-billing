import { describe, expect, it, vi } from 'vitest';
import { createCustomersPage, formatBatchResult, getBillingSelection, renderCustomerList, toggleSelectableOrder } from '../../assets/js/pages/customers.js';
import { renderProductsList } from '../../assets/js/pages/products.js';

const orders = [
  { id: 'XSD1', status: 'pending_bill', amount: 120 },
  { id: 'XSD2', status: 'unsettled', amount: 200 },
  { id: 'XSD3', status: 'settled', amount: 300 }
];

describe('customer billing selection', () => {
  it('separates bill and settle actions and excludes settled orders', () => {
    expect(getBillingSelection(orders, new Set(['XSD1', 'XSD2', 'XSD3']))).toEqual({
      selectedCount: 2,
      selectedAmount: 320,
      pendingBillIds: ['XSD1'],
      unsettledIds: ['XSD2']
    });
    expect(getBillingSelection([
      { id: 'XSD4', status: 'pending_ship', amount: 999 },
      { id: 'XSD5', status: 'shipped', amount: 999 }
    ], new Set(['XSD4', 'XSD5']))).toEqual({ selectedCount: 0, selectedAmount: 0, pendingBillIds: [], unsettledIds: [] });
  });

  it('does not select a settled order', () => {
    expect(toggleSelectableOrder(new Set(), orders[2])).toEqual(new Set());
    expect(toggleSelectableOrder(new Set(), { id: 'XSD4', status: 'shipped' })).toEqual(new Set());
  });

  it('renders customer, product, and spec values as text', () => {
    const customerContainer = document.createElement('div');
    const productContainer = document.createElement('div');
    renderCustomerList(customerContainer, [{ name: '<img src=x>', phone: '<script>bad</script>' }], {});
    renderProductsList(productContainer, [{ name: '<b>商品</b>', specs: '<img>规格' }]);
    expect(customerContainer.querySelector('img, script, b')).toBeNull();
    expect(productContainer.querySelector('img, script, b')).toBeNull();
    expect(customerContainer.textContent).toContain('<img src=x>');
    expect(productContainer.textContent).toContain('<b>商品</b>');
    expect(productContainer.textContent).toContain('<img>规格');
  });

  it('keeps skipped reasons in a text-only batch summary', () => {
    expect(formatBatchResult({ successCount: 1, skippedCount: 1, reasons: ['<script>原因</script>'] }))
      .toBe('成功 1 单，跳过 1 单：<script>原因</script>');
    expect(formatBatchResult({ successCount: 1, skippedCount: 1, reasons: [{ id: 'XSD2', reason: '状态不允许' }] }))
      .toBe('成功 1 单，跳过 1 单：XSD2：状态不允许');
  });

  it('renders complete customer order accounting details with safe DOM nodes', async () => {
    document.body.innerHTML = '<input id="customer-search"><div id="customers-list"></div><div id="customer-orders-name"></div><div id="customer-orders-list"></div><div id="billing-bar"></div><span id="selected-count"></span><span id="selected-amount"></span><button id="btn-unified-bill"></button><button id="btn-settle-selected"></button><section id="page-customers"><div class="card-header"><button></button></div></section><section id="page-customer-orders"><button class="back-btn"></button></section><div id="loading-overlay"></div>';
    const api = { get: vi.fn((path) => path.includes('customer=') ? Promise.resolve([{ id: 'O1', customer: '<script>客户</script>', product: '<img>商品', spec: '30头', date: '2026-08-25', actualWeight: 2, price: 10, amount: 20, status: 'pending_bill' }]) : Promise.resolve([])) };
    const page = createCustomersPage({ api, today: () => '2026-08-25', navigate: vi.fn() });
    await page.viewOrders('<script>客户</script>');
    const text = document.getElementById('customer-orders-list').textContent;
    expect(text).toContain('未开单'); expect(text).toContain('2026-08-25'); expect(text).toContain('订单号 O1');
    expect(text).toContain('实际重量 2斤'); expect(text).toContain('单价 ¥10.00'); expect(text).toContain('金额 ¥20.00');
    expect(text).toContain('<script>客户</script>'); expect(text).toContain('<img>商品'); expect(document.querySelector('#customer-orders-list script')).toBeNull();
  });

  it('does not misreport or repeat a successful customer write when the refresh fails', async () => {
    document.body.innerHTML = '<input id="customer-search"><div id="customers-list"></div><div id="customer-orders-name"></div><div id="customer-orders-list"></div><div id="billing-bar"></div><span id="selected-count"></span><span id="selected-amount"></span><button id="btn-unified-bill"></button><button id="btn-settle-selected"></button><section id="page-customers"><div class="card-header"><button class="btn">添加客户</button></div></section><section id="page-customer-orders"><button class="back-btn"></button></section><div id="loading-overlay"></div><div id="modal-overlay"><h2 id="modal-title"></h2><div id="modal-body"></div><div id="modal-footer"></div></div>';
    const api = {
      post: vi.fn().mockResolvedValue({ recordId: 'customer-record', name: '新客户' }),
      get: vi.fn().mockRejectedValue(new Error('读取飞书数据失败'))
    };
    const showToast = vi.fn();
    createCustomersPage({ api, showToast, navigate: vi.fn() });

    document.querySelector('#page-customers .card-header .btn').click();
    const inputs = document.querySelectorAll('#modal-body input');
    inputs[0].value = '新客户';
    document.querySelector('#modal-footer .btn-primary').click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(
      '客户已添加，但列表刷新失败，请刷新页面', 'warning'
    ));

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/api/customers', {
      name: '新客户', phone: '', settlement: '', remark: ''
    });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(document.getElementById('modal-overlay').classList.contains('show')).toBe(false);
  });
});
