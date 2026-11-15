# FS-89 legacy normal Cookie flow

| Spec | Scope | Tier |
|---|---|---|
| `legacy-auth-fixture.spec.ts` | 独立 PostgreSQL、既有 signup/signin 页面、Better Auth legacy session Cookie 与 run-labelled SMTP | legacy owned fixture |

运行命令：

```sh
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/legacy-auth-fixture.spec.ts --config=playwright.legacy-auth.config.ts --workers=1 --trace=off
```

测试先用既有注册流程创建 synthetic user，再清除浏览器 Cookie，通过既有登录流程重新取得 session Cookie；fixture 不接受生产 session/token 注入，SMTP 只通过本 run 的隔离 receiver 探活。
