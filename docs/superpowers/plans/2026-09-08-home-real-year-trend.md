# 首页真实年度趋势图实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除首页伪造金额，扩展现有首页统计接口，用飞书真实订单与进货数据展示当年 1 月至当前月趋势，并在无数据时明确显示空状态。

**Architecture:** Worker 在现有 `/api/stats/home` 一次飞书读取中同时计算统计卡片和 `yearTrend`，前端首页使用安全 DOM 渲染月度销售与进货柱形。HTML 不保留任何示例经营数据；旧响应、空数据和非法金额统一降级为“暂无经营数据”。

**Tech Stack:** 原生 HTML/CSS/ES modules、Cloudflare Workers、飞书多维表格、Vitest、Playwright

---

## 文件结构

- Modify: `worker/services/statistics.js` — 计算当年连续月份及真实销售/进货月度合计。
- Modify: `tests/worker/statistics-service.test.js` — 锁定趋势统计口径、年份边界和空数据行为。
- Modify: `index.html` — 删除固定示例金额和无效按钮，提供动态趋势容器。
- Modify: `assets/js/pages/home.js` — 清洗并渲染真实趋势或空状态。
- Modify: `assets/css/components.css` — 为动态图表金额、双系列柱形和空状态提供样式。
- Modify: `assets/css/responsive.css` — 限制手机端月份金额标签宽度，防止横向溢出。
- Modify: `tests/frontend/pages-quality.test.js` — 验证真实趋势渲染、非法数据降级和首页加载接线。
- Modify: `tests/frontend/assets-structure.test.js` — 防止固定示例金额回归到静态页面。
- Modify: `tests/e2e/mock-api.js` — 让浏览器测试的首页接口返回真实口径的 `yearTrend`。
- Create: `tests/e2e/home-trend.spec.js` — 验证有数据与无数据页面，并检查手机/桌面无横向溢出。

### Task 1: Worker 返回当年真实月度趋势

**Files:**
- Modify: `tests/worker/statistics-service.test.js`
- Modify: `worker/services/statistics.js`

- [ ] **Step 1: 写入失败的后端趋势测试**

在 `tests/worker/statistics-service.test.js` 的 `describe` 中增加：

```javascript
  it('returns real monthly sales and purchases from January through the requested month', async () => {
    const orders = [
      { record_id: 'o1', fields: { 日期: '2026-01-08', 金额: 100.125, 状态: '未结算' } },
      { record_id: 'o2', fields: { 日期: '2026-01-09', 金额: 20.125, 状态: '已结算' } },
      { record_id: 'o3', fields: { 日期: '2026-02-01', 金额: 900, 状态: '未开单' } },
      { record_id: 'o4', fields: { 日期: '2025-01-08', 金额: 700, 状态: '已结算' } },
      { record_id: 'o5', fields: { 日期: 'invalid', 金额: 800, 状态: '已结算' } }
    ];
    const purchases = [
      { record_id: 'p1', fields: { 日期: '2026-02-12', 金额: 50.555 } },
      { record_id: 'p2', fields: { 日期: '2027-02-12', 金额: 999 } },
      { record_id: 'p3', fields: { 日期: '', 金额: 888 } }
    ];
    const feishu = {
      listAllRecords: async (tableId) => tableId === 'orders' ? orders : purchases
    };
    const service = createStatisticsService(feishu, {
      TABLE_ORDERS: 'orders',
      TABLE_PURCHASES: 'purchases'
    });

    const result = await service.home('2026-03-15');

    expect(result.yearTrend).toEqual([
      { month: '2026-01', sales: 120.25, purchases: 0 },
      { month: '2026-02', sales: 0, purchases: 50.56 },
      { month: '2026-03', sales: 0, purchases: 0 }
    ]);
  });

  it('returns continuous zero-valued months when the year has no business data', async () => {
    const feishu = { listAllRecords: async () => [] };
    const service = createStatisticsService(feishu, {
      TABLE_ORDERS: 'orders',
      TABLE_PURCHASES: 'purchases'
    });

    await expect(service.home('2026-02-08')).resolves.toMatchObject({
      yearTrend: [
        { month: '2026-01', sales: 0, purchases: 0 },
        { month: '2026-02', sales: 0, purchases: 0 }
      ]
    });
  });
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `npm run test:worker -- tests/worker/statistics-service.test.js`

Expected: FAIL，`result.yearTrend` 为 `undefined`。

- [ ] **Step 3: 实现最小月度汇总函数并接入现有响应**

在 `worker/services/statistics.js` 的 `isSale` 后增加：

```javascript
export function buildYearTrend(orders, purchases, date) {
  const year = date.slice(0, 4);
  const currentMonth = Number(date.slice(5, 7));
  const trend = Array.from({ length: currentMonth }, (_, index) => ({
    month: `${year}-${String(index + 1).padStart(2, '0')}`,
    sales: 0,
    purchases: 0
  }));
  const byMonth = new Map(trend.map((item) => [item.month, item]));

  for (const order of orders) {
    const item = isSale(order) ? byMonth.get(order.date.slice(0, 7)) : null;
    if (item) item.sales += order.amount;
  }
  for (const purchase of purchases) {
    const item = byMonth.get(purchase.date.slice(0, 7));
    if (item) item.purchases += purchase.amount;
  }

  return trend.map((item) => ({
    month: item.month,
    sales: round(item.sales),
    purchases: round(item.purchases)
  }));
}
```

在 `home(date)` 返回值中加入：

```javascript
      yearTrend: buildYearTrend(orders, purchases, date)
