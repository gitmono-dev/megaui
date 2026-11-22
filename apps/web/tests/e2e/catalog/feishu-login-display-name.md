# feishu-login-display-name

FSL-182：飞书会话下工作区外壳侧栏的显示名与头像首字母、首页问候、资料表单姓名输入的初始值都经 `selfDisplayName` 取会话投影的 `user.displayName`，不再直接读取会话的 `user.name`（授权主体 `fs_<用户 ID>`）。

基座与 [feishu-login-page](./feishu-login-page.md) 相同（`helpers/feishu-login-harness.ts`：`OwnedWeb` 源码副本与一次性 PostgreSQL、真实 Feishu Mock CLI 进程、飞书模式的独立 `next dev`），本 spec 在 `beforeAll` 启动一次；`afterAll` 保存并等待仍在进行的基座启动后再关闭，对非 `FeishuLoginHarnessSetupError` 及 cause 为 `AggregateError` 的启动错误重新抛出（ER-14 / EX-17）。页面请求不被拦截，期望值取自真实 `get-session` 投影。验证码只从 Mock 收件箱读取并留在内存中（ER-11）：只作为 `locator.evaluate` 的参数写入输入框并在页面内比较，不经 `locator.fill` 或 `toHaveValue`；本 spec 加载时设置 `PLAYWRIGHT_NO_COPY_PROMPT=1`，使失败时不生成含输入框值的页面 ARIA 快照；用例的页面在成功与抛错时都先于其浏览器上下文关闭。

## 用例

| 名称 | 覆盖 |
|---|---|
| AC1-AC3: rail, greeting and profile form show the projection displayName | Alice 经 Mock 收件箱验证码登录后读取 `get-session`：`user.name` 为 `fs_<用户 ID>`，本地 `user` 行的姓名与邮箱为 Mock 的 `Mock Alice` 与 `alice@example.com`，`user.displayName` 等于 `feishuUserDisplayName` 对二者的结果（姓名含登录邮箱本地部分，为用户 ID）；`/en/workspace` 的侧栏显示名与首页问候中的名字等于去首尾空白的 `displayName`，头像首字母等于对其的 `getInitials`，`/en/workspace/settings` 资料表单姓名输入的初始值等于 `displayName` 原值。随后把本地 `user.name` 改写为不触发规则、带首尾空白的姓名，再读 `get-session`：`user.name` 不变，`displayName` 为该姓名原值；三处断言同上（侧栏与问候去空白，表单保留空白），且页面不出现 `fs_<用户 ID>` |

## 运行

```sh
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/feishu-login-display-name.spec.ts --config=playwright.feishu-login.config.ts --workers=1 --trace=off
```

需要本机 Docker（一次性 PostgreSQL）与 Playwright 的 Chromium。
