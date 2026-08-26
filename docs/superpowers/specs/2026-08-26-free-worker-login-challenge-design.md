# 免费 Worker 登录挑战协议设计

## 背景与根因

生产登录接口在收到任意密码时返回 HTTP `500` 和“服务器内部错误”。密码密钥重新按纯 Base64 值配置后，现象仍然稳定复现。当前 Worker 在每次登录中执行 210,000 次 PBKDF2；本地同一路径单次实测约 146ms，而 Cloudflare Workers Free 每次 HTTP 请求的 CPU 限额为 10ms。

Cloudflare Workers 支持 Web Crypto PBKDF2，但当前服务端迭代量与免费 CPU 限额不兼容。修复方案把高成本 PBKDF2 移到用户浏览器，将 Worker 侧校验改为快速 HMAC 挑战验证。

参考：

- <https://developers.cloudflare.com/workers/runtime-apis/web-crypto/>
- <https://developers.cloudflare.com/workers/platform/limits/>

## 目标

- 继续使用 Cloudflare Workers Free，不购买付费计算额度。
- 保留 PBKDF2-SHA-256、210,000 次迭代和 32 字节派生结果，不降低密码派生强度。
- 原始店铺密码只在浏览器内存中使用，不发送到 Worker、不写入日志、不保存到浏览器存储。
- 使用 60 秒有效的签名挑战，避免把长期可复用的 PBKDF2 派生结果直接作为登录凭证发送。
- 保持现有 30 天登录令牌、每 IP 每 60 秒 10 次登录限流和 CORS 策略。
- 继续使用现有 `SHOP_PASSWORD_SALT`、`SHOP_PASSWORD_HASH` 和 `AUTH_SECRET`，不新增生产 secret。
- 完全兼容现有五张飞书表，不改字段、不迁移数据，也不新增 KV、Durable Object 或其他存储。

## 非目标

- 不实现账号体系、多用户密码、短信验证码或第三方身份提供商。
- 不实现挑战的全局单次消费记录。没有服务端状态时，同一挑战及证明在 60 秒有效期内理论上可重放。
- 不修改业务 API、飞书字段映射或业务数据展示逻辑。
- 不在本变更中执行任何生产飞书记录的创建、修改或删除。

## 方案比较

### 采用：浏览器 PBKDF2 + 60 秒签名挑战

浏览器派生 32 字节密码密钥，再使用该密钥对短期挑战令牌计算 HMAC。Worker 用已保存的 `SHOP_PASSWORD_HASH` 字节执行同一个快速 HMAC 并做恒定时间比较。

该方案保留高迭代次数，Worker 只承担低成本签名与比较；挑战过期后，截获的证明不能继续用于新登录。

### 不采用：直接发送 PBKDF2 派生结果

实现更简单，但派生结果会成为长期可重放的密码等价物，直到店铺密码轮换，不满足本项目的安全偏好。

### 不采用：降低服务端 PBKDF2 迭代次数

虽然改动较少，但会降低抗离线破解能力，而且 10ms 免费 CPU 上限缺少稳定余量，未来仍可能出现生产超时。

## 协议与数据流

### 1. 获取挑战

浏览器向 `GET /api/auth/challenge` 发起跨域请求。Worker 继续要求请求 `Origin` 位于 `ALLOWED_ORIGINS`。

生成挑战前，Worker 先严格验证当前盐值可解码为 16 字节、密码哈希可解码为 32 字节，并确认 `AUTH_SECRET` 非空。任一检查失败都直接返回安全的 `503`，不把无效参数发送给浏览器。

Worker 生成以下挑战载荷：

```json
{
  "version": 1,
  "nonce": "16-byte-random-base64url",
  "salt": "SHOP_PASSWORD_SALT",
  "iterations": 210000,
  "hash": "SHA-256",
  "iat": 1787710000,
  "exp": 1787710060
}
```

载荷使用稳定 JSON 字段顺序编码为 Base64URL，并用现有 `AUTH_SECRET` 进行 HMAC-SHA-256 签名。挑战令牌格式为：

```text
base64url(payload).base64url(signature)
```

