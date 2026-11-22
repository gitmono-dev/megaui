# feishu-login-resend

FSL-155：飞书登录页 `/[lang]/signin/feishu` 验证码步骤的「重新发送」与「更换邮箱」。

基座与 [feishu-login-page](./feishu-login-page.md) 相同（`helpers/feishu-login-harness.ts`：`OwnedWeb` 源码副本与一次性 PostgreSQL、真实 Feishu Mock CLI 进程、飞书模式的独立 `next dev`）。本 spec 在 `beforeAll` 启动一次基座，并保存启动 Promise。`afterAll` 先等待仍在进行的启动再关闭；启动错误不是 `FeishuLoginHarnessSetupError`，或其 `cause` 为 `AggregateError` 时，重新抛出（ER-14 / EX-17）。

所有结果都来自真实的 request 与 verify 端点，不拦截页面请求。本 spec 不使用 Playwright 假时钟：重发用例在验证码步骤出现后实际等待 61 秒，让页面倒计时与服务端 / 数据库的 60 秒邮箱冷却都到期，因此用例超时设为 120 秒。

数据库断言只读取该 flow 各行的 `flow_seq` 与 `state`，flow 以浏览器 flow Cookie 的 SHA-256 定位，Cookie 值不写入断言信息。

验证码只从 Mock 收件箱读取并留在内存中，不写入日志或报告（ER-11）：
- 它只作为 `locator.evaluate` 的参数写入输入框，并在页面内比较；
- 不经 `locator.fill` 或 `toHaveValue`；
- 本 spec 加载时设置 `PLAYWRIGHT_NO_COPY_PROMPT=1`，使失败时不生成含输入框值的 ARIA 快照；
- 每个用例的页面在成功与抛错时都先于其浏览器上下文关闭。

## 用例

| 名称 | 覆盖 |
|---|---|
| AC1-AC4: resend is usable after 60 seconds and replaces the code | **AC1**：Alice 到达验证码步骤后，「重新发送」不可用并显示倒计时（`resendWait`），57 秒时仍不可用；强制点击不发送 request，该 flow 仍只有一行 `active`，收件箱不变。**AC2**：61 秒时按钮可用（`resend`）。重发返回 202 时 flow Cookie 不变，该 flow 已有 `flow_seq` 1（`void`）与 2（`reserved` 或 `active`）两行；Mock 收件箱收到第二条私聊，新行随后为 `active`。页面显示 `codeResent`，把重发前填入的验证码清空，并重新倒计时。**AC3**：旧验证码提交为 401，显示 `codeInvalid`。**AC4**：新验证码提交为 200，进入 `/en` 并设置会话 Cookie |
| a failed resend keeps the code and waits 60 seconds again | 把已有行的创建时间整体前移 1 小时，使 Alice 不在冷却内。Alice 到达验证码步骤 61 秒后，在运行的数据库中为 `feishu_login_codes` 创建 before insert 触发器，使预约事务失败，然后重发：request 为 503。页面显示 `requestFailed`，不显示 `codeResent`，按钮重新倒计时且不可用，输入框保留验证码；该 flow 仍只有一行 `active`，收件箱不变。移除触发器（`finally`）后，原验证码登录成功 |
| AC5 / AC6 (hit): change email goes back, and a member's request voids the first code | **AC5**：`zh-CN` 页面中 Bob 到达验证码步骤后点击「更换邮箱」（`changeEmail`），回到空的输入邮箱步骤，路径不变、flow Cookie 不变，该 flow 仍只有一行 `active`。**AC6 命中**：随后为 Dave 请求，验证码提示显示 Dave 的邮箱；该 flow 变为 `void` 与 `active` 两行，Bob 收件箱不再增加。Bob 的验证码提交为 401（`codeInvalid`），Dave 的验证码登录成功 |
| AC6 (miss): a request for an unknown email voids the first code | 把已有行的创建时间整体前移 1 小时，使 Bob 不在冷却内。Bob 到达验证码步骤并更换邮箱后，为未知邮箱请求：仍显示验证码步骤，该 flow 的两行都为 `void`，任何成员的收件箱都不变。**AC6 未命中**：Bob 的验证码提交为 401（`codeInvalid`） |

## 运行

```sh
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/feishu-login-resend.spec.ts --config=playwright.feishu-login.config.ts --workers=1 --trace=off
```

需要本机 Docker（一次性 PostgreSQL）与 Playwright 的 Chromium。
