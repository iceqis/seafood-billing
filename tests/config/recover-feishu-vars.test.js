import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEISHU_VARIABLE_NAMES,
  recoverFeishuVariables
} from '../../scripts/recover-feishu-vars.js';

const accountId = 'account-id';
const scriptName = 'seafood-billing-api';
const sourceVersionId = 'b01f1b84-1111-2222-3333-444444444444';

function jsonResponse(result, success = true) {
  return new Response(JSON.stringify({ success, result, errors: success ? [] : [{ message: 'failed' }] }), {
    status: success ? 200 : 400,
    headers: { 'content-type': 'application/json' }
  });
}

function sourceBindings(overrides = {}) {
  return FEISHU_VARIABLE_NAMES.map((name, index) => ({
    name,
    type: 'plain_text',
    text: overrides[name] ?? `private-value-${index + 1}`
  }));
}

test('restores only the seven allow-listed Feishu variables while inheriting current bindings', async () => {
  const calls = [];
  const logs = [];
  const recovered = sourceBindings();
  const currentBindings = [
    { name: 'ALLOWED_ORIGINS', type: 'plain_text', text: 'https://iceqis.github.io' },
    { name: 'APP_VERSION', type: 'plain_text', text: '3.2.0' },
    { name: 'AUTH_SECRET', type: 'secret_text' },
    { name: 'SHOP_PASSWORD_HASH', type: 'secret_text' },
    { name: 'SHOP_PASSWORD_SALT', type: 'secret_text' },
    { name: 'FEISHU_APP_SECRET', type: 'secret_text' },
    { name: 'LOGIN_RATE_LIMITER', type: 'ratelimit' }
  ];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });

    if (url.endsWith('/versions?per_page=100')) {
      return jsonResponse({ items: [{ id: sourceVersionId }] });
    }
    if (url.endsWith(`/versions/${sourceVersionId}`)) {
      return jsonResponse({ resources: { bindings: [...recovered, { name: 'IGNORED', type: 'plain_text', text: 'do-not-copy' }] } });
    }
    if (url.endsWith('/settings') && options.method === 'PATCH') {
      return jsonResponse({ bindings: [...currentBindings, ...recovered] });
    }
    if (url.endsWith('/settings')) {
      const settingsReads = calls.filter((call) => call.url.endsWith('/settings') && !call.options.method).length;
      return jsonResponse({ bindings: settingsReads === 1 ? currentBindings : [...currentBindings, ...recovered] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await recoverFeishuVariables({
    accountId,
    apiToken: 'token-value',
    fetchImpl,
    log: (message) => logs.push(message),
    scriptName,
    sourceVersionPrefix: 'b01f1b84'
  });

  assert.deepEqual(result, { restoredCount: 7, sourceVersionId });
  const patchCall = calls.find((call) => call.options.method === 'PATCH');
  assert.ok(patchCall);
  assert.equal(patchCall.options.headers.Authorization, 'Bearer token-value');
  const settings = JSON.parse(patchCall.options.body.get('settings'));
  assert.deepEqual(
    settings.bindings.slice(0, currentBindings.length),
    currentBindings.map(({ name }) => ({ name, type: 'inherit' }))
  );
  assert.deepEqual(settings.bindings.slice(currentBindings.length), recovered);
  assert.doesNotMatch(JSON.stringify(settings), /do-not-copy/);
  assert.doesNotMatch(logs.join('\n'), /private-value|token-value|do-not-copy/);
});

test('fails before mutation when a required Feishu variable is absent', async () => {
  let patchCalled = false;
  const bindings = sourceBindings().filter(({ name }) => name !== 'TABLE_PURCHASES');
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'PATCH') patchCalled = true;
    if (url.endsWith('/settings') && !options.method) return jsonResponse({ bindings: [] });
    if (url.endsWith('/versions?per_page=100')) return jsonResponse({ items: [{ id: sourceVersionId }] });
    if (url.endsWith(`/versions/${sourceVersionId}`)) return jsonResponse({ resources: { bindings } });
    throw new Error(`Unexpected request: ${url}`);
  };

  await assert.rejects(
    recoverFeishuVariables({
      accountId,
      apiToken: 'token-value',
      fetchImpl,
      log: () => {},
      scriptName,
      sourceVersionPrefix: 'b01f1b84'
    }),
    /TABLE_PURCHASES/
  );
  assert.equal(patchCalled, false);
});

test('rejects a non-plain-text source binding and ambiguous version prefix', async () => {
  const invalidBindings = sourceBindings({ FEISHU_APP_ID: 'secret-value' });
  invalidBindings.find(({ name }) => name === 'FEISHU_APP_ID').type = 'secret_text';
  const ambiguousFetch = async (url) => {
    if (url.endsWith('/settings')) return jsonResponse({ bindings: [] });
    if (url.endsWith('/versions?per_page=100')) {
      return jsonResponse({ items: [{ id: `${sourceVersionId}-a` }, { id: `${sourceVersionId}-b` }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await assert.rejects(
    recoverFeishuVariables({
      accountId,
      apiToken: 'token-value',
      fetchImpl: ambiguousFetch,
      log: () => {},
      scriptName,
      sourceVersionPrefix: 'b01f1b84'
    }),
    /exactly one source version/
  );

  const invalidFetch = async (url) => {
    if (url.endsWith('/settings')) return jsonResponse({ bindings: [] });
    if (url.endsWith('/versions?per_page=100')) return jsonResponse({ items: [{ id: sourceVersionId }] });
    if (url.endsWith(`/versions/${sourceVersionId}`)) return jsonResponse({ resources: { bindings: invalidBindings } });
    throw new Error(`Unexpected request: ${url}`);
  };
  await assert.rejects(
    recoverFeishuVariables({
      accountId,
      apiToken: 'token-value',
      fetchImpl: invalidFetch,
      log: () => {},
      scriptName,
      sourceVersionPrefix: 'b01f1b84'
    }),
    /FEISHU_APP_ID/
  );
});

test('is a no-op when all seven current variables are already present', async () => {
  const calls = [];
  const currentBindings = [
    { name: 'AUTH_SECRET', type: 'secret_text' },
    ...sourceBindings()
  ];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/settings') && !options.method) return jsonResponse({ bindings: currentBindings });
    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await recoverFeishuVariables({
    accountId,
    apiToken: 'token-value',
    fetchImpl,
    log: () => {},
    scriptName,
    sourceVersionPrefix: 'b01f1b84'
  });

  assert.deepEqual(result, { restoredCount: 0, sourceVersionId: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, undefined);
});

test('fails before source lookup or mutation when current Feishu variables are only partially present', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/settings') && !options.method) {
      return jsonResponse({ bindings: [{ name: 'FEISHU_APP_ID', type: 'plain_text', text: 'existing-value' }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await assert.rejects(
    recoverFeishuVariables({
      accountId,
      apiToken: 'token-value',
      fetchImpl,
      log: () => {},
      scriptName,
      sourceVersionPrefix: 'b01f1b84'
    }),
    /partially configured/
  );
  assert.equal(calls.length, 1);
});
