# 海鲜批发记账系统第一轮优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在完全兼容现有五张飞书表和历史数据的前提下，修复现有故障，将前端与 Worker 模块化，加入统一密码登录、自动化测试和 `main` 分支自动部署。

**Architecture:** GitHub Pages 继续托管原生 HTML/CSS/ES Modules，Cloudflare Worker 分为路由、鉴权、校验、业务服务和飞书适配层。飞书多维表格仍是唯一业务账本；前端操作通过受保护的 Worker API 读写飞书，并在写操作成功后重新读取数据。

**Tech Stack:** HTML5、原生 CSS、原生 JavaScript ES Modules、Cloudflare Workers、飞书开放 API、Vitest、`@cloudflare/vitest-pool-workers`、jsdom、Playwright、Wrangler、GitHub Actions、GitHub Pages。

**Design reference:** `docs/superpowers/specs/2026-08-23-seafood-billing-optimization-design.md`

---

## 目标文件结构

```text
.
├── index.html
├── assets/
│   ├── css/
│   │   ├── base.css
│   │   ├── components.css
│   │   ├── pages.css
│   │   └── responsive.css
│   └── js/
│       ├── app.js
│       ├── api-client.js
│       ├── auth.js
│       ├── config.js
│       ├── state.js
│       ├── utils.js
│       └── pages/
│           ├── customers.js
│           ├── home.js
│           ├── orders.js
│           ├── preorder.js
│           ├── products.js
│           ├── profile.js
│           └── purchases.js
├── worker/
│   ├── index.js
│   ├── auth.js
│   ├── feishu-client.js
│   ├── field-mappers.js
│   ├── response.js
│   ├── validation.js
│   └── services/
│       ├── customers.js
│       ├── orders.js
│       ├── products.js
│       ├── purchases.js
│       ├── statistics.js
│       └── suppliers.js
├── tests/
│   ├── fixtures/
│   │   └── feishu-records.js
│   ├── frontend/
│   ├── worker/
│   └── e2e/
├── docs/
│   ├── requirements.md
│   ├── operations.md
│   └── superpowers/
├── .github/workflows/
│   ├── checks.yml
│   └── deploy.yml
├── package.json
├── package-lock.json
├── playwright.config.js
├── vitest.config.js
├── vitest.worker.config.js
└── wrangler.toml
```

---

### Task 1: 建立可回滚的生产基线

**Files:**
- Create: `index.html`
- Create: `worker/index.js`
- Create: `docs/requirements.md`
- Create: `README.md`
- Create: `.gitignore`

- [ ] **Step 1: 将默认分支统一为 `main`**

Run:

```bash
git branch -m main
git status --short --branch
```

Expected: 第一行显示 `## main`，已提交的设计文档仍存在。

- [ ] **Step 2: 导入当前生产前端、Worker 和需求文档**

Run:

```bash
cp /Users/yangsiqi/Downloads/seafood_billing_web.html index.html
mkdir -p worker
cp /Users/yangsiqi/Downloads/cloudflare_worker.js worker/index.js
cp /Users/yangsiqi/Downloads/海鲜批发记账系统_需求与开发文档.md docs/requirements.md
```

Expected: `index.html` 为2989行，`worker/index.js` 为840行，`docs/requirements.md` 为1283行。

- [ ] **Step 3: 验证导入前端与当前线上版本一致**

Run:

```bash
shasum -a 256 index.html /Users/yangsiqi/Downloads/seafood_billing_web.html
cmp -s index.html /Users/yangsiqi/Downloads/seafood_billing_web.html
```

Expected: 两个 SHA-256 都是 `84f7214a8e68842451bc931852ba5bba332a7bd57db1c46ca0022f6d46c45d26`，`cmp` 退出码为0。

- [ ] **Step 4: 添加仓库说明和忽略规则**

Create `README.md`:

```markdown
# 海鲜批发记账系统

面向海鲜批发业务的网页记账系统。GitHub Pages 托管前端，Cloudflare Worker 提供受保护的 API，业务数据保存在飞书多维表格。

## 本地检查

```bash
npm ci
npm run check
```

部署和密钥配置见 `docs/operations.md`。
```

Create `.gitignore`:

```gitignore
node_modules/
playwright-report/
test-results/
coverage/
.dev.vars
.env
.DS_Store
_site/
```

- [ ] **Step 5: 记录生产基线提交**

Run:

```bash
git add index.html worker/index.js docs/requirements.md README.md .gitignore
git commit -m "chore: import production baseline"
```

Expected: 提交成功，`git status --short` 无输出。

---

### Task 2: 建立测试工具链并用失败测试锁定现有故障

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `vitest.config.js`
- Create: `vitest.worker.config.js`
- Create: `wrangler.toml`
- Create: `tests/frontend/baseline.test.js`
- Create: `tests/worker/baseline.test.js`

- [ ] **Step 1: 创建 Node 工程并锁定开发依赖**

Create `package.json`:

```json
{
  "name": "seafood-billing",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "npm run test:frontend && npm run test:worker",
    "test:frontend": "vitest run --config vitest.config.js",
    "test:worker": "vitest run --config vitest.worker.config.js",
    "test:e2e": "playwright test",
    "check": "npm test && npm run test:e2e",
    "dev": "http-server . -p 4173 -c-1",
    "deploy:worker": "wrangler deploy",
    "build:pages": "node scripts/build-pages.js"
  },
  "devDependencies": {}
}
```

Run:

```bash
npm install --save-dev vitest jsdom @cloudflare/vitest-pool-workers wrangler @playwright/test http-server
```

Expected: `package-lock.json` 被创建，安装命令退出码为0。

- [ ] **Step 2: 配置前端 Vitest**

Create `vitest.config.js`:

```javascript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/frontend/**/*.test.js'],
    restoreMocks: true
  }
});
```

- [ ] **Step 3: 配置 Worker Vitest**

Create `vitest.worker.config.js`:

```javascript
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['tests/worker/**/*.test.js'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' }
      }
    }
  }
});
```

Create the initial `wrangler.toml` required by the Worker test pool:

```toml
name = "seafood-billing-api"
main = "worker/index.js"
compatibility_date = "2026-08-23"
compatibility_flags = ["nodejs_compat"]

[vars]
ALLOWED_ORIGINS = "https://iceqis.github.io"
APP_VERSION = "3.0.1"
```

- [ ] **Step 4: 写前端失败测试，锁定加载元素问题**

Create `tests/frontend/baseline.test.js`:

```javascript
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

describe('production baseline', () => {
  it('contains the loading text element referenced by showLoading', () => {
    expect(html).toContain('id="loading-text"');
  });
});
```

- [ ] **Step 5: 写 Worker 失败测试，锁定路由和状态映射问题**

Create `tests/worker/baseline.test.js`:

```javascript
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../worker/index.js', import.meta.url), 'utf8');

describe('worker production baseline', () => {
  it('routes bill and settle before the generic order prefix', () => {
    const generic = source.indexOf("path === '/api/orders' || path.startsWith('/api/orders/')");
    expect(source.indexOf("path === '/api/orders/bill'")).toBeLessThan(generic);
    expect(source.indexOf("path === '/api/orders/settle'")).toBeLessThan(generic);
  });

  it('maps normal order responses to frontend status values', () => {
    expect(source).toContain('items.map(formatOrder).map');
    expect(source).toContain('statusFromFeishu(o.status)');
  });

  it('handles health before requesting a Feishu token', () => {
    expect(source.indexOf("path === '/api/health'")).toBeLessThan(
      source.indexOf('const token = await getTenantToken(env)')
    );
  });
});
```

