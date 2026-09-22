import { expect, test } from '@playwright/test';
import { expectNoProductionForward, installMockApi } from './mock-api.js';

function currentMonthDates() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return {
    month: now.getMonth() + 1,
    orderDate: `${year}-${month}-01`,
    purchaseDate: `${year}-${month}-02`
  };
}

async function login(page) {
  await page.goto('/');
  await page.getByLabel('店铺密码').fill('correct-shop-password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.locator('#app-container')).toBeVisible();
}

test('renders the current month home trend from seeded records', async ({ page }) => {
  const { month, orderDate, purchaseDate } = currentMonthDates();
  const mock = await installMockApi(page, {
    orders: [{ id: 'XSD001', date: orderDate, amount: 200, status: 'unsettled' }],
    purchases: [{ id: 'CGD001', date: purchaseDate, amount: 80 }]
  });

  await login(page);

  const trend = page.locator('#home-year-trend');
  await expect(trend).toContainText(`${month}月`);
  await expect(trend).toContainText('销售 ¥200.00');
  await expect(trend).toContainText('进货 ¥80.00');
  await expect(trend).not.toContainText('12,000');
  await expect(trend).not.toContainText('8,500');
  await expect(trend).not.toContainText('15,200');
  expectNoProductionForward(expect, mock);
});

test('shows an empty home trend without seeded records and avoids overflow', async ({ page }) => {
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
