# Live E2E 纪要（OPS-01）

核对日：2026-09-04

## 状态：`done`（DEP-01 已落地）

monoengine `docker-compose.test.yml` web profile 已改指向 `../megaui`
（`website-next` / `website-db-init` + 新增 `megaui-collab`）。留痕见
`../monoengine/docs/refactoring/website-to-megaui.md`。

## 探活与镜像证据（脱敏）

| 探活 | 结果 |
|---|---|
| `curl -sf http://127.0.0.1:19180/api/openapi.json` | 200（119 paths；REF-02 五端点均在） |
| `curl -sf http://127.0.0.1:17001/api/health` | 200（database healthy） |
| `curl -sf http://127.0.0.1:17002/health` | 200（megaui-collab） |

| 镜像 | Image ID（短） | 说明 |
|---|---|---|
| `website-next:local` | `31153cf7280e` | 构建自 `../megaui` `apps/web/Dockerfile` target `runner`（含 `resolveCollabPublicUrl` 内联修复） |
| `megaui-collab:local` | `e3eeea354f85` | 构建自 `../megaui` `apps/collab-server/Dockerfile` |
| `monoengine:local` | `5991fe7f4a83` | app profile |

monoengine HEAD 仍为 `80ddff4`（与 REF-02 / REF-06 pin 一致）。compose 与留痕文档为工作区改动（仓外 DEP-01）。

## Live 档 e2e

基址：`E2E_BASE_URL=http://127.0.0.1:17001` + `E2E_SKIP_WEBSERVER=1`，会话 mint 指向
compose `website` 库（host `15432`），密钥与 compose `BETTER_AUTH_SECRET` 对齐。

清单（与 TEST-CATALOG live 列一致）：auth-flow、workspace-code（含 live S-05）、
workspace-cl-detail、workspace-docs、workspace-docs-edit（local autosave 在 collab URL
已 bake 时 skip）、workspace-collab、workspace-issues、workspace-chat、workspace-inbox、
upload。

## Re-pin 记录

| 日期 | REF-02 原 sha | 新 sha | 差异摘要 |
|---|---|---|---|
| 2026-09-04 | `80ddff4` | `80ddff4`（不变） | live OpenAPI 与 pin 一致；`packages/engine/.../live.contract.test.ts` 1/1 绿 |

## 修复摘记

- `resolveCollabPublicUrl`：改为静态读取 `process.env.NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL`，
  否则 Next 不内联，compose bake 的 URL 在浏览器中恒为空。
- Playwright：`E2E_BASE_URL` / `E2E_SKIP_WEBSERVER` 支持对着 `:17001` 跑 live。