- [ ] **Step 6: 运行测试并确认它们因已知问题失败**

Run:

```bash
npm run test:frontend
npm run test:worker
```

Expected: 前端测试因缺少 `id="loading-text"` 失败；Worker 测试因路由顺序、状态映射和健康检查顺序失败。

- [ ] **Step 7: 提交测试工具链**

Run:

```bash
git add package.json package-lock.json vitest.config.js vitest.worker.config.js wrangler.toml tests
git commit -m "test: capture production baseline failures"
```

Expected: 提交成功；此提交允许已知的失败测试存在，下一任务立即修复。

---

### Task 3: 修复当前版本的四个阻断性问题

**Files:**
- Modify: `index.html:1522`
- Modify: `worker/index.js:268-328`
- Modify: `worker/index.js:538-598`
- Modify: `worker/index.js:759-824`
- Modify: `tests/worker/baseline.test.js`

- [ ] **Step 1: 修复加载提示元素**

Change the loading markup to:

```html
<div class="loading-overlay" id="loading-overlay" aria-live="polite" aria-busy="false">
  <div class="loading-spinner" aria-hidden="true"></div>
  <div class="loading-text" id="loading-text">正在处理...</div>
</div>
```

Change `showLoading` and `hideLoading` to:

```javascript
function showLoading(text = '正在处理...') {
  document.getElementById('loading-text').textContent = text;
  const overlay = document.getElementById('loading-overlay');
  overlay.classList.add('show');
  overlay.setAttribute('aria-busy', 'true');
}

function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  overlay.classList.remove('show');
  overlay.setAttribute('aria-busy', 'false');
}
```

- [ ] **Step 2: 在普通订单响应边界转换状态**

In the `GET /api/orders` branch, return:

```javascript
const data = items.map(formatOrder).map((order) => ({
  ...order,
  status: statusFromFeishu(order.status)
}));
return jsonResponse({ code: 0, message: 'success', data });
```

Update internal comparisons after `formatOrder` only where API-facing English values are now used:

```javascript
if (statusFromFeishu(order.status) !== 'pending_bill') continue;
if (statusFromFeishu(order.status) !== 'unsettled') continue;
if (body.status === 'pending_bill' && statusFromFeishu(current.status) === 'settled') {
  updateFields[FIELDS.orders.settled] = false;
}
```

- [ ] **Step 3: 将特定订单路由放到通用订单路由前**

The order routing section must be exactly ordered as:

```javascript
if (path === '/api/orders/bill') {
  return await handleBillOrders(request, env, token);
}

if (path === '/api/orders/settle') {
  return await handleSettleOrders(request, env, token);
}

if (path === '/api/orders' || /^\/api\/orders\/[^/]+$/.test(path)) {
  return await handleOrders(request, env, token, url);
}
```

- [ ] **Step 4: 让健康检查独立于飞书**

Move this block after URL parsing and before environment validation/token acquisition:

```javascript
if (path === '/api/health') {
  return jsonResponse({
    code: 0,
    message: 'ok',
    data: { version: '3.0.1', service: 'seafood-billing-api' }
  });
}
```

- [ ] **Step 5: 运行基线测试**

Run:

```bash
npm run test:frontend
npm run test:worker
```

Expected: 所有基线测试通过。

- [ ] **Step 6: 做脚本语法检查**

Run:

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('index.html','utf8');const js=s.match(/<script>([\\s\\S]*?)<\\/script>/)[1];new Function(js);console.log('frontend syntax ok')"
node -e "const fs=require('fs');let s=fs.readFileSync('worker/index.js','utf8').replace(/export default/,'const worker =');new Function(s);console.log('worker syntax ok')"
```

Expected: 输出 `frontend syntax ok` 和 `worker syntax ok`。

- [ ] **Step 7: 提交阻断性修复**

Run:

```bash
git add index.html worker/index.js tests
git commit -m "fix: restore loading and order workflows"
```

---

### Task 4: 提取 Worker 的响应、字段映射和校验模块

**Files:**
- Create: `worker/response.js`
- Create: `worker/field-mappers.js`
- Create: `worker/validation.js`
- Create: `tests/worker/field-mappers.test.js`
- Create: `tests/worker/validation.test.js`
- Modify: `worker/index.js`

- [ ] **Step 1: 先写字段映射失败测试**

Create `tests/worker/field-mappers.test.js`:

```javascript
import { describe, expect, it } from 'vitest';
import {
  orderFromFeishu,
  statusFromFeishu,
  statusToFeishu
} from '../../worker/field-mappers.js';

describe('field mappers', () => {
  it.each([
    ['待发货', 'pending_ship'],
    ['已发货', 'shipped'],
    ['未开单', 'pending_bill'],
    ['未结算', 'unsettled'],
    ['已结算', 'settled']
  ])('maps %s to %s', (feishu, api) => {
    expect(statusFromFeishu(feishu)).toBe(api);
    expect(statusToFeishu(api)).toBe(feishu);
  });

  it('normalizes a Feishu order record', () => {
    const order = orderFromFeishu({
      record_id: 'rec1',
      fields: {
        订单编号: 'XSD20260823001',
        日期: '2026-08-23',
        客户: '测试客户',
        商品: '基围虾',
        规格: '30头',
        报货重量: 5,
        实际发货重量: 5.5,
        单价: 40,
        金额: 220,
        状态: '未结算',
        是否结算: false
      }
    });
    expect(order).toMatchObject({
      id: 'XSD20260823001',
      status: 'unsettled',
      amount: 220
    });
  });
});
```

- [ ] **Step 2: 先写校验失败测试**

Create `tests/worker/validation.test.js`:

```javascript
import { describe, expect, it } from 'vitest';
import { validateOrderTransition, validatePositiveNumber } from '../../worker/validation.js';

describe('validation', () => {
  it('accepts positive numbers', () => {
    expect(validatePositiveNumber('5.5', '实际发货重量')).toBe(5.5);
  });

  it('rejects zero and invalid numbers', () => {
    expect(() => validatePositiveNumber(0, '单价')).toThrow('单价必须大于0');
    expect(() => validatePositiveNumber('abc', '单价')).toThrow('单价必须是有效数字');
  });

  it.each([
    ['pending_ship', 'shipped'],
    ['shipped', 'pending_bill'],
    ['pending_bill', 'unsettled'],
    ['unsettled', 'settled'],
    ['settled', 'pending_bill']
  ])('allows %s to %s', (from, to) => {
    expect(() => validateOrderTransition(from, to)).not.toThrow();
  });

  it('rejects skipping states', () => {
    expect(() => validateOrderTransition('pending_ship', 'settled')).toThrow('不允许的订单状态转换');
  });
});
```

- [ ] **Step 3: 运行测试确认模块尚不存在**

Run:

```bash
npm run test:worker
```

Expected: FAIL，原因是 `field-mappers.js` 和 `validation.js` 尚不存在。

- [ ] **Step 4: 实现统一响应模块**

Create `worker/response.js`:

```javascript
export function corsHeaders(origin, allowedOrigins) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
  if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function jsonResponse(data, status, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors }
  });
}

