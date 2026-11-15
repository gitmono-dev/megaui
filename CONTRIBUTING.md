# Contributing to megaui

English · [中文](#中文)

Thanks for your interest in megaui. This guide explains how to propose a change,
set up a development environment, run the checks, and submit a pull request.
By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Small fixes** (typos, docs, an obvious bug with a test) can go straight to a pull request.
- **Larger changes** (new features, behaviour changes, new packages, schema changes): please
  open an issue first. Describe the problem, motivation, scope, and non-goals, and wait for
  agreement on the direction before you invest time in an implementation.
- **Security problems** must not be reported in public issues. See [SECURITY.md](SECURITY.md).

## Repository layout

megaui is a pnpm + Turborepo monorepo (Node.js 24, `pnpm@10.32.1`).

| Path | What it is |
|---|---|
| `apps/web` | Next.js web application and BFF (the only code that talks to mega2) |
| `apps/collab-server` | Hocuspocus real-time collaboration server |
| `apps/feishu-mock` | Local Feishu simulator used for development and E2E tests |
| `packages/*` | Shared libraries: `core`, `content`, `database`, `auth`, `email`, `i18n`, `storage`, `engine`, `ui` |
| `docs/implementation` | Design and behaviour notes (Chinese) |
| `scripts` | Guard scripts that CI also runs |

Package dependencies point one way: `core` ← `{content, database, i18n, storage, auth, email}` ← `engine` ← `apps/web`;
`ui` may only depend on `core`, `content`, and `i18n`. `pnpm run lint:deps` enforces this.
[AGENTS.md](AGENTS.md) summarises the engineering rules in more detail.

## Development setup

```bash
pnpm install --frozen-lockfile
cp env.example apps/web/.env      # then edit the values
pnpm --filter @megaui/web run dev # http://127.0.0.1:3000
```

See the [configuration reference](docs/configuration.md) for every environment variable.
Some integration tests start their own PostgreSQL and therefore need a running Docker
(or Podman) daemon; the plain unit tests do not.

## Checks to run before you push

```bash
pnpm turbo run typecheck
pnpm turbo run lint            # includes the dependency-direction guard
pnpm vitest run <path>         # the tests for the code you touched
pnpm vitest run                # the full unit suite (needs Docker for DB-backed tests)
```

CI additionally runs the guard scripts in `scripts/` (brand residue, license allowlist,
secret residue, docs links, public assets). Run them locally when you touch the files they cover:

```bash
bash scripts/check-brand-residue.sh
bash scripts/check-docs-links.sh
bash scripts/check-licenses.sh
bash scripts/check-env-placeholders.sh env.example .env.test.example
```

## Code and documentation conventions

- **TypeScript, strict.** No `any` shortcuts to silence the compiler; keep public exports stable
  or call out the change in the pull request.
- **Tests with the change.** New behaviour and bug fixes need tests next to the code
  (`*.test.ts`, contract tests under `apps/web/tests/contract`, E2E under `apps/web/tests/e2e`).
- **i18n.** User-visible strings live in `packages/i18n/src/locales`; add both `en` and `zh-CN`.
- **Fail closed.** Authentication, authorisation, and configuration parsing must reject unknown or
  missing input rather than fall back to a permissive default.
- **Secrets.** Never commit real credentials. Sample env files only contain placeholders
  (`replace-with-...`); `scripts/check-env-placeholders.sh` enforces it.
- **Docs.** Update the relevant file under `docs/` when behaviour or configuration changes.
  `docs/` is currently written in Chinese; English contributions are welcome and will be
  accepted alongside.
- **Provenance headers.** Source files start with a `// megaui-only: ...` or
  `// megaui:<path>@<sha>` header where the package guards require it. Keep the header when you
  edit a file.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/)-style messages:
  `<type>(<scope>): <summary>`, where `type` is one of `feat`, `fix`, `docs`, `chore`,
  `refactor`, `test`, `build`, `ci`.
- **Sign off every commit** (`git commit -s`) to certify the
  [Developer Certificate of Origin](https://developercertificate.org/).
- Stage only the files that belong to the change; keep unrelated edits out.
- Keep a pull request focused on one change and fill in the pull request template.
- Maintainers may ask for changes; please respond in the same thread.

## License

megaui is dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE) at your option.
Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in
this project, as defined in the Apache-2.0 license, is licensed as above, without any additional
terms or conditions.

---

## 中文

感谢你关注 megaui。本文说明如何提出改动、搭建开发环境、运行检查并提交 Pull Request。参与项目即表示你同意遵守[行为准则](CODE_OF_CONDUCT.md)。

### 开始之前

- **小改动**（错别字、文档、带测试的明显缺陷修复）可以直接提交 Pull Request。
- **较大的改动**（新功能、行为变更、新增包、数据库结构变更）请先开 Issue，说明问题、动机、范围和非目标，在方向达成一致后再实现。
- **安全问题**不要在公开 Issue 中报告，请见 [SECURITY.md](SECURITY.md)。

### 仓库结构

megaui 是 pnpm + Turborepo 的 monorepo（Node.js 24，`pnpm@10.32.1`）：`apps/web` 是 Next.js 应用与 BFF（唯一与 mega2 对接的出口），`apps/collab-server` 是协作服务，`apps/feishu-mock` 是本地飞书模拟器，`packages/*` 是共享库。包依赖方向单向：`core` ← `{content, database, i18n, storage, auth, email}` ← `engine` ← `apps/web`，`ui` 只能依赖 `core`、`content`、`i18n`，由 `pnpm run lint:deps` 强制。更多工程约束见 [AGENTS.md](AGENTS.md)。

### 开发环境

```bash
pnpm install --frozen-lockfile
cp env.example apps/web/.env      # 然后修改取值
pnpm --filter @megaui/web run dev # http://127.0.0.1:3000
```

全部环境变量见[配置参考](docs/configuration.md)。部分集成测试会自行启动 PostgreSQL，需要可用的 Docker（或 Podman）；普通单元测试不需要。

### 提交前的检查

```bash
pnpm turbo run typecheck
pnpm turbo run lint
pnpm vitest run <路径>
```

CI 还会运行 `scripts/` 里的守卫脚本（品牌残留、许可证白名单、密钥残留、文档链接、公共资源）。

### 约定

- TypeScript 严格模式；公开导出保持稳定，变更需在 PR 中说明。
- 改动要带测试；用户可见文案放在 `packages/i18n/src/locales`，同时补 `en` 与 `zh-CN`。
- 认证、授权与配置解析必须 fail-closed；不要提交真实凭据，示例 env 只能写占位符。
- 行为或配置变化时更新 `docs/`（目前以中文为主，欢迎英文贡献）。
- 提交信息使用 `<type>(<scope>): <summary>`；每个提交都要签名确认（`git commit -s`，即 DCO）；只暂存与本次改动相关的文件。

### 许可证

megaui 以 [MIT](LICENSE-MIT) 或 [Apache-2.0](LICENSE-APACHE) 双许可，由你任选其一。除非你明确声明，你有意提交的贡献按 Apache-2.0 的定义以相同方式授权，不附加任何额外条款。
