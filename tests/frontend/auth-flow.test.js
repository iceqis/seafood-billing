// @vitest-environment node

import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const SESSION_KEY = 'seafood_billing_session';

function apiResponse(data, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data
  });
}

function createApp(fetchMock, sessionToken) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(indexHtml, {
    runScripts: 'dangerously',
    url: 'https://allowed.example/',
    virtualConsole,
    beforeParse(window) {
      window.fetch = fetchMock;
      window.scrollTo = () => {};
      if (sessionToken) window.localStorage.setItem(SESSION_KEY, sessionToken);
    }
  });
  return dom;
}

async function waitFor(check) {
  await vi.waitFor(check, { timeout: 1500, interval: 10 });
}

describe('frontend shared-shop login flow', () => {
  it('shows only the login view and does not initialize without a saved session', async () => {
    const fetchMock = vi.fn();
    const dom = createApp(fetchMock);

    expect(dom.window.document.querySelector('#login-view').hidden).toBe(false);
    expect(dom.window.document.querySelector('#app-container').hidden).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    dom.window.close();
  });

  it('restores a saved session and authenticates initialization requests', async () => {
    const fetchMock = vi.fn(() => apiResponse({
      code: 0,
      data: { todaySales: 0, todayDealCount: 0, todayPurchase: 0, monthSales: 0 }
    }));
    const dom = createApp(fetchMock, 'saved-token');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(dom.window.document.querySelector('#loading-overlay').getAttribute('aria-busy')).toBe('false');
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(new dom.window.Headers(init.headers).get('Authorization')).toBe('Bearer saved-token');
    expect(dom.window.document.querySelector('#login-view').hidden).toBe(true);
    expect(dom.window.document.querySelector('#app-container').hidden).toBe(false);
    dom.window.close();
  });

  it('logs in, saves the token, reveals the app, and initializes with Bearer auth', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => apiResponse({
        code: 0,
        data: { token: 'fresh-token', expiresIn: 2592000 }
      }))
      .mockImplementationOnce(() => apiResponse({
        code: 0,
        data: { todaySales: 0, todayDealCount: 0, todayPurchase: 0, monthSales: 0 }
      }));
    const dom = createApp(fetchMock);
    const document = dom.window.document;

    document.querySelector('#login-password').value = 'shop-password';
    document.querySelector('#login-form').dispatchEvent(new dom.window.Event('submit', {
      bubbles: true,
      cancelable: true
    }));

    expect(document.querySelector('#login-password').value).toBe('');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(document.querySelector('#login-submit').disabled).toBe(false);
    });
    expect(dom.window.localStorage.getItem(SESSION_KEY)).toBe('fresh-token');
    expect(document.querySelector('#login-view').hidden).toBe(true);
    expect(document.querySelector('#app-container').hidden).toBe(false);
    expect(new dom.window.Headers(fetchMock.mock.calls[1][1].headers).get('Authorization'))
      .toBe('Bearer fresh-token');
    dom.window.close();
  });

  it('clears an expired session and returns to login on any 401', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: false,
      status: 401,
      json: async () => { throw new SyntaxError('invalid upstream body'); }
    }));
    const dom = createApp(fetchMock, 'expired-token');
    const document = dom.window.document;

    await waitFor(() => {
      expect(dom.window.localStorage.getItem(SESSION_KEY)).toBeNull();
      expect(document.querySelector('#login-message').textContent)
        .toBe('登录已过期，请重新登录');
    });
    expect(document.querySelector('#login-view').hidden).toBe(false);
    expect(document.querySelector('#app-container').hidden).toBe(true);
    dom.window.close();
  });
});