export function success(data = null, cors = {}, status = 200) {
  return jsonResponse({ code: 0, message: 'success', data }, status, cors);
}

export function failure(status, message, cors = {}, details = null) {
  return jsonResponse({ code: status, message, data: details }, status, cors);
}
```

- [ ] **Step 5: 实现字段映射模块**

Create `worker/field-mappers.js` with exported constants for all five existing tables and these public functions:

```javascript
export const STATUS_TO_FEISHU = Object.freeze({
  pending_ship: '待发货',
  shipped: '已发货',
  pending_bill: '未开单',
  unsettled: '未结算',
  settled: '已结算'
});

export function statusToFeishu(status) {
  return STATUS_TO_FEISHU[status] ?? status;
}

export function statusFromFeishu(status) {
  return Object.entries(STATUS_TO_FEISHU).find(([, value]) => value === status)?.[0] ?? status;
}

export function orderFromFeishu(item) {
  const fields = item.fields ?? {};
  const actualWeight = Number(fields['实际发货重量']) || 0;
  const price = Number(fields['单价']) || 0;
  return {
    recordId: item.record_id,
    id: fields['订单编号'] ?? '',
    date: fields['日期'] ?? '',
    customer: fields['客户'] ?? '',
    product: fields['商品'] ?? '',
    spec: fields['规格'] ?? '',
    orderWeight: Number(fields['报货重量']) || 0,
    actualWeight,
    price,
    amount: Number(fields['金额']) || Number((actualWeight * price).toFixed(2)),
    status: statusFromFeishu(fields['状态'] ?? ''),
    settled: Boolean(fields['是否结算'])
  };
}
```

Also move the existing customer, supplier, product and purchase formatters into this module as `customerFromFeishu`, `supplierFromFeishu`, `productFromFeishu` and `purchaseFromFeishu`, preserving their existing API property names.

- [ ] **Step 6: 实现校验模块**

Create `worker/validation.js`:

```javascript
const TRANSITIONS = Object.freeze({
  pending_ship: new Set(['shipped']),
  shipped: new Set(['pending_bill']),
  pending_bill: new Set(['pending_bill', 'unsettled']),
  unsettled: new Set(['pending_bill', 'settled']),
  settled: new Set(['pending_bill'])
});

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

export function validatePositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ValidationError(`${label}必须是有效数字`);
  if (number <= 0) throw new ValidationError(`${label}必须大于0`);
  return number;
}

export function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError('日期格式必须为YYYY-MM-DD');
  }
  return value;
}

export function validateRequiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new ValidationError(`${label}不能为空`);
  return text;
}

export function validateOrderTransition(from, to) {
  if (!TRANSITIONS[from]?.has(to)) {
    throw new ValidationError(`不允许的订单状态转换：${from} → ${to}`, 409);
  }
}
```

- [ ] **Step 7: 替换 Worker 内重复实现并运行测试**

Modify `worker/index.js` to import the new response, mapping and validation functions. Remove the duplicated `FIELDS`, status mapping, formatter and response helper definitions only after all references use the imported modules.

Run:

```bash
npm run test:worker
```

Expected: 新增测试及基线测试全部通过。

- [ ] **Step 8: 提交 Worker 核心模块**

Run:

```bash
git add worker tests/worker
git commit -m "refactor: extract worker mapping and validation"
```

---

### Task 5: 提取飞书客户端并完整处理分页

**Files:**
- Create: `worker/feishu-client.js`
- Create: `tests/worker/feishu-client.test.js`
- Modify: `worker/index.js`

- [ ] **Step 1: 写分页失败测试**

Create `tests/worker/feishu-client.test.js`:

```javascript
import { describe, expect, it, vi } from 'vitest';
import { createFeishuClient } from '../../worker/feishu-client.js';

