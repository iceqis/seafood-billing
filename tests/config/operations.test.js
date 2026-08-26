import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);
const projectPath = fileURLToPath(projectRoot);

const expectedVariables = new Map([
  ['FEISHU_APP_ID', 'replace-with-app-id'],
  ['FEISHU_APP_SECRET', 'replace-with-app-secret'],
  ['FEISHU_BASE_TOKEN', 'replace-with-base-token'],
  ['TABLE_CUSTOMERS', 'replace-with-table-id'],
  ['TABLE_SUPPLIERS', 'replace-with-table-id'],
  ['TABLE_PRODUCTS', 'replace-with-table-id'],
  ['TABLE_ORDERS', 'replace-with-table-id'],
  ['TABLE_PURCHASES', 'replace-with-table-id'],
  ['SHOP_PASSWORD_SALT', 'replace-with-base64-salt'],
  ['SHOP_PASSWORD_HASH', 'replace-with-base64-pbkdf2-hash'],
  ['AUTH_SECRET', 'replace-with-random-signing-secret']
]);

const runHashGenerator = (password) => spawnSync(
  process.execPath,
  ['scripts/generate-password-hash.js'],
  { cwd: projectPath, input: password, encoding: 'utf8' }
);

const parseHashOutput = (stdout) => new Map(
  stdout.trim().split('\n').map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  })
);

test('development variable template contains exactly eleven placeholders and no real values', async () => {
  const template = await readFile(new URL('../../.dev.vars.example', import.meta.url), 'utf8');
  const lines = template.trim().split(/\r?\n/);
  const variables = new Map(lines.map((line) => {
    const separator = line.indexOf('=');
    assert.ok(separator > 0, `invalid variable line: ${line}`);
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));

  assert.equal(lines.length, 11);
  assert.deepEqual(variables, expectedVariables);
  for (const value of variables.values()) assert.match(value, /^replace-with-/);
});

test('password hash generator rejects short input without echoing it', () => {
  const password = 'short123';
  const result = runHashGenerator(password);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /店铺密码至少需要10个字符/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(password));
});

test('password hash generator emits verifiable random PBKDF2-SHA-256 values without echoing the password', () => {
  const password = 'safe-password-123';
  const first = runHashGenerator(`${password}\n`);
  const second = runHashGenerator(`${password}\n`);

  for (const result of [first, second]) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, new RegExp(password));
    const values = parseHashOutput(result.stdout);
    assert.deepEqual([...values.keys()], ['SHOP_PASSWORD_SALT', 'SHOP_PASSWORD_HASH']);
    const salt = Buffer.from(values.get('SHOP_PASSWORD_SALT'), 'base64');
    const hash = Buffer.from(values.get('SHOP_PASSWORD_HASH'), 'base64');
    assert.equal(salt.length, 16);
    assert.equal(hash.length, 32);
    assert.deepEqual(hash, pbkdf2Sync(password, salt, 210000, 32, 'sha256'));
  }

  assert.notEqual(
    parseHashOutput(first.stdout).get('SHOP_PASSWORD_SALT'),
    parseHashOutput(second.stdout).get('SHOP_PASSWORD_SALT')
  );
});

test('operations runbook covers secret setup, safety controls, acceptance, and rollback', async () => {
  const runbook = await readFile(new URL('../../docs/operations.md', import.meta.url), 'utf8');
  const secretCommands = [...runbook.matchAll(/^npx wrangler secret put ([A-Z_]+)$/gm)].map((match) => match[1]);

  assert.deepEqual(secretCommands, [...expectedVariables.keys()]);
  assert.match(runbook, /CLOUDFLARE_API_TOKEN/);
  assert.match(runbook, /CLOUDFLARE_ACCOUNT_ID/);
  assert.match(runbook, /GitHub Pages[\s\S]*GitHub Actions/);
  assert.match(runbook, /轮换[\s\S]*SHOP_PASSWORD_SALT[\s\S]*SHOP_PASSWORD_HASH/);
  assert.match(runbook, /轮换 `AUTH_SECRET`[\s\S]*全部[\s\S]*登录/);
  assert.match(runbook, /日志/);
  assert.match(runbook, /已知正常提交/);
  assert.match(runbook, /git revert/);
  assert.match(runbook, /\/api\/auth\/login/);
  assert.match(runbook, /Worker 原生 Rate Limiting binding/);
  assert.match(runbook, /客户端 IP/);
  assert.match(runbook, /每 60 秒最多(?:允许 )?10 次/);
  assert.match(runbook, /下一(?:个 )?60 秒窗口/);
  assert.match(runbook, /HTTP 429/);
  assert.doesNotMatch(runbook, /封禁 10 分钟/);
  assert.match(runbook, /浏览器[\s\S]*PBKDF2[\s\S]*210,000/);
  assert.match(runbook, /60 秒[\s\S]*登录挑战/);
  assert.match(runbook, /登录服务配置异常[\s\S]*auth_configuration_invalid/);
  assert.match(runbook, /原始密码[\s\S]*证明[\s\S]*日志/);

  const acceptanceSteps = [
    'GitHub Actions test job',
    'Worker 部署和健康检查',
    '挑战接口返回 200',
    'Pages 部署',
    '未登录访问业务接口返回 401',
    '错误密码返回 401',
    '正确密码可以登录',
    '五张表的数据源检查全部成功',
    '系统验收',
    '发货、定价、开单和结算',
    '首页与客户页面金额一致',
    '删除验收记录'
  ];
  let previousIndex = -1;
  for (const step of acceptanceSteps) {
    const index = runbook.indexOf(step, previousIndex + 1);
    assert.ok(index > previousIndex, `acceptance step is missing or out of order: ${step}`);
    previousIndex = index;
  }
  assert.match(runbook, /创建[\s\S]{0,30}[“"]系统验收[”"][\s\S]*操作前[\s\S]*二次确认/);
  assert.match(runbook, /删除验收记录[\s\S]*操作前[\s\S]*二次确认/);
});

test('README links installation, local development, testing, deployment, and operations without secrets', async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');

  for (const heading of ['安装', '本地开发', '测试', '部署', '运维']) {
    assert.match(readme, new RegExp(`^## ${heading}$`, 'm'));
  }
  assert.match(readme, /docs\/operations\.md/);
  assert.doesNotMatch(readme, /FEISHU_APP_SECRET|SHOP_PASSWORD_HASH|AUTH_SECRET|CLOUDFLARE_API_TOKEN/);
});