```

- [ ] **Step 4: 运行后端测试并确认通过**

Run: `npm run test:worker -- tests/worker/statistics-service.test.js`

Expected: PASS，4 个统计服务测试全部通过。

- [ ] **Step 5: 提交 Worker 趋势统计**

```bash
git add worker/services/statistics.js tests/worker/statistics-service.test.js
git commit -m "fix: return real home year trend"
```

### Task 2: 前端渲染真实数据与明确空状态

**Files:**
- Modify: `tests/frontend/pages-quality.test.js`
- Modify: `assets/js/pages/home.js`

- [ ] **Step 1: 写入失败的前端渲染测试**

把 `tests/frontend/pages-quality.test.js` 的首页模块导入改为：

```javascript
import {
  createHomePage,
  getHomeDetailConfig,
  renderHomeDetail,
  renderYearTrend
} from '../../assets/js/pages/home.js';
```

在 `describe` 中增加：

```javascript
  it('renders real year trend amounts with proportional sales and purchase bars', () => {
    const container = document.createElement('div');
    renderYearTrend(container, [
      { month: '2026-01', sales: 200, purchases: 100 },
      { month: '2026-02', sales: 0, purchases: 50 }
    ]);

    expect(container.textContent).toContain('1月');
    expect(container.textContent).toContain('销售 ¥200.00');
    expect(container.textContent).toContain('进货 ¥100.00');
    expect(container.textContent).not.toContain('暂无经营数据');
    expect(container.querySelector('[data-series="sales"]').style.width).toBe('100%');
    expect(container.querySelector('[data-series="purchases"]').style.width).toBe('50%');
  });

  it.each([
    undefined,
    [],
    [{ month: '2026-01', sales: 0, purchases: 0 }],
    [{ month: '2026-01', sales: -10, purchases: Number.NaN }]
  ])('shows a no-data state for missing, zero, or invalid trend values', (trend) => {
    const container = document.createElement('div');
    renderYearTrend(container, trend);

    expect(container.textContent).toBe('暂无经营数据');
    expect(container.querySelector('.chart-row')).toBeNull();
  });

  it('updates dashboard cards and year trend from one home request', async () => {
    document.body.innerHTML = `
      <section id="page-home">
        <div class="stat-card"></div><div class="stat-card"></div>
        <div class="stat-card"></div><div class="stat-card"></div>
        <div class="quick-card"></div>
        <div id="home-today-sales"></div><div id="home-deal-count"></div>
        <div id="home-today-purchase"></div><div id="home-month-sales"></div>
        <div id="home-year-trend"></div>
      </section>
      <section id="page-stat-detail"><button class="back-btn"></button></section>
      <div id="stat-detail-summary"></div><div id="stat-detail-title"></div>
      <div id="stat-detail-icon"></div><div id="stat-detail-list"></div>
      <div id="loading-overlay"><div id="loading-text"></div></div>
    `;
    const response = {
      todaySales: 100,
      todayDealCount: 1,
      todayPurchase: 60,
      monthSales: 100,
      yearTrend: [{ month: '2026-09', sales: 100, purchases: 60 }]
    };
    const get = vi.fn().mockResolvedValue(response);
    const home = createHomePage({ api: { get }, today: () => '2026-09-08' });

    await home.enter();

    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith('/api/stats/home?date=2026-09-08');
    expect(document.getElementById('home-today-sales').textContent).toBe('¥100.00');
    expect(document.getElementById('home-year-trend').textContent).toContain('销售 ¥100.00');
  });
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `npm run test:frontend -- tests/frontend/pages-quality.test.js`

