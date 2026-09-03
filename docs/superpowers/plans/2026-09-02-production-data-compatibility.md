# 生产数据兼容性修复实施计划

> 目标：在不修改现有五张飞书表结构和数据的前提下，修复客户列表读取、统计日期兼容和写入后刷新误报，并通过生产只读检查闭环验证。

## 任务 1：修复飞书筛选读取契约

**文件：**
- 修改：`tests/worker/feishu-client.test.js`
- 修改：`worker/feishu-client.js`

**步骤：**
1. 将筛选分页测试改为断言 `/records/search`、POST、JSON 筛选体和分页参数。
2. 运行该测试并确认旧实现失败。
3. 实现单条件包装、筛选搜索请求和分页。
4. 运行飞书客户端测试，确认筛选读取通过且写请求仍只调用一次。

## 任务 2：兼容飞书日期类型

**文件：**
- 修改：`tests/worker/field-mappers.test.js`
- 修改：`tests/worker/statistics-service.test.js`
- 修改：`tests/worker/orders-service.test.js`
- 修改：`tests/worker/purchases-service.test.js`
- 修改：`worker/field-mappers.js`
- 修改：`worker/services/orders.js`
- 修改：`worker/services/purchases.js`

**步骤：**
1. 增加数字毫秒、数字秒、数字文本和已有日期文本的失败测试。
2. 增加统计服务读取数字日期的失败测试。
3. 实现按上海时区输出 `YYYY-MM-DD` 的日期转换。
4. 订单和进货映射统一使用该转换。
5. 日期筛选在映射后本地精确校验，单据编号分配只比较规范化后的同日记录。
6. 运行相关 Worker 测试并确认通过。

## 任务 3：避免新增客户成功后误报失败

**文件：**
- 修改：`tests/frontend/customers-page.test.js`
- 修改：`assets/js/pages/customers.js`

**步骤：**
1. 增加“POST 成功、随后 GET 失败”的交互测试，断言不会二次 POST，并显示已保存提示。
2. 运行测试并确认旧实现失败。
3. 将保存和刷新拆成两个明确阶段。
4. 运行客户页面测试并确认通过。

## 任务 4：补齐安全错误日志

**文件：**
- 修改：`tests/worker/router-auth.test.js`
- 修改：`worker/index.js`

**步骤：**
1. 增加未知异常只记录事件名和异常类型的测试。
2. 运行测试并确认旧实现失败。
3. 实现安全日志，保持客户端通用错误响应。
4. 运行路由测试并确认不泄露敏感信息。

## 任务 5：增加临时生产只读业务诊断

**文件：**
- 修改：`tests/worker/router-auth.test.js`
- 修改：`tests/config/workflows.test.js`
- 修改：`worker/index.js`
- 修改：`.github/workflows/deploy.yml`

**步骤：**
1. 增加诊断输出最小化、只读调用和部署检查的失败测试。
2. 实现临时业务诊断入口，只返回检查项布尔值。
3. 部署流程在 Worker 发布后调用该入口，任一检查失败即停止 Pages 发布。
4. 运行完整测试：`npm test`。
5. 运行端到端测试：`npm run test:e2e`。
6. 提交并推送到 `main`，等待 GitHub Actions 全部成功。
7. 读取线上诊断结果，确认客户、订单筛选、日期筛选和统计均成功。

## 任务 6：删除临时诊断并最终发布

**文件：**
- 修改：`tests/worker/router-auth.test.js`
- 修改：`tests/config/workflows.test.js`
- 修改：`worker/index.js`
- 修改：`.github/workflows/deploy.yml`

**步骤：**
1. 删除临时诊断入口和部署调用。
2. 恢复并运行“临时诊断不存在”的安全测试。
3. 再次运行 `npm test` 与 `npm run test:e2e`。
4. 审查差异，确认没有字段变更、迁移脚本、明文密钥和写入诊断。
5. 提交并推送最终版本到 `main`，等待 Worker 与 Pages 自动部署成功。
6. 只读检查最终健康接口、登录挑战和线上页面版本。
