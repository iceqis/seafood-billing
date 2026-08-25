// @vitest-environment node

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const SESSION_KEY = 'seafood_billing_session';
const originalGlobals = new Map();
let activeDom;

function apiResponse(data, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

function installGlobal(name, value) {
  if (!originalGlobals.has(name)) originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function installDeniedStorage() {
  if (!originalGlobals.has('localStorage')) {
    originalGlobals.set('localStorage', Object.getOwnPropertyDescriptor(globalThis, 'localStorage'));
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => { throw new DOMException('storage denied', 'SecurityError'); }
  });
}

async function createApp(fetchMock, sessionToken = '', seedState, options = {}) {
  const dom = new JSDOM(indexHtml, { url: 'https://allowed.example/' });
  activeDom = dom;
  dom.window.scrollTo = () => {};
  if (sessionToken) dom.window.localStorage.setItem(SESSION_KEY, sessionToken);
  installGlobal('window', dom.window);
  installGlobal('document', dom.window.document);
  if (options.storageDenied) installDeniedStorage();
  else installGlobal('localStorage', dom.window.localStorage);
  installGlobal('fetch', fetchMock);
  vi.resetModules();
  if (seedState) seedState((await import('../../assets/js/state.js')).state);
  const app = await import('../../assets/js/app.js');
  if (options.awaitReady !== false) await app.appReady;
  return { app, dom, document: dom.window.document };
}

afterEach(() => {
  activeDom?.window.close();
  activeDom = undefined;
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  originalGlobals.clear();
  vi.restoreAllMocks();
});

describe('frontend shared-shop login flow', () => {
  it('shows only login and does not initialize business data without a token', async () => {
    const fetchMock = vi.fn();
    const { document } = await createApp(fetchMock);

    expect(document.querySelector('#login-view').hidden).toBe(false);
    expect(document.querySelector('#app-container').hidden).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('restores a token and initializes once with Bearer authorization', async () => {
    const fetchMock = vi.fn(() => apiResponse({
      code: 0,
      message: 'success',
      data: { todaySales: 0, todayDealCount: 0, todayPurchase: 0, monthSales: 0 }
    }));
    const { document, dom } = await createApp(fetchMock, 'saved-token');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer saved-token');
    expect(document.querySelector('#login-view').hidden).toBe(true);
    expect(document.querySelector('#app-container').hidden).toBe(false);
    expect(dom.window.localStorage.getItem(SESSION_KEY)).toBe('saved-token');
  });

  it('clears the password immediately, saves only the token, and initializes once after login', async () => {
    let releaseLogin;
    const loginResponse = new Promise((resolve) => { releaseLogin = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => loginResponse)
      .mockImplementationOnce(() => apiResponse({
        code: 0,
        message: 'success',
        data: { todaySales: 0, todayDealCount: 0, todayPurchase: 0, monthSales: 0 }
      }));
    const { document, dom } = await createApp(fetchMock);

    document.querySelector('#login-password').value = 'shop-password';
    document.querySelector('#login-form').dispatchEvent(new dom.window.Event('submit', {
      bubbles: true,
      cancelable: true
    }));
    expect(document.querySelector('#login-password').value).toBe('');
    expect(JSON.stringify(dom.window.localStorage)).not.toContain('shop-password');

    releaseLogin(await apiResponse({
      code: 0,
      message: 'success',
      data: { token: 'fresh-token', expiresIn: 2592000 }
    }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(dom.window.localStorage.length).toBe(1);
    expect(dom.window.localStorage.getItem(SESSION_KEY)).toBe('fresh-token');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh-token');
    expect(document.querySelector('#login-view').hidden).toBe(true);
    expect(document.querySelector('#app-container').hidden).toBe(false);
  });

  it('does not retain the password when login fails', async () => {
    const fetchMock = vi.fn(() => apiResponse({ code: 401, message: '店铺密码错误', data: null }, 401));
    const { document, dom } = await createApp(fetchMock);

    document.querySelector('#login-password').value = 'wrong-password';
    document.querySelector('#login-form').dispatchEvent(new dom.window.Event('submit', {
      bubbles: true,
      cancelable: true
    }));
    expect(document.querySelector('#login-password').value).toBe('');
    await vi.waitFor(() => expect(document.querySelector('#login-message').textContent).toBe('店铺密码错误'));
    expect(dom.window.localStorage.length).toBe(0);
  });

  it('coalesces duplicate successful submits into one login and one initialization', async () => {
    let resolveLogin;
    const pendingLogin = new Promise((resolve) => { resolveLogin = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => pendingLogin)
      .mockImplementationOnce(() => apiResponse({
        code: 0,
        message: 'success',
        data: { todaySales: 0, todayDealCount: 0, todayPurchase: 0, monthSales: 0 }
      }));
    const { document, dom } = await createApp(fetchMock);
    const submit = () => document.querySelector('#login-form').dispatchEvent(new dom.window.Event('submit', {
      bubbles: true,
      cancelable: true
    }));

    document.querySelector('#login-password').value = 'shop-password';
    submit();
    submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveLogin(await apiResponse({
      code: 0,
      message: 'success',
      data: { token: 'single-token' }
    }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/api/auth/login'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('/api/stats/home'))).toHaveLength(1);
    expect(dom.window.localStorage.getItem(SESSION_KEY)).toBe('single-token');
  });

  it('releases the login lock after failure so a later retry can initialize', async () => {
    let resolveFirstLogin;
    const firstLogin = new Promise((resolve) => { resolveFirstLogin = resolve; });
    let loginCallCount = 0;
    const fetchMock = vi.fn((url) => {
      if (url.endsWith('/api/auth/login')) {
        loginCallCount += 1;
        if (loginCallCount === 1) return firstLogin;
        return apiResponse({ code: 0, message: 'success', data: { token: 'retry-token' } });
      }
      return apiResponse({
        code: 0,
        message: 'success',
        data: { todaySales: 0, todayDealCount: 0, todayPurchase: 0, monthSales: 0 }
      });
    });
    const { document, dom } = await createApp(fetchMock);
    const submit = () => document.querySelector('#login-form').dispatchEvent(new dom.window.Event('submit', {
      bubbles: true,
      cancelable: true
    }));

    document.querySelector('#login-password').value = 'shop-password';
    submit();
    submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirstLogin(await apiResponse({ code: 401, message: '店铺密码错误', data: null }, 401));
    await vi.waitFor(() => expect(document.querySelector('#login-submit').disabled).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    document.querySelector('#login-password').value = 'shop-password';
    submit();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(loginCallCount).toBe(2);
    expect(dom.window.localStorage.getItem(SESSION_KEY)).toBe('retry-token');
    expect(document.querySelector('#app-container').hidden).toBe(false);
  });

  it('supports a current-page login and logout when global storage access throws', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => apiResponse({
        code: 0,
        message: 'success',
        data: { token: 'memory-token' }
      }))
      .mockImplementationOnce(() => apiResponse({
        code: 0,
        message: 'success',
        data: { todaySales: 0, todayDealCount: 0, todayPurchase: 0, monthSales: 0 }
      }));
    const { document, dom } = await createApp(fetchMock, '', undefined, { storageDenied: true });

    expect(document.querySelector('#login-view').hidden).toBe(false);
    document.querySelector('#login-password').value = 'shop-password';
    document.querySelector('#login-form').dispatchEvent(new dom.window.Event('submit', {
      bubbles: true,
      cancelable: true
    }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer memory-token');
    expect(document.querySelector('#app-container').hidden).toBe(false);
    document.querySelector('#logout-button').click();
    expect(document.querySelector('#login-view').hidden).toBe(false);
    expect(document.querySelector('#app-container').hidden).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears all state and returns to login on a business 401', async () => {
    const fetchMock = vi.fn(() => apiResponse({ code: 401, message: '登录已过期', data: null }, 401));
    const { document, dom } = await createApp(fetchMock, 'expired-token', (state) => {
      state.customers = [{ id: 'customer' }];
      state.suppliers = [{ id: 'supplier' }];
      state.products = [{ id: 'product' }];
      state.orders = [{ id: 'order' }];
      state.purchases = [{ id: 'purchase' }];
      state.currentCustomer = '测试客户';
      state.selectedOrderIds.add('order');
    });
    const { state } = await import('../../assets/js/state.js');

    expect(dom.window.localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(document.querySelector('#login-message').textContent).toBe('登录已过期，请重新登录');
    expect(document.querySelector('#login-view').hidden).toBe(false);
    expect(document.querySelector('#app-container').hidden).toBe(true);
    expect(state).toMatchObject({
      customers: [], suppliers: [], products: [], orders: [], purchases: [], currentCustomer: ''
    });
    expect(state.selectedOrderIds.size).toBe(0);
  });

  it('can log in and initialize normally after an expired session', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => apiResponse({ code: 401, message: '登录已过期', data: null }, 401))
      .mockImplementationOnce(() => apiResponse({
        code: 0,
        message: 'success',
        data: { token: 'renewed-token', expiresIn: 2592000 }
      }))
      .mockImplementationOnce(() => apiResponse({
        code: 0,
        message: 'success',
        data: { todaySales: 0, todayDealCount: 0, todayPurchase: 0, monthSales: 0 }
      }));
    const { document, dom } = await createApp(fetchMock, 'expired-token');

    document.querySelector('#login-password').value = 'shop-password';
    document.querySelector('#login-form').dispatchEvent(new dom.window.Event('submit', {
      bubbles: true,
      cancelable: true
    }));
    expect(document.querySelector('#login-password').value).toBe('');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(dom.window.localStorage.getItem(SESSION_KEY)).toBe('renewed-token');
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer renewed-token');
    expect(document.querySelector('#login-view').hidden).toBe(true);
    expect(document.querySelector('#app-container').hidden).toBe(false);
  });

  it('logout clears state without issuing another business request', async () => {
    const fetchMock = vi.fn(() => apiResponse({
      code: 0,
      message: 'success',
      data: { todaySales: 0, todayDealCount: 0, todayPurchase: 0, monthSales: 0 }
    }));
    const { document, dom } = await createApp(fetchMock, 'saved-token');
    const { state } = await import('../../assets/js/state.js');
    state.customers = [{ id: 'customer' }];
    state.suppliers = [{ id: 'supplier' }];
    state.products = [{ id: 'product' }];
    state.orders = [{ id: 'order' }];
    state.purchases = [{ id: 'purchase' }];
    state.currentCustomer = '测试客户';
    state.selectedOrderIds.add('order');

    document.querySelector('#logout-button').click();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dom.window.localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(document.querySelector('#login-view').hidden).toBe(false);
    expect(document.querySelector('#app-container').hidden).toBe(true);
    expect(state).toMatchObject({
      customers: [], suppliers: [], products: [], orders: [], purchases: [], currentCustomer: ''
    });
    expect(state.selectedOrderIds.size).toBe(0);
  });

  it('ignores an old successful business response after logout', async () => {
    let resolveCustomers;
    const oldCustomers = new Promise((resolve) => { resolveCustomers = resolve; });
    const fetchMock = vi.fn((url) => {
      if (url.includes('/api/stats/home')) {
        return apiResponse({
          code: 0,
          message: 'success',
          data: { todaySales: 0, todayDealCount: 0, todayPurchase: 0, monthSales: 0 }
        });
      }
      if (url.endsWith('/api/customers')) return oldCustomers;
      return apiResponse({ code: 0, message: 'success', data: [] });
    });
    const { document, dom } = await createApp(fetchMock, 'old-token');
    const { state } = await import('../../assets/js/state.js');

    document.querySelector('.nav-btn[data-page="customers"]').click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    document.querySelector('#logout-button').click();
    resolveCustomers(await apiResponse({
      code: 0,
      message: 'success',
      data: [{ id: 'old-customer', name: '旧客户' }]
    }));
    await Promise.resolve();

    expect(state.customers).toEqual([]);
    expect(state.orders).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(document.querySelector('#toast').classList.contains('show')).toBe(false);
    expect(document.querySelector('#login-view').hidden).toBe(false);
  });

  it('does not let an old delayed 401 clear a newly logged-in session', async () => {
    let resolveOldRequest;
    const oldRequest = new Promise((resolve) => { resolveOldRequest = resolve; });
    let statsCalls = 0;
    const fetchMock = vi.fn((url) => {
      if (url.includes('/api/stats/home')) {
        statsCalls += 1;
        return apiResponse({
          code: 0,
          message: 'success',
          data: { todaySales: statsCalls, todayDealCount: 0, todayPurchase: 0, monthSales: 0 }
        });
      }
      if (url.endsWith('/api/customers')) return oldRequest;
      if (url.endsWith('/api/auth/login')) {
        return apiResponse({ code: 0, message: 'success', data: { token: 'new-token' } });
      }
      return apiResponse({ code: 0, message: 'success', data: [] });
    });
    const { document, dom } = await createApp(fetchMock, 'old-token');

    document.querySelector('.nav-btn[data-page="customers"]').click();
    document.querySelector('#logout-button').click();
    document.querySelector('#login-password').value = 'shop-password';
    document.querySelector('#login-form').dispatchEvent(new dom.window.Event('submit', {
      bubbles: true,
      cancelable: true
    }));
    await vi.waitFor(() => expect(dom.window.localStorage.getItem(SESSION_KEY)).toBe('new-token'));
    await vi.waitFor(() => expect(document.querySelector('#app-container').hidden).toBe(false));

    resolveOldRequest(await apiResponse({ code: 401, message: '旧会话已过期', data: null }, 401));
    await Promise.resolve();

    expect(dom.window.localStorage.getItem(SESSION_KEY)).toBe('new-token');
    expect(document.querySelector('#login-view').hidden).toBe(true);
    expect(document.querySelector('#app-container').hidden).toBe(false);
    expect(document.querySelector('#login-message').textContent).toBe('');
  });

  it('uses delegated module events instead of inline handler globals', async () => {
    const { dom } = await createApp(vi.fn());
    expect(indexHtml).not.toMatch(/\bon(?:click|input|change|submit)=/i);
    expect(dom.window.goPage).toBeUndefined();
  });
});