describe('Feishu client', () => {
  it('reads every page', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { items: [{ record_id: '1', fields: {} }], has_more: true, page_token: 'next' }
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { items: [{ record_id: '2', fields: {} }], has_more: false }
      })));

    const client = createFeishuClient({
      FEISHU_APP_ID: 'app',
      FEISHU_APP_SECRET: 'secret',
      FEISHU_BASE_TOKEN: 'base'
    }, fetchMock);

    const records = await client.listAllRecords('table');
    expect(records.map((item) => item.record_id)).toEqual(['1', '2']);
    expect(fetchMock.mock.calls[2][0]).toContain('page_token=next');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:worker`

Expected: FAIL，因为 `createFeishuClient` 尚不存在。

- [ ] **Step 3: 实现可注入 `fetch` 的飞书客户端**

Create `worker/feishu-client.js` with this public interface:

```javascript
export function createFeishuClient(env, fetchImpl = fetch) {
  let tokenCache = null;

  async function getTenantToken() {
    const now = Date.now();
    if (tokenCache && tokenCache.expiresAt > now) return tokenCache.value;
    const response = await fetchImpl(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: env.FEISHU_APP_ID,
          app_secret: env.FEISHU_APP_SECRET
        })
      }
    );
    const body = await response.json();
    if (!response.ok || body.code !== 0) throw new Error('飞书认证失败');
    tokenCache = {
      value: body.tenant_access_token,
      expiresAt: now + Math.max(60, Number(body.expire) - 300) * 1000
    };
    return tokenCache.value;
  }

  async function listAllRecords(tableId, filter = null) {
    const items = [];
    let pageToken = '';
    do {
      const url = new URL(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_BASE_TOKEN}/tables/${tableId}/records`
      );
      url.searchParams.set('page_size', '500');
      if (pageToken) url.searchParams.set('page_token', pageToken);
      if (filter) url.searchParams.set('filter', JSON.stringify(filter));
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${await getTenantToken()}` }
      });
      const body = await response.json();
      if (!response.ok || body.code !== 0) throw new Error('读取飞书数据失败');
      items.push(...(body.data?.items ?? []));
      pageToken = body.data?.has_more ? body.data.page_token : '';
    } while (pageToken);
    return items;
  }

  return {
    getTenantToken,
    listAllRecords,
    createRecord: async (tableId, fields) => requestRecord('POST', tableId, '', fields),
    updateRecord: async (tableId, recordId, fields) => requestRecord('PUT', tableId, recordId, fields),
    deleteRecord: async (tableId, recordId) => requestRecord('DELETE', tableId, recordId)
  };

  async function requestRecord(method, tableId, recordId = '', fields) {
    const suffix = recordId ? `/${recordId}` : '';
    const response = await fetchImpl(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_BASE_TOKEN}/tables/${tableId}/records${suffix}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${await getTenantToken()}`,
          'Content-Type': 'application/json'
        },
        body: method === 'DELETE' ? undefined : JSON.stringify({ fields })
      }
    );
    const body = await response.json();
    if (!response.ok || body.code !== 0) throw new Error('写入飞书数据失败');
    return body.data?.record ?? body.data;
  }
}
```

- [ ] **Step 4: 用新客户端替换 Worker 的飞书请求**

Create one client per request in `worker/index.js`:

```javascript
const feishu = createFeishuClient(env);
```

Pass `feishu` into service handlers. Remove the old `getTenantToken`, `listRecords`, `createRecord`, `updateRecord` and `deleteRecord` functions after no references remain.

- [ ] **Step 5: 运行分页及回归测试**

Run: `npm run test:worker`

Expected: 分页测试和既有 Worker 测试全部通过。

- [ ] **Step 6: 提交飞书客户端**

Run:

```bash
git add worker tests
git commit -m "refactor: add paginated feishu client"
```

---

### Task 6: 拆分业务服务并强化订单状态、批量操作和单号

**Files:**
- Create: `worker/services/customers.js`
- Create: `worker/services/suppliers.js`
- Create: `worker/services/products.js`
- Create: `worker/services/orders.js`
- Create: `worker/services/purchases.js`
- Create: `worker/services/statistics.js`
- Create: `tests/worker/orders-service.test.js`
- Create: `tests/worker/statistics-service.test.js`
- Modify: `worker/index.js`

- [ ] **Step 1: 写订单服务失败测试**

Create `tests/worker/orders-service.test.js` with an in-memory fake Feishu client and these assertions:

```javascript
import { describe, expect, it } from 'vitest';
import { createOrdersService } from '../../worker/services/orders.js';

function orderRecord(id, customer, status) {
  return {
    record_id: `rec_${id}`,
    fields: {
      订单编号: id,
      日期: '2026-08-23',
      客户: customer,
      商品: '基围虾',
      规格: '30头',
      报货重量: 5,
      实际发货重量: 5,
      单价: 40,
      金额: 200,
      状态: status,
      是否结算: false
    }
  };
}

function fakeOrdersClient(initialRecords) {
  const records = structuredClone(initialRecords);
  return {
    listAllRecords: async () => records,
    updateRecord: async (_tableId, recordId, fields) => {
      const record = records.find((item) => item.record_id === recordId);
      Object.assign(record.fields, fields);
      return record;
    },
    createRecord: async (_tableId, fields) => {
      const record = { record_id: `rec_${records.length + 1}`, fields };
      records.push(record);
      return record;
    },
    deleteRecord: async (_tableId, recordId) => {
      const index = records.findIndex((item) => item.record_id === recordId);
      if (index >= 0) records.splice(index, 1);
      return null;
    }
  };
}

describe('orders service', () => {
  it('rejects billing orders from different customers', async () => {
    const service = createOrdersService(fakeOrdersClient([
      orderRecord('XSD20260823001', '甲客户', '未开单'),
      orderRecord('XSD20260823002', '乙客户', '未开单')
    ]), { TABLE_ORDERS: 'orders' });
    await expect(service.bill(['XSD20260823001', 'XSD20260823002'], '甲客户'))
      .rejects.toMatchObject({ status: 409 });
  });

  it('only settles unsettled orders', async () => {
    const service = createOrdersService(fakeOrdersClient([
      orderRecord('XSD20260823001', '甲客户', '未开单')
    ]), { TABLE_ORDERS: 'orders' });
    await expect(service.settle(['XSD20260823001']))
      .rejects.toMatchObject({ status: 409 });
  });
});
```

Create `tests/worker/statistics-service.test.js`:

```javascript
import { describe, expect, it } from 'vitest';
import { createStatisticsService } from '../../worker/services/statistics.js';

describe('statistics service', () => {
  it('sums every record returned by the paginated client', async () => {
    const orders = [
      { record_id: 'o1', fields: { 日期: '2026-08-23', 金额: 100, 状态: '未结算' } },
      { record_id: 'o2', fields: { 日期: '2026-08-23', 金额: 220, 状态: '已结算' } },
      { record_id: 'o3', fields: { 日期: '2026-08-23', 金额: 500, 状态: '未开单' } }
    ];
    const purchases = [
      { record_id: 'p1', fields: { 日期: '2026-08-23', 金额: 80 } }
    ];
    const feishu = {
      listAllRecords: async (tableId) => tableId === 'orders' ? orders : purchases
    };
    const service = createStatisticsService(feishu, {
      TABLE_ORDERS: 'orders',
      TABLE_PURCHASES: 'purchases'
    });
    await expect(service.home('2026-08-23')).resolves.toEqual({
      todaySales: 320,
      todayDealCount: 2,
      todayPurchase: 80,
      monthSales: 320
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:worker`

Expected: FAIL，因为 `worker/services/orders.js` 尚不存在。

- [ ] **Step 3: 提取基础资料服务**

Each basic service must expose `list`, `create` and `remove` and receive `(feishu, env)` through a factory. Example public interface:

```javascript
export function createCustomersService(feishu, env) {
  return {
    list,
    create,
    remove
  };
}
```

Implement identical factories for suppliers and products. Use the existing Chinese field names from `field-mappers.js`; deletion resolves the matching record first and deletes only that record.

- [ ] **Step 4: 实现订单服务的明确操作接口**

`createOrdersService(feishu, env)` must expose:

```javascript
return {
  list,
  createPreorder,
  ship,
  price,
  edit,
  bill,
  settle,
  remove
};
```

Do not expose a generic client-controlled status update. `ship` only allows `pending_ship → shipped`; `price` only allows `shipped → pending_bill`; `edit` resets eligible customer orders to `pending_bill`; `bill` validates the requested customer and every order; `settle` accepts only `unsettled` orders.

- [ ] **Step 5: 修复单号生成**

Implement a pure helper in `worker/services/orders.js`:

```javascript
export function nextDocumentId(prefix, date, existingIds) {
  const compactDate = date.replaceAll('-', '');
  const pattern = new RegExp(`^${prefix}${compactDate}(\\d{3})$`);
  const max = existingIds.reduce((current, id) => {
    const match = pattern.exec(id);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  if (max >= 999) throw new ValidationError('当日单据数量已达到上限', 409);
  return `${prefix}${compactDate}${String(max + 1).padStart(3, '0')}`;
}
```

Before creation, re-query that date and retry allocation up to three times if the candidate already exists in the fresh result. Return409 after the third collision.

- [ ] **Step 6: 提取进货和统计服务**

`createPurchasesService` exposes `list`, `create` and `remove`. `createStatisticsService` exposes `home` and `details`; both use `listAllRecords`, so statistics include every page.

- [ ] **Step 7: 用精确路由调用服务**

Replace generic status updates with these routes:

```text
POST   /api/orders
PUT    /api/orders/:id/ship
PUT    /api/orders/:id/price
PUT    /api/orders/:id
DELETE /api/orders/:id
POST   /api/orders/bill
POST   /api/orders/settle
```

Keep the old `PUT /api/orders/:id` payload compatible during the deployment window by translating recognized old payloads to `ship`, `price` or `edit` inside the router. The new front end will use the explicit routes.

Wrap route execution in one error boundary. Return `ValidationError.status` for validation/state conflicts,502 for Feishu upstream failures, and500 for unknown failures. Generate a request ID with `crypto.randomUUID()` and include it in the response header `X-Request-Id`. Log only `{ requestId, method, path, status, durationMs }`; do not log request bodies, tokens, telephone numbers or Feishu credentials.

- [ ] **Step 8: 运行 Worker 测试**

Run: `npm run test:worker`

Expected: 状态、跨客户批量开单、分页统计、单号和基线测试全部通过。

- [ ] **Step 9: 提交业务服务拆分**

Run:

```bash
git add worker tests/worker
git commit -m "refactor: isolate worker business services"
```

---

### Task 7: 加入统一密码登录、接口保护和受限 CORS

**Files:**
- Create: `worker/auth.js`
- Create: `tests/worker/auth.test.js`
- Create: `tests/worker/router-auth.test.js`
- Modify: `wrangler.toml`
- Modify: `worker/index.js`
- Modify: `index.html`

- [ ] **Step 1: 写令牌失败测试**

Create `tests/worker/auth.test.js`:

```javascript
import { describe, expect, it } from 'vitest';
import { issueToken, verifyToken } from '../../worker/auth.js';

describe('auth token', () => {
  it('accepts a valid token', async () => {
    const token = await issueToken('test-secret', 1_000, 30 * 24 * 60 * 60);
    await expect(verifyToken(token, 'test-secret', 2_000)).resolves.toMatchObject({ version: 1 });
  });

  it('rejects expired and tampered tokens', async () => {
    const token = await issueToken('test-secret', 1_000, 1);
    await expect(verifyToken(token, 'test-secret', 3_000)).rejects.toThrow('登录已过期');
    await expect(verifyToken(`${token}x`, 'test-secret', 1_500)).rejects.toThrow('登录凭证无效');
  });
});
```

- [ ] **Step 2: 写路由保护失败测试**

Create `tests/worker/router-auth.test.js`:

```javascript
import { describe, expect, it } from 'vitest';
import worker from '../../worker/index.js';

const env = {
  SHOP_PASSWORD_SALT: 'AAAAAAAAAAAAAAAAAAAAAA==',
  SHOP_PASSWORD_HASH: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  AUTH_SECRET: 'test-signing-secret-with-enough-length',
  ALLOWED_ORIGINS: 'https://test'
};

describe('router authentication', () => {
  it('keeps health public', async () => {
    expect((await worker.fetch(new Request('https://test/api/health'), env)).status).toBe(200);
  });

  it('protects business endpoints', async () => {
    expect((await worker.fetch(new Request('https://test/api/customers'), env)).status).toBe(401);
  });

  it('rejects an incorrect shop password', async () => {
    const response = await worker.fetch(new Request('https://test/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://test' },
      body: JSON.stringify({ password: 'wrong' })
    }), env);
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm run test:worker`

Expected: FAIL，因为 `auth.js` 和登录路由尚不存在。

- [ ] **Step 4: 实现密码验证和30天 HMAC 令牌**

Create `worker/auth.js` exporting:

```javascript
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return decodeBase64(padded);
}

function timingSafeEqual(left, right) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function importHmacKey(secret, usages) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages
  );
}

export async function verifyPassword(password, saltBase64, expectedHashBase64) {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: decodeBase64(saltBase64),
    iterations: 210000,
    hash: 'SHA-256'
  }, passwordKey, 256));
  return timingSafeEqual(derived, decodeBase64(expectedHashBase64));
}

export async function issueToken(secret, nowMs = Date.now(), ttlSeconds = TOKEN_TTL_SECONDS) {
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    version: 1,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds
  })));
  const key = await importHmacKey(secret, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return `${payload}.${encodeBase64Url(signature)}`;
}

export async function verifyToken(token, secret, nowMs = Date.now()) {
  try {
    const [payload, encodedSignature, extra] = String(token).split('.');
    if (!payload || !encodedSignature || extra) throw new Error('invalid');
    const key = await importHmacKey(secret, ['sign']);
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
    if (!timingSafeEqual(expected, decodeBase64Url(encodedSignature))) throw new Error('invalid');
    const value = JSON.parse(decoder.decode(decodeBase64Url(payload)));
    if (value.exp <= Math.floor(nowMs / 1000)) throw new Error('expired');
    return value;
  } catch (error) {
    if (error.message === 'expired') throw new Error('登录已过期');
    throw new Error('登录凭证无效');
  }
}

export function readBearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  return match?.[1] || '';
}
```

Implementation requirements:

- `verifyPassword` derives 256 bits with PBKDF2-SHA-256 and 210000 iterations.
- `issueToken` signs a base64url JSON payload `{ version: 1, iat, exp }` with HMAC-SHA-256.
- `verifyToken` compares signatures byte by byte without early return, then checks `exp`.
- `readBearerToken` only accepts the `Bearer` scheme.
- No function logs the password, password hash, signing secret or token.

- [ ] **Step 5: 配置 Worker**

Create `wrangler.toml`:

```toml
name = "seafood-billing-api"
main = "worker/index.js"
compatibility_date = "2026-08-23"
compatibility_flags = ["nodejs_compat"]

[vars]
ALLOWED_ORIGINS = "https://iceqis.github.io"
APP_VERSION = "3.1.0"

[env.dev.vars]
ALLOWED_ORIGINS = "http://localhost:4173"
APP_VERSION = "3.1.0-dev"
```

- [ ] **Step 6: 在路由入口应用鉴权和 CORS**

Router order:

```javascript
if (request.method === 'OPTIONS') return handleOptions(request, env);
if (path === '/api/health' && request.method === 'GET') return health(env, cors);
if (path === '/api/auth/login' && request.method === 'POST') return login(request, env, cors);
await requireAuthentication(request, env);
return routeProtectedRequest(request, env, url, cors);
```

Reject an `Origin` not in `ALLOWED_ORIGINS` with403. Requests without an `Origin` are allowed only for health checks and authenticated API clients.

- [ ] **Step 7: 增加受保护的数据源检查**

Add `GET /api/health/data-source`, which requests a Feishu tenant token and verifies that each configured table ID can return one record. Return only table availability booleans; do not return records or credentials.

- [ ] **Step 8: 在单文件前端加入可用的过渡登录界面**

Before the later module extraction, make the current single-file front end compatible with protected APIs:

```javascript
const SESSION_KEY = 'seafood_billing_session';

function getSessionToken() {
  return localStorage.getItem(SESSION_KEY) || '';
}

function saveSessionToken(token) {
  localStorage.setItem(SESSION_KEY, token);
}

function clearSessionToken() {
  localStorage.removeItem(SESSION_KEY);
}
```

Add a login form before the application container. On submit, call `POST /api/auth/login`, save `data.token`, hide the login view and call `init()`. Update `apiRequest` to add `Authorization: Bearer <token>`. If a response is401, clear the token, hide all business pages and show `登录已过期，请重新登录`.

Remove the unconditional final `init()` call and replace it with:

```javascript
if (getSessionToken()) {
  showApplication();
  init();
} else {
  showLogin();
}
```

- [ ] **Step 9: 运行全部 Worker 和前端测试**

Run:

```bash
npm run test:worker
npm run test:frontend
```

Expected: 登录、过期、篡改、未授权、CORS、业务服务、分页和前端基线测试全部通过。

- [ ] **Step 10: 提交鉴权功能**

Run:

```bash
git add worker tests/worker wrangler.toml index.html
git commit -m "feat: protect api with shared shop login"
```

---

### Task 8: 拆分前端公共模块和 CSS

**Files:**
- Create: `assets/css/base.css`
- Create: `assets/css/components.css`
- Create: `assets/css/pages.css`
- Create: `assets/css/responsive.css`
- Create: `assets/js/config.js`
- Create: `assets/js/state.js`
- Create: `assets/js/utils.js`
- Create: `assets/js/api-client.js`
- Create: `tests/frontend/utils.test.js`
- Create: `tests/frontend/api-client.test.js`
- Modify: `index.html`

- [ ] **Step 1: 写前端工具失败测试**

Create `tests/frontend/utils.test.js`:

```javascript
import { describe, expect, it } from 'vitest';
import { formatMoney, getLocalDate, setText } from '../../assets/js/utils.js';

describe('frontend utils', () => {
  it('formats money consistently', () => {
    expect(formatMoney(5)).toBe('¥5.00');
    expect(formatMoney(5.126)).toBe('¥5.13');
  });

  it('uses the local calendar date', () => {
    expect(getLocalDate(new Date(2026, 7, 23, 1))).toBe('2026-08-23');
  });

  it('renders business text without interpreting HTML', () => {
    const element = document.createElement('div');
    setText(element, '<img src=x onerror=alert(1)>');
    expect(element.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(element.querySelector('img')).toBeNull();
  });
});
```

- [ ] **Step 2: 写 API 客户端失败测试**

Create `tests/frontend/api-client.test.js`:

```javascript
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../assets/js/api-client.js';

function createClient(fetchImpl, onUnauthorized = vi.fn()) {
  return {
    client: createApiClient({
      apiBase: 'https://api.test',
      getToken: () => 'test-token',
      onUnauthorized,
      timeoutMs: 10,
      fetchImpl
    }),
    onUnauthorized
  };
}

describe('api client', () => {
  it('adds the bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      message: 'success',
      data: []
    }), { status: 200 }));
    const { client } = createClient(fetchMock);
    await client.get('/api/customers');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/api/customers',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' })
      })
    );
  });

  it('reports unauthorized responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 401,
      message: '登录已过期',
      data: null
    }), { status: 401 }));
    const { client, onUnauthorized } = createClient(fetchMock);
    await expect(client.get('/api/customers')).rejects.toThrow('登录已过期');
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('converts aborts to a friendly timeout message', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const { client } = createClient(fetchMock);
    await expect(client.get('/api/customers'))
      .rejects.toThrow('网络连接超时，请稍后重试');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm run test:frontend`

Expected: FAIL，因为公共前端模块尚不存在。

- [ ] **Step 4: 实现公共模块**

Create `assets/js/config.js`:

```javascript
export const APP_CONFIG = Object.freeze({
  apiBase: 'https://seafood-billing-api.iceqy0313.workers.dev',
  version: '3.1.0',
  requestTimeoutMs: 15000
});
```

Create `assets/js/state.js`:

```javascript
export const state = {
  customers: [],
  suppliers: [],
  products: [],
  orders: [],
  purchases: [],
  currentCustomer: '',
  selectedOrderIds: new Set()
};
```

Create `assets/js/utils.js` with `getLocalDate`, `formatMoney`, `setText`, `createElement`, `showLoading`, `hideLoading` and `showToast`. All user-visible business strings must be assigned through `textContent`.

Create `assets/js/api-client.js` as a factory:

```javascript
export function createApiClient({ apiBase, getToken, onUnauthorized, timeoutMs, fetchImpl = fetch }) {
  return {
    get: (path) => request(path, { method: 'GET' }),
    post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) }),
    put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (path) => request(path, { method: 'DELETE' })
  };

  async function request(path, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const token = getToken();
      const response = await fetchImpl(`${apiBase}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      });
      const body = await response.json();
      if (response.status === 401) onUnauthorized();
      if (!response.ok || body.code !== 0) throw new Error(body.message || '请求失败');
      return body.data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('网络连接超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

- [ ] **Step 5: 拆分 CSS 并保持视觉基线**

Move existing rules without changing declarations:

- CSS variables, reset, typography and utilities → `base.css`
- navigation, buttons, cards, forms, modal, toast and loading → `components.css`
- home, preorder, order, customer, purchase, product and profile layouts → `pages.css`
- all media queries → `responsive.css`

Replace the inline `<style>` with:

```html
<link rel="stylesheet" href="./assets/css/base.css">
<link rel="stylesheet" href="./assets/css/components.css">
<link rel="stylesheet" href="./assets/css/pages.css">
<link rel="stylesheet" href="./assets/css/responsive.css">
```

- [ ] **Step 6: 运行前端测试和页面语法检查**

Run:

```bash
npm run test:frontend
node -e "import('./assets/js/api-client.js').then(()=>console.log('modules ok'))"
```

Expected: 前端测试全部通过并输出 `modules ok`。

- [ ] **Step 7: 提交公共模块拆分**

Run:

```bash
git add index.html assets tests/frontend
git commit -m "refactor: extract frontend core modules"
```

---

### Task 9: 加入前端登录界面和登录保持

**Files:**
- Create: `assets/js/auth.js`
- Create: `tests/frontend/auth.test.js`
- Modify: `index.html`
- Create: `assets/js/app.js`
- Modify: `assets/js/api-client.js`
- Modify: `assets/css/components.css`

- [ ] **Step 1: 写登录状态失败测试**

Create `tests/frontend/auth.test.js`:

```javascript
import { beforeEach, describe, expect, it } from 'vitest';
import { createAuthStore } from '../../assets/js/auth.js';

describe('auth store', () => {
  beforeEach(() => localStorage.clear());

  it('persists only the signed token', () => {
    const auth = createAuthStore(localStorage);
    auth.saveToken('signed-token');
    expect(auth.getToken()).toBe('signed-token');
    expect(JSON.stringify(localStorage)).not.toContain('password');
  });

  it('clears the token on logout', () => {
    const auth = createAuthStore(localStorage);
    auth.saveToken('signed-token');
    auth.clear();
    expect(auth.getToken()).toBe('');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:frontend`

Expected: FAIL，因为 `auth.js` 尚不存在。

- [ ] **Step 3: 实现令牌存储和登录请求**

Create `assets/js/auth.js`:

```javascript
const TOKEN_KEY = 'seafood_billing_session';

export function createAuthStore(storage) {
  return {
    getToken: () => storage.getItem(TOKEN_KEY) || '',
    saveToken: (token) => storage.setItem(TOKEN_KEY, token),
    clear: () => storage.removeItem(TOKEN_KEY)
  };
}

export async function login(apiBase, password, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0) throw new Error(body.message || '登录失败');
  return body.data.token;
}
```

- [ ] **Step 4: 添加登录视图**

Add a `#login-view` containing one password input, one submit button and one error region. Add `#app-view` around the existing application. Do not put the password into query parameters, URL fragments, logs or analytics.

Login behavior:

```javascript
if (authStore.getToken()) {
  showApp();
  await initializeHome();
} else {
  showLogin();
}
```

On401, clear the token, hide business content and show `登录已过期，请重新登录`.

- [ ] **Step 5: 添加退出登录**

Connect the profile page logout button to:

```javascript
authStore.clear();
state.customers = [];
state.suppliers = [];
state.products = [];
state.orders = [];
state.purchases = [];
showLogin();
```

- [ ] **Step 6: 运行登录和回归测试**

Run: `npm run test:frontend`

Expected: 登录状态、API 客户端和工具测试全部通过。

- [ ] **Step 7: 提交前端登录**

Run:

```bash
git add index.html assets tests/frontend
git commit -m "feat: add persistent shop login ui"
```

---

### Task 10: 将各业务页面迁移为独立模块

**Files:**
- Modify: `assets/js/app.js`
- Create: `assets/js/pages/home.js`
- Create: `assets/js/pages/preorder.js`
- Create: `assets/js/pages/orders.js`
- Create: `assets/js/pages/customers.js`
- Create: `assets/js/pages/purchases.js`
- Create: `assets/js/pages/products.js`
- Create: `assets/js/pages/profile.js`
- Create: `tests/frontend/orders-page.test.js`
- Create: `tests/frontend/customers-page.test.js`
- Modify: `index.html`

- [ ] **Step 1: 写订单页面失败测试**

Create `tests/frontend/orders-page.test.js`:

```javascript
import { describe, expect, it, vi } from 'vitest';
import { renderOrdersList } from '../../assets/js/pages/orders.js';

describe('orders page', () => {
  it('renders state-specific actions and treats names as text', () => {
    const container = document.createElement('div');
    renderOrdersList(container, [
      {
        id: 'XSD1', customer: '<script>测试客户</script>', product: '基围虾',
        spec: '30头', orderWeight: 5, actualWeight: 0, status: 'pending_ship'
      },
      {
        id: 'XSD2', customer: '安全客户', product: '基围虾',
        spec: '40头', orderWeight: 6, actualWeight: 6, status: 'shipped'
      }
    ], { onShip: vi.fn(), onPrice: vi.fn() });

    expect(container.textContent).toContain('去发货');
    expect(container.textContent).toContain('去定价');
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>测试客户</script>');
  });
});
```

- [ ] **Step 2: 写客户批量操作失败测试**

Create `tests/frontend/customers-page.test.js`:

```javascript
import { describe, expect, it } from 'vitest';
import { getBillingSelection, toggleSelectableOrder } from '../../assets/js/pages/customers.js';

const orders = [
  { id: 'XSD1', status: 'pending_bill', amount: 120 },
  { id: 'XSD2', status: 'unsettled', amount: 200 },
  { id: 'XSD3', status: 'settled', amount: 300 }
];

describe('customer billing selection', () => {
  it('separates bill and settle actions and excludes settled orders', () => {
    expect(getBillingSelection(orders, new Set(['XSD1', 'XSD2', 'XSD3']))).toEqual({
      selectedCount: 2,
      selectedAmount: 320,
      pendingBillIds: ['XSD1'],
      unsettledIds: ['XSD2']
    });
  });

  it('does not select a settled order', () => {
    expect(toggleSelectableOrder(new Set(), orders[2])).toEqual(new Set());
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm run test:frontend`

Expected: FAIL，因为页面模块尚不存在。

- [ ] **Step 4: 迁移首页和导航**

`home.js` owns `loadHomeStats`, statistic cards and detail drawers. `app.js` owns navigation and calls each page module through this interface:

```javascript
const pages = {
  home: createHomePage(dependencies),
  preorder: createPreorderPage(dependencies),
  orders: createOrdersPage(dependencies),
  customers: createCustomersPage(dependencies),
  purchase: createPurchasesPage(dependencies),
  products: createProductsPage(dependencies),
  profile: createProfilePage(dependencies)
};

await pages[pageName].enter();
```

- [ ] **Step 5: 迁移预订单模块**

`preorder.js` owns customer/product/spec linkage, form validation, preview and save. Save through `POST /api/orders`, then clear the form and navigate to orders only after the API succeeds.

- [ ] **Step 6: 迁移订单模块**

`orders.js` owns date/search filters, shipping and pricing dialogs. Use explicit endpoints:

```javascript
await api.put(`/api/orders/${orderId}/ship`, { actualWeight });
await api.put(`/api/orders/${orderId}/price`, { price });
```

After success, reload the selected date and update home statistics.

Export `renderOrdersList(container, orders, handlers)` as a pure renderer. It must build cards with `document.createElement`, assign business strings through `textContent`, and attach `onShip`/`onPrice` with `addEventListener`.

- [ ] **Step 7: 迁移客户模块**

`customers.js` owns customer CRUD, customer order detail, selection, edit, bill and settle. Before batch requests, show the selected order count and total amount. Use:

```javascript
await api.post('/api/orders/bill', { ids: pendingBillIds, customer: currentCustomer });
await api.post('/api/orders/settle', { ids: unsettledIds });
```

Display the server's `successCount`, `skippedCount` and skipped reasons when a batch is partially successful.

Export these tested pure helpers:

```javascript
export function getBillingSelection(orders, selectedIds) {
  const selected = orders.filter((order) => selectedIds.has(order.id) && order.status !== 'settled');
  return {
    selectedCount: selected.length,
    selectedAmount: selected.reduce((sum, order) => sum + Number(order.amount || 0), 0),
    pendingBillIds: selected.filter((order) => order.status === 'pending_bill').map((order) => order.id),
    unsettledIds: selected.filter((order) => order.status === 'unsettled').map((order) => order.id)
  };
}

export function toggleSelectableOrder(selectedIds, order) {
  const next = new Set(selectedIds);
  if (order.status === 'settled') return next;
  if (next.has(order.id)) next.delete(order.id);
  else next.add(order.id);
  return next;
}
```

- [ ] **Step 8: 迁移进货、商品和我的页面**

`purchases.js` owns supplier CRUD and purchase records. `products.js` owns product/spec CRUD. `profile.js` displays version, data-source status and logout; the export button remains明确显示“请在飞书多维表格中导出”，不伪装成已实现功能。

- [ ] **Step 9: 移除内联脚本和事件属性**

Replace the final inline script with:

```html
<script type="module" src="./assets/js/app.js"></script>
```

Remove all `onclick`, `oninput` and `onchange` attributes. Register handlers through `addEventListener` inside the owning page module.

Add this initial Content Security Policy after all JavaScript has moved to external modules:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; connect-src 'self' https://seafood-billing-api.iceqy0313.workers.dev; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'">
```

`'unsafe-inline'` is limited to CSS because the existing page still contains inline layout styles; scripts remain restricted to same-origin module files.

- [ ] **Step 10: 运行前端和 Worker 回归测试**

Run:

```bash
npm run test:frontend
npm run test:worker
rg -n "on(click|input|change)=|innerHTML.*\$\{|<script>(.|[[:space:]])*</script>" index.html assets/js
```

Expected: 两套测试通过；`rg` 不应发现业务数据拼入内联事件或模板 HTML 的代码。

- [ ] **Step 11: 提交页面模块化**

Run:

```bash
git add index.html assets tests/frontend
git commit -m "refactor: split frontend business pages"
```

---

### Task 11: 建立完整端到端流程和响应式验收

**Files:**
- Create: `playwright.config.js`
- Create: `tests/e2e/mock-api.js`
- Create: `tests/e2e/order-lifecycle.spec.js`
- Create: `tests/e2e/responsive.spec.js`

- [ ] **Step 1: 配置 Playwright 本地服务**

Create `playwright.config.js`:

```javascript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'] } }
  ]
});
```

- [ ] **Step 2: 创建内存 API 模拟器**

`tests/e2e/mock-api.js` must intercept `**/api/**`, hold customers/products/orders/purchases in per-test memory, enforce the same five order states, and return the production response envelope `{ code, message, data }`. It must never forward a request to the production Worker.

- [ ] **Step 3: 写完整业务流程测试**

`tests/e2e/order-lifecycle.spec.js` performs:

```text
错误密码被拒绝
→ 正确密码登录
→ 新建预订单
→ 订单页显示待发货
→ 输入实际重量并发货
→ 输入单价并定价
→ 客户页统一开单
→ 结算订单
→ 首页成交笔数和销售额更新
→ 退出后业务页面不可见
```

Use role/label locators. Do not use coordinate clicks or arbitrary timeouts.

- [ ] **Step 4: 写响应式测试**

`tests/e2e/responsive.spec.js` verifies on both configured projects:

- 登录按钮、保存按钮和主要业务按钮可见且可点击。
- 页面没有水平溢出：`document.documentElement.scrollWidth <= window.innerWidth`。
- 手机菜单可以打开、选择页面并自动关闭。
- 表单标签与输入框通过 `label` 关联。

- [ ] **Step 5: 安装浏览器并运行端到端测试**

Run:

```bash
npx playwright install chromium
npm run test:e2e
```

Expected: desktop 和 mobile 项目全部通过，测试过程中生产 Worker 没有收到请求。

- [ ] **Step 6: 提交端到端测试**

Run:

```bash
git add playwright.config.js tests/e2e
git commit -m "test: cover complete order lifecycle"
```

---

### Task 12: 配置检查工作流和 `main` 自动部署

**Files:**
- Create: `scripts/build-pages.js`
- Create: `.github/workflows/checks.yml`
- Create: `.github/workflows/deploy.yml`
- Modify: `package.json`

- [ ] **Step 1: 创建确定性的 Pages 构建脚本**

Create `scripts/build-pages.js`:

```javascript
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('_site', { recursive: true, force: true });
await mkdir('_site', { recursive: true });
await cp('index.html', '_site/index.html');
await cp('assets', '_site/assets', { recursive: true });
```

Run:

```bash
npm run build:pages
test -f _site/index.html
test -f _site/assets/js/app.js
```

Expected: 两个文件检查都成功。

- [ ] **Step 2: 创建拉取请求检查工作流**

Create `.github/workflows/checks.yml`:

```yaml
name: Checks

on:
  pull_request:
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run check
      - run: npm run build:pages
```

- [ ] **Step 3: 创建生产部署工作流**

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy production

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: production
  cancel-in-progress: false

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run check

  deploy-worker:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
      - run: curl --fail --retry 5 --retry-delay 5 https://seafood-billing-api.iceqy0313.workers.dev/api/health
      - run: test "$(curl -sS -o /dev/null -w '%{http_code}' https://seafood-billing-api.iceqy0313.workers.dev/api/customers)" = "401"

  deploy-pages:
    needs: deploy-worker
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build:pages
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v4
        with:
          path: _site
      - id: deployment
        uses: actions/deploy-pages@v4
      - run: curl --fail --retry 5 --retry-delay 5 "${{ steps.deployment.outputs.page_url }}"
```

- [ ] **Step 4: 本地执行发布前检查**

Run:

```bash
npm run check
npm run build:pages
git diff --check
```

Expected: 所有命令退出码为0。

- [ ] **Step 5: 提交 CI/CD 配置**

Run:

```bash
git add scripts package.json package-lock.json .github
git commit -m "ci: test and deploy main automatically"
```

---

### Task 13: 配置生产密钥、执行受控验收并完善运维文档

**Files:**
- Create: `.dev.vars.example`
- Create: `scripts/generate-password-hash.js`
- Create: `docs/operations.md`
- Modify: `README.md`

- [ ] **Step 1: 创建无真实值的变量模板**

Create `.dev.vars.example`:

```dotenv
FEISHU_APP_ID=replace-with-app-id
FEISHU_APP_SECRET=replace-with-app-secret
FEISHU_BASE_TOKEN=replace-with-base-token
TABLE_CUSTOMERS=replace-with-table-id
TABLE_SUPPLIERS=replace-with-table-id
TABLE_PRODUCTS=replace-with-table-id
TABLE_ORDERS=replace-with-table-id
TABLE_PURCHASES=replace-with-table-id
SHOP_PASSWORD_SALT=replace-with-base64-salt
SHOP_PASSWORD_HASH=replace-with-base64-pbkdf2-hash
AUTH_SECRET=replace-with-random-signing-secret
```

- [ ] **Step 2: 编写生产配置说明**

Create `scripts/generate-password-hash.js`:

```javascript
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');
if (password.length < 10) {
  console.error('店铺密码至少需要10个字符');
  process.exit(1);
}
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, 210000, 32, 'sha256');
console.log(`SHOP_PASSWORD_SALT=${salt.toString('base64')}`);
console.log(`SHOP_PASSWORD_HASH=${hash.toString('base64')}`);
```

Generate the two values locally without placing the password in shell history:

```bash
read -s SHOP_PASSWORD_INPUT
printf '%s' "$SHOP_PASSWORD_INPUT" | node scripts/generate-password-hash.js
unset SHOP_PASSWORD_INPUT
```

Copy only the generated salt and hash into Cloudflare Secrets.

`docs/operations.md` must include these one-time Cloudflare commands without real values:

```bash
npx wrangler secret put FEISHU_APP_ID
npx wrangler secret put FEISHU_APP_SECRET
npx wrangler secret put FEISHU_BASE_TOKEN
npx wrangler secret put TABLE_CUSTOMERS
npx wrangler secret put TABLE_SUPPLIERS
npx wrangler secret put TABLE_PRODUCTS
npx wrangler secret put TABLE_ORDERS
npx wrangler secret put TABLE_PURCHASES
npx wrangler secret put SHOP_PASSWORD_SALT
npx wrangler secret put SHOP_PASSWORD_HASH
npx wrangler secret put AUTH_SECRET
```

Also document GitHub repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, GitHub Pages source “GitHub Actions”, password rotation, forced logout by rotating `AUTH_SECRET`, log inspection and rollback by reverting a known-good commit.

Document a Cloudflare rate-limiting rule for `/api/auth/login`: key by client IP, allow at most10 requests per minute, then block that IP for10 minutes. Verify the rule in the Cloudflare dashboard before production acceptance.

- [ ] **Step 3: 执行完整本地验证**

Run:

```bash
npm ci
npm run check
npm run build:pages
git diff --check
git status --short
```

Expected: 测试和构建通过；除计划内文档修改外没有未提交文件。

- [ ] **Step 4: 执行受控生产验收**

After secrets are configured and the user authorizes deployment, push `main`. Verify in this order:

```text
GitHub Actions test job succeeded
→ Worker deployment and health checks succeeded
→ Pages deployment succeeded
→ 未登录访问业务接口返回401
→ 正确密码可以登录
→ 五张表的数据源检查全部成功
→ 创建一条明确标记为“系统验收”的客户/商品/订单记录
→ 完成发货、定价、开单和结算
→ 首页与客户页面金额一致
→ 经用户确认后删除验收记录
```

Production record creation and deletion are external data changes. Stop immediately before those actions and obtain action-time confirmation from the user.

- [ ] **Step 5: 提交运维文档**

Run:

```bash
git add .dev.vars.example scripts/generate-password-hash.js docs/operations.md README.md
git commit -m "docs: add deployment and recovery runbook"
```

- [ ] **Step 6: 最终验收检查**

Run:

```bash
git log --oneline --decorate -15
git status --short --branch
```

Expected: 每个阶段都有独立提交，工作区干净，当前分支为 `main`。

---

## 实施检查点

- Task 3 完成后：当前线上业务阻断问题已修复，可单独发布紧急版本。
- Task 7 完成后：Worker API 已受统一密码保护，但旧前端仍通过兼容路由工作。
- Task 10 完成后：前后端模块化完成，旧兼容路由可以在下一独立版本中移除。
- Task 12 完成后：`main` 分支具备自动测试和部署能力。
- Task 13 完成后：生产密钥、验收、回滚和日常维护流程完整。

任何检查点失败时停止推进，保留当前稳定提交，不将后续阶段与失败阶段混合提交。
