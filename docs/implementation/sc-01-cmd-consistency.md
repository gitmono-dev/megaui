# SC-01 provisional 命令 ↔ 回填 CMD 对照清单

| provisional（回填前） | 回填后 CMD | 一致？ |
|---|---|---|
| `pnpm install`（bootstrap，非 frozen） | CMD-10 | 是 |
| `pnpm install --frozen-lockfile` | CMD-00 | 是 |
| `pnpm turbo run typecheck build lint` | CMD-01 / CMD-02 / CMD-03 | 是 |
| `pnpm vitest run` | CMD-05（CMD-04 = 同 runner 加路径） | 是 |
| `pnpm exec playwright test --list` | CMD-07 收集范围核对 | 是 |

模板版本：`v1.3`（2026-09-02）。CI-01 仍为 `无`（SC-02）。
