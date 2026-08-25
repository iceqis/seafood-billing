import { describe, expect, it, vi } from 'vitest';
import { createPageFactory } from '../../assets/js/pages/factory.js';
import { getHomeDetailConfig, renderHomeDetail } from '../../assets/js/pages/home.js';
import { createProfilePage } from '../../assets/js/pages/profile.js';
import { createPurchasesPage } from '../../assets/js/pages/purchases.js';

describe('page quality boundaries', () => {
  it('does not toast request cancellation', async () => {
    const toast = vi.fn();
    const page = createPageFactory({ showToast: toast });
    await expect(page.run(() => { const error = new Error('cancelled'); error.name = 'RequestCancelled'; throw error; })).rejects.toThrow('cancelled');
    expect(toast).not.toHaveBeenCalled();
    const reported = new Error('api'); reported.reported = true;
    await expect(page.run(() => { throw reported; })).rejects.toThrow('api');
    expect(toast).not.toHaveBeenCalled();
  });

  it('locks a modal action while its async mutation is in flight', async () => {
    const parent = document.createElement('div'); let release; const handler = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const page = createPageFactory({}); const button = page.addButton(parent, '保存', 'btn', handler);
    button.click(); button.click();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledOnce(); expect(button.disabled).toBe(true);
    release(); await vi.waitFor(() => expect(button.disabled).toBe(false));
  });

  it('renders home detail fields as text', () => {
    const container = document.createElement('div');
    renderHomeDetail(container, [{ customer: '<script>客户</script>', product: '虾', spec: '30头', actualWeight: 2, price: 10, date: '2026-08-25', amount: 20, status: 'unsettled' }]);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>客户</script>');
    expect(container.textContent).toContain('30头');
    expect(container.textContent).toContain('¥20.00');
  });

  it('uses the correct Chinese summary for each home detail card', () => {
    expect(getHomeDetailConfig('today-deals').summary({ count: 3, total: 999 })).toBe('今日共成交 3 笔');
    expect(getHomeDetailConfig('today-sales').summary({ count: 3, total: 99.5 })).toContain('¥99.50');
    expect(getHomeDetailConfig('today-purchase').summary({ count: 2, total: 20 })).toContain('共 2 条');
    expect(getHomeDetailConfig('month-sales').summary({ count: 4, total: 40 })).toContain('合计 ¥40.00');
  });

  it('loads data-source status for the profile page', async () => {
    document.body.innerHTML = '<section id="page-me"><div class="text-xs"></div><div class="list-item"></div></section><button id="logout-button"></button>';
    const get = vi.fn().mockResolvedValue({ customers: true, suppliers: true, products: true, orders: true, purchases: true });
    const page = createProfilePage({ api: { get }, version: '版本 v3.0', showToast: vi.fn(), logout: vi.fn() });
    await page.enter();
    expect(get).toHaveBeenCalledWith('/api/health/data-source');
    expect(document.querySelector('.text-xs').textContent).toContain('5/5');

    get.mockResolvedValue({ customers: true, suppliers: false, products: true, orders: false });
    await page.enter();
    expect(document.querySelector('.text-xs').textContent).toContain('2/5');
  });

  it('writes purchase amount into the readonly input value', async () => {
    document.body.innerHTML = '<section id="page-purchase"><div class="card-header"><button></button></div><select id="purchase-supplier"></select><select id="purchase-product"></select><div id="purchase-spec-chips"></div><input id="purchase-date"><input id="purchase-weight"><input id="purchase-price"><input id="purchase-amount"><div id="purchase-summary-weight"></div><div id="purchase-summary-total"></div><div id="supplier-list"></div><div id="purchase-records-list"></div><button></button></section>';
    const page = createPurchasesPage({ api: { get: vi.fn().mockResolvedValue([]) }, today: () => '2026-08-25' });
    document.getElementById('purchase-weight').value = '2'; document.getElementById('purchase-price').value = '12';
    document.getElementById('purchase-weight').dispatchEvent(new Event('input'));
    expect(document.getElementById('purchase-amount').value).toBe('24.00');
    expect(page).toBeTruthy();
  });

  it('clears a stale purchase spec when changing products', async () => {
    document.body.innerHTML = '<section id="page-purchase"><div class="card-header"><button></button></div><select id="purchase-supplier"></select><select id="purchase-product"></select><div id="purchase-spec-chips"></div><input id="purchase-date"><input id="purchase-weight"><input id="purchase-price"><input id="purchase-amount"><div id="purchase-summary-weight"></div><div id="purchase-summary-total"></div><div id="supplier-list"></div><div id="purchase-records-list"></div><button></button></section>';
    const api = { get: vi.fn().mockResolvedValue([]), post: vi.fn(), delete: vi.fn() };
    createPurchasesPage({ api, today: () => '2026-08-25', showToast: vi.fn() });
    const chips = document.getElementById('purchase-spec-chips'); chips.dataset.selected = '旧规格';
    document.getElementById('purchase-product').dispatchEvent(new Event('change'));
    expect(chips.dataset.selected).toBeUndefined();
  });

  it('refreshes purchase catalog without losing a valid half-filled form', async () => {
    document.body.innerHTML = '<section id="page-purchase"><div class="card-header"><button></button></div><select id="purchase-supplier"></select><select id="purchase-product"></select><div id="purchase-spec-chips"></div><input id="purchase-date"><input id="purchase-weight"><input id="purchase-price"><input id="purchase-amount"><div id="purchase-summary-weight"></div><div id="purchase-summary-total"></div><div id="supplier-list"></div><div id="purchase-records-list"></div><button></button></section>';
    const api = { get: vi.fn((path) => path.includes('suppliers') ? Promise.resolve([{ name: '原供应商' }]) : path.includes('products') ? Promise.resolve([{ name: '原商品', specs: '30头,40头' }]) : Promise.resolve([])) };
    const page = createPurchasesPage({ api, today: () => '2026-08-25' });
    await page.enter();
    const chips = document.getElementById('purchase-spec-chips'); document.getElementById('purchase-date').value = '2026-08-20'; document.getElementById('purchase-supplier').value = '原供应商'; document.getElementById('purchase-product').value = '原商品'; document.getElementById('purchase-weight').value = '2'; document.getElementById('purchase-price').value = '10'; chips.dataset.selected = '30头';
    await page.refreshCatalog();
    expect(document.getElementById('purchase-date').value).toBe('2026-08-20'); expect(document.getElementById('purchase-supplier').value).toBe('原供应商'); expect(document.getElementById('purchase-product').value).toBe('原商品'); expect(chips.dataset.selected).toBe('30头'); expect(document.getElementById('purchase-weight').value).toBe('2'); expect(document.getElementById('purchase-amount').value).toBe('20.00');
  });
});
