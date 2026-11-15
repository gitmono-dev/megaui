# FS-19 enterprise auth operation policy

| Spec | Scope | Tier |
|---|---|---|
| `enterprise-auth-policy.spec.ts` | 企业模式只允许六项认证 operation；HTTP、direct auth.api、admin、deleteUser 与路径变体均不得绕过；持久策略变更后不恢复 legacy | enterprise owned fixture |

运行命令：

```bash
pnpm exec playwright test apps/web/tests/e2e/enterprise-auth-policy.spec.ts --config=playwright.enterprise.config.ts
```