Expected: FAIL，`renderYearTrend` 尚未导出。

- [ ] **Step 3: 实现安全的趋势清洗与 DOM 渲染**

在 `assets/js/pages/home.js` 中加入：

```javascript
function trendAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function trendBar(label, series, value, maximum) {
  const track = createElement('div', {
    className: 'chart-bar',
    'aria-label': `${label} ${pageMoney(value)}`
  });
  const fill = createElement('div', {
    className: `chart-fill chart-fill-${series}`,
    'data-series': series
  });
  fill.style.width = `${Math.min(100, (value / maximum) * 100)}%`;
  track.append(fill);
  return track;
}

export function renderYearTrend(container, trend) {
  while (container.firstChild) container.removeChild(container.firstChild);
  const rows = Array.isArray(trend) ? trend.map((item) => ({
    month: typeof item?.month === 'string' ? item.month : '',
    sales: trendAmount(item?.sales),
    purchases: trendAmount(item?.purchases)
  })) : [];
  const maximum = Math.max(0, ...rows.flatMap((item) => [item.sales, item.purchases]));
  if (!rows.length || maximum === 0) {
    container.append(createElement('div', { className: 'chart-empty', role: 'status' }, '暂无经营数据'));
    return;
  }

  for (const item of rows) {
    const monthNumber = Number(item.month.slice(5, 7));
    const row = createElement('div', { className: 'chart-row' });
    const label = createElement('div', { className: 'chart-label' });
    label.append(
      createElement('span', {}, Number.isInteger(monthNumber) && monthNumber > 0 ? `${monthNumber}月` : item.month),
      createElement('span', { className: 'chart-amounts' }, `销售 ${pageMoney(item.sales)} · 进货 ${pageMoney(item.purchases)}`)
    );
    row.append(
      label,
      trendBar('销售金额', 'sales', item.sales, maximum),
      trendBar('进货金额', 'purchases', item.purchases, maximum)
    );
    container.append(row);
  }
}
```

把 `createHomePage` 内的 `enter` 改为：

```javascript
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
```

- [ ] **Step 4: 运行前端测试并确认通过**

Run: `npm run test:frontend -- tests/frontend/pages-quality.test.js`

Expected: PASS，新增的趋势渲染、空状态和单请求接线测试全部通过。

- [ ] **Step 5: 提交前端渲染逻辑**

```bash
git add assets/js/pages/home.js tests/frontend/pages-quality.test.js
git commit -m "fix: render real home year trend"
```

### Task 3: 删除静态伪造数据并完成响应式样式

**Files:**
- Modify: `tests/frontend/assets-structure.test.js`
- Modify: `index.html`
- Modify: `assets/css/components.css`
- Modify: `assets/css/responsive.css`

- [ ] **Step 1: 写入禁止示例经营数据回归的失败测试**

