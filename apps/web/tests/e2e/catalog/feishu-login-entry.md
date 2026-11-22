# feishu-login-entry

FSL-131：飞书模式下的登录入口。`/[lang]/signin` 转到飞书登录页 `/[lang]/signin/feishu`，注册、找回密码与重置密码页面返回 404。

基座与 [feishu-login-page](./feishu-login-page.md) 相同（`helpers/feishu-login-harness.ts`：`OwnedWeb` 源码副本与一次性 PostgreSQL、真实 Feishu Mock CLI 进程、飞书模式的独立 `next dev`）。本 spec 在 `beforeAll` 启动一次基座，并保存启动 Promise。`afterAll` 先等待仍在进行的启动再关闭；启动错误不是 `FeishuLoginHarnessSetupError`，或其 `cause` 为 `AggregateError` 时，重新抛出（ER-14 / EX-17）。

本 spec 不输入邮箱或验证码，不读取 Mock 收件箱。加载时设置 `PLAYWRIGHT_NO_COPY_PROMPT=1`，失败时不生成页面快照（ER-11）。每个用例的页面与浏览器上下文在成功与抛错时都关闭。

`legacy` 部署的登录页不变，未设置 `AUTH_PROVIDER` 的 `enterprise` 与 `maintenance` 部署拒绝启动（FSL-132），二者都由单元测试 `apps/web/tests/unit/signin-entry.test.ts` 覆盖，不在本 spec 中。

## 用例

| 名称 | 覆盖 |
|---|---|
| AC1: a guest's /[lang]/signin answers 307 to /[lang]/signin/feishu | **AC1**：访客对 `/en/signin` 与 `/zh-CN/signin` 的请求（不跟随重定向）返回 307，`Location` 为同源的 `/[lang]/signin/feishu`。带 `callbackUrl` 的请求保留该参数。在浏览器中打开 `/[lang]/signin` 后到达飞书登录页的邮箱步骤：页面没有原登录卡片、企业表单、密码输入框，也没有注册与找回密码链接 |
| AC2: a guest on a protected page ends on the Feishu sign-in page | **AC2**：访客访问 `/en/workspace` 时，中间件仍以 302 转到 `/en/signin?callbackUrl=%2Fen%2Fworkspace`，下一跳为 307 到 `/en/signin/feishu`。在浏览器中打开 `/en/workspace` 与 `/zh-CN/workspace/issues` 后最终为 200 的飞书登录页，`callbackUrl` 为原路径，页面同样没有密码表单与注册链接 |
| AC3: /[lang]/signup answers 404 | **AC3**：两种语言的 `/[lang]/signup`（含结尾斜杠）返回 404，带 `Cache-Control: no-store`，正文不含表单；浏览器打开时同为 404 且页面没有表单 |
| AC4: /[lang]/forgot-password answers 404 | **AC4**：同上，路径为 `/[lang]/forgot-password` |
| AC5: /[lang]/reset-password answers 404 | **AC5**：同上，路径为 `/[lang]/reset-password` |

## 运行

```sh
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/feishu-login-entry.spec.ts --config=playwright.feishu-login.config.ts --workers=1 --trace=off
```

需要本机 Docker（一次性 PostgreSQL）与 Playwright 的 Chromium。
