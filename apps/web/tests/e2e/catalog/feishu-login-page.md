# feishu-login-page

FSL-129：飞书登录页 `/[lang]/signin/feishu` 的两步主流程与飞书登录 E2E 基座。

每次运行由 `helpers/feishu-login-harness.ts` 自建并释放：`OwnedWeb` 的源码副本（不复制、不加载真实 `.env`）与一次性 PostgreSQL（已迁移）、真实 Feishu Mock CLI 进程（`startFeishuMock`），以及在该副本上以飞书模式（`AUTH_MODE=enterprise`、`AUTH_PROVIDER=feishu`、`FEISHU_PROVIDER=simulator` 指向 Mock，Mock 的应用凭据与新生成的合成 HMAC 密钥）启动的独立 `next dev` 进程组。专用配置 `playwright.feishu-login.config.ts` 收集 `feishu-login-*.spec.ts`，不配置 `webServer`、不依赖外部 `E2E_BASE_URL`，单 worker 串行，trace/video/screenshot 全部关闭。验证码只从 Mock 的 `/__mock/state` 收件箱读取并留在内存中，不写入日志或报告（ER-11）。

## 用例

| 名称 | 覆盖 |
|---|---|
| AC7: a setup failure releases the PG and the Mock already started | 注入在 Mock 启动后失败：基座抛出 `FeishuLoginHarnessSetupError`，源码副本目录、PG 容器与端口、Mock 进程与端口均不再存在 |
| AC7: a setup failure after the Web is up releases the PG, the Mock and the Web | 注入在 Web 就绪（并登记其进程组）后失败：基座抛出 `FeishuLoginHarnessSetupError`，源码副本、PG、Mock、Web 端口与 Web 进程组的存活成员均不再存在 |
| AC7: a failing test body releases the PG, the Mock and the Web | `withFeishuLoginHarness` 的工作函数抛错：运行期间七项资源都在，原错误原样抛出，之后全部释放（含 Web 端口与 Web 进程组） |
| AC1: the email step renders an email input and a submit button, with dictionary texts | 访客直接打开 `en` 与 `zh-CN` 页面（200，不被重定向）；标题、说明、邮箱输入框（`type=email`）与提交按钮的文案取自对应词典；不显示验证码步骤；相邻路径对访客仍 302 到 `/en/signin` |
| AC3 / AC5: a known and an unknown email both switch to the same code step | 已知成员与未知邮箱各在新的浏览器上下文中提交：request 均为 202 `{"status":"accepted"}`，都切换到验证码步骤；替换邮箱后的验证码步骤 DOM 与 Cookie 名称集合相同；只有成员的 Mock 收件箱多出一条私聊 |
| AC4: an invalid email shows the format error and stays on the email step | 非法邮箱 request 为 400，邮箱步骤内显示词典中的格式错误，停留在邮箱步骤，不设置 flow Cookie |
| the email stays out of browser storage and a reload returns to the email step | 验证码步骤时 localStorage、sessionStorage 与 `document.cookie` 都不含邮箱，flow Cookie 为 HttpOnly；刷新后回到空的邮箱步骤，flow Cookie 不变 |
| AC6: the code from the Mock inbox signs in and lands on the workspace | 以 Mock 收件箱中的验证码（以小写、中间带空格的形式粘贴，输入框规范化为 8 位大写）提交 verify 为 200，直接进入工作区 `/en/workspace`（FSL-184），设置会话 Cookie；随后单独访问首页 `/en` 为 200 且停在该页，首页 CTA 为「进入工作区」并指向 `/en/workspace`；此后再访问本页被 302 到 `/en/workspace` |
| AC7: on success, closing the harness releases the PG, the Mock and the Web | 主流程基座在关闭前七项资源都在，`close()` 之后全部释放 |

## 运行

```sh
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/feishu-login-page.spec.ts --config=playwright.feishu-login.config.ts --workers=1 --trace=off
```

需要本机 Docker（一次性 PostgreSQL）与 Playwright 的 Chromium。
