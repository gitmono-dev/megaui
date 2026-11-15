# FS-40 双模式企业 Web harness

| Spec | Scope | Tier |
|---|---|---|
| `enterprise-harness.spec.ts` | 每次运行创建独立 PostgreSQL、无 `.env` 源快照和宿主机 Next dev；检查 `/api/health`、固定 loopback origin、同端口重启与数据库健康 | enterprise / legacy owned fixture |

运行器由 `helpers/isolated-server.ts` 管理本 run 源快照、白名单环境、私有 HOME/XDG cache、子进程组和有界清理；fixture 只登记本 run 的 Web、PG、目录资源。该 spec 不取 Cookie、不启动 Mock、worker、collab 或 SMTP，不声称企业认证已经联通。

```sh
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/enterprise-harness.spec.ts --config=playwright.enterprise.config.ts --workers=1 --trace=off
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/enterprise-harness.spec.ts --config=playwright.legacy.config.ts --workers=1 --trace=off
```

