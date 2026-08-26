# Worker Login Rate Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect `POST /api/auth/login` with Cloudflare Workers native per-IP rate limiting at 10 requests per 60 seconds without changing the five Feishu tables.

**Architecture:** Add a focused `worker/login-rate-limit.js` adapter around the Cloudflare Rate Limiting binding. The router calls it only after Origin validation and before reading or hashing the password; denial produces the existing JSON error envelope with HTTP 429 and `Retry-After: 60`, while missing or failed limiter infrastructure fails open with a static safe log entry.

**Tech Stack:** Cloudflare Workers ES modules, Wrangler 4.125.0, JavaScript, Vitest 3.2.7, Node.js test runner, GitHub Actions.

---

## File map

- Create `worker/login-rate-limit.js`: isolate IP-key selection and Cloudflare binding failure behavior.
- Create `tests/worker/login-rate-limit.test.js`: unit-test the adapter without exercising password hashing.
- Modify `worker/index.js`: apply the adapter to the login route and build the 429 response.
- Modify `tests/worker/router-auth.test.js`: verify route ordering, response headers, and PBKDF2 avoidance.
- Modify `wrangler.toml`: declare the production `LOGIN_RATE_LIMITER` binding.
- Create `tests/config/rate-limit.test.js`: lock the binding name, namespace, threshold, and window.
- Modify `docs/operations.md`: replace the obsolete WAF/10-minute instructions with the deployed Worker binding behavior.
- Modify `tests/config/operations.test.js`: verify the revised runbook claims.

### Task 1: Isolate the Cloudflare rate limiter adapter

**Files:**
- Create: `tests/worker/login-rate-limit.test.js`
- Create: `worker/login-rate-limit.js`

- [ ] **Step 1: Write the failing adapter tests**

Create `tests/worker/login-rate-limit.test.js`:

```js
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLoginRateLimit } from '../../worker/login-rate-limit.js';

function request(ip) {
  const headers = ip ? { 'CF-Connecting-IP': ip } : {};
  return new Request('https://worker.example/api/auth/login', { headers });
}

afterEach(() => vi.restoreAllMocks());

describe('login rate limiter adapter', () => {
  it('uses the client IP as the Cloudflare limiter key', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });

    await expect(checkLoginRateLimit(request('203.0.113.8'), {
      LOGIN_RATE_LIMITER: { limit }
    })).resolves.toBe(true);

    expect(limit).toHaveBeenCalledOnce();
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.8' });
  });

  it('uses one stable key when Cloudflare IP metadata is absent locally', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });

    await checkLoginRateLimit(request(), { LOGIN_RATE_LIMITER: { limit } });

    expect(limit).toHaveBeenCalledWith({ key: 'local-development' });
  });

  it('returns false when Cloudflare rejects the request', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });

    await expect(checkLoginRateLimit(request('203.0.113.9'), {
      LOGIN_RATE_LIMITER: { limit }
    })).resolves.toBe(false);
  });

  it.each([
    ['the binding is absent', {}],
    ['the binding throws', {
      LOGIN_RATE_LIMITER: { limit: vi.fn().mockRejectedValue(new Error('provider details')) }
    }]
  ])('fails open with a static safe log when %s', async (_name, env) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(checkLoginRateLimit(request('203.0.113.10'), env)).resolves.toBe(true);

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith({ event: 'login_rate_limiter_unavailable' });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('provider details');
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run:

```bash
npx vitest run --config vitest.worker.config.js tests/worker/login-rate-limit.test.js
```

Expected: FAIL because `worker/login-rate-limit.js` does not exist.

- [ ] **Step 3: Add the minimal adapter implementation**

Create `worker/login-rate-limit.js`:

```js
const LOCAL_DEVELOPMENT_KEY = 'local-development';

