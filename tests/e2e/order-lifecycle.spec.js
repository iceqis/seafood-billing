import { expect, test } from '@playwright/test';
import { expectNoProductionForward, installMockApi } from './mock-api.js';

test('completes the five-state order lifecycle without production requests', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', '完整重流程只在桌面项目执行，响应式验收覆盖双项目');
  const mock = await installMockApi(page);
  await page.goto('/');

  await page.getByLabel('店铺密码').fill('wrong-password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('alert')).toHaveText('店铺密码错误');

  await page.getByLabel('店铺密码').fill('correct-shop-password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.locator('#app-container')).toBeVisible();

  await page.getByRole('button', { name: '预订单', exact: true }).click();
  const preorderPage = page.locator('#page-preorder');
  await preorderPage.getByLabel('👤 客户').selectOption('海鲜酒楼');
  await preorderPage.getByLabel('选择商品').selectOption('基围虾');
  await preorderPage.getByRole('button', { name: '30头', exact: true }).click();
  await preorderPage.getByLabel('报货重量(斤)', { exact: true }).fill('5');
  await preorderPage.getByRole('button', { name: /保存预订单/ }).click();

  const ordersPage = page.locator('#page-orders');
  await expect(ordersPage).toHaveClass(/active/);
  await expect(ordersPage).toContainText('待发货');
  await ordersPage.getByRole('button', { name: '去发货' }).click();
  await page.getByLabel('实际重量(斤)').fill('5');
  await page.getByRole('button', { name: '确认发货' }).click();
  await expect(ordersPage).toContainText('已发货');

  await ordersPage.getByRole('button', { name: '去定价' }).click();
  await page.getByLabel('单价(元/斤)', { exact: true }).fill('20');
  await page.getByRole('button', { name: '确认定价' }).click();
  await expect(ordersPage.getByText('海鲜酒楼')).toHaveCount(0);

  await page.getByRole('button', { name: '客户', exact: true }).click();
  await page.locator('#page-customers').getByRole('button', { name: '查看订单' }).click();
  const customerOrders = page.locator('#page-customer-orders');
  const checkbox = customerOrders.getByRole('checkbox', { name: /基围虾 30头/ });
  await checkbox.check();
  page.once('dialog', (dialog) => dialog.accept());
  await customerOrders.getByRole('button', { name: '统一开单' }).click();
  await expect(customerOrders).toContainText('未结算');

  await customerOrders.getByRole('checkbox', { name: /基围虾 30头/ }).check();
  page.once('dialog', (dialog) => dialog.accept());
  await customerOrders.getByRole('button', { name: '结算选中' }).click();
  await expect(customerOrders).toContainText('已结算');

  await page.getByRole('button', { name: '首页', exact: true }).click();
  await expect(page.locator('#home-deal-count')).toHaveText('1');
  await expect(page.locator('#home-today-sales')).toHaveText('¥100.00');

  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.locator('#login-view')).toBeVisible();
  await expect(page.locator('#app-container')).toBeHidden();

  expect(mock.transitions).toEqual(['pending_ship', 'shipped', 'pending_bill', 'unsettled', 'settled']);
  expect(mock.requests.filter((request) => request.path !== '/api/auth/login' && request.path !== '/api/health').every((request) => request.authorization === `Bearer ${mock.token}`)).toBe(true);
  expect(mock.requests.some((request) => request.method === 'PUT' && request.path.endsWith('/ship'))).toBe(true);
  expect(mock.requests.some((request) => request.method === 'PUT' && request.path.endsWith('/price'))).toBe(true);
  expect(mock.requests.some((request) => request.method === 'POST' && request.path === '/api/orders/bill')).toBe(true);
  expect(mock.requests.some((request) => request.method === 'POST' && request.path === '/api/orders/settle')).toBe(true);
  expectNoProductionForward(expect, mock);
});
