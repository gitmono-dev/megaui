# feishu-login-verify-errors

FSL-130：飞书登录页 `/[lang]/signin/feishu` 验证码步骤按 verify 状态码显示的错误提示。

基座与 [feishu-login-page](./feishu-login-page.md) 相同（`helpers/feishu-login-harness.ts`：`OwnedWeb` 源码副本与一次性 PostgreSQL、真实 Feishu Mock CLI 进程、飞书模式的独立 `next dev`），本 spec 在 `beforeAll` 启动一次、`afterAll` 关闭。各状态码都是真实 verify 端点的结果，不拦截页面的请求：409 由在运行的数据库中预置与成员同邮箱的本地用户触发，503 由测试数据库中 `session` 插入的触发器注入会话签发故障触发（用例结束时移除）。验证码只从 Mock 收件箱读取并留在内存中，不写入日志或报告（ER-11）：它与由它派生的错码、7 位截断值只作为 `locator.evaluate` 的参数写入输入框并在页面内比较（以一次 input 事件写入，与粘贴相同），不经 `locator.fill`（会写入 Playwright 的操作日志）或 `toHaveValue`（会写入断言失败信息）。Playwright 失败时写入 `error-context.md` 的页面 ARIA 快照会含验证码输入框的值，本 spec 加载时设置 `PLAYWRIGHT_NO_COPY_PROMPT=1` 使其不生成（含测试超时，此时测试函数的 `finally` 不一定执行）；此外每个用例的页面在成功与抛错时都先于其浏览器上下文关闭。

## 用例

| 名称 | 覆盖 |
|---|---|
| AC1 / AC2: a wrong code shows invalid-or-expired and stays on the code step | Alice 提交与真实验证码每位都不同的合法格式验证码：verify 为 401，验证码步骤内显示 `codeInvalid`，仍在验证码步骤（输入框与按钮可用、无邮箱步骤、不设置会话 Cookie）；7 位验证码为 400，显示同一文案；随后以正确验证码提交为 200 并进入 `/en/workspace` |
| AC3: a 409 for a local user with the member's email shows the account conflict | 预置 `bob@example.com` 的本地用户后，`zh-CN` 与 `en` 页面各提交 Bob 的正确验证码：409，显示对应语言的 `accountConflict`，停留在验证码步骤、不设置会话 Cookie，`user` 表全部行不变；同一验证码再次提交为 401，显示 `codeInvalid` |
| AC4: a 503 from a failed session issue asks for a new code | Dave 到达验证码步骤后注入 `session` 插入故障，提交正确验证码：503，显示 `codeRetry`，停留在验证码步骤、不设置会话 Cookie，`session` 表不变；移除触发器后同一验证码再次提交为 401，显示 `codeInvalid` |

## 运行

```sh
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/feishu-login-verify-errors.spec.ts --config=playwright.feishu-login.config.ts --workers=1 --trace=off
```

需要本机 Docker（一次性 PostgreSQL）与 Playwright 的 Chromium。
