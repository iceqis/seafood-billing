import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const projectRoot = new URL('../../', import.meta.url);
const readWorkflow = (name) => readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
const readWranglerConfig = () => readFile(new URL('../../wrangler.toml', import.meta.url), 'utf8');
const readRuntimeConfig = () => readFile(new URL('../../assets/js/config.js', import.meta.url), 'utf8');

const expectedActions = new Map([
  ['actions/checkout', { sha: '34e114876b0b11c390a56381ad16ebd13914f8d5', version: 'v4.3.1', count: 4 }],
  ['actions/setup-node', { sha: '49933ea5288caeca8642d1e84afbd3f7d6820020', version: 'v4.4.0', count: 3 }],
  ['cloudflare/wrangler-action', { sha: '9acf94ace14e7dc412b076f2c5c20b8ce93c79cd', version: 'v3.15.0', count: 1 }],
  ['actions/configure-pages', { sha: '983d7736d9b0ae728b81ab479565c72886d7745b', version: 'v5.0.0', count: 1 }],
  ['actions/upload-pages-artifact', { sha: '7b1f4a764d45c48632c6b24a0339c27f5614fb0b', version: 'v4.0.0', count: 1 }],
  ['actions/deploy-pages', { sha: 'd6db90164ac5ed86f2b6aed7e0febac5b3c0c03e', version: 'v4.0.5', count: 1 }]
]);

async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await listFiles(new URL(`${entry.name}/`, directory), `${relativePath}/`));
    } else {
      files.push(relativePath);
    }
  }

  return files;
}

test('Pages build removes stale output and copies only index.html and assets', async () => {
  const siteRoot = new URL('../../_site/', import.meta.url);
  await mkdir(siteRoot, { recursive: true });
  await writeFile(new URL('stale.txt', siteRoot), 'stale');

  await execFileAsync(process.execPath, ['scripts/build-pages.js'], { cwd: fileURLToPath(projectRoot) });

  const assetFiles = await listFiles(new URL('../../assets/', import.meta.url), 'assets/');
  const outputFiles = await listFiles(siteRoot);
  assert.deepEqual(outputFiles, [...assetFiles, 'index.html'].sort());

  for (const outputFile of outputFiles) {
    const source = await readFile(new URL(`../../${outputFile}`, import.meta.url));
    const built = await readFile(new URL(outputFile, siteRoot));
    assert.deepEqual(built, source, `${outputFile} must be copied without modification`);
  }
});

test('pull requests and manual runs execute the complete check pipeline', async () => {
  const workflow = await readWorkflow('checks.yml');

  assert.match(workflow, /^name: Checks$/m);
  assert.match(workflow, /^  pull_request:$/m);
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.match(workflow, /node-version: 22/);
  assert.match(workflow, /- run: npm ci/);
  assert.match(workflow, /- run: npx playwright install --with-deps chromium/);
  assert.match(workflow, /- run: npm run check/);
  assert.match(workflow, /- run: npm run build:pages/);
});

test('production deploy is gated, least-privileged, and verifies Worker before Pages', async () => {
  const workflow = await readWorkflow('deploy.yml');

  assert.match(workflow, /^name: Deploy production$/m);
  assert.match(workflow, /^  push:\n    branches: \[main\]$/m);
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /^concurrency:\n  group: production\n  cancel-in-progress: false$/m);
  assert.match(workflow, /^  test:\n    if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(workflow, /^  deploy-worker:\n    needs: test$/m);
  assert.match(workflow, /^  deploy-pages:\n    needs: deploy-worker$/m);
  assert.doesNotMatch(workflow, /recover-feishu-vars|SOURCE_VERSION_PREFIX|b01f1b84/);
  assert.match(workflow, /apiToken: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(workflow, /accountId: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
  assert.match(workflow, /wranglerVersion: '4\.125\.0'/);
  assert.match(workflow, /seafood-billing-api\.iceqy0313\.workers\.dev\/api\/health/);
  assert.match(workflow, /Verify business data reads/);
  assert.match(workflow, /api\/health\/business-diagnostic/);
  assert.match(workflow, /seafood-billing-api\.iceqy0313\.workers\.dev\/api\/customers/);
  assert.match(workflow, /Verify auth challenge/);
  assert.match(workflow, /api\/auth\/challenge/);
  assert.match(workflow, /Origin: https:\/\/iceqis\.github\.io/);
  assert.match(workflow, /EXPECTED_STATUS: '401'/);
  assert.match(workflow, /^    permissions:\n      contents: read\n      pages: write\n      id-token: write$/m);
  assert.match(workflow, /uses: actions\/upload-pages-artifact@[0-9a-f]{40} # v4\.0\.0\n        with:\n          path: _site/);
  assert.match(workflow, /DEPLOYED_PAGE_URL: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
  assert.doesNotMatch(workflow, /^\s*-?\s*run:.*\$\{\{/m);
});

test('Worker deployment preserves variables managed in the Cloudflare dashboard', async () => {
  const config = await readWranglerConfig();

  assert.match(config, /^keep_vars = true$/m);
  assert.equal(config.match(/^keep_vars = true$/gm)?.length, 1);
  assert.ok(
    config.indexOf('keep_vars = true') < config.indexOf('[vars]'),
    'keep_vars must be a top-level Wrangler setting'
  );
});

test('browser timeout leaves enough time for bounded Feishu read recovery', async () => {
  const config = await readRuntimeConfig();

  assert.match(config, /requestTimeoutMs:\s*30000/);
});

test('every external action is pinned to the reviewed immutable release commit', async () => {
  const workflows = await Promise.all(['checks.yml', 'deploy.yml'].map(readWorkflow));
  const actions = workflows.flatMap((workflow) => [...workflow.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)(?: # (v\S+))?$/gm)]);
  const counts = new Map();

  for (const [, action, version] of actions) {
    const separator = action.lastIndexOf('@');
    assert.notEqual(separator, -1, `${action} must include an immutable ref`);
    const name = action.slice(0, separator);
    const sha = action.slice(separator + 1);
    assert.equal(sha.length, 40, `${name} must use a full 40-character commit SHA`);
    assert.match(sha, /^[0-9a-f]{40}$/, `${name} must use a hexadecimal commit SHA`);
    const expected = expectedActions.get(name);
    assert.ok(expected, `unexpected external action: ${name}`);
    assert.deepEqual({ sha, version }, { sha: expected.sha, version: expected.version });
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  assert.deepEqual(
    Object.fromEntries(counts),
    Object.fromEntries([...expectedActions].map(([name, { count }]) => [name, count]))
  );
});
