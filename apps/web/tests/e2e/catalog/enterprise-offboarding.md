# FS-30 / FS-17 / FS-18 enterprise offboarding consumer fixture

| Spec | Scope | Tier |
|---|---|---|
| `enterprise-offboarding.spec.ts` | 独立 PostgreSQL、真实 Web enterprise Cookie、identity 停用与 auth epoch 前进后页面、BFF、上传、设置及 collab ticket 全部 fail-closed；FS-17/18 复用本 fixture 作为 Web 侧撤销回归 | enterprise owned fixture |

运行命令：

```sh
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/enterprise-offboarding.spec.ts --config=playwright.enterprise.config.ts --workers=1 --trace=off
```

测试只更新本 run 的合成 identity/policy，并在 fixture teardown 销毁独立数据库、Web、Mock 与辅助进程；不会触碰共享环境或生产租户。
