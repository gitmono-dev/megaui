# ADR-FS-01：megaui PG 全文搜索方案（SP-01 / GAP-04）

- **Status:** Accepted（go/no-go 见下）
- **Date:** 2026-09-03
- **Spike card:** SP-01
- **Consuming cards:** EG-10（English + schema）、EG-14（CJK 补强）
- **Baseline refs:** REF-05 `libs/mega/services/{search,search-fts}.ts@0ff3a9d`；REF-07 上游前端仓 `libs/database/drizzle/0011_body_fts.sql@0ff3a9d`；REF-06 `postgres:15-alpine`
- **Spike environment:** `docker run --rm -d --name megaui-spike-pg -p 15433:5432 -e POSTGRES_PASSWORD=<redacted> postgres:15-alpine`

## Context

GAP-04：上游前端仓 正文搜索按方言分支——Postgres 用 `tsvector + GIN`，SQLite IT 用 FTS5。本仓 ADR-ARCH-02 只保留 PG。PK-05 已落地 `mega_content_blocks`（含 `text_summary`），但**尚未**移植 上游前端仓 `0011_body_fts.sql` 的 generated `text_search` 列与 GIN 索引（schema 注释仅登记了索引名约定）。

SP-01 需在联调栈同系列镜像（`postgres:15-alpine`）上回答四个问题，并给出三选一 go/no-go。

## Decision（go/no-go）

**选择：移植 + CJK 补强**（不是「原样移植 alone」，也不是「立即换分词镜像」）。

| 备选 | 结论 | 理由 |
|---|---|---|
| 原样移植 上游前端仓 PG 路径 | **拒绝作为完整方案** | English 路径可用且与 上游前端仓 生产 PG 对齐；但对 CJK 子串召回实测为 **0 hits**（见 Q1），不满足本仓双语产品面。 |
| **移植 + CJK 补强** | **采纳** | EG-10 先落 上游前端仓 同款 `english` tsvector+GIN（`plainto_tsquery('english')`，**默认不加** `:*` 前缀，与 上游前端仓 PG 生产路径一致）；另加明确的 CJK **精确子串**召回策略（见 ① / Consequences），不得把默认阈值 `pg_trgm %` 或无证据的「已索引 ILIKE」写成已验证方案。 |
| 换分词镜像（zhparser / pg_jieba） | **拒绝作为 SP-01 阻断项** | `postgres:15-alpine` **无** zhparser/jieba 扩展；引入自定义镜像属 DEP-01 仓外评估。可作后续增强，不阻塞 EG-10 首版。 |

## Answers to the four spike questions

### ① tsvector 配置对中文/CJK 的召回与是否需要 zhparser

**实测（postgres:15.18 alpine）：**

