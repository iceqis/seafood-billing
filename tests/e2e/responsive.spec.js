import { expect, test } from '@playwright/test';
import { expectNoProductionForward, installMockApi } from './mock-api.js';

async function expectNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
}

async function expectActionable(button) {
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await button.click({ trial: true });
}

async function expectVisibleFormAssociations(page) {
  const failures = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const active = document.querySelector('.page-section.active');
    const controls = [...active.querySelectorAll('input, select, textarea')].filter(visible);
    const labels = [...active.querySelectorAll('label')].filter(visible);
    const controlFailures = controls.filter((control) => control.labels?.length === 0).map((control) => `${control.tagName.toLowerCase()}#${control.id || '(missing-id)'}`);
    const labelFailures = labels.filter((label) => !label.control).map((label) => `label:${label.textContent.trim()}`);
    return [...controlFailures, ...labelFailures];
  });
  expect(failures, '所有可见表单控件和 label 必须通过 for/id 或嵌套关联').toEqual([]);
}

async function navigate(page, projectName, name) {
  if (projectName === 'mobile') {
    const mobileNames = { '首页': '🏠 首页', '预订单': '📝 预订单', '进货单': '🚚 进货单', '订单': '📋 订单', '客户': '👥 客户', '商品': '📦 商品', '我的': '👤 我的' };
    const menuButton = page.getByRole('button', { name: '打开导航菜单' });
    await menuButton.click();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#mobile-menu').getByRole('button', { name: mobileNames[name], exact: true }).click();
    await expect(page.locator('#mobile-menu')).not.toHaveClass(/show/);
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  } else {
    await page.locator('.desktop-nav').getByRole('button', { name, exact: true }).click();
  }
}

test('keeps primary actions usable, responsive, and accessibly labelled', async ({ page }, testInfo) => {
  const mock = await installMockApi(page);
  await page.goto('/');

  const loginButton = page.getByRole('button', { name: '登录' });
  await expectActionable(loginButton);
  await page.getByLabel('店铺密码').fill('correct-shop-password');
  await loginButton.click();
  await expect(page.locator('#app-container')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await navigate(page, testInfo.project.name, '预订单');
  await expectActionable(page.getByRole('button', { name: /保存预订单/ }));
  await expectVisibleFormAssociations(page);
  await expectNoHorizontalOverflow(page);

  await navigate(page, testInfo.project.name, '进货单');
  await expectActionable(page.getByRole('button', { name: /保存进货单/ }));
  await expectActionable(page.getByRole('button', { name: /添加供应商/ }));
  await expectVisibleFormAssociations(page);
  await expectNoHorizontalOverflow(page);

  await navigate(page, testInfo.project.name, '订单');
  await expectActionable(page.getByRole('button', { name: /新建预订单/ }));
  await expectVisibleFormAssociations(page);
  await expectNoHorizontalOverflow(page);

  await navigate(page, testInfo.project.name, '客户');
  const addCustomer = page.getByRole('button', { name: /添加客户/ });
  await expectActionable(addCustomer);
  await expectVisibleFormAssociations(page);
  await addCustomer.click();
  await expect(page.getByLabel('客户名称')).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();
  await expectNoHorizontalOverflow(page);

  await navigate(page, testInfo.project.name, '商品');
  await expectActionable(page.getByRole('button', { name: /添加商品/ }));
  await expectNoHorizontalOverflow(page);

  await navigate(page, testInfo.project.name, '我的');
  await expectActionable(page.getByRole('button', { name: '退出登录' }));
  await expectNoHorizontalOverflow(page);

  expect(JSON.stringify(mock.requests.map((request) => request.body))).not.toContain('correct-shop-password');
  expectNoProductionForward(expect, mock);
});