export async function checkLoginRateLimit(request, env) {
  const key = request.headers.get('CF-Connecting-IP')?.trim() || LOCAL_DEVELOPMENT_KEY;
  try {
    if (typeof env.LOGIN_RATE_LIMITER?.limit !== 'function') {
      throw new Error('rate limiter binding unavailable');
    }
    const result = await env.LOGIN_RATE_LIMITER.limit({ key });
    return result?.success !== false;
  } catch {
    console.error({ event: 'login_rate_limiter_unavailable' });
    return true;
  }
}
```

- [ ] **Step 4: Run the focused test and confirm the green state**

Run:

```bash
npx vitest run --config vitest.worker.config.js tests/worker/login-rate-limit.test.js
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit the isolated adapter**

```bash
git add worker/login-rate-limit.js tests/worker/login-rate-limit.test.js
git commit -m "feat: add worker login rate limiter adapter"
```

### Task 2: Apply rate limiting before password work

**Files:**
- Modify: `worker/index.js`
- Modify: `tests/worker/router-auth.test.js`

- [ ] **Step 1: Give every router test an allowed limiter by default**

Add the binding placeholder to the shared `env` object in `tests/worker/router-auth.test.js`:

```js
  AUTH_SECRET,
  LOGIN_RATE_LIMITER: null
```

Then extend the existing `beforeEach`:

```js
beforeEach(() => {
  env.LOGIN_RATE_LIMITER = {
    limit: vi.fn().mockResolvedValue({ success: true })
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
```

- [ ] **Step 2: Write the failing router limit test**

Add to the `authenticated Worker router` suite:

```js
  it('returns 429 before reading or hashing a rate-limited login', async () => {
    env.LOGIN_RATE_LIMITER.limit.mockResolvedValue({ success: false });
    const deriveSpy = vi.spyOn(crypto.subtle, 'deriveBits');

    const response = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.20'
      },
      body: JSON.stringify({ password: SHOP_PASSWORD })
    }), env);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    await expect(response.json()).resolves.toMatchObject({
      code: 429,
      message: '登录尝试过于频繁，请稍后再试'
    });
    expect(env.LOGIN_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: '203.0.113.20' });
    expect(deriveSpy).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run the router test and confirm the red state**

Run:

```bash
npx vitest run --config vitest.worker.config.js tests/worker/router-auth.test.js
```

Expected: the new test FAILS because the login route still returns 200 and has no `Retry-After` header.

- [ ] **Step 4: Integrate the adapter into the login route**

Add this import to `worker/index.js`:

```js
import { checkLoginRateLimit } from './login-rate-limit.js';
```

Add a focused wrapper immediately after `login()`:

```js
async function rateLimitedLogin(request, env) {
  if (!await checkLoginRateLimit(request, env)) {
    return withHeaders(
      errorResponse('登录尝试过于频繁，请稍后再试', 429),
      { 'Retry-After': '60' }
    );
  }
  return login(request, env);
}
```

Replace the allowed-Origin login call:

```js
        response = origin
          ? await rateLimitedLogin(request, env)
          : errorResponse('来源不允许', 403);
```

- [ ] **Step 5: Run the Worker suite**

Run:

```bash
npm run test:worker
```

Expected: all Worker tests pass, including the new adapter and 429 route tests.

- [ ] **Step 6: Commit the routed behavior**

```bash
git add worker/index.js tests/worker/router-auth.test.js
git commit -m "feat: rate limit shop login attempts"
```

### Task 3: Declare and document the production binding

**Files:**
- Modify: `wrangler.toml`
- Create: `tests/config/rate-limit.test.js`
- Modify: `docs/operations.md`
- Modify: `tests/config/operations.test.js`

- [ ] **Step 1: Write the failing Wrangler configuration test**

Create `tests/config/rate-limit.test.js`:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Wrangler declares the production login rate limiter exactly once', async () => {
  const config = await readFile(new URL('../../wrangler.toml', import.meta.url), 'utf8');

  assert.equal((config.match(/^\[\[ratelimits\]\]$/gm) ?? []).length, 1);
  assert.match(config, /^name = "LOGIN_RATE_LIMITER"$/m);
  assert.match(config, /^namespace_id = "2026082601"$/m);
  assert.match(config, /^\s*\[ratelimits\.simple\]$/m);
  assert.match(config, /^\s*limit = 10$/m);
  assert.match(config, /^\s*period = 60$/m);
});
```

