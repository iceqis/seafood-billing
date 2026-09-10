import { createElement } from '../utils.js';
import { createPageFactory } from './factory.js';

export function createHomePage(deps) {
  const page = createPageFactory(deps);
  async function enter() {
    const trendContainer = page.byId('home-year-trend');
    renderYearTrend(trendContainer, []);
    const stats = await page.api.get(`/api/stats/home?date=${page.today()}`) || {};
    page.setText(page.byId('home-today-sales'), page.money(stats.todaySales));
    page.setText(page.byId('home-deal-count'), stats.todayDealCount || 0);
    page.setText(page.byId('home-today-purchase'), page.money(stats.todayPurchase));
    page.setText(page.byId('home-month-sales'), page.money(stats.monthSales));
    renderYearTrend(trendContainer, stats.yearTrend);
  }
  async function detail(type) {
    const data = await page.api.get(`/api/details/${type}?date=${page.today()}`) || {}; const config = getHomeDetailConfig(type); page.setText(page.byId('stat-detail-summary'), config.summary(data)); page.setText(page.byId('stat-detail-title'), config.title); page.setText(page.byId('stat-detail-icon'), config.icon);
    renderHomeDetail(page.byId('stat-detail-list'), data.items || []); page.navigate('stat-detail');
  }
  function bind() {
    page.byId('page-home').querySelectorAll('.stat-card').forEach((card, index) => card.addEventListener('click', () => detail(['today-sales', 'today-deals', 'today-purchase', 'month-sales'][index])));
    page.byId('page-home').querySelectorAll('.quick-card').forEach((card, index) => card.addEventListener('click', () => page.navigate(['preorder', 'purchase', 'orders', 'customers'][index])));
    document.querySelector('#page-stat-detail .back-btn')?.addEventListener('click', () => page.navigate('home'));
  }
  bind(); return { enter: page.run.bind(null, enter), detail };
}

export function getHomeDetailConfig(type) {
  const configs = {
    'today-sales': { title: '今日销售额明细', icon: '📊', summary: (data) => `共 ${data.count || 0} 条，合计 ${pageMoney(data.total)}` },
    'today-deals': { title: '今日成交明细', icon: '🤝', summary: (data) => `今日共成交 ${data.count || 0} 笔` },
    'today-purchase': { title: '今日进货明细', icon: '🚚', summary: (data) => `共 ${data.count || 0} 条，合计 ${pageMoney(data.total)}` },
    'month-sales': { title: '本月销售额明细', icon: '📅', summary: (data) => `共 ${data.count || 0} 条，合计 ${pageMoney(data.total)}` }
  };
  return configs[type] || { title: '数据明细', icon: '📊', summary: (data) => `共 ${data.count || 0} 条` };
}
function pageMoney(value) { return `¥${(Number.isFinite(Number(value)) ? Number(value) : 0).toFixed(2)}`; }

export function trendAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function trendMonthLabel(month) {
  const match = String(month ?? '').match(/^\d{4}-(\d{2})$/);
  const number = Number(match?.[1]);
  return number >= 1 && number <= 12 ? `${number}月` : String(month ?? '');
}

export function renderYearTrend(container, trend) {
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);

  const rows = Array.isArray(trend) ? trend.map((item) => ({
    month: item?.month,
    sales: trendAmount(item?.sales),
    purchases: trendAmount(item?.purchases)
  })) : [];
  const maximum = Math.max(0, ...rows.flatMap((item) => [item.sales, item.purchases]));
  if (!rows.length || maximum === 0) {
    container.append(createElement('div', { className: 'chart-empty', role: 'status' }, '暂无经营数据'));
    return;
  }

  rows.forEach((item) => {
    const row = createElement('div', { className: 'chart-row' });
    row.append(createElement('div', { className: 'chart-month' }, trendMonthLabel(item.month)));
    row.append(createElement('div', { className: 'chart-values' }, `销售 ¥${item.sales.toFixed(2)} · 进货 ¥${item.purchases.toFixed(2)}`));
    [['sales', item.sales], ['purchases', item.purchases]].forEach(([series, amount]) => {
      const bar = createElement('div', { className: 'chart-bar' });
      const fill = createElement('div', { className: `chart-fill chart-fill-${series}`, 'data-series': series });
      fill.style.width = `${Math.min(100, Math.max(0, amount / maximum * 100))}%`;
      bar.append(fill); row.append(bar);
    });
    container.append(row);
  });
}

export function renderHomeDetail(container, items) {
  while (container.firstChild) container.removeChild(container.firstChild);
  (items || []).forEach((item) => {
    const row = createElement('div', { className: 'list-item' });
    const info = createElement('div', { className: 'flex-1' });
    info.append(createElement('div', { className: 'font-bold' }, item.customer || item.supplier || ''));
    info.append(createElement('div', { className: 'text-sm text-gray' }, `${item.product || ''} ${item.spec || ''}`));
    info.append(createElement('div', { className: 'text-sm text-gray' }, `${item.actualWeight ?? item.weight ?? 0}斤 × ¥${item.price ?? 0}/斤 · ${item.date || ''}`));
    const status = createElement('div', { className: 'text-xs text-gray-light' }, item.status || '');
    info.append(status); row.append(info, createElement('div', { className: 'text-xl font-bold text-blue' }, `¥${Number(item.amount || 0).toFixed(2)}`)); container.append(row);
  });
}
