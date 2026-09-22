import { expect, test } from '@playwright/test';
import { expectNoProductionForward, installMockApi } from './mock-api.js';

async function login(page) {
  await page.goto('/');
  await page.getByLabel('店铺密码').fill('correct-shop-password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.locator('#app-container')).toBeVisible();
}

test('renders the current month home trend from seeded records', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-12-15T04:00:00Z'));
  const mock = await installMockApi(page, {
    orders: [{ id: 'XSD001', date: '2026-12-01', amount: 1234567.89, status: 'unsettled' }],
    purchases: [{ id: 'CGD001', date: '2026-12-02', amount: 987654.32 }]
  });

  await login(page);

  const trend = page.locator('#home-year-trend');
  await expect(trend).toContainText('12月');
  await expect(trend).toContainText('销售 ¥1234567.89');
  await expect(trend).toContainText('进货 ¥987654.32');
  await expect(trend).not.toContainText('12,000');
  await expect(trend).not.toContainText('8,500');
  await expect(trend).not.toContainText('15,200');
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
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
