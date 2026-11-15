# FS-23 成员聊天与Release投影脱离邮箱

| Spec | Scope | Tier |
|---|---|---|
| `enterprise-social-profile.spec.ts` | 真实企业 OTP simulator、隔离 PostgreSQL、Next Web 与 Chromium；同通知邮箱成员、成员列表、聊天作者、Release作者与停用历史资料 | enterprise / FSM-05 simulator |

该用例创建两个拥有相同通知邮箱但不同 `user.id`/`login_name` 的合成成员，验证成员、聊天和Release DTO不包含兼容邮箱、通知邮箱或 `backend_username`，并在另一成员停用后保留历史展示资料。

```sh
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/enterprise-social-profile.spec.ts --config=playwright.enterprise.config.ts --workers=1 --trace=off
```
