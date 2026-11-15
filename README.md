# megaui: Web Workspace for Mega

> An open-source web workspace for the [Mega](https://github.com/gitmono-dev/mega2) monorepo engine: code browsing, change lists, issues, collaborative documents, chat, and agent sessions, built with Next.js, Hocuspocus, and PostgreSQL.

English · [中文](README.zh.md)

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](#license)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A524-339933.svg)](.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-10.32.1-F69220.svg)](package.json)

**megaui is the front end of the Mega stack.** It gives teams one workspace on top of a [mega2](https://github.com/gitmono-dev/mega2) server: browse the monorepo, review change lists, track issues, write documents together in real time, talk in channels, and run agent sessions. The browser never talks to mega2 directly; every call goes through the server-side BFF adapter in `apps/web` and the mega2 client in `packages/engine`, which keeps authentication, error mapping, and the mega2 contract in one place.

megaui is **pre-release (`0.x`)**. The core workspace is usable, interfaces may still change, and the project is under active development.

Start with the [Quick start](#quick-start), then see the [Configuration reference](docs/configuration.md) for every environment variable and the [Contributing guide](CONTRIBUTING.md) to get involved.

## At a glance

| Item | Details |
|---|---|
| What it is | Web workspace for a mega2 monorepo server |
| Language | TypeScript (strict), Node.js 24, pnpm workspaces + Turborepo |
| Web app | Next.js (App Router) with a server-side BFF under `apps/web/app/api/mega/**` |
| Real-time | Hocuspocus collaboration server (`apps/collab-server`, default port `7002`) |
| Data | PostgreSQL via Drizzle ORM; S3-compatible object storage for uploads |
| Authentication | [Better Auth](https://www.better-auth.com): email and password, optional Google and GitHub; **enterprise mode** with Feishu private-chat pairing |
| Languages | English and Simplified Chinese (`en`, `zh-CN`) |
| Backend | [mega2](https://github.com/gitmono-dev/mega2) (OpenAPI contract) |
| Tests | Vitest unit and contract tests, Playwright E2E |
| License | MIT OR Apache-2.0 |

## What is in the workspace

The workspace is a single shell with a left rail, a command palette (`⌘K`), and favorites. Its sections are:

- **Home**: a dashboard of review requests, assigned issues, activity, releases, and recent documents.
- **Code**: browse trees and files of the monorepo, with READMEs rendered inline.
- **Change lists (CL)**: list, review, and discuss changes, with file diffs, revisions, checks, and dependency views.
- **Issues**: track and discuss work, with comments and reactions.
- **Docs**: collaborative block-based documents with comments and cross-references.
- **Chat**: channels and direct messages backed by the same collaboration server.
- **Agent**: agent sessions with streaming output.
- **Releases and tags**, an **inbox** for notifications, and **settings** (including personal credentials).

## Repository layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js web application and the BFF adapter to mega2 |
| `apps/collab-server` | Hocuspocus real-time collaboration server |
| `apps/feishu-mock` | Local Feishu simulator for development and E2E tests |
| `packages/core` | Leaf package: shared types and pure logic |
| `packages/content`, `database`, `i18n`, `storage`, `auth`, `email` | Domain libraries built on `core` |
| `packages/engine` | Services and workers that combine the libraries; the only package `apps/web` imports business logic from |
| `packages/ui` | Design system, workspace shell, and editor components |
| `docs` | Design notes and the [configuration reference](docs/configuration.md) |
| `scripts` | Guard scripts that CI also runs |

Package dependencies point one way: `core` ← `{content, database, i18n, storage, auth, email}` ← `engine` ← `apps/web`, and `ui` depends only on `core`, `content`, and `i18n`. `pnpm run lint:deps` enforces this rule.

## Quick start

You need Node.js 24 and pnpm 10.32.1, a PostgreSQL database, and (for the full workspace) a running [mega2](https://github.com/gitmono-dev/mega2) instance.

```bash
git clone https://github.com/gitmono-dev/megaui.git
cd megaui
pnpm install --frozen-lockfile

cp env.example apps/web/.env      # then edit the values; see docs/configuration.md
pnpm --filter @megaui/database run db:migrate   # apply the database schema
pnpm --filter @megaui/web run dev               # http://127.0.0.1:3000
```

Optional: start the collaboration server, which powers documents and chat.

```bash
pnpm --filter @megaui/collab-server run dev     # default port 7002
```

At minimum set `APP_BASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_TRUSTED_ORIGINS`, `DATABASE_URL`, `EMAIL_PROVIDER`, and `EMAIL_DEFAULT_FROM`. Sample values in `env.example` are placeholders (`replace-with-...`) and must be replaced; the app fails closed on missing or unknown values. To connect to mega2, set `MEGA2_PUBLIC_BASE_URL` and the collaboration variables described in the [configuration reference](docs/configuration.md). `GET /api/health` reports liveness.

### Docker

`apps/web/Dockerfile` builds the production web image by default and has a `db-init` target for running migrations; `apps/collab-server/Dockerfile` builds the collaboration server. Build from the repository root.

```bash
docker build -f apps/web/Dockerfile -t megaui-web:local .
docker build -f apps/web/Dockerfile --target db-init -t megaui-db-init:local .
docker build -f apps/collab-server/Dockerfile -t megaui-collab:local .
```

Pushing a stable `v<major>.<minor>.<patch>` tag runs `.github/workflows/docker.yml`. It builds `apps/web/Dockerfile` target `runner` for `linux/amd64` and `linux/arm64`, then publishes `${DOCKER_USER}/megaui` (Docker Hub `genedna/megaui`) with the version tags. `latest` moves only when the tag is the highest stable release.

### Enterprise sign-in (optional)

Set `AUTH_MODE=enterprise` to replace password sign-in with Feishu private-chat pairing: the user sends a one-time `/login` command to the bot and enters the 8-character code it returns. For local development, `apps/feishu-mock` provides a loopback simulator so no real Feishu tenant is needed. See [Enterprise identity: configuration contract](docs/implementation/enterprise-auth.md) and [Feishu mock](docs/implementation/feishu-simulator.md) (Chinese).

## Development

```bash
pnpm turbo run typecheck            # type-check every package
pnpm turbo run lint                 # eslint plus the dependency-direction guard
pnpm vitest run <path>              # unit tests for the code you changed
pnpm vitest run                     # the full unit suite
pnpm exec playwright test <spec>    # E2E (apps/web/tests/e2e)
```

Tests that start their own PostgreSQL need a running Docker or Podman daemon. CI also runs the scripts in `scripts/` (brand residue, license allowlist, secret residue, docs links, public assets); see [CONTRIBUTING.md](CONTRIBUTING.md) for the full list and [AGENTS.md](AGENTS.md) for the engineering rules.

## Documentation

| Start here | What it covers |
|---|---|
| [`docs/configuration.md`](docs/configuration.md) | Every environment variable, and the CI guard tools (Chinese) |
| [`docs/implementation/enterprise-auth.md`](docs/implementation/enterprise-auth.md) | Enterprise identity configuration contract (Chinese) |
| [`docs/implementation/chat-collab-protocol.md`](docs/implementation/chat-collab-protocol.md) | Chat and collaboration protocol (Chinese) |
| [`docs/implementation/document-page-features.md`](docs/implementation/document-page-features.md) | Document editing features (Chinese) |
| [`docs/implementation/ci-test-isolation.md`](docs/implementation/ci-test-isolation.md) | How CI isolates and parallelizes tests (Chinese) |
| [`docs/implementation/application-visual-style.md`](docs/implementation/application-visual-style.md) | Visual style baseline (Chinese) |

Design notes under `docs/implementation` are written in Chinese; English contributions are welcome.

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) first. For anything larger than a small fix, open an issue to agree on the direction before implementing. Report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

megaui is dual-licensed under MIT and Apache-2.0 (`MIT OR Apache-2.0`); you may choose either license:

- [MIT License](LICENSE-MIT)
- [Apache License 2.0](LICENSE-APACHE)

Third-party code copied directly into this repository is declared in [`NOTICE`](NOTICE).

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in this project, as defined in the Apache-2.0 license, shall be dual-licensed as above, without any additional terms or conditions.