在 `tests/frontend/assets-structure.test.js` 中增加：

```javascript
  it('contains no hard-coded business amounts and exposes a dynamic year-trend container', () => {
    const html = read('index.html');

    expect(html).not.toContain('12,000');
    expect(html).not.toContain('8,500');
    expect(html).not.toContain('15,200');
    expect(html).not.toContain('查看更多');
    expect(html).toContain('id="home-year-trend"');
    expect(html).toContain('正在读取真实数据…');
  });
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `npm run test:frontend -- tests/frontend/assets-structure.test.js`

Expected: FAIL，当前 `index.html` 仍包含三个固定金额和“查看更多”。

- [ ] **Step 3: 把静态图表替换为动态容器**

把 `index.html` 中销售—进货图表卡片替换为：

```html
            <div class="card">
                <div class="card-header">
                    <div class="card-title"><span class="icon">📊</span> 当年销售—进货趋势（元）</div>
                </div>
                <div class="card-body">
                    <div class="chart-legend">
                        <div class="legend-item">
                            <div class="legend-dot chart-dot-sales"></div>
                            <span>销售金额</span>
                        </div>
                        <div class="legend-item">
                            <div class="legend-dot chart-dot-purchases"></div>
                            <span>进货金额</span>
                        </div>
                    </div>
                    <div id="home-year-trend">
                        <div class="chart-empty" role="status">正在读取真实数据…</div>
                    </div>
                </div>
            </div>
