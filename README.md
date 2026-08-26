# 海鲜批发记账系统

海鲜批发业务的生产前端与 Cloudflare Worker 基线，包含订单、客户、库存及收付款等记账流程。

## 安装

```sh
npm ci
```

## 本地开发

复制 `.dev.vars.example` 为本地 `.dev.vars`，用开发值替换占位符，不要提交该文件。然后启动静态前端：

```sh
npm run dev
```

Worker 本地变量、店铺密码摘要生成和安全注意事项见 [运维手册](docs/operations.md)。

## 测试

```sh
npm run check
npm run build:pages
```

## 部署

Pull Request 会执行检查工作流。获得发布授权后，`main` 上的生产工作流才会依次测试、发布 Worker、验证 API 并发布 Pages。不要从本地绕过该流程直接部署。

## 运维

生产变量、限流、密钥轮换、日志、验收与回滚流程见 [docs/operations.md](docs/operations.md)。