- 上游前端仓 DDL：`to_tsvector('english', coalesce(text_summary,''))` + `plainto_tsquery('english', $q)`（见 `0011_body_fts.sql` / `searchPostgresFts`）。
- `to_tsvector('english'|'simple', <CJK 句子>)` 均把**整句当作单一 token**（无字/词切分）。
- 查询 `plainto_tsquery('english'|'simple', '全文搜索'|'工作台')` 对含这些子串的行 → **0 rows**。
- 仅当查询字符串与整段 `text_summary` **完全相等**时，simple/english 才能命中（整 token 相等）。
- `pg_available_extensions`：有 `pg_trgm`；**无** zhparser / jieba。
- **CJK 精确子串召回策略（SP-01 定稿，供 EG-10 执行）：**
  1. **谓词（首选）：** `position(lower(query) in lower(coalesce(text_summary,''))) > 0`——字面子串，无 `%`/`_` 通配风险。若实现选用 `ILIKE`，必须先对 query 转义 `%`/`_`/`\` 再包 `%…%`，且单测覆盖通配字符。
  2. **不得**把默认 `similarity_threshold=0.3` 下的 `text_summary % query` 当作召回方案（实测 0 hits）。
  3. **按 kind 有界取数 + 公平归并（防饿死，GC-10；单次扫描优先）：**
     - **生产首选 SQL（单次 Seq Scan + 窗口）：** 选出 `source_type, source_id, block_id, text_summary, rn`（**必须投影 `text_summary`**，禁止 ID-only 后再逐条回表）；`row_number() OVER (PARTITION BY source_type ORDER BY source_id, block_id) AS rn`；外层 `WHERE rn <= $perKindFetch ORDER BY source_type, rn`（保留窗口序）。谓词含 `position(lower($q) in lower(...))` 与 `source_type = ANY($kinds)`。`$kinds` **必须**是 REF-05 `BODY_FTS_KINDS`：`doc` / `issue` / `cl` / `doc_comment` / `issue_comment` / `cl_comment` / `chat_message`（**禁止**用 `channel` / `comment` / `release` 等非 body 别名）。`perKindFetch = min(500, max(perKind, (offset + perKind) * FETCH_MULTIPLIER))`。
     - **应用层（仅 CJK）：** 对窗口结果做确定性 **round-robin**（按请求 kinds 序），再 `applyLimits`。禁止 (i) 全局 `ORDER BY source_type … LIMIT`；(ii) kind 串联后直接 `slice(total)`（7×5>30 会整段饿死末位 kind）。
     - **备选：** N 次 per-kind / `UNION ALL` 仅当窗口方案不可用且全请求墙钟证明 ≤P95（本 spike 7-kind CTE ~74ms，劣于窗口 ~45ms）。
     - **English：** 保持 `ORDER BY ts_rank DESC`；**禁止**对 English 做 round-robin（破坏 checklist #2 / REF-05）。English 宽取窗 + `applyLimits` 沿用 上游前端仓。
     - 单测：高扇出不饿死；kinds×perKind>total 无一 kind 整段丢弃；English 严格 rank 降序。
  4. **强制规模守卫 + 错误契约：** blocks `> 200_000` 且无 CJK 索引跟进 → CJK 路径 **fail-closed**，禁止继续全表 `position`。EG-10 必须落地完整契约（见 Consequences #3），不得只抛裸 `Error`。
  5. **跟进（非 SP-01 门禁）：** DEP-01 评估 zhparser/自定义镜像，或后续卡引入可索引 CJK n-gram；在跟进落地前，禁止宣称「CJK 已走 GIN」。
  6. 查询路由：含 CJK 脚本 → 单次窗口有界 `position` + 仅 CJK round-robin（整串字面量；混合中英不拆 AND，有意限制）；否则 → english FTS。

**结论：** 原样 `english` 路径不能承担 CJK 子串搜索。首版 CJK 补强 = **已证实的精确子串谓词 `position`** + **单次窗口 per-kind 有界扫描（附全请求预算）**；默认阈值 `pg_trgm %` 禁止。zhparser / 可索引 CJK 交 DEP-01 或后续卡。

### ② 本仓 DDL / 维护方式与 上游前端仓 差异

**EG-10 应执行的可复现 DDL（对齐 上游前端仓 `0011_body_fts.sql`）：**

```sql
ALTER TABLE mega_content_blocks
  ADD COLUMN text_search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(text_summary, ''))) STORED;
CREATE INDEX mega_content_blocks_fts_idx
  ON mega_content_blocks USING gin (text_search);
