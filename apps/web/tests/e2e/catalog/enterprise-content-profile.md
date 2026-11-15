# FS-22 内容域用户投影脱离邮箱

| Spec | Scope | Tier |
|---|---|---|
| `enterprise-content-profile.spec.ts` | 真实企业 OTP simulator、隔离 PostgreSQL、Next Web 与 Chromium；创建 Docs/评论/Issue/评论/CL/评论并验证作者资料 | enterprise / FSM-05 simulator |

该用例只使用本 run 的企业认证 fixture 与隔离数据库。它验证内容作者使用 `enterprise_profile.login_name` 与目录显示名，DTO 不含 Better Auth 兼容邮箱、通知邮箱或 `backend_username`，并在通知地址与显示名更新后保持作者 `user.id` 与 `login_name` 不变。

```sh
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/enterprise-content-profile.spec.ts --config=playwright.enterprise.config.ts --workers=1 --trace=off
```
