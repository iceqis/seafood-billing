import { createElement } from '../utils.js';
import { createPageFactory } from './factory.js';

export function createProfilePage(deps) {
  const page = createPageFactory(deps);
  async function enter() {
    const label = page.byId('page-me').querySelector('.text-xs');
    try { const status = await page.api.get('/api/health/data-source') || {}; const tables = ['customers', 'suppliers', 'products', 'orders', 'purchases']; const available = tables.filter((table) => status[table] === true).length; page.setText(label, `${page.version || '版本 v3.0'} · 数据源：飞书多维表格（${available}/${tables.length} 张表可用）`); }
    catch { page.setText(label, `${page.version || '版本 v3.0'} · 数据源检查失败`); }
  }
  function bind() { page.byId('page-me').querySelector('.list-item')?.addEventListener('click', () => page.showToast?.('请在飞书多维表格中导出数据', 'error')); page.byId('logout-button').addEventListener('click', page.logout); }
  bind(); return { enter: () => page.run(enter) };
}