-- Optional follow-up only (NOT v1 required):
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CREATE INDEX … USING gin (text_summary gin_trgm_ops);
```

| 项 | 上游前端仓 | megaui（EG-10 应落地） |
|---|---|---|
| 表 | `mega_content_blocks` | 同名（PK-05 已有；本 spike 在同结构上验证） |
| generated 列 | 上表 `ALTER … GENERATED … STORED` | **同款**（新 migration，建议 `0002_body_fts.sql`） |
| GIN | `mega_content_blocks_fts_idx` | **同名**（PK-05 注释已预留） |
| Drizzle model | 不建模 generated 列 | **保持不建模**（写入只写 `text_summary`；块重建沿用 上游前端仓 CE-50） |
| CJK 补强 | 无 | **v1：** `position(...)` + **单次窗口 per-kind** + 仅 CJK round-robin（见 ①）；**禁止**默认阈值 `%`。**跟进：** DEP-01 zhparser / n-gram |
| SaaS / 其它表 | 无独立 title FTS 列 | 不变；title 仍走应用层（见 ③） |

**维护证据：** `text_summary` 更新后 generated `text_search` 由 PG 自动维护（STORED）；无需应用层双写。本 spike 建表即用同款 generated 表达式，English 查询走 GIN（Appendix A.1）。

### ③ `ts_rank` 权重（title>body）与前缀 `:*` 与两分支规格

**行为规格（整理自 REF-05，供 EG-10 验收）：**

| 表面 | 机制 | title>body？ | 前缀 |
|---|---|---|---|
| 标题 / 编号组（⌘K） | `search.ts` 的 `searchTextScore`（exact/prefix/word-boundary/substring，**越低越好**） | 标题组独立排序，不经 tsvector | 应用层 prefix（`startsWith`） |
| 正文 FTS（PG） | `plainto_tsquery('english')` + `ts_rank(text_search, …)`，结果 rank **取负**以对齐 FTS5「越低越好」 | **无** `setweight`；正文内无 title 加权 | `plainto_tsquery` **不做** `:*`；SQLite 分支 `buildSqliteFtsMatchQuery` 才加前缀 |
| 正文 FTS（SQLite IT） | FTS5 `MATCH` | 无 title 加权 | 有前缀 token |

**Spike 补充：** 在 PG 上用 `to_tsquery('english', 'authent:*')` 可命中 “Authentication…”——说明英语前缀在 tsquery 层可行，但**不是** 上游前端仓 生产 PG 路径当前行为；EG-10 若要对齐 SQLite 前缀体验，需显式改查询构造（登记为有意差异或增强），默认先对齐 上游前端仓 PG：`plainto_tsquery`。

### ④ 数据规模基准（约 1e4 docs / 1e5 messages）

数据生成：`generate_series` 注入 **10006** `doc` + **2** `issue` + **100000** `chat_message` = **110008** 行（≈1e4 docs / 1e5 messages 量级）。

| 查询 | 计划要点 | Execution Time |
|---|---|---|
| English `plainto_tsquery('postgres migration')` + `ts_rank` LIMIT 30 | Bitmap Index Scan on `mega_content_blocks_fts_idx`（724 candidates） | **~0.73 ms** |
| English CJK 词 `plainto_tsquery('全文搜索')` LIMIT 30 | Bitmap Index Scan，**0 rows** | ~0.19 ms |
| CJK **生产热路径**（`BODY_FTS_KINDS` 7 kinds，`row_number` PARTITION BY，`rn<=40`，含 `lower`） | 单次 Seq Scan + Sort + WindowAgg | **~47.2 ms** |
| CJK 7-kind 无命中（同窗口形状 + `lower`） | 单次 Seq Scan | **~30.0 ms** |
| CJK 7-kind CTE/`UNION ALL` 备选（7×扫描，含 `lower`） | Append of Seq Scans | **~74.2 ms**（次选） |
| CJK 单 kind `doc` LIMIT 40（对照） | Seq Scan + Sort | **~15.7 ms** |
| CJK 全局 `ORDER BY source_type LIMIT 500`（**非**生产，含 `lower`） | Parallel Seq Scan | **~26.6 ms** |
| CJK 无命中全表 count（含 `lower`） | Seq Scan + Aggregate | **~44.6 ms** |
| 默认阈值 `text_summary % '全文搜索'` | **0 rows**——禁止作召回 | — |
| INSERT 1e4 / 1e5 | — | ~64 ms / ~785 ms |

**相对 EG-10/EG-14 P95 < 200ms 与 GC-10：** 下列为 **单次 EXPLAIN 点估计**（非 P95）：生产窗口 ~47.2ms / 无命中 ~30ms @110k。**English P95 门归 EG-10**（`english.test.ts` 具名用例）；**CJK P95 门归 EG-14**（`bench:search`）。本 spike 只证明该形状在 110k 点估计下远小于 200ms。**≤2e5 blocks** 允许该形状；**`>2e5` 必须 fail-closed**（Consequences #3）。

**结论：** English GIN 路径可用；CJK v1 采用 `position` + 单次窗口扫描（预算内）；默认阈值 `%` 禁止。

## Consequences for EG-10 / EG-14 / WA-05 / WA-07

1. **EG-10：** 新增 **手写** migration `0002_body_fts.sql`（generated `text_search` + GIN），并登记 `packages/database/drizzle/meta/_journal.json` **与** 配套 `packages/database/drizzle/meta/0002_snapshot.json`（parent = `0001` snapshot；禁止只加 journal 不加 snapshot）。同步更新 `migrate.test.ts`：hash 条数 2→3，并断言 `text_search` 列与 `mega_content_blocks_fts_idx` 存在。因 generated 列不进 Drizzle model，`drizzle-kit generate` 不会自动产出。
2. **EG-14：** CJK：`position(lower(query) in lower(coalesce(text_summary,''))) > 0`；**首选**单次扫描 + `row_number() OVER (PARTITION BY source_type …) WHERE rn <= perKindFetch`；再 **仅 CJK** round-robin 后 `applyLimits`。**禁止**全局 source_type LIMIT、kind 串联直接 slice。**English 禁止 round-robin**——必须保留 `ts_rank` 降序（checklist #2）。N 次 per-kind 仅为已证明预算内的备选。
3. **EG-14 领域错误 + WA-05 HTTP + WA-07 E2E：** blocks `> 200_000` 且无 CJK 索引跟进 → CJK 路径 **fail-closed**。分工：
   - **EG-14：** 抛 `SearchCjkScaleExceededError`（`code = "SEARCH_CJK_SCALE_EXCEEDED"`）；i18n `errors.search.cjkScaleExceeded` 双语
   - **WA-05：** HTTP 503 + JSON `{ "error": { "code": "SEARCH_CJK_SCALE_EXCEEDED", "messageKey": "errors.search.cjkScaleExceeded" } }`（仅此两字段；禁止顶层 `{code,messageKey}`；HTTP 不含 `message`）
   - **WA-07：** CMD-07 `apps/web/tests/e2e/workspace-home.spec.ts`（catalog `workspace-home.md`）
4. 非 CJK → `plainto_tsquery('english')`；含 CJK → 单次窗口有界 `position` + 仅 CJK round-robin（整串字面量；混合中英不拆 AND = 有意限制）。**禁止**默认阈值 `%`（SQL 形状守卫）。
5. Title/编号继续 `searchTextScore`；English 正文默认不加 `:*`。
6. zhparser / 可索引 CJK 跟进交 DEP-01；未跟进前不得宣称 CJK 已走 GIN。
7. **db:push fail-closed（EG-10 必做，非 README-only）：** `text_search` 不进 Drizzle model。EG-10 必须把 `packages/database/package.json` 的 `db:push` **改为硬失败**（`process.exit(1)` 提示改用 migrate）或删除该 script，并同步 README。禁止只写警告而保留可执行 `drizzle-kit push`。SP-01/RP-01 allowlist 不含 `packages/`，本条由 EG-10 同卡落地验收。

## Revisit when

- `mega_content_blocks` 行数稳定超过 **200_000**，或 CJK 生产形状 P95 逼近/超过 200ms。
- 联调栈镜像出现可用的 zhparser / pg_jieba / 可索引 CJK n-gram（DEP-01）。
- English 路径需要 `:*` 前缀或 `setweight` title>body（当前有意对齐 上游前端仓 PG，不做）。
- `BODY_FTS_KINDS` 集合变更。

## Search acceptance case checklist（EG-10 English + EG-14 CJK）

> EG-10 覆盖 English/schema 项；EG-14 覆盖 CJK/规模项（可落单测或一次性 PG 契约测试）。

1. 空查询 → 空结果。
2. English 多词 `plainto_tsquery` 命中正文，`ts_rank` 降序（对外 rank 符号与 上游前端仓 一致：内部取负或文档化）。
3. English stem（如 `authenticate` ↔ `authentication` / `migrating` ↔ `migration`）。
4. `kinds` 过滤与空 `kinds` → 无命中。
5. per-kind / total / offset 封顶（`SEARCH_BODY_PER_KIND=5`，`SEARCH_BODY_TOTAL=30`）。
6. 生产 SQL 守卫：English FTS 路径禁止 `LIKE`；CJK v1 子串路径允许已登记的可接受 Seq Scan，但不得无预算/无 EXPLAIN 证据地扩张。
7. CJK 子串（如「全文搜索」）经补强路径命中含该子串的 `text_summary`。
8. 纯 CJK 短查询不依赖「整段 text_summary 全等」。
9. Title 组仍用 `searchTextScore`（exact < prefix < boundary < substring）。
10. `#12` / `!12` 引用式查询只落到对应实体组（search.ts 规格）。
11. ACL 过滤钩子默认开放编辑策略（CE-120）可测。
12. EXPLAIN：English GIN 走索引；CJK **单次窗口 7-kind（或已证明预算内的等价形状）** 附 EXPLAIN + 全请求延迟；无命中同形状计入预算；全局 source_type LIMIT 仅对照。
13. 守卫：生产 SQL 形状禁止 `text_summary %` / 默认阈值 similarity；附录 A.3 为零行证据（需先 `CREATE EXTENSION pg_trgm`）。
14. 策略测试：含 CJK → 单次窗口有界 `position` + 仅 CJK round-robin；纯 Latin → english FTS（rank 序）。
15. 规模守卫 + 错误契约：blocks > 2e5 → 抛 `SearchCjkScaleExceededError`（`SEARCH_CJK_SCALE_EXCEEDED`）；HTTP 503；JSON 精确为 `{ "error": { "code": "SEARCH_CJK_SCALE_EXCEEDED", "messageKey": "errors.search.cjkScaleExceeded" } }`（无 `message` 字段）；双语键齐全；EG-10 单元 + WA-05 CMD-06；**WA-07** CMD-07 覆盖用户可见失败。
16. 防饿死：CJK 窗口/`perKindFetch` + **仅 CJK** round-robin；English 保持 `ts_rank`；单测覆盖高扇出、total 帽、English rank 不被打乱。
17. 手写 migration 已入 `_journal.json` **与** `0002_snapshot.json`；migrate 条数 3；断言 generated 列 + GIN；`db:push` **硬失败或删除**。
18. 基准与生产一致：附录必须含 **完整多-kind 请求**（窗口形状）+ `lower` 谓词 + 无命中同形状；不得用单 kind / 未 lower 冒充热路径预算。