- [ ] **Step 2: Update the runbook assertions to the confirmed behavior**

In `tests/config/operations.test.js`, replace the two obsolete assertions:

```js
  assert.match(runbook, /Worker 原生 Rate Limiting binding/);
  assert.match(runbook, /客户端 IP/);
  assert.match(runbook, /每 60 秒最多 10 次/);
  assert.match(runbook, /下一(?:个 )?60 秒窗口/);
  assert.match(runbook, /HTTP 429/);
  assert.doesNotMatch(runbook, /封禁 10 分钟/);
```

- [ ] **Step 3: Run config tests and confirm both red failures**

Run:

```bash
npm run test:config
```

Expected: FAIL because the binding is absent and the runbook still describes a WAF rule with a 10-minute block.

- [ ] **Step 4: Add the production binding**

Add to `wrangler.toml` before `[env.dev.vars]`:

```toml
[[ratelimits]]
name = "LOGIN_RATE_LIMITER"
namespace_id = "2026082601"

  [ratelimits.simple]
  limit = 10
  period = 60
```

- [ ] **Step 5: Replace the obsolete runbook section**

Replace `docs/operations.md` section `## 登录限流` with:

```markdown
## 登录限流

生产 Worker 通过 `wrangler.toml` 中的 Worker 原生 Rate Limiting binding `LOGIN_RATE_LIMITER` 保护 `POST /api/auth/login`：

- 以 Cloudflare 提供的客户端 IP 为键。
- 每 60 秒最多允许 10 次登录请求。
- 超限返回 HTTP 429 和 `Retry-After: 60`，下一个 60 秒窗口自动恢复。
- 计数由 Cloudflare 按数据中心维护，不写入飞书五张业务表，也不新增 KV 或 Durable Object。
- 限流基础设施异常时采用 fail-open，避免店铺完全无法登录；日志只记录固定事件名，不记录 IP、密码或服务异常详情。

生产验收时应确认第 11 次同 IP 登录请求返回 429，并在下一窗口恢复。Cloudflare 原生计数为最终一致，短时间并发测试可能存在轻微宽松。
```

- [ ] **Step 6: Validate the config and runbook**

Run:

```bash
npm run test:config
npx wrangler deploy --dry-run
```

Expected: all config tests pass; Wrangler completes a dry-run bundle and recognizes `LOGIN_RATE_LIMITER` without deploying.

- [ ] **Step 7: Commit configuration and operations docs**

```bash
git add wrangler.toml tests/config/rate-limit.test.js docs/operations.md tests/config/operations.test.js
git commit -m "chore: configure production login rate limiting"
```

### Task 4: Run release verification

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run all automated tests**

Run:

```bash
npm test
npm run test:e2e
```

Expected: frontend, Worker, and config suites pass; E2E reports 3 passed and 1 intentional production-only skip.

- [ ] **Step 2: Rebuild the Pages artifact**

Run:

```bash
npm run build:pages
```

Expected: `_site/index.html` and `_site/assets/` are rebuilt successfully with no secret files.

- [ ] **Step 3: Scan the tracked diff for secrets and whitespace errors**

Run:

```bash
git diff --check publish/main...HEAD
git grep -nE '(sk-[A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9._-]{20,}|SHOP_PASSWORD_(SALT|HASH)=|AUTH_SECRET=)' -- ':!*.example' ':!docs/superpowers/plans/*'
```

Expected: `git diff --check` exits 0; the secret scan has no production secret values.

- [ ] **Step 4: Confirm the release remains a clean fast-forward**

Run:

```bash
git merge-base --is-ancestor publish/main HEAD
git status --short
git log --oneline publish/main..HEAD
```

Expected: ancestor check exits 0, status is clean, and only reviewed optimization plus rate-limit commits are ahead of `publish/main`.
