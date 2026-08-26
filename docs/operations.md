# 生产部署与恢复手册

本手册中的 Cloudflare、GitHub 和生产数据操作都是待管理员执行的步骤。本地验证不得执行 secret 写入、推送、部署或生产数据变更。

## 首次密钥配置

1. 从 `.dev.vars.example` 复制本地 `.dev.vars`，只在本地替换占位符。`.dev.vars` 已被 Git 忽略，不得提交。
2. 为共享店铺密码生成盐和摘要。以下方式从 stdin 传入密码，不要把密码写在命令行、文件或日志中：

```bash
read -s SHOP_PASSWORD_INPUT
printf '%s' "$SHOP_PASSWORD_INPUT" | node scripts/generate-password-hash.js
unset SHOP_PASSWORD_INPUT
```

只复制生成的 salt 和 hash，不复制或记录原始密码。

3. 管理员登录正确的 Cloudflare 账号并确认 Worker 目标后，逐条执行下列命令。Wrangler 会交互式读取值；不要在命令后附加真实值。

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

4. 在 GitHub 仓库的 Settings → Secrets and variables → Actions 中创建两个 repository secret：`CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。Token 只授予部署该 Worker 所需的最小权限，两个值都不得出现在 workflow 、issue 或日志中。
5. 在 Settings → Pages 中将 GitHub Pages 的 Source 设为 **GitHub Actions**。

## 免费 Worker 登录挑战

登录页面在浏览器内使用 PBKDF2-SHA-256 和 210,000 次迭代派生 32 字节密钥，避免让 Cloudflare Workers Free 在单次请求中承担高成本 PBKDF2。不降低密码派生强度，也不需要改变任何飞书表字段。

1. 浏览器请求 `GET /api/auth/challenge`，Worker 返回有效期为 60 秒的签名登录挑战。
2. 浏览器用密码派生密钥，并对完整挑战令牌计算 HMAC 证明。
3. `POST /api/auth/login` 只发送 `challengeToken` 和 `proof`，Worker 用现有 `SHOP_PASSWORD_HASH` 快速验证后签发 30 天会话令牌。

原始密码只存在于浏览器当前函数内存中；挑战证明也不得出现在日志、本地存储或错误响应中。密码轮换仍同时更新 `SHOP_PASSWORD_SALT` 和 `SHOP_PASSWORD_HASH`，无需新增 secret。

## 登录限流

生产 Worker 通过 `wrangler.toml` 中的 Worker 原生 Rate Limiting binding `LOGIN_RATE_LIMITER` 保护 `POST /api/auth/login`：

- 以 Cloudflare 提供的客户端 IP 为键。
- 每 60 秒最多允许 10 次登录请求。
- 超限返回 HTTP 429 和 `Retry-After: 60`，下一个 60 秒窗口自动恢复。
- 计数由 Cloudflare 按数据中心维护，不写入飞书五张业务表，也不新增 KV 或 Durable Object。
- 限流基础设施异常时采用 fail-open，避免店铺完全无法登录；日志只记录固定事件名，不记录 IP、密码或服务异常详情。

生产验收时应确认第 11 次同 IP 登录请求返回 429，并在下一窗口恢复。Cloudflare 原生计数为最终一致，短时间并发测试可能存在轻微宽松。

## 密钥轮换

### 店铺密码

在维护时段用新密码重新运行生成脚本，然后轮换 `SHOP_PASSWORD_SALT` 和 `SHOP_PASSWORD_HASH`。两个 secret 更新之间可能短暂无法登录，应连续完成并立即验证新密码。不要删除或暴露旧值；在密码管理器中保留受控恢复记录。

### 强制所有会话退出

轮换 `AUTH_SECRET` 会使全部现有令牌立即失效，所有用户都需要重新登录。只在密钥疑似泄漏、人员变更或明确的强制退出窗口内操作，并在轮换后验证旧令牌返回 401、新登录可用。

## 日志与故障诊断

- 先检查 GitHub Actions 中对应提交的 test、Worker 和 Pages job 日志。Worker 验收失败时，Pages 不应继续部署。
- 挑战接口返回 HTTP 503 和“登录服务配置异常”时，检查 Worker 日志中固定事件 `auth_configuration_invalid`，再核对 salt 是否为 16 字节 Base64、hash 是否为 32 字节 Base64，以及 `AUTH_SECRET` 是否非空。不要在日志中打印实际值。
- 需要实时 Worker 日志时，管理员可在受控终端运行 `npx wrangler tail --format pretty`，完成后立即结束会话。
- 日志只应包含 request ID、方法、路径、状态码和耗时。若发现密码、令牌、secret 或业务记录，立即停止共享日志并按泄漏处理。

## 回滚

1. 记录当前失败的 workflow run 和提交 SHA，确认最后一个已知正常提交，并确认本地工作树无未保存更改。
2. 对已确认的故障提交创建可审计的反向提交：`git revert <faulty-commit-sha>`。不改写已发布历史。
3. 重新运行 `npm ci`、`npm run check` 和 `npm run build:pages`。通过变更审批后才允许推送 `main`，并按下方顺序重新验收。

## 生产验收顺序

在 secret、Pages Source 和限流绑定都已核对，且用户授权发布后，严格按以下顺序执行：

1. GitHub Actions test job 成功。
2. Worker 部署和健康检查成功。
3. 挑战接口返回 200。
4. Pages 部署成功。
5. 未登录访问业务接口返回 401。
6. 错误密码返回 401 和“店铺密码错误”，不再返回 500。
7. 正确密码可以登录。密码只在页面中输入，不在聊天或验收日志中提供。
8. 五张表的数据源检查全部成功。
9. 创建一条明确标记为“系统验收”的客户、商品和订单记录。这是生产数据写入；必须在操作前停止，并向用户请求当次二次确认。
10. 完成发货、定价、开单和结算。
11. 确认首页与客户页面金额一致。
12. 删除验收记录。这是生产数据删除；必须在操作前再次停止，并向用户请求当次二次确认。

任一步失败都应停止后续操作，保留对应提交 SHA 和 workflow 记录；未获得上述两次独立的操作时确认，不得创建或删除任何生产验收记录。