## Appendix A — Spike command log (sanitized)

```text
image: postgres:15-alpine (PostgreSQL 15.18)
container: megaui-spike-pg
port: 15433
auth: POSTGRES_PASSWORD=<redacted>
```

### A.1 English FTS @ ~110k rows (sanitized EXPLAIN)

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, ts_rank(text_search, plainto_tsquery('english', 'postgres migration')) AS rank
FROM mega_content_blocks
WHERE text_search @@ plainto_tsquery('english', 'postgres migration')
ORDER BY rank DESC LIMIT 30;
```

```text
Limit  (actual rows=30)
  ->  Sort (top-N heapsort)
        ->  Bitmap Heap Scan on mega_content_blocks (actual rows=724)
              Recheck Cond: (text_search @@ '''postgr'' & ''migrat'''::tsquery)
              ->  Bitmap Index Scan on mega_content_blocks_fts_idx (actual rows=724)
Planning Time: ~0.14 ms
Execution Time: ~0.73 ms
```

### A.2 CJK production hot path (single-pass window, lowercased)

Body kinds = REF-05 `BODY_FTS_KINDS` (`doc`,`issue`,`cl`,`doc_comment`,`issue_comment`,`cl_comment`,`chat_message`). Spike data @110008 rows had hits only in `doc` + `chat_message` (issue=2, others empty).

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT source_type, source_id, block_id, text_summary, rn FROM (
  SELECT source_type, source_id, block_id, text_summary,
         row_number() OVER (PARTITION BY source_type ORDER BY source_id, block_id) AS rn
  FROM mega_content_blocks
  WHERE position(lower('全文搜索') in lower(coalesce(text_summary,''))) > 0
    AND source_type = ANY(ARRAY['doc','issue','cl','doc_comment','issue_comment','cl_comment','chat_message'])
) t WHERE rn <= 40
ORDER BY source_type, rn;
```

```text
Subquery Scan on t (actual rows=41)
  -> WindowAgg (actual rows=41)
       -> Sort (actual rows=4348)
            -> Seq Scan on mega_content_blocks (actual rows=4348)
                 Filter: position(lower) AND source_type = ANY(BODY_FTS_KINDS)
Planning Time: ~0.66 ms
Execution Time: ~47.2 ms
```

No-hit same shape: ~30.0 ms. Secondary 7× UNION ALL: ~74.2 ms (not preferred).
Non-production global `ORDER BY source_type LIMIT 500`: ~26.6 ms.

### A.3 Default-threshold similarity (must not be treated as recall)

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SELECT count(*) FROM mega_content_blocks
WHERE text_summary % '全文搜索';  -- default similarity_threshold=0.3
-- result: 0
```

## Appendix B — Allowlist / production surface

SP-01 / RP-01 仅允许改动：

- `docs/implementation/adr-fs-01-pg-fts.md`（本文件）

不得改动 `apps/`、`packages/`、根工程文件、CI workflow。
