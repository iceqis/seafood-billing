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
