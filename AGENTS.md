# AGENTS.md

本文件是 megaui 仓库对自动化 Agent 与人类贡献者的工程约束速查。仓库只在 `docs/plan/` 收录日期计划及其索引（见下方「计划维护」），不收录其它内部计划文档；下面的 `ER-*` / `GC-*` / `G-*` 与 `CMD-*` / `DIR-*` 基线以本文件为准。

## 模板条款引用

本仓沿用这些规范性条款：

- **`ER-*`（执行检查必备需求）**：开工前安全检查（ER-01）、先核对后实现（ER-02）、粒度门禁（ER-03）、每卡验收门（ER-04）、代码 review 闭环（ER-05）、文档与兼容同步（ER-06）、提交工作流与提交签名（ER-07）、版本与发布（ER-08）、push 失败策略（ER-09）、内部服务错误处理（ER-10）、证据卫生（ER-11）、并发边界与串行发布（ER-12）、测试执行分层（ER-13）、测试资源清理（ER-14）。
- **`GC-*`（全局工程约束）**：单一事实源（GC-02）、参照源标注（GC-03）、输出与错误契约（GC-04）、文档同步（GC-05）、测试覆盖（GC-06）、安全默认值 fail-closed（GC-07）、原子性与恢复（GC-08）、并发与资源生命周期（GC-09）、性能预算（GC-10）、生产异常禁止（GC-11）、精确提交（GC-12）、参照债务不夹带（GC-13）、i18n 双语（GC-14）、数据库角色隔离（GC-15）等。
- **`G-*`（任务卡粒度规则）**：单一行为轴（G-01）、完整可交付（G-02）、条目上限（G-03）、规模上限（G-04）、依赖闭合无环（G-06）、写集与并发（G-10）等，决定任务卡如何拆分与验收。

修改这些条款时直接修订本文件，并在同一次改动里同步受影响的命令、目录和文档。

## DIR 约定

以下目录约定是仓库工程基线（`DIR-01..07`），以本表为准：

| ID | 目录 | 用途 |
|---|---|---|
| DIR-01 | `apps/web` | 页面 / 路由 / 布局的落点（Next.js 应用） |
| DIR-02 | `packages/{core,content,database,auth,email,i18n,storage,engine,ui}` | 纯逻辑、类型、hooks 等共享库；依赖方向见下方 ADR-ARCH-01 守卫 |
| DIR-03 | `apps/web/lib/adapter/**`（BFF 路由落点 `apps/web/app/api/mega/**`） | 与 mega2 对接的唯一出口（GC-04）；错误映射集中于此 |
| DIR-04 | `packages/i18n/src/locales/`；语言集 `zh-CN` + `en`（ADR-ARCH-07） | i18n 词典目录与语言集 |
| DIR-05 | `env.example` | 环境变量样例；校验方式 = CMD-02 构建期加载 `apps/web/lib/env.ts`（由 `apps/web/next.config.ts` import） |
| DIR-06 | 单元：`apps/**/tests/unit/` + `packages/**` 的 `*.test.ts` + `tests/guards/`（仓库级跨包守卫测试，如包依赖方向守卫）；E2E：`apps/web/tests/e2e/`；契约：`apps/web/tests/contract/` 与 `packages/**` 的 `*.contract.test.ts` | 测试文件落点，与 CMD-04/06/07 的收集范围一致 |
| DIR-07 | `docs/`（中文单语；含 `docs/implementation/` 与 `docs/plan/`） | 文档目录 |

**包依赖方向（ADR-ARCH-01，由 `.dependency-cruiser.cjs` 守卫）：**

```
packages/core  ←  packages/{content,database,i18n,storage,auth,email}  ←  packages/engine  ←  apps/web
packages/ui  →  仅 {packages/core, packages/content, packages/i18n}
apps/web  与  apps/collab-server 是两个独立可发布应用，不通过源码 import 互相耦合
```

`packages/core` 是叶子包，不得依赖仓内任何其它 package 或 app；`packages/ui` 不得依赖 `engine`/`database`/`auth`/`email`/`storage`/`apps`。违反方向的 import 会被守卫（挂入 CMD-03 lint 管道）拦截，退出码非 0。

## 提交流程

本工作区使用 Libra 原生工作流（VCS-01，有 `.libra`、无 `.git`）：`libra status`、`libra add <相关路径>`、`libra commit -s -m "<type>(<scope>): <summary>"`、`libra push origin <branch>`。提交前只暂存相关路径，不得使用 `commit -a`（GC-12）；发现无关脏状态时保留并报告，不得清理、重置或混入提交。其它 checkout 先识别元数据，不按 GitHub 托管地址猜 VCS。

