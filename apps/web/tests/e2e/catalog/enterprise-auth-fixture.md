# FS-89 enterprise normal Cookie flow

| Spec | Scope | Tier |
|---|---|---|
| `enterprise-auth-fixture.spec.ts` | 独立 PostgreSQL、真实 Web HTTP pairing、FSM-05 Mock 私聊 callback、OTP verify 与 Better Auth session Cookie | enterprise owned fixture |

运行命令：

```sh
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/enterprise-auth-fixture.spec.ts --config=playwright.enterprise-auth.config.ts --workers=1 --trace=off
```

夹具只生成本 run 的用户、enterprise profile/identity、目录快照与水位线。Cookie 必须由 Web 的 `/api/auth/enterprise/request` 和 `/api/auth/enterprise/verify` 正常 HTTP 路径产生；Mock admin token 只用于测试控制面，不进入 Web 环境。私聊 callback 的 verified inbox 由 `bot-login` 消费并创建 challenge，测试只把已返回的合成码回填 HTTP verify，不直接写 session 或 Cookie。