成功响应继续使用现有 API 信封：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "challengeToken": "payload.signature",
    "salt": "base64-salt",
    "iterations": 210000,
    "hash": "SHA-256",
    "expiresAt": 1787710060
  }
}
```

盐值不是密码或长期凭证，可以安全返回给浏览器。Worker 仍把当前盐值保存在 secret 中，以保持现有运维方式不变。

### 2. 浏览器生成证明

浏览器收到挑战后：

1. 严格验证响应字段类型、迭代次数、算法和过期时间。
2. 使用用户输入的店铺密码、返回的盐值、PBKDF2-SHA-256 和 210,000 次迭代派生 32 字节密钥。
3. 以派生密钥作为 HMAC-SHA-256 key，以完整 `challengeToken` UTF-8 字节作为消息，生成 32 字节证明。
4. 将证明编码为无填充 Base64URL。
5. 立即清空密码输入框，只在当前函数作用域内保留派生结果，完成请求后释放引用。

浏览器向 `POST /api/auth/login` 发送：

```json
{
  "challengeToken": "payload.signature",
  "proof": "base64url-hmac-proof"
}
```

请求体不再包含 `password` 字段。

### 3. Worker 验证证明

现有登录限流仍在读取请求体之前执行。通过限流后，Worker：

1. 严格验证请求体只包含非空的 `challengeToken` 和 `proof`。
2. 验证挑战令牌 HMAC 签名、载荷固定形状、版本、签发时间和 60 秒有效期。
3. 验证载荷内的盐值、迭代次数和算法与当前 Worker 配置完全一致，使密码轮换后的旧挑战立即失效。
4. 严格解码 `SHOP_PASSWORD_HASH`，要求它是标准 Base64 且恰好得到 32 字节。
5. 以这 32 字节作为 HMAC key，对完整 `challengeToken` 计算预期证明。
6. 严格解码客户端证明并执行恒定时间比较。
7. 验证成功后，沿用现有 `AUTH_SECRET` 签发 30 天登录令牌。

Worker 不再对用户密码执行 PBKDF2，因此登录请求满足免费 CPU 额度。

## 前端行为

- `assets/js/auth.js` 负责获取挑战、调用浏览器 Web Crypto、生成证明和提交登录请求。
- 登录按钮在计算期间保持禁用，并显示“正在安全验证…”，避免重复提交。
- 密码输入框在读取后立即清空；成功与失败时都不保存密码或派生结果。
- 浏览器仍只在现有存储键中保存签名登录令牌。
- 挑战过期时自动重新获取一次挑战并重试证明流程；其他错误不自动重复登录。
- 旧页面若仍发送 `password` 字段，Worker 返回 `400` 和“登录协议已更新，请刷新页面”，不执行服务端 PBKDF2。

## 错误处理与安全日志

- 缺少或畸形请求字段：HTTP `400`，返回统一客户端错误，不回显请求内容。
- 密码证明错误：HTTP `401`，返回“店铺密码错误”。
- 挑战过期：HTTP `401`，返回“登录请求已过期，请重试”。
- 登录限流拒绝：保持 HTTP `429` 和 `Retry-After: 60`。
- 盐、哈希或签名 secret 配置无效：HTTP `503`，返回“登录服务配置异常”，日志只记录固定事件 `auth_configuration_invalid`。
- 挑战签名或载荷无效：HTTP `401`，不记录令牌、证明、IP、密码或底层加密异常。
- 普通请求日志继续只包含 request ID、方法、路径、状态码和耗时。

## 安全边界

- HTTPS 和现有 CORS 白名单仍是传输边界。
- 挑战随机数使用 `crypto.getRandomValues` 生成 16 字节随机值。
- 挑战签名防止攻击者修改盐值、迭代参数或有效期。
- 密码证明绑定完整挑战令牌，不能用于另一个挑战。
- 在不增加 KV 或 Durable Object 的前提下，挑战无法做到服务端单次消费；最坏重放窗口被限制为 60 秒。
- 每 IP 每分钟 10 次登录限制继续降低在线猜测风险。
- `SHOP_PASSWORD_HASH` 仍是 PBKDF2 派生结果；密码轮换继续使用现有生成脚本，无需迁移飞书数据。

## 配置与兼容性

- `wrangler.toml` 的 Rate Limiting binding、Allowed Origins 和五张飞书表变量保持不变。
- 不新增或删除 Cloudflare secrets。
- 不修改五张飞书表的名称、字段、记录或表 ID。
- 业务 API 和响应结构保持不变。
- 登录协议发生前后端同步变更，应用版本升级到 `3.2.0`。
- 当前生产登录已经不可用，因此 Worker 先部署、Pages 后部署产生的短暂协议不一致不会造成额外业务数据风险；新 Pages 发布完成后执行登录验收。

## 测试策略

### 前端单元测试

- 使用固定密码、盐值和挑战令牌验证 PBKDF2/HMAC 已知结果。
- 验证获取挑战后提交的请求只包含 `challengeToken` 和 `proof`，不包含密码。
- 验证密码输入框立即清空，按钮在计算期间禁用。
- 验证挑战过期只自动重试一次，避免无限循环。
- 验证网络、400、401、429 和 503 错误信息。

### Worker 单元测试

- 验证挑战随机数、签名、固定载荷形状和 60 秒有效期。
- 验证挑战接口会在盐、密码哈希或签名 secret 配置无效时返回安全的 503。
- 验证篡改、过期、未来签发、错误版本和错误参数挑战均被拒绝。
- 验证正确证明签发 30 天令牌，错误证明返回 401。
- 验证密码轮换后旧挑战失效。
- 验证错误配置返回 503 且安全日志不包含 secret、证明或底层异常。
- 验证旧 `password` 请求不会进入 PBKDF2。
- 验证限流仍先于请求解析和证明验证。

### 集成与端到端测试

- 更新 mock API 和登录生命周期测试以使用新协议。
- 重新运行前端、Worker、配置和 Playwright 全量测试。
- 构建 GitHub Pages 并执行 Wrangler dry-run，确认没有新增绑定或存储。

## 部署与生产验收

1. 将修复代码推送到 `main`，触发现有 GitHub Actions。
2. 云端完整测试通过后部署 Worker。
3. 验证健康接口、未登录业务接口和挑战接口。
4. 部署 GitHub Pages，并确认线上前端版本为 `3.2.0`。
5. 使用错误密码确认返回 401，而不是 500。
6. 用户只在网页中输入正确店铺密码，确认登录成功和 30 天令牌保存。
7. 只读检查 customers、suppliers、products、orders、purchases 五个数据源。
8. 未获得独立的生产写入确认前，不创建、修改或删除任何飞书记录。

## 回滚

- 使用可审计的反向提交回滚代码，不强制改写 `main` 历史。
- 回滚不修改 Cloudflare secrets 或飞书表。
- 上一版本在免费 Worker 上存在已知登录 500，因此回滚只能用于控制新代码风险，不能恢复登录能力；若新方案验证失败，应保留健康接口和未登录保护，并继续修复挑战协议。
