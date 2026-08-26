# Worker 登录限流设计

## 背景

生产 API 当前通过 `workers.dev` 对外提供服务，没有绑定用户自有的 Cloudflare Zone 或自定义域名。原计划中的 WAF Rate Limiting Rule 属于 Zone 级能力，不能直接作为当前 `workers.dev` 登录接口的可靠限流方案。

本变更改用 Cloudflare Workers 原生 Rate Limiting binding，在 Worker 内只对 `POST /api/auth/login` 执行限流。

## 目标

- 按客户端 IP 统计登录请求。
- 每个 Cloudflare 数据中心内，同一 IP 在 60 秒内最多允许 10 次登录请求。
- 第 11 次及后续请求返回 HTTP `429`；下一个 60 秒窗口自动恢复。
- 限流检查先于密码校验，避免错误密码暴力尝试消耗 PBKDF2 计算。
- 保持现有前端、Worker、GitHub Pages、Cloudflare Worker 和飞书多维表格技术栈。
- 不修改现有五张飞书表的字段，不迁移或写入任何限流数据。

## 非目标

- 不实现跨 Cloudflare 数据中心的全局精确计数。
- 不增加 KV、Durable Object 或其他持久化资源。
- 不实现超限后的额外 10 分钟封禁；限流窗口为 Cloudflare 原生支持的 60 秒。
- 不限制健康检查或已登录后的业务 API。

## 架构与数据流

在 `wrangler.toml` 中新增名为 `LOGIN_RATE_LIMITER` 的 Rate Limiting binding，配置独立的正整数命名空间、`limit = 10`、`period = 60`。

`POST /api/auth/login` 的处理顺序：

1. 读取 Cloudflare 提供的 `CF-Connecting-IP`。
2. 如果请求来自测试或本地环境且没有该请求头，使用稳定的本地回退键，不阻塞开发和测试。
3. 调用 `env.LOGIN_RATE_LIMITER.limit({ key })`。
4. 若结果为拒绝，返回统一 JSON 错误响应、HTTP `429`，并附带 `Retry-After: 60`。
5. 若结果为允许，继续现有 JSON 校验、密码 PBKDF2 校验和令牌签发流程。

限流器不可用或抛出异常时采用 fail-open：记录错误并继续密码校验，避免 Cloudflare 限流服务异常导致店铺完全无法登录。

## 接口行为

超限响应继续使用现有 API 信封格式，错误信息为“登录尝试过于频繁，请稍后再试”。前端沿用现有错误展示逻辑，不新增页面字段或交互。

## 测试

- Worker 单元测试验证登录路由会使用客户端 IP 调用限流绑定。
- 验证限流拒绝时返回 `429`、`Retry-After: 60`，且不会进入密码校验和令牌签发。
- 验证限流允许时，正确密码与错误密码行为保持不变。
- 验证限流器异常时 fail-open，现有登录仍可工作。
- 配置测试验证 binding 名称、命名空间、10 次上限和 60 秒周期。
- 重新运行完整前端、Worker、配置和 E2E 测试。

## 部署与回滚

限流配置与 Worker 代码一同通过现有 GitHub Actions 部署。若部署后出现登录异常，可将 `main` 回滚到上一提交，Wrangler 会恢复上一版本 Worker；五张飞书表不受影响。