```

在 `assets/css/components.css` 的图表样式末尾增加：

```css
        .chart-dot-sales { background: #0ea5e9; }
        .chart-dot-purchases { background: #fb923c; }
        .chart-fill-sales { background: #0ea5e9; }
        .chart-fill-purchases { background: #fb923c; }
        .chart-amounts {
            margin-left: 16px;
            text-align: right;
            font-weight: 700;
        }
        .chart-empty {
            padding: 28px 16px;
            border: 1px dashed #cbd5e1;
            border-radius: 12px;
            color: #64748b;
            text-align: center;
        }
```

在 `assets/css/responsive.css` 末尾加入明确的手机断点：

```css
@media (max-width: 767px) {
            .chart-label {
                align-items: flex-start;
                gap: 8px;
            }
            .chart-amounts {
                max-width: 75%;
                overflow-wrap: anywhere;
            }
}
```

- [ ] **Step 4: 运行静态结构和前端测试**

Run: `npm run test:frontend`

Expected: PASS，全部前端测试通过且静态页面不包含示例经营金额。

- [ ] **Step 5: 提交 HTML 与样式修复**

```bash
git add index.html assets/css/components.css assets/css/responsive.css tests/frontend/assets-structure.test.js
git commit -m "fix: remove fabricated home chart data"
```

### Task 4: 浏览器级验证真实图表和空状态

**Files:**
- Modify: `tests/e2e/mock-api.js`
- Create: `tests/e2e/home-trend.spec.js`

- [ ] **Step 1: 写入失败的浏览器验收测试**

创建 `tests/e2e/home-trend.spec.js`：

```javascript
import { expect, test } from '@playwright/test';
import { expectNoProductionForward, installMockApi } from './mock-api.js';

async function login(page) {
  await page.goto('/');
  await page.getByLabel('店铺密码').fill('correct-shop-password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.locator('#app-container')).toBeVisible();
}

test('shows real current-year amounts without fabricated values', async ({ page }) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const mock = await installMockApi(page, {
    orders: [{ id: 'X1', date: `${year}-${month}-01`, amount: 200, status: 'unsettled' }],
    purchases: [{ id: 'P1', date: `${year}-${month}-02`, amount: 80 }]
  });

  await login(page);

  const trend = page.locator('#home-year-trend');
  await expect(trend).toContainText(`${Number(month)}月`);
  await expect(trend).toContainText('销售 ¥200.00');
  await expect(trend).toContainText('进货 ¥80.00');
  await expect(trend).not.toContainText('12,000');
  await expect(trend).not.toContainText('8,500');
  await expect(trend).not.toContainText('15,200');
  expectNoProductionForward(expect, mock);
});

test('shows a no-data state without horizontal overflow', async ({ page }) => {
  const mock = await installMockApi(page, { orders: [], purchases: [] });

  await login(page);

  await expect(page.locator('#home-year-trend')).toHaveText('暂无经营数据');
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
  expectNoProductionForward(expect, mock);
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `npm run test:e2e -- tests/e2e/home-trend.spec.js`

Expected: FAIL，测试 API 尚未返回 `yearTrend`，有数据场景会显示“暂无经营数据”。

- [ ] **Step 3: 让浏览器测试 API 使用同一年度口径**

在 `tests/e2e/mock-api.js` 的首页统计分支中，计算并返回趋势：

```javascript
      const currentMonth = Number(date.slice(5, 7));
      const year = date.slice(0, 4);
      const yearTrend = Array.from({ length: currentMonth }, (_, index) => {
        const monthKey = `${year}-${String(index + 1).padStart(2, '0')}`;
        return {
          month: monthKey,
          sales: state.orders
            .filter((order) => order.date.startsWith(monthKey) && ['unsettled', 'settled'].includes(order.status))
            .reduce((sum, order) => sum + Number(order.amount || 0), 0),
          purchases: state.purchases
            .filter((purchase) => purchase.date.startsWith(monthKey))
            .reduce((sum, purchase) => sum + Number(purchase.amount || 0), 0)
        };
      });
```

在同一分支的返回对象中加入：

```javascript
        yearTrend
```

- [ ] **Step 4: 运行浏览器测试并确认通过**

Run: `npm run test:e2e -- tests/e2e/home-trend.spec.js`

Expected: PASS，桌面和手机项目中的有数据、无数据场景全部通过。

- [ ] **Step 5: 提交浏览器验收覆盖**

```bash
git add tests/e2e/mock-api.js tests/e2e/home-trend.spec.js
git commit -m "test: cover real home year trend"
```

### Task 5: 完整验证与发布准备

**Files:**
- Verify: `index.html`
- Verify: `worker/services/statistics.js`
- Verify: `assets/js/pages/home.js`
- Verify: `tests/worker/statistics-service.test.js`
- Verify: `tests/frontend/pages-quality.test.js`
- Verify: `tests/frontend/assets-structure.test.js`
- Verify: `tests/e2e/home-trend.spec.js`

- [ ] **Step 1: 搜索并确认伪造金额已完全移除**

Run: `rg -n '12,000|8,500|15,200|width: 60%|width: 45%|width: 42%|width: 38%|width: 76%|width: 58%' index.html assets tests`

Expected: 无输出。

- [ ] **Step 2: 运行完整自动测试**

Run: `npm run check`

Expected: frontend、worker、config 和 Playwright 全部通过；仅保留项目已有且有明确原因的生命周期跳过项。

- [ ] **Step 3: 验证 Pages 构建内容**

Run: `npm run build:pages`

Expected: `_site/index.html`、`_site/assets/js/pages/home.js` 和对应 CSS 存在，且 `_site/index.html` 不包含三个示例金额。

- [ ] **Step 4: 检查变更质量与工作区状态**

Run: `git diff --check && git status --short`

Expected: `git diff --check` 无输出；工作区仅包含本计划范围内的已知变更，或在所有提交完成后为空。

- [ ] **Step 5: 请求代码审查并修复审查发现**

按 `requesting-code-review` 流程检查统计口径、空状态、前后端契约、移动端溢出和回归测试。若发现问题，先增加能复现问题的失败测试，再做最小修复并重新运行 `npm run check`。

- [ ] **Step 6: 准备发布说明**

发布说明必须包含：QA-01 已修复、趋势范围为当年 1 月至当前月、销售与进货口径、无数据空状态、五张表无字段或数据迁移，以及完整测试结果。发布到 `main` 和生产环境必须另行确认，不在本步骤自动执行。