**双仓同版本发布（ER-08 强制门禁）：** `gitmono-dev/megaui` 与 `gitmono-dev/mega2` 使用同一稳定版本号发布。任一仓库发布 `v<major>.<minor>.<patch>` 前，另一个仓库必须已经存在同名 tag，且两个仓库最新 `main` CI 均为 `success`；版本不一致、CI 缺失、运行中或失败时不得创建或推送发布 tag、GitHub Release 或 Docker 镜像。不得用旧 CI、局部测试或其它 workflow 冒充最新质量门。`.github/workflows/docker.yml` 的 `release-gate` 是机器门禁，必须先于任何构建或推送成功；发布保持串行，禁止绕过该门禁。

**签名策略（ER-07）：** `-s` 只记录 `Signed-off-by`，与加密签名分别核验。先读取 `commit.gpgSign`，未显式配置时再检查 `vault.signing`；若 `vault.signing=true`，不得把它记作无签名。每次提交冻结 SHA，以 `libra log -1 --pretty=raw <SHA>` 核对 DCO 和 `gpgsig`；已启用签名却缺少 `gpgsig` 时不得推送，不能自行关闭签名绕过。签名头仅是结构证据。

提交信息统一采用 `<type>(<scope>): <summary>`（VCS-01）；`type` 取 `feat` / `fix` / `docs` / `chore` / `refactor` / `test` / `build` / `ci` 之一。

VCS-01：版本控制系统为 Libra，默认分支 `main`；canonical 仓库 `gitmono-dev/megaui`。

## 标准命令

以下命令是仓库工程基线（`CMD-00..10`）。变更命令文本时同步修订本表：

| ID | 用途 | 命令 |
|---|---|---|
| CMD-00 | 只读安装（按 lockfile） | `pnpm install --frozen-lockfile`（lockfile = 根 `pnpm-lock.yaml`；`packageManager` = `pnpm@10.32.1`） |
| CMD-01 | typecheck | `pnpm turbo run typecheck` |
| CMD-02 | build | `pnpm turbo run build`（`apps/web` 构建期经 `next.config.ts` → `lib/env.ts` 校验 `env.example` 中的样例变量） |
| CMD-03 | lint（含依赖方向守卫） | `pnpm turbo run lint`（守卫经 turbo 根任务 `//#lint:deps` 挂入 `lint` 任务的 `dependsOn`，命令文本本身不变） |
| CMD-04 | 单元测试（指定文件） | `pnpm vitest run <path>`；收集范围 = `apps/**/*.{test,spec}.{ts,tsx}` + `packages/**/*.{test,spec}.{ts,tsx}` + `tests/**/*.{test,spec}.{ts,tsx}`（排除 e2e，见根 `vitest.config.ts`） |
| CMD-05 | 全量单元测试 | `pnpm vitest run`（`passWithNoTests=false`） |
| CMD-06 | BFF / API 契约测试（指定文件） | 指定文件 `pnpm vitest run <path>`；既有集合 `pnpm vitest run apps/web/tests/contract packages/engine/src/services/mega2/client.contract.test.ts packages/engine/src/services/mega2/code-backend.contract.test.ts` |
| CMD-07 | E2E（指定 spec） | `pnpm exec playwright test <spec>`；用例目录 = `apps/web/tests/e2e/`；本地 baseURL `http://127.0.0.1:3000`；行为卡手工维护 `catalog/<spec>.md` 与 `TEST-CATALOG.md` |
| CMD-08 | 本地 dev 启动 | `pnpm --filter @megaui/web run dev`（端口 3000；环境样例 `env.example`） |
| CMD-09 | mega2 联调栈启动与探活 | 在 `../mega2` 执行 `docker compose -p mega2-it -f docker/docker-compose.test.yml --profile app up -d --build --wait`，再以 `curl -sf http://127.0.0.1:19180/api/openapi.json` 探活；需要网站时增加 `--profile web`，当前 context 指向 sibling megaui |
| CMD-10 | 依赖变更与 lockfile 刷新 | `pnpm install`（非 frozen）或 `pnpm up <pkg>`；lockfile = 根 `pnpm-lock.yaml`；不得手改 lockfile |

其它常用命令：`pnpm run lint:deps` 单独运行依赖方向守卫（`depcruise --config .dependency-cruiser.cjs apps packages`），等价于 CMD-03 内嵌的守卫步骤，便于本地调试。

## 计划维护

日期计划 `docs/plan/plan-YYYYMMDD.md` 与索引 `docs/plan/README.md` 收录于本仓库：计划经评审 `PASS` 后以只含计划与索引的精确签名提交进入 `main`（引入本条款的那次提交同时包含本文件）；执行期间，各任务卡按该计划的状态收敛规则，在本卡的精确提交中更新计划的状态字段（状态记录不属于产品文档同步）。计划中不得包含凭据或未脱敏的真实租户数据。其它内部计划文档不收录。计划只描述任务、依赖与验收，产品行为仍以源码、测试和 `docs/implementation` 为准。
