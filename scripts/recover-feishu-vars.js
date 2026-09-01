import { pathToFileURL } from 'node:url';

export const FEISHU_VARIABLE_NAMES = Object.freeze([
  'FEISHU_APP_ID',
  'FEISHU_BASE_TOKEN',
  'TABLE_CUSTOMERS',
  'TABLE_SUPPLIERS',
  'TABLE_PRODUCTS',
  'TABLE_ORDERS',
  'TABLE_PURCHASES'
]);

const DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4';

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function safeApiError(payload, status) {
  const message = payload?.errors?.find(({ message }) => typeof message === 'string')?.message;
  return new Error(message ? `Cloudflare API request failed (${status}): ${message}` : `Cloudflare API request failed (${status})`);
}

export async function recoverFeishuVariables({
  accountId,
  apiBase = DEFAULT_API_BASE,
  apiToken,
  fetchImpl = fetch,
  log = console.log,
  scriptName,
  sourceVersionPrefix
}) {
  const safeAccountId = requireString(accountId, 'CLOUDFLARE_ACCOUNT_ID');
  const safeApiToken = requireString(apiToken, 'CLOUDFLARE_API_TOKEN');
  const safeScriptName = requireString(scriptName, 'CLOUDFLARE_SCRIPT_NAME');
  const safeVersionPrefix = requireString(sourceVersionPrefix, 'SOURCE_VERSION_PREFIX');
  const scriptPath = `/accounts/${encodeURIComponent(safeAccountId)}/workers/scripts/${encodeURIComponent(safeScriptName)}`;

  async function request(path, options = {}) {
    const response = await fetchImpl(`${apiBase}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${safeApiToken}`,
        ...options.headers
      }
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Cloudflare API returned an unreadable response (${response.status})`);
    }
    if (!response.ok || payload?.success !== true) {
      throw safeApiError(payload, response.status);
    }
    return payload.result;
  }

  const versions = await request(`${scriptPath}/versions?per_page=100`);
  const sourceMatches = Array.isArray(versions)
    ? versions.filter(({ id }) => typeof id === 'string' && id.startsWith(safeVersionPrefix))
    : [];
  if (sourceMatches.length !== 1) {
    throw new Error(`Expected exactly one source version matching ${safeVersionPrefix}; found ${sourceMatches.length}`);
  }

  const sourceVersionId = sourceMatches[0].id;
  const sourceVersion = await request(`${scriptPath}/versions/${encodeURIComponent(sourceVersionId)}`);
  const sourceBindings = sourceVersion?.resources?.bindings;
  if (!Array.isArray(sourceBindings)) {
    throw new Error('Source version does not contain readable bindings');
  }

  const recoveredBindings = FEISHU_VARIABLE_NAMES.map((name) => {
    const candidates = sourceBindings.filter((binding) => binding?.name === name);
    if (candidates.length !== 1) {
      throw new Error(`Source version must contain exactly one ${name} binding`);
    }
    const binding = candidates[0];
    if (binding.type !== 'plain_text' || typeof binding.text !== 'string' || binding.text.trim() === '') {
      throw new Error(`Source version ${name} binding is not a non-empty plain-text variable`);
    }
    return { name, type: 'plain_text', text: binding.text };
  });

  const currentSettings = await request(`${scriptPath}/settings`);
  const currentBindings = currentSettings?.bindings;
  if (!Array.isArray(currentBindings)) {
    throw new Error('Current Worker settings do not contain readable bindings');
  }
  const recoveredNames = new Set(FEISHU_VARIABLE_NAMES);
  const currentNames = new Set();
  const inheritedBindings = [];
  for (const binding of currentBindings) {
    if (typeof binding?.name !== 'string' || binding.name === '' || recoveredNames.has(binding.name)) continue;
    if (currentNames.has(binding.name)) throw new Error(`Current Worker contains duplicate binding ${binding.name}`);
    currentNames.add(binding.name);
    inheritedBindings.push({ name: binding.name, type: 'inherit' });
  }

  const settings = {
    annotations: { 'workers/message': 'Restore Feishu variables without code rollback' },
    bindings: [...inheritedBindings, ...recoveredBindings]
  };
  const form = new FormData();
  form.append('settings', JSON.stringify(settings));
  const patched = await request(`${scriptPath}/settings`, { method: 'PATCH', body: form });

  const verifiedSettings = await request(`${scriptPath}/settings`);
  const verifiedBindings = verifiedSettings?.bindings;
  if (!Array.isArray(verifiedBindings)) {
    throw new Error('Cloudflare did not return bindings after recovery');
  }
  for (const recovered of recoveredBindings) {
    const verified = verifiedBindings.find(({ name }) => name === recovered.name);
    if (!verified || verified.type !== 'plain_text' || verified.text !== recovered.text) {
      throw new Error(`Cloudflare did not retain recovered variable ${recovered.name}`);
    }
  }

  log(`Recovered ${FEISHU_VARIABLE_NAMES.length} allow-listed Feishu variables from version ${safeVersionPrefix}.`);
  return {
    restoredCount: FEISHU_VARIABLE_NAMES.length,
    sourceVersionId,
    versionId: patched?.id
  };
}

async function main() {
  await recoverFeishuVariables({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    scriptName: process.env.CLOUDFLARE_SCRIPT_NAME ?? 'seafood-billing-api',
    sourceVersionPrefix: process.env.SOURCE_VERSION_PREFIX
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Feishu variable recovery failed');
    process.exitCode = 1;
  });
}
