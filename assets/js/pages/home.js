import { createElement } from '../utils.js';
import { createPageFactory } from './factory.js';

export function createHomePage(deps) {
  const page = createPageFactory(deps);
  async function enter() {
    const trendContainer = page.byId('home-year-trend');
    const requestDate = page.today();
    renderTrendStatus(trendContainer, '正在读取真实数据…', 'chart-status');
    const stats = await page.api.get(`/api/stats/home?date=${requestDate}`) || {};
    page.setText(page.byId('home-today-sales'), page.money(stats.todaySales));
    page.setText(page.byId('home-deal-count'), stats.todayDealCount || 0);
    page.setText(page.byId('home-today-purchase'), page.money(stats.todayPurchase));
    page.setText(page.byId('home-month-sales'), page.money(stats.monthSales));
    renderYearTrend(trendContainer, stats.yearTrend, requestDate);
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

function trendAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function trendPeriod(requestDate) {
  if (typeof requestDate !== 'string') return null;
  const match = requestDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(`${requestDate}T00:00:00.000Z`);
  return date.toISOString().slice(0, 10) === requestDate ? { year: match[1], month } : null;
}

function trendMonth(month, period) {
  if (typeof month !== 'string' || !period) return null;
  const match = month.match(/^(\d{4})-(\d{2})$/);
  const number = Number(match?.[2]);
  return match?.[1] === period.year && number >= 1 && number <= period.month ? number : null;
}

function renderTrendStatus(container, text, className = 'chart-empty') {
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  const status = createElement('div', { className }, text);
  status.setAttribute('role', 'status');
  container.append(status);
}

export function renderYearTrend(container, trend, requestDate) {
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);

  const period = trendPeriod(requestDate);
  const rows = period && Array.isArray(trend) ? trend.map((item) => ({
    month: trendMonth(item?.month, period),
    sales: trendAmount(item?.sales),
    purchases: trendAmount(item?.purchases)
  })).filter((item) => item.month !== null) : [];
  const maximum = Math.max(0, ...rows.flatMap((item) => [item.sales, item.purchases]));
  if (!rows.length || maximum === 0) {
    renderTrendStatus(container, '暂无经营数据');
    return;
  }

  rows.forEach((item) => {
    const row = createElement('div', { className: 'chart-row' });
    const label = createElement('div', { className: 'chart-label' }, `${item.month}月`);
    label.append(createElement('div', { className: 'chart-amounts' }, `销售 ¥${item.sales.toFixed(2)} · 进货 ¥${item.purchases.toFixed(2)}`));
    row.append(label);
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
