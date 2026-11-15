# megaui：Mega 的 Web 工作区

> 面向 [Mega](https://github.com/gitmono-dev/mega2) monorepo 引擎的开源 Web 工作区：代码浏览、变更列表、Issue、实时协作文档、聊天与 Agent 会话，基于 Next.js、Hocuspocus 和 PostgreSQL 构建。

[English](README.md) · 中文

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](#许可证)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A524-339933.svg)](.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-10.32.1-F69220.svg)](package.json)

**megaui 是 Mega 技术栈的前端。** 它在 [mega2](https://github.com/gitmono-dev/mega2) 服务端之上为团队提供统一的工作区：浏览 monorepo、评审变更列表、跟踪 Issue、实时协作写文档、在频道里沟通，并运行 Agent 会话。浏览器不会直接访问 mega2，所有调用都经过 `apps/web` 中服务端的 BFF 适配层和 `packages/engine` 中的 mega2 客户端，认证、错误映射和 mega2 契约因此集中在同一处。

megaui 目前是**预发布版本（`0.x`）**：核心工作区已可使用，接口仍可能调整，项目处于积极开发中。

先看[快速开始](#快速开始)，再到[配置参考](docs/configuration.md)查阅全部环境变量，参与贡献请阅读[贡献指南](CONTRIBUTING.md)。

## 项目概览

| 项目 | 说明 |
|---|---|
| 定位 | mega2 monorepo 服务端的 Web 工作区 |
| 语言 | TypeScript（严格模式）、Node.js 24、pnpm workspaces + Turborepo |
| Web 应用 | Next.js（App Router），服务端 BFF 位于 `apps/web/app/api/mega/**` |
| 实时协作 | Hocuspocus 协作服务（`apps/collab-server`，默认端口 `7002`） |
| 数据 | 通过 Drizzle ORM 使用 PostgreSQL；上传使用 S3 兼容对象存储 |
| 认证 | [Better Auth](https://www.better-auth.com)：邮箱密码，可选 Google 与 GitHub；**企业模式**支持飞书私聊配对登录 |
| 语言 | 英文与简体中文（`en`、`zh-CN`） |
| 后端 | [mega2](https://github.com/gitmono-dev/mega2)（OpenAPI 契约） |
| 测试 | Vitest 单元与契约测试，Playwright E2E |
| 许可证 | MIT OR Apache-2.0 |

## 工作区包含什么

工作区是一个统一的外壳，带左侧导航、命令面板（`⌘K`）和收藏夹，包含以下板块：

- **首页**：评审请求、指派给你的 Issue、动态、发布与最近文档的仪表盘。
- **代码**：浏览 monorepo 的目录树和文件，内联渲染 README。
- **变更列表（CL）**：列出、评审和讨论变更，含文件 diff、修订、检查与依赖视图。
- **Issue**：跟踪与讨论工作，支持评论与表情回应。
- **文档**：基于块的协作文档，支持评论与交叉引用。
- **聊天**：频道与私信，与文档共用同一个协作服务。
- **Agent**：支持流式输出的 Agent 会话。
- **发布与标签**、通知**收件箱**，以及**设置**（含个人凭据）。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `apps/web` | Next.js Web 应用，以及对接 mega2 的 BFF 适配层 |
| `apps/collab-server` | Hocuspocus 实时协作服务 |
| `apps/feishu-mock` | 用于开发和 E2E 测试的本地飞书模拟器 |
| `packages/core` | 叶子包：共享类型与纯逻辑 |
| `packages/content`、`database`、`i18n`、`storage`、`auth`、`email` | 基于 `core` 的领域库 |
| `packages/engine` | 组合各领域库的服务与 worker；`apps/web` 的业务逻辑唯一来源 |
| `packages/ui` | 设计系统、工作区外壳与编辑器组件 |
| `docs` | 设计说明与[配置参考](docs/configuration.md) |
| `scripts` | CI 同样会运行的守卫脚本 |

包依赖方向是单向的：`core` ← `{content, database, i18n, storage, auth, email}` ← `engine` ← `apps/web`，`ui` 只依赖 `core`、`content` 和 `i18n`，由 `pnpm run lint:deps` 强制。

## 快速开始

需要 Node.js 24 与 pnpm 10.32.1、一个 PostgreSQL 数据库；要使用完整工作区还需要一个运行中的 [mega2](https://github.com/gitmono-dev/mega2) 实例。

```bash
git clone https://github.com/gitmono-dev/megaui.git
cd megaui
pnpm install --frozen-lockfile

cp env.example apps/web/.env      # 然后修改取值，见 docs/configuration.md
pnpm --filter @megaui/database run db:migrate   # 应用数据库结构
pnpm --filter @megaui/web run dev               # http://127.0.0.1:3000
```

可选：启动协作服务，文档与聊天依赖它。

```bash
pnpm --filter @megaui/collab-server run dev     # 默认端口 7002
```

至少需要设置 `APP_BASE_URL`、`BETTER_AUTH_URL`、`BETTER_AUTH_SECRET`、`BETTER_AUTH_TRUSTED_ORIGINS`、`DATABASE_URL`、`EMAIL_PROVIDER` 和 `EMAIL_DEFAULT_FROM`。`env.example` 中的取值都是占位符（`replace-with-...`），必须替换；应用对缺失或未知的取值会拒绝启动（fail-closed）。要连接 mega2，请设置 `MEGA2_PUBLIC_BASE_URL` 以及[配置参考](docs/configuration.md)中的协作相关变量。`GET /api/health` 用于存活探测。

### Docker

`apps/web/Dockerfile` 默认构建生产 Web 镜像，并提供用于执行迁移的 `db-init` 目标；`apps/collab-server/Dockerfile` 构建协作服务。请在仓库根目录构建。

```bash
docker build -f apps/web/Dockerfile -t megaui-web:local .
docker build -f apps/web/Dockerfile --target db-init -t megaui-db-init:local .
docker build -f apps/collab-server/Dockerfile -t megaui-collab:local .
```

推送稳定标签 `v<major>.<minor>.<patch>` 会运行 `.github/workflows/docker.yml`。它为 `linux/amd64` 和 `linux/arm64` 构建 `apps/web/Dockerfile` 的 `runner` 目标，再把镜像发布到 `${DOCKER_USER}/megaui`（Docker Hub 上的 `genedna/megaui`）。只有该标签是最高稳定版本时才会移动 `latest`。

**双仓协同发布：** mega2 与 MegaUI 使用同一稳定版本号。发布前两个仓库必须存在同名 tag，且最新 `main` CI 均为 `success`。任一仓库缺少同名 tag、CI 运行中或失败时，`release-gate` 会阻止镜像发布。

### 企业登录（可选）

设置 `AUTH_MODE=enterprise` 后，密码登录被飞书私聊配对取代：用户向机器人发送一次性 `/login` 指令，再输入机器人返回的 8 位验证码。本地开发可使用 `apps/feishu-mock` 提供的回环模拟器，无需真实的飞书租户。详见[企业身份：配置合同](docs/implementation/enterprise-auth.md)与[飞书 Mock](docs/implementation/feishu-simulator.md)。

## 开发

```bash
pnpm turbo run typecheck            # 类型检查所有包
pnpm turbo run lint                 # eslint 与依赖方向守卫
pnpm vitest run <路径>              # 运行你改动代码对应的单元测试
pnpm vitest run                     # 全量单元测试
pnpm exec playwright test <spec>    # E2E（apps/web/tests/e2e）
```

需要自行启动 PostgreSQL 的测试要求有可用的 Docker 或 Podman。CI 还会运行 `scripts/` 中的脚本（品牌残留、许可证白名单、密钥残留、文档链接、公共资源）；完整清单见 [CONTRIBUTING.md](CONTRIBUTING.md)，工程约束见 [AGENTS.md](AGENTS.md)。

## 文档

| 入口 | 内容 |
|---|---|
| [`docs/configuration.md`](docs/configuration.md) | 全部环境变量与 CI 守卫工具 |
| [`docs/implementation/enterprise-auth.md`](docs/implementation/enterprise-auth.md) | 企业身份配置合同 |
| [`docs/implementation/chat-collab-protocol.md`](docs/implementation/chat-collab-protocol.md) | 聊天与协作协议 |
| [`docs/implementation/document-page-features.md`](docs/implementation/document-page-features.md) | 文档页编辑功能 |
| [`docs/implementation/ci-test-isolation.md`](docs/implementation/ci-test-isolation.md) | CI 如何隔离并并行测试 |
| [`docs/implementation/application-visual-style.md`](docs/implementation/application-visual-style.md) | 全站样式基线 |

`docs/implementation` 下的设计说明以中文撰写，欢迎提交英文贡献。

## 参与贡献

请先阅读[贡献指南](CONTRIBUTING.md)和[行为准则](CODE_OF_CONDUCT.md)。超出小修小补的改动，请先开 Issue 对齐方向再实现。安全问题请按 [SECURITY.md](SECURITY.md) 私密报告。

## 许可证

megaui 以 MIT 与 Apache-2.0 双许可（`MIT OR Apache-2.0`），你可以任选其一：

- [MIT License](LICENSE-MIT)
- [Apache License 2.0](LICENSE-APACHE)

直接复制进本仓库的第三方代码在 [`NOTICE`](NOTICE) 中声明。

除非你明确声明，你有意提交到本项目的贡献，按 Apache-2.0 的定义以上述双许可授权，不附加任何额外条款。
