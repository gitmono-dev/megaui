# 企业身份：配置合同

本文件说明企业身份功能的共享配置合同。当前只交付配置解析，登录面由后续卡逐片交付。

## 认证模式

`AUTH_MODE` 由所有进程共享，只接受三个值：

| 值 | 语义 |
|---|---|
| `legacy` | 保持既有认证行为；未配置 `AUTH_MODE` 的旧部署也落在这一档 |
| `enterprise` | 企业身份模式；缺少当前能力必需配置时拒绝启动 |
| `maintenance` | 维护模式 |

解析规则：值前后空白会被归一；空字符串与缺省都按 `legacy` 处理；其它取值一律拒绝。部署持有持久激活标记时解析器拒绝 `legacy`，避免已激活部署退回旧模式。

## 解析器

`@megaui/core` 导出 `resolveEnterpriseConfig({ authMode, activated, required })`：

- 调用方注入配置对象，解析器不读取环境、不持有运行态 secret，因此网站、worker 与其它进程复用同一份语义。
- `required` 是当前能力要求配置的**值**，解析器只把缺失项的**名字**写进错误，不回声任何值。
- 失败时抛出 `EnterpriseConfigError`，其 `code` 是稳定机器键：`auth_mode_invalid`、`enterprise_config_missing`、`enterprise_activation_conflict`。调用方按 `code` 分支，不要匹配文案。

## server-only 边界

`@megaui/core` 同时导出 `CLIENT_SAFE_KEYS`、`isClientSafeKey` 与 `findClientUnsafeKeys`：只有列在白名单里的配置可以进入客户端 bundle，白名单之外默认 server-only。新增敏感配置必须留在服务端；密钥残留守卫由 FS-51 承接，provider 准入由 FS-87 承接。

## provider 准入与唯一目标

`@megaui/core` 导出 `admitProvider(input)`，它是 provider 的唯一准入 owner：

- 输入是调用方注入的对象（`enabled`、`provider`、`role`、`nodeEnv`、`simulatorOrigin`）。模块不读 `process.env`、不请求 HTTP，因此所有进程复用同一份语义。
- 只有当前进程启用 provider 能力（`enabled: true`）时才构造目标；未启用时不返回任何目标。
- 启用后 `provider` 必须显式是 `feishu` 或 `simulator`；缺省、空白或其它取值一律拒绝。
- `feishu` 的源固定为官方 `https://open.feishu.cn`，不可配置。
- `simulator` 只允许可信 `development` / `test` 部署角色，且只允许 `NODE_ENV` 为 `development` / `test`；`production` / `canary` 角色与 `production` 环境一律拒绝。
- `simulator` 的源只接受独立 Mock 合同的精确 loopback origin，即 `http://127.0.0.1:<port>`（端口 1..65535）且字符串本身就是该 origin。校验比对原始字符串而非解析后的 URL：URL 解析会丢掉端口 80，也会把 `127.1`、`2130706433` 这类非字面主机改写成 `127.0.0.1`。`localhost`、`[::1]`、其它回环地址、`https`、缺端口、带路径/查询/片段/凭据、尾斜杠或多余空白都属于歧义写法，一律拒绝。

结果是一个冻结的单一目标 `{ provider, origin }`：没有备用 provider，也没有失败后切源的能力，传输故障不能改变来源。请求参数不能覆盖 provider 或 origin——`resolveRequestTarget(admission, request)` 只返回准入结果，请求里的 `provider` / `origin` 一律不被读取。

失败时抛出 `ProviderAdmissionError`，其 `code` 是稳定机器键：`provider_not_selected`、`provider_unknown`、`provider_role_untrusted`、`provider_env_untrusted`、`provider_origin_invalid`。调用方按 `code` 分支，不要匹配文案。

`resolveEnterpriseConfig` 在 `enterprise` 模式下、调用方传入 `provider` 时会先跑一次准入，准入失败即拒绝启动；`legacy` / `maintenance` 不构造目标。后续的 token 与 HTTP 传输只消费这里冻结的目标，不得重新决定准入。

## 新增密钥的 CI 残留守卫

企业密钥的单一清单落在 `scripts/check-enterprise-secrets.sh`（对应 ADR-FS-ENT-07 的 secret 清单）：`FEISHU_APP_SECRET`、`FEISHU_EVENT_ENCRYPT_KEY`、`FEISHU_EVENT_VERIFICATION_TOKEN`、`ENTERPRISE_OTP_HMAC_KEY`、`ENTERPRISE_DELIVERY_KEY`、`ENTERPRISE_IP_HMAC_MASTER_KEY`、`ENTERPRISE_INTROSPECTION_KEY`、`ENTERPRISE_COLLAB_REVOKE_KEY`、`ENTERPRISE_CANARY_SIGNING_PRIVATE_KEY`、`ENTERPRISE_PROBE_SIGNING_PRIVATE_KEY`、`ENTERPRISE_LIVE_RESULTS_PRIVATE_KEY`。新增密钥先加进这份清单，守卫即接管，不用再改扫描表达式。

守卫跑两条扫描，任一命中或工具出错都以非零退出：

- **生产赋值扫描**：生产面（`apps`、`packages`、`scripts`、`package.json`、`pnpm-workspace.yaml`）不得给这些 key 赋值。`rg` 命中即失败；`rg` 退出码大于 1 是工具错误，同样失败。
- **样例占位扫描**：样例环境文件里这些 key 只能缺省或取占位前缀（`replace-with-` / `REPLACE_WITH_`），出现具体值即失败。

失败输出只报 `文件:行:key`，不回显被检查的值，`scripts/check-env-placeholders.sh` 同样不再回显值。CI 在 `Enterprise secret guard (FS-51)` 步骤真实执行该守卫。

本地复现与恢复：`bash scripts/check-enterprise-secrets.sh` 用默认目标扫描，可用 `MEGAUI_ENTERPRISE_SURFACES` 与 `MEGAUI_ENTERPRISE_SAMPLES` 覆盖扫描目标，`--list` 打印清单。恢复方式是把生产面里的赋值删除或改为从 secret store 注入，并把样例文件里的值改回占位前缀；守卫不回显真实值，因此不要把值贴进工单或提交信息。

## 一次性 PG 迁移 fixture

测试用的 Postgres 由隔离器独占：`packages/database/src/test-support/isolated-pg.ts` 在本次运行内创建一个带 `megaui-run-id` 标签的独立容器，从该容器派生连接串，在容器内创建一个以随机 run_id 命名的一次性数据库，把迁移只应用到该库，并在结束时只销毁本次运行登记的数据库与容器。

- 隔离器不读 `DATABASE_URL`：任意外部连接串都不可能成为 fixture 的写入目标，也不可能有外部数据库被本次运行销毁。
- 每次运行创建随机 run_id 的容器与数据库，容器名与标签都带 run_id，遗留资源可归因；进程退出时还有兜底清理。
- 迁移只应用到本 run 创建的一次性库；同一库重跑迁移不增加 journal 记录。
- 销毁失败会抛错，让验证失败而不是被忽略。
- 迁移一致性由 `packages/database/src/migrate.test.ts` 证明：表清单是显式 schema 清单（每张 schema 卡同卡更新），迁移条数取自生成的 journal，不再保留「23 表 / 4 迁移」的固定快照。

隔离器需要 docker：没有 docker 时本地跳过并给出警告，CI 里缺 docker 是硬失败。postgres 服务不能替代隔离器，因为 fixture 必须拥有自己的数据库。

## 企业身份与通知资料 schema

三张表由 Drizzle 建立（`packages/database/src/schema/auth/enterprise-identity.ts`、`enterprise-profile.ts`、`enterprise-policy.ts`），全部继续引用原 `user.id`，本地 ID 永不替换：

| 表 | 内容 | 约束 |
|---|---|---|
| `enterprise_identity` | 外部身份三元组与本地用户的绑定 | `UNIQUE(tenant_key, app_id, open_id)`；`UNIQUE(local_user_id, tenant_key, app_id)` |
| `enterprise_profile` | 别名、不可变内部名与通知地址 | `UNIQUE(tenant_key, login_name)`；`UNIQUE(backend_username)`；`login_name` 必须匹配 `^[a-z0-9][a-z0-9._-]{2,63}$`；`notification_email` 可空且不参与任何唯一约束 |
| `enterprise_policy` | 实例归属与激活水位 | 每实例一行（`scope` 唯一）；`activation_state` ∈ legacy / maintenance / enterprise；`auth_epoch >= 0`；`legacy` 必带水位 0 |

`login_name` 是管理员清单分配的 ASCII 小写别名，租户内唯一，禁止从邮箱或姓名推导；`backend_username` 是实例内唯一的不可变内部名，与人用别名分离；`notification_email` 是独立可空的通知地址，同一地址可以通知多个身份，也绝不合并账号。

激活水位单调：`auth_epoch` 只增不减，已激活的部署不能回到 legacy。写入前的检查由 `assertMonotonicActivation` 负责，数据库约束另行守住「已带水位即不得自称 legacy」。

迁移由既有 `pnpm --filter @megaui/database db:generate` 生成，旧 SQL 与 journal 不改；`packages/database/src/migrate.test.ts` 的显式 schema 清单随每张 schema 卡同卡更新。

## 企业 DB 角色与迁移目标守卫

`packages/database/src/enterprise-scope.ts` 按 GC-15 的角色表校验数据库目标，`packages/database/src/enterprise-scope.test.ts` 留存可重复验证。

- 目标必须携带登记的 owner 指纹、instance id 与 environment，任一不符即拒绝企业操作。
- SQL 角色的实际权限不得超出其登记范围：只有 `migration` 与 `test` 角色可 DDL，只有 `test` 角色可 CREATEDB，其余都是 DML 角色。
- `test` 进程不得使用 production 环境的 marker。
- 陌生目标不会自动创建 owner marker：bootstrap 需要已批准的目标指纹，且只接受空库或既有 MegaUI ledger。
- `db:migrate` 在连接目标前先跑预检，预检失败则零 DDL；企业 database client（`createEnterpriseDatabaseClient`）在返回连接前执行同一守卫。

期望值来自环境：`ENTERPRISE_DB_INSTANCE_ID`、`ENTERPRISE_PROCESS_ROLE`、`ENTERPRISE_DEPLOYMENT_ROLE`、`ENTERPRISE_OWNER_FINGERPRINT` 与 `ENTERPRISE_APPROVED_TARGETS`。未声明 `ENTERPRISE_DB_INSTANCE_ID` 的部署不使用该守卫，迁移行为与之前一致。

## 租约队列与撤销 outbox schema

`packages/database/src/schema/auth/enterprise-jobs.ts` 与 `enterprise-revocations.ts` 建立两张持久表：

| 表 | 内容 | 约束与索引 |
|---|---|---|
| `enterprise_jobs` | 通用 leased job | `UNIQUE(dedupe_key)` 保证同一工作只入队一次；`claim_owner` 与 `lease_until` 记录持有者与租约；`available_at` 承载重试退避；claim 索引 `(queue, state, available_at)` 支撑有界 `FOR UPDATE SKIP LOCKED`；`completed_at` 索引支撑按 TTL 清理已完成任务 |
| `enterprise_revocations` | user-revoke outbox | `UNIQUE(user_id, auth_epoch)` 是幂等键：同一 epoch 只入队一次，后续 epoch 是新撤销；`(state, created_at)` 索引支撑投递查询；`user_id` 外键随用户删除 |

任务不是内存队列：worker 在事务内用 `FOR UPDATE SKIP LOCKED` 领取，租约到期后任务回到可领取状态。撤销 outbox 是停用事务到各处理进程的持久投递。worker 与 handler 由 FS-07 承接。

## 登录通知 outbox schema

`packages/database/src/schema/auth/enterprise-notifications.ts` 建立
`enterprise_notification_outbox`，供成功登录后的对账 worker 持久化通知任务：

| 内容 | 约束与索引 |
|---|---|
| `grant_id` | 外键指向 `enterprise_login_grants`，`UNIQUE(grant_id)` 保证同一成功登录只入队一次 |
| `destination_email` / `destination_version` | 保存独立 `enterprise_profile.notification_email` 的目的地快照及地址版本；后续 worker 可因版本漂移使旧任务失效 |
| 模板字段 | 仅保存收件人显示名、登录时间、设备、脱敏来源、应用名、普通 `http(s)` 入口和 `en`/`zh-CN` locale；表中没有 OTP、session token 或 secret 字段 |
| `state` / `attempts` / `available_at` | `pending`、`sending`、`sent`、`skipped`、`failed` 的持久投递状态；索引 `(state, available_at)` 支撑有界领取 |
| `expires_at` | 每行最多保留 31 天，`expires_at` 索引支持按截止时间分页清理，不删除仍待处理的新任务 |

本卡只交付表、约束和迁移，不发送邮件。FS-21 负责每 60 秒对账补齐 session 写后崩溃的遗漏、比较地址版本并调用 FS-31 模板；投递失败不撤销 session。测试由独立一次性 PostgreSQL 验证 grant 幂等、字段禁存认证秘密、URL 边界和到期清理。

## 通知队列与成功登录补偿

`packages/engine/src/services/enterprise/notifications.ts` 由 worker 每 60 秒调用一次：

1. 只读取已提交的 enterprise `session`、`enterprise_login_grants`、`enterprise_identity` 和 `enterprise_profile`，以 `grant_id` 幂等写入 `enterprise_notification_outbox`；session 写入后进程崩溃时，下一轮对账会补齐缺失行。
2. 收件地址只来自 `enterprise_profile.notification_email`。地址为空仍写入 `skipped` 任务；地址版本（profile `updated_at`）漂移会使尚未投递的旧任务变为 `skipped`，不会新建第二行。
3. 领取任务前重新检查 session 未过期、身份仍为 `active` 且持久策略仍为 `enterprise`。停用身份不会发送待发通知；sender 抛错只把任务标记为 `failed` 并保留 session/grant。
4. 成功后仅更新 outbox 的 `sent_at`/`state`。发送调用使用 FS-31 双语模板，来源在进入模板前脱敏，绝不读取 Better Auth 兼容邮箱、OTP 或 session token。

`ENTERPRISE_NOTIFICATION_QUEUE` 的 payload 只有规范化的 UTC `scheduledFor`，重复 slot 通过 durable-job `dedupe_key` 幂等；每轮最多处理 100 行，下一 slot 固定为 60 秒后。

## 企业暂存状态保留与 worker 清理

`packages/engine/src/services/enterprise/auth-retention.ts` 注册到标准 enterprise worker 的 `enterprise.retention` 队列，按 UTC 小时槽续排。每次 READ COMMITTED 事务以索引顺序、`FOR UPDATE SKIP LOCKED` 分页，四类行共享最多 100 条的总预算：

1. `enterprise_jobs` 只删除 `done` 且 `completed_at` 超过 30 天的记录；pending/leased 任务不会被 TTL 清理。
2. `enterprise_notification_outbox` 按 `expires_at` 到期清理，先于 grant 处理，避免外键阻塞。
3. `enterprise_login_budgets` 删除所有已过期窗口（包含匿名 IP 与身份失败额度）；匿名派生摘要的进程缓存通过 `createAnonymousIpSubjectCache` 只保留当前日和前一日，原 master 与原 IP 不进入缓存。
4. `enterprise_login_grants` 仅删除 `recover_until` 已结束、没有任何 session 引用且没有未到期通知 outbox 的孤立 grant；有效 session 的 grant 保持不动。

事务中任一删除失败都会回滚整页并抛错，不创建后继 slot；现有 worker 会把 leased job 恢复为 pending 并按指数退避重试。pairing、verified-event inbox、加密 DM delivery 的生命周期仍由 FS-11、FS-66、FS-13 各自 handler 承担，不在本卡重复清理。

## 内容域用户投影脱离邮箱

FS-22 的 Docs、评论、Issues 和 CL 服务统一调用
`packages/engine/src/services/enterprise/public-profile.ts`。企业资料的公开 `username`
只来自稳定的 `enterprise_profile.login_name`，显示名优先使用目录资料的 `display_name`；
Better Auth 的兼容 `user.email`、通知地址和不可变 `backend_username` 不进入内容作者 DTO。
内容表继续只保存原本的 `user.id` 外键，因此通知邮箱或显示名更新不会改变作者归属。尚未有
enterprise profile 的历史作者仍按既有 user 资料兼容展示，未知作者 ID 则保留为不透明占位资料。
恢复时先检查 profile 投影和内容作者 ID，再重试请求；不执行邮箱合并，也不调用外部 provider。

## 成员聊天与Release投影脱离邮箱

FS-23 的 `members.ts`、`chat/users.ts` 和 `releases.ts` 复用同一 public-profile resolver。成员、聊天作者、
DM participant 与 Release 作者均按本地 `user.id` 解析稳定的 `login_name` 和目录显示名；`user.email` 只作为
无 enterprise profile 的 legacy 兼容回退，永远不会进入公开 DTO。`notification_email` 不参与查找或去重，
因此共用通知地址的成员仍保持独立的成员行、DM participant 和内容作者。

停用只改变 `enterprise_identity.status` 与资格版本，不删除 profile 或历史外键。恢复/排障时先核对
`user.id`、profile 投影和作者资料，再读取成员、聊天或 Release；未知历史 ID 使用不透明占位资料，禁止按
邮箱重绑。所有读路径仍只做本地数据库查询，不调用 Feishu provider。

## mega2 enabled偏好与本地邮件通知分离

FS-58 将 `apps/web/lib/adapter/mega2/user-notifications.ts` 收敛到 mega2 当前的通知偏好合同：
settings 只读取 `username`、`enabled`、`created_at` 与 `updated_at`，偏好项只读取事件类型及其
当前启用状态。响应中的历史 `email`、`delivery_mode`、`preferred_locale` 字段不会进入本地
`WorkspaceNotificationSettings`，即使旧服务仍返回它们也会被丢弃。

更新请求只允许 `enabled` 和逐事件 `preferences`，adapter 不序列化已退场的邮件、投递模式或语言
字段，也不会从 Better Auth session 的兼容邮箱补值。通知地址和登录邮件继续由本地
`enterprise_profile.notification_email`、`enterprise_notification_outbox` 与 FS-21 对账 worker
负责；mega2 偏好接口不重新启用邮件发送。合同回归位于
`apps/web/tests/contract/mega2-notification-preferences.spec.ts`，并以本地 HTTP stub 验证旧字段忽略、
PUT 请求字段白名单和无 session 邮箱回退。

## 企业资料编辑入口只读化

FS-59 的设置页继续保留客户端导航就绪门，但 `profile-prefs` GET 响应由服务端
`resolveWebActor` 附带 `directoryManaged` 标志。企业 actor 的显示名与头像因此只作为目录投影展示：
显示名输入、头像文件选择和头像 URL 输入都被禁用，页面同时展示目录资料来源说明。企业保存动作仍可
更新本地简介，但不会调用 Better Auth `update-user`，也不会尝试上传或写回目录字段。

`en` 与 `zh-CN` 词典分别提供目录管理标题和说明。未命中企业资格时 `directoryManaged=false`，
legacy 页面继续调用既有 `update-user` 资料编辑合同；因此未激活企业模式的独立部署无需迁移或新的
认证入口。可重复验证位于 `apps/web/tests/e2e/enterprise-profile.spec.ts`，覆盖企业只读/简介保存
与 legacy 显示名编辑两条路径。

## Web资料与通知设置隔离

FS-24 的 `profile-prefs` GET 由 `resolveWebActor` 形成只读视图：enterprise 模式的
`username` 来自冻结的 `backend_username`，`notificationEmail` 只来自
`enterprise_profile.notification_email`，可为空，不从 Better Auth 兼容 `user.email` 补值。
本地 `bio` 和通知偏好仍分属两个写入边界；通知设置的 PUT 对未知身份字段 fail-closed，
只把当前 `enabled` 与事件偏好合同转发到 mega2，因此不会修改身份绑定。

workspace rail、首页欢迎语和协作编辑器使用 session 的 public name 或该投影的 public
username，不再从兼容邮箱推导显示名/协作作者。通知地址缺失时仍返回成功的 profile 视图，
不会阻止已登录访问；设置页以只读字段展示地址或“未配置”提示。回滚只需撤回本卡的
profile projection、调用方与契约测试，不清除 enterprise profile 或 session。

可重复验证：

```sh
pnpm vitest run apps/web/tests/contract/enterprise-notification-settings.spec.ts
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/enterprise-profile.spec.ts --config=playwright.enterprise.config.ts --workers=1 --trace=off
```

## 旧内部邮件 API 的企业模式边界

FS-50 将已退场的 `/api/internal/notifications/email` 限定为 legacy 兼容面。`AUTH_MODE=enterprise`
或 `maintenance` 时，路由在任何 Bearer 或请求体校验前固定返回 HTTP 410，不会调用邮件 sender；未知
`AUTH_MODE` 也按退场处理。legacy 模式仍要求 `Authorization: Bearer` 与
`MEGA2_INTERNAL_MAIL_BEARER`，仅接受当前产品通知事件，未知认证事件返回 422。

legacy 请求的 `recipient.email` 不能是 `identity.invalid` 兼容地址，即使配置了测试 sender 也会在
幂等预留和发送前拒绝；企业通知地址只来自 `enterprise_profile.notification_email`，本路由不会重启
mega2 邮件或把 Better Auth 的兼容邮箱当作收件地址。可重复验证位于
`apps/web/tests/contract/enterprise-legacy-mail.spec.ts`。

## 管理员操作与迁移账本 schema

`packages/database/src/schema/auth/enterprise-operations.ts` 建立三张账本表，让本期 CLI 的写入可恢复、可追责：

| 表 | 内容 | 约束与索引 |
|---|---|---|
| `enterprise_admin_operations` | 审批操作 | `UNIQUE(operation_id)` 去重重放；`manifest_digest` 记录批准对象；`expected_user_version` 与 `expected_identity_version` 记录操作者预期的版本；审计只保存摘要与计数，不保存验证码 |
| `enterprise_batch_checkpoints` | 批次 checkpoint | `UNIQUE(operation_id, batch_number)`；每条 checkpoint 绑定其操作的 `manifest_digest`，续跑不能换用未批准的清单 |
| `enterprise_quarantine` | 隔离状态 | 每个用户一条（`UNIQUE(user_id)`）；`state` 与 `reason` 是持久状态，不是一次运行的日志；`user_id` 外键随用户删除 |

延期范围的 canary 回执与 nonce 表不在本卡：它们随 DEFER-FS-03 复启时由独立 migration 交付。

## 后端 actor 保留集 schema

`packages/database/src/schema/auth/enterprise-actor-reservations.ts` 建立后端用户名的永久保留集：未绑定的历史主体、隔离中的主体、已注销主体与上游原生 actor 都保留自己的名字，不能只靠 `enterprise_profile` 的唯一键，因为这些主体没有 profile 行。

| 内容 | 约束 |
|---|---|
| `backend_username` | `UNIQUE`，全实例唯一 |
| `identity_id` / `local_user_id` | 可空：保留记录不必关联当前 identity；本地用户被删除时置空而不带走记录 |
| `actor_state` | `reserved` / `ambiguous` / `unclaimable`；多个历史主体同名时标 `ambiguous`，上游原生 actor 登记为 `unclaimable` |
| `quarantined` | 隔离中的主体只能停留在 `reserved`（数据库检查强制），因此它的名字不会被释放 |
| `source_snapshot_digest` | 非空：保留集必须记录其来源快照的摘要 |

## 飞书 token 与固定源 HTTP 传输

`packages/engine/src/services/enterprise/feishu/http.ts` 与 `token.ts` 消费 FS-87 冻结的唯一 provider 目标，不重新决定准入、不提供备用源：

- HTTP 只请求 `target.origin` 加相对路径；调用方不能指定另一个主机，重定向以 `manual` 模式取得并用 3xx 状态拒绝，不发生跟随。
- 一次操作有 20 秒总预算（含重试与退避）；临时错误（网络失败、429、5xx）按指数退避最多 3 次尝试；永久权限错误（401/403、非零业务码）不重试。
- 服务 token 按 `tenant + app` 缓存，过期前 60 秒刷新；并发过期刷新共用同一次请求，只发一次。
- 传输错误输出只有状态与业务码，绝不回显 token、app secret 或响应体。

## 应用机器人私聊消息 client

`packages/engine/src/services/enterprise/feishu/message.ts` 是企业验证码的唯一 IM v1 发送边界。它只接收已经由服务端资格事务绑定的 `open_id`、服务端生成的验证码和持久化 delivery UUID；浏览器输入、群聊 webhook 和调用方提供的 provider 目标都不能进入此边界。

- 请求固定为 `POST /open-apis/im/v1/messages?receive_id_type=open_id`，使用 FS-03 的固定源 transport 和 FS-03 的 tenant token 单飞缓存；body 只含 `receive_id`、`msg_type: "text"`、严格 JSON 字符串 `content` 与原 delivery `uuid`。
- 文本明确包含配置绑定的可信登录站点、`企业登录`用途和勿转发提示。client 不记录、抛出或回显正文、验证码、token 或 secret。
- transport 的临时错误按同一 UUID 重试，永久权限错误只尝试一次；超时、断连或其它无法确定 provider 是否已受理的结果返回 `unknown`，调用方必须沿用原 UUID，不得生成第二枚验证码。成功只接受完整的 provider envelope，并核对 message id、收件人、类型和原 content。
- FS-13 的密文 outbox worker 负责资格复查、challenge TTL 和清理；本 client 本身不创建 challenge、不降级 Email，也不把 `unknown` 当成失败后另发。

本地验证：

```sh
pnpm vitest run packages/engine/src/services/enterprise/feishu/message.test.ts
```

## 密文 DM 任务投递与清理

`packages/engine/src/services/enterprise/delivery.ts` 只消费 FS-46 已经写入的
`enterprise_dm_deliveries` 行；`enterprise_jobs` payload 只有 `deliveryId`，不携带
验证码、收件人或 provider 凭据。handler 要求当前 worker lease owner 和未过期租约，
随后重新读取原 challenge、identity 和 policy：challenge 必须仍为 `active`、未到期，
identity version 必须与发码时一致，并经 FS-10 的数据库资格 resolver（含当前 auth mode、
目录 generation/freshness、ban 和 auth epoch）通过。maintenance、已消费、过期、版本漂移、
密文无法打开或资格失败均 fail-closed，不调用 provider，也不创建 Email 认证任务。

成功发送始终使用原 challenge 解出的同一码和原 delivery UUID。provider 的 `unknown`
结果最多保留三次 claim、共享首次尝试起算的 20 秒窗口；每次重试都复用 UUID，超过次数或
窗口后直接完成 job，不再换渠道。`enterprise.dm-cleanup` 每分钟排程一页最多 100 行，
按 `expires_at` 有界删除密文，重复执行安全，保证到期密文在五分钟运维预算内清除。

本地验证：

```sh
pnpm vitest run packages/engine/src/services/enterprise/delivery.integration.test.ts
```

## 一次性 grant 与 session 元数据 schema

`enterprise_login_grants` 是验证码消费事务后创建的一次性授权事实：
`challenge_id` 唯一且引用原 challenge，绑定 scope、flow/generation、identity
及当前 auth epoch，并保存不超过 390 秒的 `recover_until`（通常为消费后的
90 秒恢复窗）。表中没有 session token 或验证码字段；`recover_until` 索引供
FS-36 的有界清理使用。

`session` 新增的 `enterprise_grant_id`、`enterprise_identity_id`、`auth_epoch`
和 `auth_method` 全部 nullable，并以 server-only 检查约束要求要么整组为空（旧
session），要么整组完整；`enterprise_grant_id` 唯一，保证一个 grant 至多关联
一个 session，identity 外键保证元数据指向现存企业身份。迁移只追加表、列、约束
和索引，不回写既有 session 的 token、期限或用户归属；FS-14/36 负责事务性消费
和创建会话。

本地验证：

```sh
pnpm vitest run packages/database/src/schema/auth/enterprise-grant.test.ts
pnpm --filter @megaui/database db:generate
pnpm vitest run packages/database/src/migrate.test.ts
```

## 验证码消费与错误预算事务

`createEnterpriseOtpConsumer` 只接收已经哈希的浏览器 flow、challenge UUID 和经
FS-49 规范化的八位码。事务由 `enterprise-grant-store` 执行，固定按
`identity → challenge → grant` 锁行，再锁定当前 policy 与该 identity/flow 的
`verify-failure` 预算；因此并发正确提交最多产生一条 grant，并且错误计数不会因
重发或并发丢失。每个 challenge 与同一 identity/flow 的滚动窗口都最多累计五次
错误，预算 subject 是带固定域分隔的 SHA-256 摘要，不保存 flow、验证码或原文。

消费前重新核对 scope、deployment、tenant/app、identity version、policy epoch、
企业 activation、身份状态和注入的 FS-10 资格 port。成功只把当前 challenge 原子
标成 `consumed`，创建绑定原 flow/generation/identity/auth epoch 的 grant，并给出
90 秒 `recover_until`；同 flow 在窗口内只能验证同一密文 HMAC 并读回原 grant，
不同 flow、已过期、已消费窗口外或资格失效都不会把 challenge 改回 active。错误和
资格拒绝使用稳定的 `invalid` 结果，数据库或依赖故障使用 `unavailable`，不输出
验证码、HMAC 或 SQL 原因。

`cleanupExpiredSecrets` 每次最多锁定并清理 100 个到期 secret；active 且已过期的
challenge 同时转为 `expired`，consumed challenge 保留 grant 和消费状态，只清除
`code_hmac`/`hmac_key_id`。该清理不删除 grant，也不允许重新激活旧验证码。

本地验证：

```sh
pnpm vitest run packages/auth/src/enterprise-otp/consume.integration.test.ts
```

## Better Auth 企业 session 创建与同 flow 恢复

`/enterprise/verify` 只接受严格的 `{challengeId, code}` 请求和同一浏览器的
`__Host-megaui.enterprise-flow` cookie；cookie 原文只在边界哈希为 flow，不回显给
客户端。插件把 FS-36 的 accepted grant 交给真实 Better Auth
`internalAdapter.createSession(userId, false, override, true)`，用 `overrideAll` 写入
`expiresAt=当前时间+8小时`、`enterpriseGrantId`、`enterpriseIdentityId`、`authEpoch`
和 `authMethod=enterprise`。这些字段在 Better Auth session additional fields 中标为
server-only，数据库唯一索引保证一个 grant 只有一个 session。

并发唯一冲突不会新建第二个 session；失败方通过 `listSessions(userId)` 读回同一
`enterpriseGrantId` 的既有行，然后复用框架 `setSessionCookie`。响应永远只返回
`{ok:true}`，不返回 session token；若 cookie 写入抛错，刚创建的 session 会通过
internal adapter 删除。FS-36 已在 cookie 前完成当前资格检查，因此不同 flow、
失效资格或已过恢复窗不会创建或恢复 session；私聊认证也不修改 `emailVerified`。

本地验证：

```sh
pnpm vitest run packages/auth/src/enterprise-otp/verify.integration.test.ts
pnpm vitest run apps/web/tests/contract/enterprise-verify.spec.ts
pnpm vitest run packages/auth/src/enterprise-otp/verify.integration.test.ts -t "overrideAll|recover|unique-conflict"
```

## 授权通讯录读取与完整快照

`packages/engine/src/services/enterprise/feishu/directory.ts` 按授权部门分页读取 Contact v3（每页 100），只走 FS-03 的固定源传输：

- 只读取配置授权范围内的部门；快照记录 `scope_hash`（tenant、app 与排序后的部门集合）与单调 `generation`。
- 所有部门的所有分页都成功读取后才标 `complete`；每页 HTTP 200 仍必须有 numeric `code === 0`、合法 `data.items`、明确 boolean `has_more`，成员的 open ID、姓名、可选 union ID/邮箱/部门列表与四状态字段都做 runtime 类型校验，需要续页时必须有非空且在该部门尚未见过的 `page_token`。缺失、类型错误、畸形成员边界或 cursor 重复/循环均返回 `complete: false` 并记录脱敏中断位置；只有此前完整接受页的成员可留在该不完整内存快照中，当前重复页不改变结果，reconciler 对整个快照零写入。
- 目录状态按边界 schema 校验（缺边界字段即拒绝）；目录邮箱按通知资料 schema校验，不可用地址存为 `null` 而非畸形值。
- `diffSnapshots` 拒绝在任何一方不完整时产出成员缺失判定，也拒绝跨 scope 比较。

## 目录快照与水位 schema

`packages/database/src/schema/auth/enterprise-directory.ts` 建立目录事实的三张表：

| 表 | 内容 | 约束与索引 |
|---|---|---|
| `enterprise_directory_snapshots` | 授权范围的完整快照 | `UNIQUE(scope_hash, generation)` 唯一标识；`complete` 与 `completed_at` 在同一事务里提交；`(scope_hash, observed_at)` 索引支撑新鲜度查询 |
| `enterprise_directory_watermarks` | 每个授权范围的当前水位 | `UNIQUE(scope_hash)`；`advanceDirectoryWatermark` 以 CAS 前进，旧或相同 generation 被拒绝 |
| `enterprise_directory_identity_watermarks` | 每个身份最近核对到的 generation | `UNIQUE(identity_id)`；`scope_hash` 索引 |

## 独立 worker 进程生命周期

`packages/engine/src/workers/enterprise.ts` 是常驻入口，命令 `pnpm --filter @megaui/engine run enterprise:worker`，不在 Next 路由里后台异步执行：

- 每次 claim 最多 100 个任务（`FOR UPDATE SKIP LOCKED`），同一租约只有一个 owner；崩溃任务在 30 秒租约到期后被新一次 claim 接管。
- 未声明scope的legacy目标handler并发上限4；scope模式普通任务并发3、配对清理专属并发1/claim1，分别拥有连接池。失败任务保留为 `pending`，按1秒起步、最大5分钟指数退避；修复下游后由同一durable job恢复。
- SIGTERM/SIGINT立即停止所有claim，通过独立控制连接取消本run backend，等待原生连接及连接池关闭；启动获取、查询超时后已断开的backend也纳入核验。10秒内退出，任一lane失败时等待另一lane清理后报告非零失败；目标配置和详细边界见[匿名配对申请与资源限额](#匿名配对申请与资源限额)。

## 目录对账与新鲜度失效

`packages/engine/src/services/enterprise/directory-sync.ts` 由 `jobs.ts` 的 durable job 每 5 分钟触发；job 只保存 tenant/app/部门范围和调度时刻，不持久化 provider credential。成功执行按原调度槽再排下一次，dedupe key 保证重试不会重复排程。

- 只有完整且与请求相同 scope 的快照才能进入事务；失败分页不写数据库，保留上一完整快照与水位。
- `packages/database/src/enterprise-directory-store.ts` 在一个事务内以 generation 原子 CAS 作为串行点，再写完整快照元数据和身份水位；`member_count`按 provider 完整页集中的去重成员计算，本期明确不新增逐快照成员投影。身份水位输入是该内存成员集里四状态均 active（activated=true、frozen=false、resigned=false、exited=false）的受校验子集；冻结、离职或退出成员计入快照总数但不会推进当前 generation，因此认证会因 identity/scope generation 不一致而 fail-closed。旧 generation 零写入，重叠执行不能倒退水位或恢复旧状态。
- 权限缩小时，首个 job 显式携带旧 scope；store 从旧 scope 的身份水位读取基线，新 scope 快照中消失的身份产出 `out_of_scope`，不读作离职。分页失败或旧 generation 会把旧 scope 继续传给下一调度槽，只有完整快照实际 `applied` 后才消费旧 scope 并恢复同范围缺失成员语义。
- 15 分钟未被观察到的身份不能取得资格（`stale`）；目录恢复不覆盖本地 ban，也不授予本地 admin 权限。停用与撤销写事务由 FS-18 接入。

## 统一企业资格判定

`@megaui/core` 提供纯 `resolveEffectiveAuthMode`、`isActiveLocalBan` 与 `isAuthenticationEligible`；`@megaui/engine` 提供 server-only `createEnterpriseEligibilityService`。factory 复制并固定 deployment tenant/app、批准部门、`enterprise_policy.scope`、已解析 `AUTH_MODE`、数据库 reader、固定源单成员 reader 与 clock。公开方法只有：

- `directoryAdmission(openId)`：只供审批后的预绑定、repair、seed 与 ready-check。它每次调用 Contact v3 精确单成员路径 `GET /open-apis/contact/v3/users/:openId?user_id_type=open_id&department_id_type=open_department_id`，不读本地快照、不要求既有 binding，也不缓存结果。HTTP 200 仍必须有 numeric `code === 0` 与合法 `data.user`；open_id 必须精确回显，至少命中一个 factory 批准部门，且四状态必须同时为 activated=true、frozen=false、resigned=false、exited=false。畸形信封、provider 错误或任一不匹配都返回拒绝，响应体与凭据不进入诊断。
- `authenticationEligibility(localUserId, identityId, epoch)`：供业务请求、bot 配对、OTP 兑换与 collab 内省。它不调用 provider，每次只执行一条 PostgreSQL SELECT，在同一 statement snapshot 内读取精确 identity↔user binding、identity status、local ban、唯一 policy、identity/scope 水位与 scope watermark 当前 generation 对应的 snapshot。结果不是恰好一行、字段畸形或数据库失败都拒绝。

`authenticationEligibility` 只有在固定 tenant/app/policy/directory scope 全匹配、identity 为 active、binding 精确、输入 epoch 等于当前 `auth_epoch`、snapshot complete、identity/scope/snapshot 三个 generation 相等，且 `0 <= now - observed_at <= 15分钟`时才把目录视为 current。active ban 的唯一谓词是 `banned === true && (ban_expires === null || ban_expires > now)`；等于当前时刻或过去的到期时间已失效，`banned`非 true 时遗留到期时间不能单独拒绝。node-postgres 对 `timestamptz '+/-infinity'` 返回数值正负 infinity：显式 ban 加正 infinity 仍是永久有效，负 infinity 已到期；未 ban 用户无论该遗留值为何都不因 expiry 单独拒绝。

有效模式组合固定为：maintenance env 在合法 policy 下得到 maintenance；legacy+legacy 得到 legacy，legacy+非legacy 拒绝；enterprise+legacy 得到 maintenance，enterprise+maintenance/enterprise 分别得到 maintenance/enterprise。policy 缺失或非法一律拒绝。业务资格只在最终模式为 enterprise 且上述全部谓词同时成立时批准；任一谓词不成立都 fail-closed。本卡不新增 schema 或 migration；恢复方式是修复 provider、policy、binding 或目录同步后重试，不得以 Cookie 或调用方参数覆盖 authority。

## 管理员 CLI 审批校验框架

管理写命令是 `pnpm --filter @megaui/engine run enterprise:admin -- <verb>`。进程只从 `ENTERPRISE_APPROVAL_PUBLIC_KEY` 读取 Ed25519 公钥；其它算法或 bundle 内的替代公钥都不能验签，进程也不持有签发私钥。写命令在调用 handler 前必须同时带 `--target`、`--approval`、`--approved-payload`、`--operation-id` 与 `--expect-policy-epoch`。`--approved-payload` 指向已签名的规范 payload 文件，也就是 digest 所覆盖的那份 canonical JSON，不是另一个输入文件。每个已注册 verb 另有严格 schema：缺参、未知 flag、重复 flag、非法数字或未配对的 UTF-16 surrogate 返回 exit 2；签名编码或验签失败返回 exit 3。可选参数的默认值在计算 digest 前写入同一份规范化 args，handler 收到的就是这组值和只读文件快照。

审批文件是 RFC 8785 规范化后的 bundle。签名覆盖除 `signature` 外的 canonical UTF-8 字节。`payloadDigest` 是同一规范化函数对 `{schemaVersion,verb,targetFingerprint,deploymentRole,operationId,expectedPolicyEpoch,args,inputFiles}` 的 SHA-256。调用方必须提交这份已签名的规范 payload。CLI 先核对 digest，再比较词法绝对路径是否等于已批准路径。文件字节由 Node 24 调用本机 `python3` 从 `/` 逐级 `O_NOFOLLOW` 打开，并一直持有第一次打开的描述符读取；路径在读取前被替换时，读到的仍是原描述符里的字节，不会读到替换文件。缺少 `python3` 是依赖失败，不是审批摘要错误。签名、verb、target fingerprint、operation id、manifest digest、过期或 payload digest 任一不符都返回 exit 3，且不注册、不调用缺少完整 guard 的写 handler。

CLI 随后以只读事务读取目标 marker 并执行既有 scope guard。数据库不可用返回 exit 4。当前已交付的业务 verb 为 `maintenance`、`reserve-actors` 与 `provision`；通过审批但尚未注册的 verb 返回 `UNKNOWN_VERB`，不写 `enterprise_admin_operations` 或 policy。诊断只输出稳定错误键，不输出审批正文、公钥或文件字节。

## 管理员写事务与 epoch 幂等

所有写 handler 必须通过 `runApprovedMutation`。事务入口自己从真实进程环境读取公钥、数据库地址、scope、role 与系统时钟，重新计算批准 digest 并核验签名，不能由调用方传入可信角色、目标、摘要或回拨时钟绕过。真实 scope guard 先于业务写入执行，deployment role 或 epoch 不符以 exit 3 拒绝且业务与账本零写入。成功与重放都返回原 `policyEpoch` 和 `resultCounts`，并标明是否重放。

同一事务内先对 operation id 获取事务级 advisory lock，再锁定 policy，读取并严格校验 operation 账本，比较 epoch 后执行 handler 和 operation 写入。业务计数与结果一起提交。相同 operation 和相同 payload 的重放返回首次结果，不重复执行 handler；同 id 不同 payload 拒绝，异常账本也不信任。崩溃导致业务与账本一起回滚，同一 operation 可安全重试。

## 完整 actor 库存快照 schema

`enterprise_actor_inventory`（FS-90）补充逐 actor 保留表：每个已存在的 policy scope 至多一行，保存批准 operation UUID、源文件 SHA-256、主体覆盖摘要、迁移归属摘要、有限的 `observed_at` 和上游 actor→显式 owner ID 数组。三个摘要均为 64 位小写 hex；空数组也能表示已批准的空库存。数据库约束 JSON 的数组形状，成员字段校验与规范化由 FS-70 写入端负责。

来源观测时间与归属摘要分离，FS-70可刷新同一归属的时效而不改变迁移批准摘要。表和类型由FS-90交付，`reserve-actors`及覆盖检查由FS-70交付；只有受审批事务实际写入的库存回执才能证明已封存，建表本身不能。

新增迁移只前滚，不修改既有保留行，不执行 down。迁移失败时不运行封存；在本 run 的隔离 PostgreSQL 修复后，重跑带作用域预检的 `pnpm --filter @megaui/database db:migrate`，再运行 `pnpm vitest run packages/database/src/schema/auth/enterprise-actor-inventory.test.ts packages/database/src/migrate.test.ts`。专属测试在临时迁移副本中注入 SQL 故障，验证新表及 journal 一起回滚，再用原迁移前滚重试，确认旧保留行不变；测试容器及副本由用例清理。真实生产迁移仍延后。

## 全部历史 actor 扫描与保留 CLI

`reserve-actors`使用全部本地user和批准的完整synthetic上游快照封存库存。已有profile沿用冻结`backend_username`；其余严格按REF-10保留非空name原字节，否则取旧email在第一个`@`之前的Rust Unicode White_Space trim结果。空actor持久隔离为`actor_missing`；多个显式owner的同名actor为`ambiguous`并隔离相关本地主体。原生actor为`unclaimable`，已有保留名不会因主体删除、来源遗漏或quarantine而释放。扫描不修改user、profile、identity或policy epoch。

输入为严格UTF-8 JSON，恰好包含`schemaVersion: 1`、`observedAt`和`actors`。`observedAt`使用UTC `YYYY-MM-DDTHH:mm:ssZ`或带三位毫秒的形式；每个actors成员恰好为`{actor, owners}`，owners为非空、无重复的显式主体ID数组，本地owner使用原`user.id`，禁止按姓名或邮箱推断归属。actor和owner均保留原字节；拒绝空白、NUL、非法Unicode、重复actor或额外字段。`actors: []`是合法的完整空快照。

```sh
pnpm --filter @megaui/engine run enterprise:admin -- reserve-actors \
  --upstream /absolute/path/upstream-actors.json --digest <源文件原字节SHA-256> \
  --target <instance> --operation-id <uuid> --expect-policy-epoch <epoch> \
  --approval /absolute/path/approval.json --approved-payload /absolute/path/request.json
```

也可使用同一组行为参数配合`--out /absolute/path/request.json --emit-approval-request`生成只读审批请求（此时不传`--approval`或`--approved-payload`）。审批由既有离线authority签发；源文件路径、原字节SHA-256及所有行为参数均受签名绑定。当前仍只面向本run合成账号及隔离数据库，真实租户接入和生产迁移延后。

来源有效期从`observedAt`起24小时，不能用重跑时间续期，未来时间及倒退时间拒绝。新operation可用重新批准的快照刷新时效；上游排序或时效元数据变化不改变迁移归属摘要，但owner、本地主体映射、隔离或永久保留状态变化会改变它。覆盖port显式接收可信instance scope，核对完整回执、当前全部主体摘要、保留行及来源时效；空库未经批准也不完整，新建同名且已隔离的主体也必须重新扫描。调用方必须在准入事务内消费结果；覆盖完整不代表主体具备登录资格。

保留、隔离、完整库存、最多100行一批的checkpoint及operation账本全部在FS-81同一事务提交；任一批次失败整笔回滚，可修复后以相同operation重试。同operation/payload成功重放只返回原始计数结果，不重新计算、不覆盖新库存，也不延长旧来源时效；新operation使用过期来源仍拒绝。输入字段/编码错误为`INVALID_ARGUMENT`（exit 2），原字节digest不符为`APPROVAL_DIGEST_MISMATCH`（exit 3），来源过期/未来/回退为`ACTOR_SOURCE_REJECTED`（exit 3）；未知故障为`DEPENDENCY_FAILED`（exit 4），不输出输入原文或actor/owner。

封存失败或覆盖不完整期间，下游provision/ready-check应拒绝准入；获取完整新批准来源后前滚，不清除旧保留或隔离账本。回归使用`pnpm vitest run packages/engine/src/services/enterprise/actor-reservations.integration.test.ts tests/guards/admin-write-verbs.test.ts`，包含专属PG、独立签发子进程、真实CLI、批次中途失败与资源清理。

## 新成员 actor 认领与准入事务 port

`createActorClaimService`（FS-71）由可信服务装配层传入 FS-10 的资格配置及受控 `createSubject` 创建步骤。factory 固定 policy scope、tenant/app、目录 reader 和创建函数；`provisionBatch(client, requests)` 接受完整的 1–100 成员批准批次，每行 `{localUserId, openId, loginName}`，在任何异步读取前复制全部字段。重复 ID/openId/alias、批内 alias 与生成 actor 碰撞、空批次或超限均写前拒绝。单成员 `provision` 委托同一批量入口；调用方不能在等待目录读取时替换目标。FS-05 已提供账户创建步骤、同批 checkpoint 及受审批 CLI 接线；较大任务须显式分批审批，FS-71本身只提供内部事务port。

调用方必须传入 FS-81 的同一 READ COMMITTED 事务 client，并保留该事务到 checkpoint 和 operation 账本提交。入口核对隔离级别，拒绝重复读、串行化或其它级别；事务本地标记拒绝同一事务第二次调用（包括另一个 factory），不能逐成员循环调用。创建步骤只能在此 client 写入指定 user/identity/profile，不得自行提交、创建独立事务或执行其它主体的变更。port 用 savepoint 防止调用方捕获拒绝后误提交半笔数据；未显式开启事务时，PostgreSQL 会在调用创建步骤前拒绝。policy 行和库存行按既定顺序锁定，两个独立批准事务串行核对最新库存。

新建路径要求持久 `enterprise` 状态和有效激活 epoch，使用 FS-10 `directoryAdmission` 重新读取精确成员，核对 FS-70 库存完整且来源未过 24 小时。已经存在的本地 ID 不通过新建路径；alias 必须符合既有小写 ASCII 格式，且不能与任何保留 actor 相同。新 `backend_username` 为 `mgu_` 加本地 ID UTF-8 字节的 SHA-256 前 32 位 hex；其与既有保留行碰撞时也拒绝，绝不通过 upsert 改绑。

全批准入和创建完成后，port 按 `user → enterprise_profile → enterprise_quarantine → enterprise_actor_reservations` 固定顺序取得 SHARE 表锁，直到外层 commit/rollback。这会阻塞四表全部 writer；先提交的额外漂移被重新读取并拒绝，晚到 writer 等待本事务结束，其后提交使后续覆盖检查失效。屏障后不再调用 provider 或创建步骤，只做固定次数的批量绑定查询、永久保留写入、快照/CAS 和账本提交。`lock_timeout`、`statement_timeout`、`idle_in_transaction_session_timeout` 在事务内限制到最多 5 秒，保留已有更短非零值；成功后限制持续到外层事务结束，失败回滚 savepoint 恢复原设置。锁升级死锁、超时或连接终止均使操作失败，不降级、不隐式重试；连接终止由 PostgreSQL 回滚。

port 核对每个实际 profile 和唯一 identity 是否与固定 tenant/app、批准 openId/alias、本地 ID 和新 actor 一致。它复用 FS-70 的主体与归属摘要算法，只允许把这一整批新主体和保留行加入原封存状态；其它新增/删除主体、归属或隔离漂移均拒绝，不会被合法 provision 顺带封存。成功只更新本地主体/归属摘要，原 source operation、原文件 digest、上游 owner 集合和 observedAt 全部保持不变。最终再次检查 policy 与来源时效；创建、认领或库存更新任何一步失败，整批创建回滚。

`existingOwner(client, localUserId)` 是供 repair/ready-check 复用的只读证据入口：从该显式本地 ID 的冻结 profile 或历史派生 actor 找到同 ID 的 `reserved` 行，库存失效、ambiguous、unclaimable、无主或他人归属均不返回 owner。maintenance 或 quarantine 不会释放原有名字；结果中的 quarantine 状态不等于登录资格。repair 仍须自行执行目录重验与批准恢复，ready-check 不执行认领。

覆盖不完整或来源过期时停止 provision，按 FS-70 重新取得批准快照前滚；成功的永久保留和本地 ID 不得靠回退代码释放。回归命令为 `pnpm vitest run packages/engine/src/services/enterprise/actor-claim.integration.test.ts`，使用 FS-57 本 run PostgreSQL、FS-10 注入式权威 reader fixture、真实 SQL 故障与并发事务，覆盖完整回滚、来源不续期、额外主体不封存和锁等待。此验证不声称真实飞书上线或生产迁移。

## 新成员provision命令

`provision`只通过受控审批dispatch执行，在一个READ COMMITTED事务中调用一次FS-71整批port；持久enterprise激活、完整新鲜actor库存及每人的权威目录资格均须通过。清单为UTF-8 JSON，最多1 MiB、1–100人：

```json
{"schemaVersion":1,"members":[{"tenant_key":"tenant_mock_megaui","app_id":"cli_mock_megaui","open_id":"ou_mock_alice","login_name":"alice","display_name":"Synthetic Alice","notification_email":null}]}
```

根和成员均拒绝未知字段；不接收local_user_id、role、密码或scope/provider覆盖。tenant/app/openId各最多256个Unicode码点且无空白空值、NUL或孤立代理项，tenant/app须与部署配置精确匹配；alias为3–64位小写ASCII（首字符字母数字，其余可含`.`、`_`、`-`），整批openId/alias唯一。显示名最多256码点，缺省/null取alias；通知地址缺省/null可用，非null需合法邮箱且最多254字符。

首次执行只从可信admin环境读取 `AUTH_MODE=enterprise`、`FEISHU_TENANT_KEY`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_PROVIDER` 和 `FEISHU_DIRECTORY_DEPARTMENT_IDS`。部门配置是严格JSON字符串数组，1–100个唯一ID，单项匹配`^[A-Za-z0-9_-]{1,256}$`，原始配置最多32 KiB；缺失或非法exit 2，不从清单或provider结果反推范围。simulator只允许可信development/test部署与对应NODE_ENV，`FEISHU_SIMULATOR_ORIGIN`必须是本run实际分配的精确`http://127.0.0.1:<port>`；正式provider固定官方源。样例的端口和secret均须由测试run或部署注入替换。配置按能力惰性读取，emit/重放及其它命令/Web/collab不会因此新增启动必填项。

```sh
pnpm --filter @megaui/engine run enterprise:admin -- provision \
  --target <instance> --operation-id <uuid> --expect-policy-epoch <epoch> \
  --manifest /absolute/path/members.json --digest <原文件字节SHA-256> \
  --approval /absolute/path/approval.json --approved-payload /absolute/path/request.json
```

先以同一组行为参数加`--emit-approval-request --out /absolute/path/request.json`生成只读请求（不带approval/approved-payload），再由离线authority签发。manifest只使用FS-80固定字节，不二次读取；digest和完整payload都须匹配审批。

每名成员生成新的UUID本地ID，user role固定普通`user`、emailVerified=false；框架兼容email为`u_`加SHA-256(localID)的小写无padding base32（52字符）再加`@identity.invalid`。通知地址与身份无关，共用邮箱不会合并主体；不同operation遇已有外部三元组拒绝，绝不upsert或按邮箱/姓名复用。不会创建密码account、session或管理员权限。

全部准入与创建在FS-71唯一库存屏障前完成，port返回后只写唯一`batch_number=0`、`processed=N`、同manifest digest的checkpoint和FS-81账本，然后commit。任一阶段失败整批回滚，不拆分或隐式重试；超过100人的任务需要分别批准多个operation。

成功输出为`{schemaVersion:2,operationId,policyEpoch,resultCounts:{created:N},replayed,provisioned:[{row:1,localUserId:"<uuid>"},...]}`。行号严格对应批准清单的1..N，ID唯一，映射同事务写入既有JSONB账本。同operation/payload重放原映射，只变replayed，不查询当前资料、不生成新ID、不访问provider；首次持久化和重放均用固定manifest核对完整N和created=N。映射缺失、截断、重复、越界或出现在其它verb均拒绝；旧命令保持v1输出。

输入/配置错误exit 2；审批digest错误及资格、归属、外部三元组冲突exit 3（业务拒绝键`PROVISION_REJECTED`，目录失败统一资格拒绝）；未知SQL/本地依赖失败exit 4，仅输出稳定键。修复输入或取得新的批准来源后前滚；保留已提交ID和永久actor，不释放名字。验证命令为`pnpm vitest run packages/engine/src/services/enterprise/identity.integration.test.ts packages/core/src/enterprise/config.test.ts packages/engine/src/cli/admin-output.test.ts tests/guards/admin-write-verbs.test.ts`，使用真实Mock子进程、签名CLI和FS-57专属PG；模拟通过不代表真实provider或生产上线。

## 历史映射preview命令

`preview`是显式只读入口，运行环境须提供`DATABASE_URL`、可信`ENTERPRISE_DB_INSTANCE_ID`/owner/environment和admin或test进程角色，以及`FEISHU_TENANT_KEY`、`FEISHU_APP_ID`。不要求审批公钥、operation ID、provider secret或网络访问；参数不能覆盖tenant/app。有效legacy、maintenance及enterprise policy均可预检，模式和epoch不会改变。

```sh
pnpm --filter @megaui/engine run enterprise:admin -- preview \
  --target <instance> --manifest /absolute/path/migration.json \
  --out /absolute/path/preview-report.json
```

清单是严格UTF-8 JSON `{schemaVersion:1,members:[...]}`，1–10,000行、原文件最多10 MiB。每行仅含以下七个字段：

| 字段 | 合同 |
|---|---|
| `local_user_id` | 既有文本ID，按此精确定位；不强制UUID，不按姓名或邮箱合并 |
| `tenant_key`、`app_id`、`open_id` | 外部身份三元组，tenant/app须精确等于可信进程配置 |
| `login_name` | 3–64字符小写ASCII alias，沿用`[a-z0-9][a-z0-9._-]{2,63}` |
| `expected_user_version` | 下述规范user摘要的64位小写SHA-256 |
| `expected_identity_version` | 0表示无目标tenant/app绑定；已有绑定填写其1–2147483647版本 |

标识字段非空、无NUL或孤立代理项，最多256 Unicode码点；全清单内local ID、外部三元组和alias各自不能重复。输入文件复用固定inode的拒绝symlink读取，后续不重开；数据库按最多100行分块查询，所有块共用一个`REPEATABLE READ READ ONLY`事务。

user版本由`manifest.ts`的`migrationUserVersion`生成：对`{id,name,email,emailVerified,updatedAt,banned}`按既有规范JSON算法排序键并做SHA-256，banned保留boolean/null。updatedAt须由SQL在UTC直接格式化为`YYYY-MM-DDTHH:mm:ss.ffffffZ`，不可先转JavaScript Date；保留六位微秒，拒绝infinity或不可表达日期。清单摘要还包含全部identity源字段、profile（含通知邮箱和精确时间）及FS-70完整ownershipDigest。`manifest.ts`提供唯一解析、源摘要和envelope构造函数，后续迁移阶段复用；`readMigrationSources(client,...)`只读调用者的连接，不创建事务或比较初始版本，阶段判断归调用者。

已有同scope绑定的open_id及同user profile的alias必须与清单一致，合法版本不能覆盖此检查。异scope身份、外部三元组或alias被占用、停用身份、隔离、actor缺失或不属于本地用户、内部兼容邮箱冲突均拒绝生成可批准摘要。actor沿用FS-70精确派生并优先使用frozen profile；不能隐式修复绑定。完整库存包括清单外的所有历史主体和原生保留行，source observation最多24小时且不得在未来；开始核验及结束前都检查时效，不本地续期。

成功及行冲突都输出一行相同JSON到stdout与新建报告文件：`{schemaVersion:1,targetFingerprint,policyEpoch,status,counts:{total,ready,conflicts},manifestDigest,rows:[{row,status,conflictKeys}]}`。报告不含local ID/open ID/姓名/邮箱/actor。只有全部行ready时给出manifestDigest并退出0；行冲突退出3，摘要为null。固定冲突键包括`USER_MISSING`、`USER_VERSION_MISMATCH`、`IDENTITY_VERSION_MISMATCH`、`IDENTITY_SCOPE_MISMATCH`、`PROFILE_SCOPE_MISMATCH`、`IDENTITY_BINDING_MISMATCH`、`PROFILE_ALIAS_MISMATCH`、`EXTERNAL_IDENTITY_OCCUPIED`、`ALIAS_OCCUPIED`、`IDENTITY_INACTIVE`、`QUARANTINED`、`ACTOR_MISSING`、`ACTOR_UNAVAILABLE`、`COMPATIBILITY_EMAIL_CONFLICT`。

JSON对象键序与空白不改变摘要，成员行序、源资料、actor及归属变化会改变摘要。库存批准续期只改变observedAt/原字节digest/operation ID而不改变归属时摘要稳定；policyEpoch单列输出，由后续写审批绑定，不纳入初始迁移digest。报告文件以0600和排他创建写入，已有文件或symlink绝不覆盖。

输入/配置错误退出2；scope或库存不完整/过期退出3（`SCOPE_REJECTED`、`ACTOR_INVENTORY_REJECTED`），不能规范表达的数据库源退出3（`SOURCE_REJECTED`）；SQL/本地依赖错误退出4（`DEPENDENCY_FAILED`）。这些前置失败不输出报告或底层异常。连接与单条SQL最多5秒，总CLI预算30秒；URL中的client query_timeout在解析后仍受5秒上限约束，实际server statement/lock/idle超时在只读事务内收紧，保留更短设置，URL options与角色默认值不能扩大预算。所有成功/失败路径释放连接，不写绑定、邮箱、会话、policy、operation或checkpoint。修正显式清单或取得新的完整批准库存后重跑；绑定修复归FS-38，preview不代替apply/convert审批。

验证：`pnpm vitest run packages/engine/src/services/enterprise/migration-preview.test.ts packages/engine/src/services/enterprise/migration-preview.integration.test.ts`。测试使用本run隔离PG、实际CLI、数据库拒绝写入证据、全表快照、SQL trace和并发外部写入；不接触真实租户或生产数据库。

## ready-check审批前置合同

`ready-check`是历史迁移演练的只读准入门。它只接受development/test目标、可信`ENTERPRISE_DB_INSTANCE_ID`与`--target`，并读取批准清单原字节及其`--digest`；不要求审批bundle，不调用provider，不进入maintenance/convert/activate，也不推进`enterprise_policy`或`enterprise_admin_operations`。

```sh
pnpm --filter @megaui/engine run enterprise:admin -- ready-check \
  --target <instance> --manifest /absolute/path/bindings.json \
  --digest <manifest-bytes-sha256> --out /absolute/path/ready.json
```

执行在一个`REPEATABLE READ READ ONLY` PostgreSQL事务中复用FS-70/71的完整actor库存与主体覆盖摘要。未绑定主体必须已有显式quarantine；活跃ambiguous actor只在相关主体全部quarantine时保留为不可认领，否则拒绝。目标目录scope hash由可信`FEISHU_TENANT_KEY`、`FEISHU_APP_ID`和严格部门JSON计算，watermark、完整快照、generation及15分钟新鲜度必须一致；worker必须声明`ENTERPRISE_WORKER_READY=1`，两个collab通过`ENTERPRISE_COLLAB_POLICY_EPOCHS=<policyEpoch>,<policyEpoch>`声明同一epoch。任何失败都返回冲突报告（exit 3），目标、输入或配置错误返回exit 2，数据库/本地依赖故障返回exit 4。

报告只含目标fingerprint、policy epoch、计数、固定失败键和`database: "read-only"`，不含用户ID、姓名、邮箱、open_id或actor。成功才生成规范manifest digest；输出文件以0600排他创建。服务会在事务前后比较表快照，集成门还记录实际SQL trace，证明没有DML/DDL以及policy/admin_operation变化；事务无论成功或冲突均rollback并释放连接。修复库存、quarantine、目录或运行实例后重新取得完整批准清单再前滚，不清除activation或已消费账本。

验证：`pnpm vitest run packages/engine/src/services/enterprise/readiness.integration.test.ts`（6/6，无skip）。测试使用一次性隔离PostgreSQL和真实CLI，覆盖未quarantine主体、活跃actor冲突、目录缺失/不完整/陈旧/generation不一致、目标不匹配、worker/collab未就绪、digest冲突及零写快照；本次全量`pnpm vitest run`为28文件失败/312通过/2skip、11测试失败/2689通过/164skip，失败为既有PostgreSQL 127.0.0.1:5432、provenance、enterprise-secret、exports、worker timeout与owned Web 404环境/守卫门；不声称真实飞书或生产门通过。

## 历史映射apply命令

`apply`通过管理员统一审批入口预绑定历史账号。先用preview取得完整清单的规范摘要，再生成请求交给独立批准方签名；一次operation只处理固定批次，仍须提供完整原文件：

```sh
pnpm --filter @megaui/engine enterprise:admin -- apply --target <instance> --operation-id <uuid> \
  --expect-policy-epoch <epoch> --manifest /absolute/path/migration.json \
  --digest <preview-manifest-digest> --batch-number 0 \
  --emit-approval-request --out /absolute/path/request.json

pnpm --filter @megaui/engine enterprise:admin -- apply --target <instance> --operation-id <same-uuid> \
  --expect-policy-epoch <same-epoch> --manifest /absolute/path/migration.json \
  --digest <same-preview-digest> --batch-number 0 \
  --approval /absolute/path/signed-bundle.json --approved-payload /absolute/path/request.json
```

原文件最多10 MiB/10,000人，写入和请求生成都在读取前执行容量限制。`batch-number`必填，为0起始整数并小于`ceil(N/100)`；固定选取第`100*b+1`到`min(100*(b+1),N)`行。摘要是preview规范摘要，文件字节SHA-256另签入payload；整表local ID、open ID和login name必须唯一，不能拆掉其它批次、替换文件、改变顺序或绕过统一签名/scope/epoch门。

执行共用provision的部署可信配置：tenant/app、secret、provider、部门JSON及owner/instance/environment不从清单推断。只对所选批次调用目录准入，全部HTTP调用在迁移源屏障之前完成；无需先有本地identity，legacy允许预绑定。事务显式使用READ COMMITTED，复用完整run初始版本及后态验证，只新增缺失的active/version=1 identity和冻结actor profile。新profile的display_name为原user.name、notification_email为null；既有一致identity/profile不修改，原user全部字段、角色、account、session与policy epoch保持原值。

成功stdout为独立v3 JSON：`schemaVersion:3`、`operationId`、`policyEpoch`、`replayed`、`resultCounts:{bound:N}`以及`applied:[{row,localUserId}]`。row是完整原清单的1起始行号，localUserId保留历史text ID原字节和大小写。映射恰好覆盖所批准批次，与绑定、阶段后态及checkpoint同事务持久化；首次结果和同operation重放都逐项核对完整已签名清单，缺项、错序、错ID、越界、重复、未知行字段或计数不符均拒绝，不能从当前资料重建结果。其它verb的v1与provision v2保持兼容，禁止跨verb混用映射。

同operation重放返回存储的原映射，不读取provider secret、访问provider或重查当前用户资料。新operation重复已完成批次仍重做目录准入及全run后态检查；一致时只记录新的operation/checkpoint。第二批失败只回滚第二批；保留同一完整清单和初始digest，经新批准operation重试该批。外部资料或actor归属改变时停止并重新预检审批，不篡改原账本。目录拒绝、源版本/digest或阶段后态冲突为`MIGRATION_REJECTED`退出3；输入错误退出2，SQL/依赖错误为`DEPENDENCY_FAILED`退出4；输出不包含底层异常或目录成员资料。

验证使用隔离PG和实际签名CLI：独立Mock的固定3名成员覆盖legacy保留、目录拒绝和重放；101人跨批故障恢复使用测试文件内单独的loopback HTTP provider，经生产token/Contact传输，不改变Mock成员合同，也不作为真实租户或Mock交接证据。当前不提供convert/activate命令。

## 隔离与受控修复

`quarantine`与`repair`均通过统一签名、target/scope、epoch CAS和operation事务入口；正式执行示例：

```sh
pnpm --filter @megaui/engine run enterprise:admin -- quarantine --target <instance> --operation-id <uuid> \
  --expect-policy-epoch <epoch> --manifest /absolute/path/quarantine.json --digest <canonical-sha256> \
  --approval /absolute/path/bundle.json --approved-payload /absolute/path/request.json
pnpm --filter @megaui/engine run enterprise:admin -- repair --target <instance> --operation-id <new-uuid> \
  --expect-policy-epoch <epoch> --manifest /absolute/path/repair.json --digest <canonical-sha256> \
  --approval /absolute/path/repair-bundle.json --approved-payload /absolute/path/repair-request.json
```

两种manifest均为严格UTF-8 JSON数组，读取前限制1 MiB，拒绝未知字段、非法Unicode/NUL、空白及重复ID；原text ID保留大小写，最多256码点。quarantine允许0–100行，每行仅含`local_user_id`、非空且最多1024码点的`reason`、`expected_user_version`；最后一个字段是FS-37 `migrationUserVersion`生成的64位小写SHA-256，旧准备入口的整数占位已移除。空数组仍须审批，只记录零计数operation/checkpoint，不改变隔离状态。

repair要求1–100行，每行仅含`local_user_id`、`tenant_key`、`app_id`、`open_id`、`login_name`、`expected_user_version`、`expected_identity_version`、`expected_profile_digest`、`expected_quarantine_operation_id`。整表单一tenant/app，ID/open ID/alias分别唯一，alias满足既有小写3–64字符规则。identity版本0表示缺失；既有版本必须精确匹配且可递增。profile摘要复用FS-37 `migrationProfileDigest`，缺失资料使用null的规范摘要。quarantine operation必须明确指定当前隔离UUID；新隔离operation使旧修复审批失效。输入tenant/app不能替代部署可信authority。

两者的digest均为`SHA256(UTF8(JCS(严格解析后的完整数组)))`，原文件SHA另由审批payload绑定。使用`--emit-approval-request --out /absolute/path/request.json`准备审批时，quarantine可省略digest自动计算；repair必须显式提供规范digest。错误显式digest在数据库连接前以`APPROVAL_MANIFEST_MISMATCH`退出3。原清单和批准文件按既有受限审计约定保存，勿将reason等私有内容复制到公开日志。

恢复顺序如下：

1. 批准并执行quarantine。事务验证原用户SHA，持久隔离当前主体并标记已存在的同owner reserved actor。无需provider配置或完整actor库存；user、identity、profile、account、session及角色保持原值。当前认证资格即被拒绝。
2. 用新的批准`reserve-actors`重新封存完整库存。隔离改变本地覆盖摘要，不能沿用隔离前的库存封存。actor必须仍为同owner的明确reserved归属；ambiguous/unclaimable及缺失actor无法通过repair释放或转移。
3. 明确映射并批准repair。实际目录准入在源锁前逐人重新读取，随后验证当前可信scope的完整目录generation和不超过15分钟、有限且非未来的快照。锁内重新核对user/identity/profile/quarantine版本及完整24小时actor库存；其它用户占用的open ID/alias，即使在同批，也不能交换或合并。
4. repair保留既有identity ID并递增版本，显式改变open ID时清空原union ID；缺identity新建version=1。既有profile只改批准alias，冻结backend_username、display_name、notification_email；缺profile采用原user.name/null通知和证明过的既有actor。释放隔离时只清除该同owner reserved actor的quarantined标志，保留归属、identity关联及来源，不刷新库存封存。
5. repair清除旧identity目录水位；等待完整目录对账成功后，enterprise模式才可能恢复资格，maintenance模式仍不允许登录。释放后再次批准`reserve-actors`封存，并重新preview/审批后续迁移；旧迁移digest不能直接复用。

单operation为一个原子批次，checkpoint固定`batch_number=0`。普通operation JSONB保存严格逐行`affected`：`row`、`localUserId`、`expectedUserVersion`、`expectedIdentityVersion`、`expectedProfileDigest`、`quarantineOperationId`；quarantine最后三项为null，repair为批准值。首次及重放都完整核对原批准清单，不从当前资料重建审计。数据库旧int版本列保持null。公开stdout仅为v1的`resultCounts:{quarantined:N}`或`{repaired:N}`，无affected/reason；同operation重放只返回原结果，不重新隔离、不重新调用provider，也不需要provider secret。

FS-81显式使用READ COMMITTED，纯输入校验先于Pool；scope与policy guard、库存行锁及固定user/profile/quarantine/actor/identity表锁在同一client事务内。目录水位/快照行持锁至提交；checkpoint之后及普通operation审计写完、紧邻COMMIT时均复核目录和原actor库存的时效，任何一次过期都使整个事务回滚。连接/单条查询及实际server statement/lock最多5秒，URL不能扩大client query预算，provider完成后才设置事务idle上限，已有更短预算保留。任何失败整批回滚，不隐式重试；业务拒绝使用`QUARANTINE_REJECTED`或`REPAIR_REJECTED`退出3，输入/配置退出2，SQL/连接/超时使用`DEPENDENCY_FAILED`退出4。

本卡提供当前资格隔离与受审修复，不签发session或改变角色。现存Web Cookie、challenge/grant、协作连接及outbox的完整撤销由FS-18继续接线，不能把本卡的资格拒绝当成这些通道已经全部下线。

## 配对challenge与加密投递schema

FS-33追加四张表；当前只交付持久合同，申请/本人确认、码生成与加密、预算扣减、发送及消费事务由后续卡接线。现有用户、身份、会话与认证模式不变。

| 表 | 绑定与唯一性 | 保留及清理 |
|---|---|---|
| `enterprise_pairings` | policy scope、deployment、tenant/app、flow摘要、generation和login purpose；token摘要全局唯一，同flow最多一个pending，同generation和真实确认message各自去重。未知alias可保存identity为空的pending，不能confirmed | pending为120秒；confirmed保留至确认后390秒，覆盖300秒challenge及最长90秒恢复；`retain_until`清理索引 |
| `enterprise_challenges` | 原user/identity外键、身份版本、flow摘要/generation/purpose；同flow最多一个active、同generation唯一；可空唯一pairing外键在pairing清理时SET NULL | 300秒有效期，消费后90秒恢复；HMAC/key_id可在`secret_expires_at`后一起清空并记`secret_cleared_at`，消费与版本元数据保留；秘密部分索引及到期索引 |
| `enterprise_login_budgets` | 跨运行实例共享scope/deployment/kind/subject摘要/window主键；used非负，四种桶为anonymous-ip、sender-send、sender-invalid、verify-failure | 有限窗口与到期索引；匿名subject由每日HMAC派生，不保存原IP；验证失败subject由已证明identity+flow构成，不含generation |
| `enterprise_dm_deliveries` | UUID用于后续provider幂等，每challenge唯一；组合外键把expires_at固定到原challenge期限，challenge删除时级联删除投递 | 只保存独立delivery key_id与48..8192字符base64url不透明AEAD封装、首次尝试/送达时间；到期索引用于有界删除密文 |

摘要必须为64位小写hex，generation和身份版本为正整数；所有期限必须为有限时间。确认、消费与秘密清理字段成对或成组受约束，验证码、pairing token、flow原值、私聊原文及原IP均无明文字段。密文格式约束只约束存储形状，加密与独立密钥保证由FS-35负责；跨表身份归属、可信部署匹配、当前资格、一次消费与状态迁移仍由后续事务重新核验。

`enterprisePairings`、`enterpriseChallenges`、`enterpriseLoginBudgets`、`enterpriseDmDeliveries`及对应Select/Insert类型经`@megaui/database`现有导出链可用。预算表没有进程ID或generation列，不能以重发清零失败预算；具体窗口、原子扣减、pending总数及已确认flow限额由FS-74/75/11/36实现。密文表不复制lease或attempts队列；FS-13复用`enterprise_jobs`，job payload只引用deliveryId，按最多3次/20秒及challenge/provider窗口投递，并在到期5分钟内清理密文。

迁移为`0011_rainy_magus.sql`，由Drizzle生成，仅追加新snapshot和journal，不改旧SQL/meta。组合外键的目标使用建表内的UNIQUE约束，避免外键先于独立索引创建。先在FS-57专属PG验证新DDL/journal故障整笔回滚、前滚重试及原user/session/identity逐字段不变；失败不得down或修改已发布SQL。实际迁移继续经过既有FS-44目标与角色预检；真实生产迁移仍为延期范围。

```sh
pnpm vitest run packages/database/src/schema/auth/enterprise-login.test.ts
pnpm vitest run packages/database/src/migrate.test.ts
```

## 验证码生成与秘密封装

FS-35在服务端`@megaui/auth`根入口导出`ENTERPRISE_OTP_ALPHABET`、`ENTERPRISE_OTP_LENGTH`、`generateEnterpriseOtpCode()`与`createEnterpriseOtpCrypto(config)`及对应类型。alphabet固定为`23456789ABCDEFGHJKMNPQRSTUVWXYZ`，长度8；逐位用Node CSPRNG `randomInt(0, alphabet.length)`无偏选取，纯数字或纯字母的完整样本重抽，最多128组后统一失败。调用方不能注入随机源。所有密码方法只接受已经规范的大写混合码；ASCII用户输入规范化由FS-49交付，共用包内部唯一规范码谓词。

工厂配置为`{hmacKeyId,hmacKey,deliveryKeyId,deliveryKey}`。密钥只接受`Uint8Array`：HMAC为32..1024字节，AES-256-GCM恰好32字节；相同密钥字节被拒绝，不能相互fallback或派生。key ID仅1..128个ASCII字母数字及`._-`。工厂复制密钥后闭包持有，调用方修改原buffer不会改变行为；返回对象和摘要/投递记录冻结，不暴露密钥。工厂本身不读环境、secret store、数据库或provider；运行时注入和资格事务由后续消费者负责。

`EnterpriseOtpBinding`包含scope、deploymentRole、tenantKey、appId、challengeId、localUserId、identityId、identityVersion、purpose、flowHash、generation、expiresAtMs。五个身份/作用域文本为1..256 Unicode码点、非全空白、无孤立surrogate，不trim或归一化；deploymentRole仅development/test/production/canary；challengeId为小写UUID，purpose仅login，flowHash为64位小写hex；版本/generation为1..2147483647整数，到期毫秒为0..8640000000000000的安全整数。拒绝额外或缺失字段、访问器、非法类型；固定编码为UTF-8 JSON数组`[1,scope,deploymentRole,tenantKey,appId,challengeId,localUserId,identityId,identityVersion,purpose,flowHash,generation,expiresAtMs]`，不受对象字段顺序影响。

| 方法 | 输入与输出 | 验证及失败行为 |
|---|---|---|
| `digest(code,binding)` | `{codeHmac,hmacKeyId}` | HMAC-SHA256覆盖UTF-8 JSON数组`["megaui:enterprise-otp:hmac:v1",hmacKeyId,bindingArray,code]`；64位小写hex |
| `verify(code,binding,record)` | boolean | 先严格校验记录/格式/key ID，再对32字节摘要调用`timingSafeEqual`；错误统一false |
| `seal(code,binding)` | `{encryptedPayload,deliveryKeyId}` | 每次生成12字节nonce，AES-256-GCM使用16字节tag；AAD为UTF-8 JSON数组`["megaui:enterprise-otp:delivery:v1",deliveryKeyId,bindingArray]` |
| `open(record,binding)` | 规范码或null | 严格校验canonical base64url、版本、长度和key ID；认证成功且明文仍符合规范码才返回，否则null |

投递plaintext仅8字节ASCII码，wire为`version=1 || nonce12 || tag16 || ciphertext8`，共37字节，编码后50字符且无padding，符合FS-33密文存储范围。拒绝非规范base64url别名、未知版本、错key/绑定、nonce/tag/ciphertext篡改和额外字段；不尝试旧算法或旧key。构建、生成、digest和seal的失败只抛`Enterprise OTP operation failed`，无输入原值或底层cause；所有方法不写日志、不持久化明文。JS字符串不保证物理内存擦除。

密码成功只证明码、绑定和密钥一致，**不证明当前资格、期限有效、未被消费或scope可信**；FS-46/13/36仍须从可信运行态和数据库核验。轮换按ADR-FS-ENT-07先停发、失效旧challenge、清除密文，再启用新密钥；不能仅切换key ID后假定旧记录仍可使用。当前没有新增HTTP入口、发码事务或真实消息发送。

```sh
pnpm vitest run packages/auth/src/enterprise-otp/code.test.ts
pnpm vitest run packages/auth/src/provenance.test.ts
```

测试覆盖公共导出、独立Python HMAC/AES-GCM固定向量、整样本拒绝与上限、逐字段绑定篡改、格式/密钥/Unicode边界、密钥复制及错误脱敏；随机样本只能检查格式，不作为统计无偏证明。三个自有实现文件使用明确FS-35来源标记，auth来源守卫只在enterprise-otp目录接受此类FS标记，其它源文件仍遵循原来源要求。

## 迁移审批digest与阶段水位协议

`migration-ledger.ts`提供内部`createMigrationLedger({expectation,authority,now?})`，工厂固定可信实例/owner/environment和tenant/app。`executeBatch(context,client,mutate)`只消费FS-81已验证签名、scope和epoch的handler上下文；`assertConverted(context,client)`供activate handler核验全部阶段完成。结构化context本身不是授权凭证。`apply`、`convert`与development/test `activate`均通过下述审批入口接线；production/canary activate及真实回执仍由DEFER-FS-03承接。

每次调用使用固定文件快照中的完整原清单，沿用preview的10 MiB/10,000行上限及唯一解析、源摘要、envelope算法。`digest`是preview给出的完整规范摘要，`batch-number`为签入payload的0起始整数；第b批固定为`[100*b,min(100*(b+1),N))`，不接受越界或另交局部清单。首次apply要求完整N行的user及identity版本、profile摘要与完整actor归属均匹配初始批准；随后各阶段比较账本记录的合法后态，不会把自己刚完成的绑定或转换误判为初始版本漂移。

内部run复用`enterprise_admin_operations`，id及operation_id均为`migration-run:`加`SHA256(canonicalizeJson({schemaVersion:1,targetFingerprint,manifestDigest}))`，与普通审批UUID互斥。verb固定`internal:migration-run:v1`，绝不注册CLI；`manifest_digest`保持初始批准值，integer版本列保持null。result为严格JSON：

```text
{schemaVersion:1,kind:"migration-run",migrationRunId,targetFingerprint,manifestDigest,
 initialEnvelope,rows:[{row,stage,userVersion,identityDigest,profileDigest,lastOperationId}]}
```

initialEnvelope永不覆盖。rows按1..N连续编号；pending的三个后态摘要等于初始源摘要且lastOperationId为null，bound/converted保存最近成功阶段operation的UUID。同一固定批次的阶段及最后成功operation一致。每次加载都重算初始摘要和run ID，并核对JSON、目标、列、完整N行和state；未知字段、截断、重复、非法阶段或版本都拒绝，不补造丢失的后态。全部converted才允许内部state为completed，否则为running。账本保留执行必需的显式身份/alias/actor及hash，不保存原姓名或邮箱，也不会作为普通CLI成功结果重放。

调用者必须保留FS-81的外层`READ COMMITTED`事务。接口按已持有的policy锁、run advisory/行锁、scope库存行锁、`user → enterprise_profile → enterprise_quarantine → enterprise_actor_reservations → enterprise_identity`五表SHARE锁的顺序进入保护区；全部源数据在锁取得后才读取。锁保持到FS-81提交，SQL/lock/idle超时收紧至最多5秒并保留更短设置。目录/provider准入由消费handler在调用前完成，源锁内只执行本批SQL，不做网络I/O。缺少外层事务或使用其它隔离级别都会拒绝。

apply回调完成后必须存在与清单一致的active绑定及冻结actor profile，同时user快照保持不变，已有identity/profile也不能被重写；convert只在maintenance允许，要求全run无pending，保留既有身份、显示名和actor，将框架邮箱置为内部兼容键且emailVerified=false，并保留已有通知地址或在其为空时保存原地址。每批业务写、合法后态、checkpoint和FS-81普通operation结果同事务提交；清单外批次的相关资料不能被本批回调改变。锁内SQL收尾会再次检查完整库存时效，失败连同checkpoint回滚。

相同operation由FS-81直接重放。新批准operation重复已完成阶段时，仅在全run后态和归属仍一致的情况下跳过业务回调并记录本次checkpoint；apply不会把converted降回bound。第一批converted之后仍能继续第二批转换；任一pending阻止convert，任一未converted阻止activate。第二批失败只回滚该批准operation，恢复使用同一完整清单/初始digest和新批准operation，从未完成批次继续；资料或归属已经外部改变时停止，重新预检和审批，不能自动接受漂移或修改原始envelope。

验证：`pnpm vitest run packages/engine/src/services/enterprise/migration-ledger.integration.test.ts`。使用专属合成PG和独立签发进程，通过真实FS-81审批事务覆盖101行跨批、第二批故障恢复、转换与激活前置、严格账本加载、资料微秒/通知变化、幂等、并发源锁和同事务回滚。接口不创建自己的Pool或提交调用者事务。

## 维护窗口兼容键转换

`convert` 是 FS-53 的唯一业务转换入口，使用完整初始 manifest/digest、可信 tenant/app 与签名 payload 中的 `--batch-number`。handler 只能在 policy 为 `maintenance`、迁移账本没有 `pending` 行且当前批属于 `bound` 状态时执行，并通过 FS-81 的 approval、scope、epoch CAS、operation 账本事务调用 `createMigrationLedger`；不存在裸 SQL 或绕过审批的 CLI 路径。

每批固定最多100个清单成员。业务 SQL 只把当前框架邮箱写入 `enterprise_profile.notification_email`（已有非空通知地址保留），再将 `user.email` 设为 `compatibilityEmail(local_user_id)` 并清除 `email_verified`。不改变 `user.id`、enterprise identity/profile 外键、ACL、`backend_username`、显示名或其它内容引用；原地址只作为通知资料保存，不进入迁移账本或普通 CLI 输出。完整后态、checkpoint 与普通 operation 账本同事务提交，重复已完成批次只在后态一致时幂等跳过。

批内任一 SQL 或后态检查失败都会回滚本批业务写和 checkpoint，保留已提交的前序批次；运维使用同一完整 manifest/digest 与新的批准 operation 重试未完成批次。资料、归属、epoch 或 actor 库存发生漂移时停止并要求重新预检和审批，不覆盖外部变更，也不重开 legacy。

验证：`pnpm vitest run packages/engine/src/services/enterprise/conversion.integration.test.ts`。一次性隔离 PostgreSQL、无 skip，覆盖101行跨批、首批转换后的第二批、maintenance/账本门、`user.id` 与 identity/profile 外键、通知地址、display/backend 字段、批大小、触发器故障回滚与 checkpoint 前滚重试。

## sticky activation命令

`activate` 是 development/test 演练的唯一切换入口，manifest/digest 仍使用 FS-37/61 的完整迁移摘要，并通过 FS-80/81 的签名、scope、epoch CAS 与 operation 账本。handler 在任何业务写入前拒绝 production/canary；随后在已锁定的批准事务中核对 policy 为 `maintenance`、目录 watermark 与完整快照同 generation 且不超过15分钟、actor 库存覆盖完整、worker 就绪、两个 collab epoch 均等于当前 `auth_epoch`，再由 `createMigrationLedger.assertConverted` 验证完整清单每一批均为 converted。它不接受 ready 报告文件作为授权凭证，也不把旧报告的 `status=ready` 当作当前状态。

所有门通过后，`activateEnterprise` 在同一事务将 policy 原子改为 `enterprise`，将 `auth_epoch` 加一，首次写入 `activated_at`，并删除全部旧 Better Auth session；policy 的 enterprise 标记和非零 epoch 使 `AUTH_MODE=legacy` 永久 fail-closed。任一门失败整笔 operation 回滚，session、policy、activation 标记和 operation 账本均不留下半笔结果；修复后使用新的批准 operation 前滚。重复同 operation 由 FS-81 重放原始结果，已进入 enterprise 的新 activation operation 不允许再次执行。

验证：`pnpm vitest run packages/engine/src/services/enterprise/cutover.integration.test.ts`。一次性隔离 PostgreSQL、无 skip，覆盖 pending conversion、maintenance/ready-check、production/canary 前置拒绝、外部版本漂移、全量 converted 后 epoch/activation/session 原子提交；真实飞书、canary 回执和生产激活由 DEFER-FS-03 延后。

## 持久 maintenance 管理命令

`maintenance` 是已交付的持久维护命令。它没有行为参数；共同的 `target`、`operation-id` 与 `expect-policy-epoch` 都进入签名 payload。已批准执行后，非 maintenance policy 原子转为 `maintenance` 并使 `auth_epoch` 加一；已经处于 maintenance 时不改 epoch、也不触碰既有 `activated_at` 标记。每次成功都写入 operation 账本，因而同一 operation/payload 重放返回原始 JSON，不重复执行 handler；同 operation 的不同 payload 继续拒绝。

生产 CLI 的 dispatch 表明确声明全部当前 verb：只读位只允许已交付 `preview` 与 `ready-check`，当前写位为 `maintenance`、`reserve-actors`、`provision`、`apply`、`convert`、`activate`、`quarantine` 和 `repair`。每个写位必须以不可伪造的 approved-mutation capability 注册到既有完整 approval/scope guard；实际注册表与 dispatch 表在启动及仓库 guard 中双向核对，随后立即封存。只有 `NODE_ENV=test` 的测试清理路径能重置该注册表；生产中任何后加载模块试图追加写 verb 都会被拒绝。未注册 sentinel、表外 guarded handler，或把 `convert`/`activate` 等写 verb 标记成只读都会使 guard 失败。此规则使后续新增写 verb 必须接入 `dispatchPinnedVerb → runApprovedMutation`，不能从 CLI 绕过签名、scope、epoch CAS 或 operation 账本。

准备审批时使用相同 verb 加 `--emit-approval-request`。该分支仍只打开真正 PostgreSQL read-only transaction 来核对 scope，输出请求但不改变 policy、operation 账本或业务表；随后离线 authority 签发 bundle，正式调用才允许写入。

## 管理员 CLI 机器输出与审批请求

成功的写命令只向 stdout 输出一行严格 JSON：既有命令为`{schemaVersion:1,operationId,policyEpoch,resultCounts,replayed}`；provision为v2并增加“新成员provision命令”章节定义的`provisioned`映射，apply为v3并增加“历史映射apply命令”章节定义的`applied`映射。quarantine/repair保持v1计数，私有逐行审计不进入stdout。`resultCounts` 仅包含非负整数计数；输出从不包含审批 bundle、签名、公钥、验证码、provider 凭据或输入文件内容。失败只向 stderr 输出 `error: <稳定键>`：输入错误（含未知 verb、未知/重复 flag）退出 `2`，审批、scope 或 epoch 冲突退出 `3`，临时依赖不可用退出 `4`。

`--emit-approval-request` 是离线审批前的只读准备分支。例如：

```sh
pnpm --filter @megaui/engine run enterprise:admin -- <已注册verb> \
  --target <instance> --operation-id <uuid> --expect-policy-epoch <epoch> \
  --out /absolute/path/request.json --emit-approval-request [verb参数]
```

该分支不接受 `--approval` 或 `--approved-payload`，不会调用写 handler；写命令的 `--out` 只在此分支作为新建（排他写入）的请求文件目标，绝不进入待签名行为参数。请求含未签名的 operation 描述、规范化行为参数、输入文件 SHA-256、target fingerprint、预期 epoch 与 `payloadDigest`；不含输入内容或秘密。该 10 字段请求可原样作为正式命令的 `--approved-payload`：CLI 会严格解析、重算 `payloadDigest` 并投影为签名校验所需的规范 payload，摘要或关联字段被篡改即拒绝。verb schema 的每一个标量参数必须显式标记 `emitSafe: true` 才能进入请求，未标记参数会在连接数据库前拒绝，避免未来敏感字段被意外导出。`quarantine` 和 `seed-canary` 的 manifest digest 由冻结 manifest 形状规范化后计算，显式提供的 digest 必须相等。

写出请求之前，CLI 在真正 PostgreSQL read-only transaction 内执行既有 marker/SQL role scope guard；scope 失败、数据库失败或目标不符都不创建请求文件，且 policy、`enterprise_admin_operations` 与业务表零写入。离线 authority 仅在重新核对 request 的 target、role、epoch、参数与 digest 后签发；随后的写调用仍会重新做签名、scope 与 epoch guard。

## 离线审批 authority

审批方在独立主机运行 `pnpm --filter @megaui/engine run enterprise:approve --request /absolute/path/request.json --key-file /absolute/path/authority-ed25519.pem --approved-by <approver> --expires-at <UTC> --out /absolute/path/approval.json`。该进程只读取 FS-82 的十字段 request 与本机 Ed25519 私钥，重新计算固定 JCS `payloadDigest`，并为恰好一个 operation 写出排他创建的 bundle；目标部署只用已配置的公钥验签，不接收或读取 authority 私钥。`approved-by` 必须非空，`expires-at` 必须是未来的 `YYYY-MM-DDTHH:mm:ssZ` UTC 时间。未知/重复参数、不合格 request、非 Ed25519 key 或不可写输出一律不产生 bundle。

authority 不加载 database client、网站环境或管理员写入口，也不连接数据库。成功 stdout 只输出 schema、approval ID、operation ID 与 expiry；错误只输出稳定错误键，绝不输出 request、bundle 或私钥内容。测试会自产临时 Ed25519 keypair 与规范 request，在真实 Node 子进程中去除数据库配置后运行签发器，并以仅持公钥的 verifier 复核签名和隔离 PostgreSQL 的前后快照。

## 飞书事件 inbox schema

`packages/database/src/schema/auth/enterprise-events.ts` 建立已验证事件的最小持久边界：

- Contact 事件以 `(tenant_key, app_id, event_id)` 去重；`im.message.receive_v1` 的 `message_id` 必须至少含一个非空白字符，并除 envelope 去重外再以 `(tenant_key, app_id, message_id)` 独立去重，换 event_id 重放同一消息仍只受理一次。
- 表只保存事件类型/时间、目录主体 open_id 与 IM 的 sender/chat/message 元数据；没有 raw body、私聊正文或通用 payload 列。`/login` 的 opaque pairing token 只允许保存 64 位小写 SHA-256 摘要，明文及验证码不入库。
- `leased` 行必须同时带至少含一个非空白字符的 `claim_owner` 与 `lease_until`，`done` 行必须带 `completed_at`；pending 与 leased 两条有界 `FOR UPDATE SKIP LOCKED` 路径分别由 `(available_at, id)` 与 `(lease_until, id)` partial index 支撑，过期租约可重领。
- 只有 `done` 且超过保留期的 metadata 可按 `(state, completed_at, id)` 索引分页清理；pending/leased 行不会被 TTL 清理。

## 已验证事件持久服务与 worker 注册

`@megaui/engine` 导出 `acceptVerifiedEvent`，供 FS-09 在完成签名、解密、tenant/app 与重放窗口校验后调用；它不承担 callback 验证。公开输入是 `contact.user.updated_v3`、`contact.user.deleted_v3` 与 `im.message.receive_v1` 的判别联合，只复制 schema 白名单字段：

- inbox 与 `enterprise.verified-event` durable job 在同一个 PostgreSQL 事务提交；任一写入失败时两者一起回滚。
- 相同 `(tenant_key, app_id, event_id)` 或 IM `(tenant_key, app_id, message_id)` 重放返回首次提交的同一组 inbox/job ID，不新建第二个任务；一个重放若同时指向两个不同历史行则 fail-closed。
- 标准 `enterprise:worker` 入口实际注册 verified-event 与 `enterprise.event-inbox-cleanup` 两个 handler，共用 worker 自己关闭的连接池。默认分派不是空回调：Contact/IM 分别以 inbox ID 为 dedupe key 写入 `enterprise.contact-event-hint` / `enterprise.private-message-event-hint` durable follow-up job；后续 owner handler 尚未激活时这些 job 保持 pending，已受理事件不会被静默消费。
- 事件 handler 领取 inbox 自身的 30 秒租约，并在 effect 执行期间每 10 秒续租。effect 同时必须以传入的 inbox ID 幂等，因为进程仍可能在 effect 提交后、inbox 标 done 前崩溃；下游失败释放租约，崩溃遗留租约到期后可接管。
- Contact 与 IM 在此层都只是提示。Contact 不从事件主体直接推断成员缺失；只有既有目录 reconciler 读到完整、同 scope 的权威快照才会产生缺失结果，旧 generation 仍由数据库 CAS 拒绝。私聊 handler 只接收 sender/chat/message 元数据和可选 token 摘要，不接收正文；默认 follow-up payload 也只含 inbox ID。
- worker 启动时以 UTC 小时槽幂等登记清理 job；调度查询纳入可取消的启动生命周期。每次清理以 follow-up 的唯一 `dedupe_key` 索引排除未完成下游任务，再通过 inbox 清理索引删除最多 100 条超过 30 天的 `done` metadata，并续排下一小时；pending、leased、新鲜 done 与等待下游消费的行不删除。

## 飞书回调验证与 durable inbox

Web 仅给精确的 `POST /api/integrations/feishu/events` 无 session 例外；GET/PUT 等其它方法、尾斜杠、相邻路径及更宽的 `/api/integrations/**` 均保持 fail-closed。Route Handler 运行在 Node runtime，读取 Web `Request` 的流并在 256 KiB 处中止，不使用无界 `arrayBuffer()`。

运行时必须从服务端环境注入四项配置：

| 变量 | 用途 |
|---|---|
| `FEISHU_TENANT_KEY` | v2 业务信封 `header.tenant_key` 的精确预期值 |
| `FEISHU_APP_ID` | v2 业务信封 `header.app_id` 的精确预期值 |
| `FEISHU_EVENT_VERIFICATION_TOKEN` | URL verification 与业务信封 token 的常数时间校验 |
| `FEISHU_EVENT_ENCRYPT_KEY` | raw wire 签名材料及 AES key 派生材料 |

验证顺序固定：先取 `X-Lark-Request-Timestamp`、`X-Lark-Request-Nonce`、`X-Lark-Signature`，按 `SHA256(UTF8(timestamp + nonce + encryptKey) || exact raw body bytes)` 常数时间验签；再拒绝偏离当前时间超过 5 分钟的 Unix 秒时间戳；然后才解析 JSON。密文 wrapper 只接受标准 base64 的 `IV16 || ciphertext`，key 为 `SHA256(UTF8(encryptKey))`，使用 AES-256-CBC/PKCS#7；解密或 JSON 失败不进入持久层。

`url_verification` 仅在签名、时间窗和 verification token 全部通过后返回 `{challenge}`，不创建 inbox。v2 业务信封还必须通过 token、tenant 与 app 校验，随后只投影三个 FS-66 类型；非 user/p2p/text 的 IM 形状验证后直接确认但不入库。用户 p2p text 的正文不会跨越 callback 模块：若精确形如 `/login <token>`，仅把 token 的 64 位小写 SHA-256 摘要交给 `acceptVerifiedEvent(getPool(), event)`，其它正文只留下允许的 message metadata。Route Handler `await` 该调用后才返回 200，因此响应代表 inbox 与 durable job 已在同一事务提交；重放继续由 FS-66 的 event/message 唯一键返回首次结果。

公开错误只含稳定 code，不回显 body、token、tenant/app 值、密钥、解密材料或数据库错误。缺配置返回服务不可用；签名/token/tenant/app/时间窗失败与解密/载荷失败都在 `getPool()` 前结束。恢复时修正 secret store 或飞书应用订阅配置后让飞书重试，不得把 callback 原文贴入日志或工单。

## 样例与构建期校验

`env.example` 与 `.env.test.example` 都登记了 `AUTH_MODE` 占位。`apps/web/lib/env.ts` 的构建期 schema 一并接受 `AUTH_MODE`（缺省 `legacy`），非法取值会让构建失败而不是回退。

## 验证

```sh
pnpm vitest run packages/core/src/enterprise/config.test.ts
pnpm vitest run packages/core/src/enterprise/provider-admission.test.ts
pnpm vitest run tests/guards/enterprise-secrets.test.ts
pnpm vitest run packages/database/src/test-support/isolated-pg.test.ts
pnpm vitest run packages/database/src/migrate.test.ts
pnpm vitest run packages/database/src/schema/auth/enterprise-schema.test.ts
pnpm vitest run packages/database/src/enterprise-scope.test.ts
pnpm vitest run packages/database/src/schema/auth/enterprise-jobs.test.ts
pnpm vitest run packages/database/src/schema/auth/enterprise-operations.test.ts
pnpm vitest run packages/database/src/schema/auth/enterprise-actor-reservations.test.ts
pnpm vitest run packages/engine/src/services/enterprise/feishu/token.test.ts
pnpm vitest run packages/engine/src/services/enterprise/feishu/directory.test.ts
pnpm vitest run packages/engine/src/workers/enterprise-runtime.test.ts
pnpm vitest run packages/engine/src/services/enterprise/directory-sync.test.ts
pnpm vitest run packages/database/src/schema/auth/enterprise-events.test.ts
pnpm vitest run packages/engine/src/services/enterprise/events.integration.test.ts
pnpm vitest run apps/web/tests/unit/feishu-events.test.ts
pnpm vitest run apps/web/tests/contract/feishu-events.spec.ts
```

## CI守卫工具与恢复

`scripts/install-ci-ripgrep.sh` 只面向 quality 的 Linux x86_64 runner，固定使用[官方 ripgrep 15.1.0 发布资产](https://github.com/BurntSushi/ripgrep/releases/tag/15.1.0)中的 `ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz`。归档 SHA-256 为 `1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599`；先校验摘要，再提取唯一的 `rg` 成员、安装并核对版本，最后向 GitHub 的 `GITHUB_PATH` 发布本job工具目录。已有 PATH 中的同名工具和环境变量不能替换固定资产。

下载仅允许HTTPS及HTTPS重定向，连接上限10秒、总上限45秒、一次尝试；curl首参数使用`-q`忽略默认配置，防止本机配置追加URL或重试。quality步骤上限2分钟，位于项目依赖安装之前。脚本不使用sudo或APT，不写系统目录，不执行远程安装脚本。正常或失败退出、可捕获的INT/TERM信号都会清理下载/解压目录；失败时同时删除未发布的工具目录。成功工具供当前job使用，由临时runner生命周期清理。SIGKILL或runner丢失时由runner清理承担，脚本不能承诺执行trap。

下载、摘要、解压、工具执行、版本或PATH发布任一步失败均非零退出；不跳过秘密/品牌等守卫。排障应先核对网络到固定官方资产的可达性、实际归档hash及job临时目录权限；不要改为任意镜像、放宽摘要或关闭检查。已推送修复只前滚，在新精确head重新执行完整quality，保留旧失败记录。安装成功只证明工具可用，不代表后续质量门已经通过。

本卡shell故障回归使用可控外部工具夹具，不将mock校验声称为官方二进制验证。Linux运行态烟测另外真实下载该归档、执行摘要校验/安装及版本、命中/无命中/无效表达式三个退出码分支；测试结束清理专属容器与临时文件。

```sh
pnpm vitest run tests/guards/ci-ripgrep.test.ts
```

## 服务端验证码ASCII规范化

`packages/auth/src/enterprise-otp/input.ts` 是本包内部纯输入边界，后续 request/plugin/verify 通过相对导入使用；本卡没有新增包根导出或子路径，也尚未注册 HTTP 登录接口。

`normalizeEnterpriseOtpInput(value: unknown): string | null` 先拒绝非字符串、超过1024个UTF-16码元的原输入和任何非ASCII字符，再仅去除两端的 TAB、LF、VT、FF、CR、SPACE（U+0009..U+000D、U+0020）。内部空白保留并被拒绝；ASCII字母转为大写后，复用FS-35的共同规范码谓词，要求8位、属于 `23456789ABCDEFGHJKMNPQRSTUVWXYZ` 且同时含字母与数字。不会使用Unicode trim或兼容归一化；NBSP、全角字符、长s等相似输入均返回 `null`。

`parseEnterpriseLoginName(value: unknown): string | null` 只接受原样3..64位ASCII字符串：首位为 `[a-z0-9]`，其余为 `[a-z0-9._-]`。不会去空白、折叠大小写或从邮箱/姓名推导；末尾换行也拒绝。两函数不会转换对象、数组或数字，不读环境或数据库，不发请求，不记录输入，不验证资格、到期或消费状态。FS-35密码接口仍只接受规范码，不会隐式调用这个规范化器；HTTP统一错误和登录事务由后续卡接线。

```sh
pnpm vitest run packages/auth/src/enterprise-otp/input.test.ts
```

## 匿名配对预算与IP隐私

FS-74在`packages/engine/src/services/enterprise/anonymous-budget.ts`提供内部`createAnonymousPairingBudget`，不增加包根导出、环境变量或HTTP入口。工厂复制FS-44目标expectation、批准CIDR和独立32..1024字节IP HMAC master；scope及deploymentRole分别固定为instanceId及environment，不允许请求覆盖，也不批准初始化未知数据库。`run({transport,flowHash}, createPending)`只接受64位小写hex flow摘要；真实socket peer及原始XFF必须由后续FS-73的服务器入口取得，当前Web Request或任意请求头不能充当来源证明。

批准CIDR最多64项，来源只接受有效ASCII IPv4/IPv6字面值，拒绝zone、括号、端口和空白；IPv6等价写法规范化，mapped IPv6归并到IPv4。IPv4与IPv6批准网段分别匹配；mapped CIDR只接受/96..128并转换成IPv4前缀。不可信peer的XFF完全忽略；可信peer缺XFF时使用peer，否则先校验全部最多16跳、2048字符的链，再从右向左剥离批准代理，选首个不可信节点，全可信时选最左节点。坏链拒绝，不降级到任意转发头。

事务显式使用READ COMMITTED，先取得固定scope/role/login的PG事务锁，再读取数据库`clock_timestamp`毫秒值T；应用时钟不决定额度。UTC日key为HMAC-SHA256(master, UTF8(JSON.stringify(["megaui:anonymous-ip:day:v1", scope, role, YYYY-MM-DD])))，subject为HMAC-SHA256(dayKey, UTF8(JSON.stringify(["megaui:anonymous-ip:subject:v1", canonicalIp])))的小写hex。仅临时派生当日及前一日key，按两个subject汇总严格窗口(T-600秒,T]，已有30次不再写拒绝事件；其余写T事件及T+600秒期限，同毫秒递增used。跨午夜不会重置额度，历史过期行不影响查询。master轮换前停止匿名申请至少一个完整10分钟窗口，旧行的有界清理由FS-84交付。

锁序为scope预算→目标flow行→IP扣减/容量→配对写入。目标flow过期pending先转expired，其余未清理的过期pending仍计入scope/role一万容量；同flow只允许一个pending。flow或总容量饱和仍提交本次IP扣减，三类饱和公开形状统一为`{kind:"rate-limited",status:429,code:"RATE_LIMITED"}`。可信createPending仅使用传入的同事务query接口与固定scope/role/flow/T，写一个TTL120秒的pending并返回UUID，不得自行提交、取得第二连接或调用provider等外部I/O。服务核验返回行归属、状态、时间及容量后确认COMMIT，才返回`{kind:"accepted",pairingId}`；回调/SQL错误回滚，提交不能确认时只返回`{kind:"unavailable"}`且不自动重试。配对token、alias隐藏、generation及真实写入由FS-11负责。

工厂只借用标准pg Pool/Client及原生Promise，真实`pool.options.connectionTimeoutMillis`必须为1..1000的整数，factory及每次run都检查并拒绝配置漂移。缺省/0、onConnect/verify、自定义Client/Promise、stream、异步password回调、替换connect、connect/acquire事件hook或Pool子类均不受支持，不能在获取期间插入外部I/O。服务不改Pool配置、不创建替代Pool、不调用Pool.end。连接获取、锁、单SQL及事务/回调分别有1/1/3/5秒预算；超时销毁本run连接，阻止迟到回调继续写，迟到获取的连接释放，满池等待项由已校验的原生Pool计时器移除。恢复时修正可信配置或数据库故障，再由业务调用方重新发起；不要清空有效IP预算或轮换key绕过限制。

原IP仅在单次内存中用于派生，不进入SQL参数、持久字段、公开错误或日志。饱和告警在事务结束并释放连接后调用可信同步sink，冻结事件仅含`event=enterprise.anonymous-budget.saturated`、原因码ip/flow/capacity、scope指纹及UTC时间。sink必须有界且返回undefined，不启动异步外部I/O；抛错或非undefined返回仅输出固定`ENTERPRISE_ANONYMOUS_BUDGET_ALERT_UNAVAILABLE`，不改变429、不宣称送达。违规thenable附加拒绝处理但不等待；其后台工作归违规调用方所有，本port不拥有告警网络或队列。

真实一次性PG测试覆盖双实例额度、9999/10000并发容量、同flow、午夜两subject滚动边界、同毫秒计数、数据库时钟、提交失败及资源清理。午夜测试向与生产共用的内部SQL函数注入合成T，不声称实际运行跨越午夜。来源与HMAC测试覆盖代理伪造、地址等价、独立摘要oracle及SQL/错误脱敏。

```sh
pnpm vitest run packages/engine/src/services/enterprise/anonymous-budget.integration.test.ts
```

## 配对清理的作用域复合索引

FS-91通过Drizzle生成的`0012_aromatic_plazm.sql`，为`enterprise_pairings`追加B-tree索引`enterprise_pairings_scope_retention_idx(scope, deployment_role, retain_until, id)`。固定scope与deployment role后，以`retain_until <= T`过滤、按retain_until/id升序取至多100行；FS-11在同一查询中使用`FOR UPDATE SKIP LOCKED`并执行清理。旧`enterprise_pairings_retain_until_idx`和全部列、唯一键、CHECK、FK保持；没有新表、数据重写、配置或版本变化。

该迁移只追加SQL、snapshot和journal项。应用仍须使用FS-44/57目标准入及获准迁移身份；测试仅在本run一次性PG执行，不读取实际环境或连接外部数据库。迁移事务失败时，新索引和journal记录一起回滚；排除故障后重跑原始迁移前滚，已经应用时重复执行不改变结果。不要修改已提交历史迁移或执行down；真实生产应用仍归DEFER-FS-03。

指定测试从本迁移之前的集合建立用户、会话、identity、配对与challenge，核对完整schema dump及全部public表数据在故障回滚、前滚和重复应用后的保持。查询门装载10000个本scope/role到期行与100000个其它scope或role历史行，不强制planner选索引，以真实`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`核新索引、顺序与100行页，并输出实际查询耗时。索引选择不代表worker已经运行，也不证明五分钟积压清理SLA；调度、租约、并发和停机恢复由FS-11验收。

```sh
pnpm vitest run packages/database/src/schema/auth/enterprise-pairing-cleanup-index.test.ts
pnpm vitest run packages/database/src/migrate.test.ts
```

## 匿名配对申请与资源限额

FS-11公开`@megaui/engine.createEnterprisePairingService(options)`，工厂固定Pool、FS-44 expectation、tenantKey/appId及FS-74预算配置。`request({loginName,flowHash,transport})`是可信服务间port：只接收已由auth验证的登录名，拒绝类型/长度/摘要/authority覆盖，查询参数化exact lookup。完整alias语法只在包内`createEnterprisePairingRequest(port)`复用FS-49解析器；原始HTTP不得直接调用engine port，真实peer与HTTP装配由FS-73承接。两工厂不读取env或访问provider。

auth接受alias、可选原始flow及可信transport。flow为规范43字符base64url、解码32字节且重编码一致；缺少时由CSPRNG生成，坏alias/flow在port调用前拒绝。flowHash和pairing tokenHash均为对应原始文本UTF-8的SHA-256小写hex，与飞书`/login`文本摘要一致。token独立生成32字节随机熵，不保存明文。只有FS-74确认COMMIT成功才返回`202 {pairingId,pairingToken,expiresIn:120,resendAfter:60}`；auth同时产生`__Host-megaui.enterprise-flow` Cookie描述符，Path=/、无Domain、HttpOnly/Secure、SameSite=Lax、Max-Age=600。FS-73负责真实Set-Cookie；429无Cookie，数据库/提交不确定只返回稳定unavailable，不恢复旧token或伪装未知alias。

创建与匿名预算使用同一事务client，核持久activation允许enterprise，再锁定固定tenant/app及exact loginName匹配的profile/identity。未知alias保存NULL intended identity并返回同形202。generation取同scope/role/purpose/flow在pairings与challenges两表最大值加一，超过int32正整数上限则回滚；两表历史全部清除后才允许从1开始。匿名pending不会supersede旧challenge，不发送DM、不访问资格provider、不消耗身份发码或verify预算。初始createdAt=T、expiresAt=retainUntil=T+120秒；后续确认服务保留到confirmedAt+390秒。

清理队列和dedupe key绑定固定目标指纹，payload只有scope、deploymentRole及UTC调度时间。标准worker启动时幂等创建唯一root；每页在真实数据库时钟下按retain_until/id有序锁定最多100条到期行，删除与唯一后继job在同一事务提交。满页立即续跑，非满页从当前时间排60秒后；重放已有后继时不再删除第二页。handler在事务开始及提交前核当前claim owner与未过期lease，坏payload、异目标、过期租约或中途失败均不提交部分变更。只删除pairing，FK将challenge.pairingId置NULL，保留challenge、delivery和grant。

运行标准`pnpm --filter @megaui/engine run enterprise:worker`时，未声明scope且数据库未激活企业认证的legacy目标保持4并发/claim100。enterprise/maintenance或任一scope字段存在时，必须显式提供`ENTERPRISE_PROCESS_ROLE=worker`、owner fingerprint、instance ID、deployment role（development/test/production/canary），匹配现存目标marker和专用DML角色；不接受bootstrap、不默认web，也不为清理要求provider凭据。两个runtime预检通过后才写队列，每页继续核目标；持久激活与AUTH_MODE冲突时拒绝。

scope模式普通runtime并发3/claim100，cleanup runtime并发1/claim1，各自独占Pool，总并发每进程最多4。cleanup连接、锁、单SQL及事务分别限制1/1/3/5秒；URL options与PGOPTIONS不能放宽限制。每页预留独立取消时间，不使用被阻塞的单连接池取消自身。SIGTERM/SIGINT同步封闭两个lane并复用聚合stop Promise，停止后不再派发已领取的任务，未运行lease在30秒后可接管。原生socket关闭不等于数据库查询消失：保留backend责任到独立控制连接确认消失；连接握手未完成时明确拒绝获取。两池清理都收尾后才报告结果，最终输出阻塞仍受10秒进程期限约束。错误只输出固定配置、目标、取消、关闭或unavailable键；取消失败不得记成功退出。

五分钟清理目标以健康worker、可用数据库为条件；标准命令真实进程测试从10000条到期记录开始，叠加其它scope/role历史、慢普通任务、旧事件积压和持续新增，按DB实际到期至删除计时。停机、数据库不可用或长期外部锁应记录违约，恢复后由租约接管和持久后继追赶，不能记按时通过。运维修复目标/权限或数据库后重启同一scope worker，不清空有效预算、重开legacy或删challenge绕过恢复状态。

```sh
pnpm vitest run packages/auth/src/enterprise-otp/request.test.ts
pnpm vitest run packages/engine/src/services/enterprise/pairing.integration.test.ts
pnpm vitest run packages/engine/src/services/enterprise/pairing-cleanup.integration.test.ts
pnpm vitest run packages/engine/src/workers/enterprise-runtime.test.ts
pnpm vitest run packages/engine/src/workers/enterprise-pairing.test.ts
```

## 配对 request HTTP 插件

FS-73 将 `POST /api/auth/enterprise/request` 注册为 Better Auth 的可选
`megaui-enterprise-pairing` 插件。只有 FS-93 完整 Web assembly 注入
`createEnterprisePairingService` 与 transport resolver 时才启用；legacy/maintenance
装配不暴露该能力。Pages API 入口关闭默认 body parser，只接受规范路径和 POST，使用
`IncomingMessage.socket.remoteAddress` 作为 peer，并把原始 `X-Forwarded-For` 交给
FS-74 的批准代理解析器；Host、Origin、Proto 和请求自带的伪造 peer 不授予 authority。

入口从固定 `BETTER_AUTH_URL` origin 构造 canonical Request，不读取 Host 推导目标。
原始 header 重复、畸形 Cookie、请求体实际超过 4 KiB、body 读取超过 2 秒或总处理超过
10 秒都会 fail-closed；响应在提交前完整缓冲，body 与单个 header 均限制 16 KiB。
transport context 由一次性的 request identity 和 AsyncLocalStorage 绑定，auth catchall、
clone/替换 Request 或超时后的晚到调用没有 transport，不能调用 pairing port。响应丢失
不会声称取消数据库事务，TTL 清理负责收敛仍处于 pending 的记录。

请求 JSON 只含 `alias`，完整语法仍由 FS-49 parser 在 FS-11 auth 边界执行；flow 只从
唯一 `__Host-megaui.enterprise-flow` Cookie 读取，必须是规范 43 字符 base64url，坏值不
会被替换成新 flow。事务成功后才返回同形 202 和 `pairingId/pairingToken/expiresIn=120/
resendAfter=60`，并设置无 Domain、`Path=/`、HttpOnly、Secure、SameSite=Lax、Max-Age=600
的 preauth Cookie；429、maintenance、未知依赖或所有输入/传输失败都不设置 Cookie，且
响应不回显 alias、目录、IP 或 OTP。该精确端点关闭 Better Auth 通用 rate-limit bucket，
匿名 10 分钟预算仍由 FS-74 原子事务 port 执行；其它 auth 端点保持既有策略。

## 配对 status HTTP 合同

FS-83 在同一可选插件中注册 `POST /api/auth/enterprise/status`。请求体严格为
`{"pairingId":"<lowercase UUID>"}`，不接受 token、flow 或其它字段；flow 只从当前请求的
`__Host-megaui.enterprise-flow` Cookie 读取并在服务端做 SHA-256 摘要。数据库查询同时绑定
固定的 policy scope、deployment role、Feishu tenant/app、login purpose 和该 flow，因而跨
flow、跨 deployment 或其它应用的 pairing 不会被读取（统一返回 `404 NOT_FOUND`）。缺失或
畸形 Cookie/UUID 返回 `400 INVALID_INPUT`，数据库不可用返回 `503 UNAVAILABLE`；精确 status
路径关闭 Better Auth 通用 rate-limit bucket，但不调用 provider、发送 DM 或扣身份预算。

同 authority 下，pending 返回 `200 {"status":"pending"}`，confirmed 返回
`200 {"status":"confirmed","challengeId":"<opaque UUID>"}`，过期或已过期的 pairing 返回
`200 {"status":"expired"}`。响应永不包含 pairing token、OTP、alias、目录资料、identity 或
IP；GET 与其它方法不能执行 status（当前 Better Auth 路由返回 404/405）。confirmed 查询只
通过 pairing 外键关联 challenge 的不透明 ID，不把任何 challenge 密文或验证码投影到 HTTP。
契约测试使用真实 Web assembly 与隔离 PostgreSQL：
`apps/web/tests/contract/enterprise-pairing-status.spec.ts`。

## 可信 sender 发码预算

FS-75 提供 engine 内部 `createEnterpriseSenderBudget` port，供后续已验签
`im.message.receive_v1` 流程调用。有效 token 的调用在同一 PostgreSQL 事务内先锁定固定
scope/deployment，再同时检查 sender 的 60 秒间隔、identity 的滚动 10 分钟 5 次上限和
最多 3 条已确认 flow；预算使用 `sender-send` 的摘要键，不含原始 open_id 或身份资料。
预算通过后才调用同一事务的 challenge/outbox callback，callback 失败会回滚预算和业务写入，
不能留下“已扣额度但未建码”的半状态。scope 级 advisory transaction lock 使独立实例并发
争用只接受一个发送，满额时不挤掉已有 confirmed flow；同一 flow 重发允许沿用该 flow 的
generation。

无效 token 不查询 identity、pairing 或 provider，只在 `sender-invalid` 公共 sender 桶中
计数（10 分钟最多 10 次）；不会消耗目标身份的 `sender-send` 预算。数据库 authority、
activation、DML 角色、连接/锁/SQL/事务期限任一失败均返回稳定 `unavailable`，不结束调用方
拥有的 Pool。验证位于
`packages/engine/src/services/enterprise/sender-budget.integration.test.ts`，由隔离
PostgreSQL 覆盖间隔、身份窗口、confirmed-flow 容量、无效 token 分桶、并发串行及 callback
回滚。

## Bot 指令准入与当前资格

FS-76 的 `createEnterpriseBotCommandService` 只接收 FS-66 inbox 的投影，或带
`inboxId` 的 follow-up job。回调边界已经把严格形如 `/login <opaque-token>` 的正文投影为
64 位小写 SHA-256 摘要；engine 不重新接收或解析私聊正文，也不把 token 写入日志、队列或
审计。缺少摘要、群聊、bot sender、非 text 消息和其它 scope/tenant/app 的事件均 fail-closed。

服务以摘要绑定当前 deployment 的 login pairing，再核对 pairing 的 intended identity 与
消息 `sender_open_id` 完全一致；unknown、过期、跨部署或 sender 不匹配都不会进入 FS-46。
通过绑定后调用 FS-10 的数据库资格端口重新核验 identity 状态、完整且新鲜的目录 generation、
本地 ban 与 auth epoch。suspended identity、陈旧/不完整目录或 active local ban 都返回
`ineligible-identity`，不调用 provider、不创建 challenge、不发送 DM、不创建 session。数据库
authority 或 scope/角色校验异常统一返回 `unavailable`。

事件 owner 应使用 `readPersistedVerifiedPrivateMessageEvent(pool, inboxId)` 从 inbox 读取
最小投影，再把结果传给 `admit`；该读取只返回 IM 元数据和可选摘要。验证位于
`packages/engine/src/services/enterprise/bot-command.integration.test.ts`，由隔离
PostgreSQL 覆盖严格命令、p2p/user/text、sender 绑定及 suspended、目录陈旧、本地 ban 三类
当前资格拒绝。

## 本人私聊确认后原子发码

FS-46 的 `createEnterpriseBotLoginService` 只接受 FS-76 的准入结果，然后调用 FS-75 的
`createEnterpriseSenderBudget`。sender budget transaction 锁定 scope/deployment 后，bot-login
在同一个连接上重新锁定 pending pairing、核对当前 sender、flow、deployment、有效期和
identity version，并用同一事务连接重新执行 FS-10 资格查询；provider、私聊正文和浏览器收件
身份都不会从消息中推导。

资格通过后才把 pairing 标记为 `confirmed`（绑定 `confirmed_message_id` 和 390 秒保留窗口），
生成 8 位码，使用注入的 FS-35 crypto port 计算 HMAC 与 AEAD 密文，再插入 300 秒
`enterprise_challenges` 和 expiry 绑定的 `enterprise_dm_deliveries`。pairing、预算、challenge
与密文 delivery 都在同一事务提交；任一更新、密码封装、约束或 outbox 写失败都会整体回滚，
不会留下“已扣预算但未建码”的半状态。message_id 重放不会再创建第二个 challenge 或 delivery；
预算返回 429 时 callback 不执行，因此不创建 challenge/outbox。该服务不创建 session，后续
FS-12/13 仅消费密文 delivery。

验证位于 `packages/engine/src/services/enterprise/bot-login.integration.test.ts`，隔离
PostgreSQL 覆盖 8 项 AC（7 个真实场景，含事务重放、资格复查、预算拒绝和失败回滚）；测试
crypto 只生成合成密文，生产密钥和 OTP 明文仍由 auth crypto assembly 注入，未写入 engine、
数据库或日志。

验证分为 auth handler/flow 单测、Node TCP/有限传输单测、owned Next+隔离 PG 契约和真实
Chromium 浏览器门。浏览器门检查 Cookie 的回送和属性，不代验收后续 status、OTP、登录或
真实飞书写入；运行记录见
[`enterprise-pairing-request` catalog](../../apps/web/tests/e2e/catalog/enterprise-pairing-request.md)。


## 混合路由导航兼容

FS-92适配Next在App与Pages并存时自行生成的nullable导航类型，范围限于CL文件页、代码路径页、文档详情、文档Roam快捷操作、设置导航和设置内容六组件。外壳先确认自身消费的params/search/pathname可用，再挂载内容；不把null search当成最新版本或默认个人设置，不挂载对应DocWriter/ProfileForm。已知上下文的路径解码、file/range、tab、快照只读、block查询保留与section行为保持。

六组件的动作与挂载周期绑定：未知上下文不准入新的业务写入或router动作，已卸载周期的旧回调不能因后来恢复而重新生效。快照恢复从动作入口冻结原文档、路径与query，异步完成时核对同一上下文才导航，不能因React Query更新回调而覆盖用户后来切换的地址。已准入的复合操作及既有子组件保存队列维持其生命周期，包括await后的后续请求；卸载外壳不是整个子树的取消协议，也不撤回已经发送的请求。

默认根Vitest使用automatic JSX转换，使Web的jsx=preserve源码能进入实际组件测试；仅改变测试编译，不改Next生产构建。focused测试使用`apps/web/tests/config/enterprise.vitest.config.ts`，关闭env加载并保留根alias、收集范围及localstorage setup。完整CMD-05仍使用默认根配置，在没有实际.env的owned副本和合成env中执行。

`apps/web/tests/helpers/owned-web.ts`在复制之前排除实际环境文件、VCS、缓存和输出，复制相对依赖链接并验证workspace解析留在副本，迁移FS-57一次性PG。全部Web、Playwright及mint子进程使用副本cwd和白名单env；pnpm生成启动器中的绝对NODE_PATH也只在副本内重定位。真实兼容契约临时加入Pages API探针，由Next生成类型并运行dev/build/standalone，同时检查旧auth路由；新增浏览器测试页仅注入导航context与fixture，导入真实六组件，不进入生产应用。

通过`pnpm exec tsx apps/web/tests/helpers/owned-web.ts e2e apps/web/tests/e2e/<spec>.spec.ts`运行浏览器门；owner内部执行原Playwright命令，单worker、trace关闭、显式本run端口和`E2E_SKIP_WEBSERVER=1`。新navigation-readiness及原workspace-cl-files/code/docs/docs-roam/settings规格共同覆盖未知与正常行为；workspace-code原optional真实mega2用例保持其既有门，不作为本卡真实联调通过证据。

旧Roam上传spec按需增加固定digest的RustFS与短命rc初始化容器、专属网络/volume和合成bucket；Web及浏览器使用本run的127.0.0.1映射端口。它实际验证认证上传、返回URL和图片解码，不连接共享S3。其它spec及CMD-05不创建对象存储。创建前登记name/label/intent；取消等待已开始的有限创建命令终结后清理，未确认终结的创建即使暂未发现对象也报告cleanup-pending。创建/移除命令30秒、资源清理总窗口60秒；只删除匹配本run label的资源，固定镜像作为工具缓存保留。

owner的构建/启动期限120秒，HTTP等待不超过60秒；关闭先封闭新动作并终止仅本run的Web/浏览器进程组，10秒后必要时SIGKILL并等待实际退出，收齐已开始的Docker创建和文件操作后，回收对象存储资源、PG和目录。重复close共享结果，各项清理失败仍继续执行其余清理并合并报告。CLI取消和契约测试超时使用同一取消路径，端口绑定失败不终止外部监听器。任一门失败应前滚修复并重跑；本卡不增加企业HTTP端点、登录开关、schema或发布版本。

## Web企业启动与恢复

## 双模式 Web 与 PG 运行隔离

FS-40 的 `helpers/isolated-server.ts` 从空环境构造子进程，只放入固定 Web
allowlist、run 私有 `HOME`/`XDG_CACHE_HOME` 与源副本路径；复制会排除真实 `.env`、VCS、缓存和
输出目录。每个 fixture 通过 FS-57 创建并迁移自己的 PostgreSQL，再以独立 DML 角色启动
`NODE_ENV=development` 的 Next dev。启动前绑定字面 `http://127.0.0.1:<port>`，重启复用同一
origin/端口；占端口、HTTP 未就绪或真实子进程退出都会失败。关闭按进程组 SIGTERM→有界
SIGKILL、实际 exit、PG 与源快照顺序清理，重复关闭共享结果且不触碰其它 run 资源。

`playwright.enterprise.config.ts` 与 `playwright.legacy.config.ts` 仅收集同一基础 harness，分别
验证 enterprise/legacy 的真实 Web/PG 健康、无 `.env` 快照和同 origin 重启；不启动 Mock、worker、
collab、SMTP，也不取 Cookie。由于 Playwright 直接加载 workspace TypeScript 时需要 ESM loader，
本地命令显式使用 `NODE_OPTIONS=--import=tsx`；该变量只作用于测试编排进程，Web 子进程仍由
白名单构造。

## 企业认证与双模式 E2E 持续集成

FS-26 在 self-hosted Linux quality job 中保留每个 run 的 PostgreSQL 资源，并分别执行
`playwright.enterprise-auth.config.ts` 的 enterprise 认证 project、`playwright.legacy-auth.config.ts`
的 legacy Cookie project，以及通过 `apps/web/tests/helpers/owned-web.ts` 启动独立 Web/PG 的
legacy auth-page project。enterprise project 只收集企业 pairing/verify 测试，不调用 legacy
signup、reset 或 session-mint helper；legacy project 才覆盖既有邮箱密码 Cookie 合同。任一
project、隔离 fixture 或清理失败都会使 job 失败，没有 `continue-on-error` 或 live 缺失回退。

CI 末尾只输出固定的 `FS-26 live Feishu/production gate: NOT EXECUTED (DEFER-FS-03)` 状态；真实
租户、provider、canary 和生产部署不在本期 job 中，也不会把未执行当作成功。可重复的本地命令为：

```sh
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/enterprise-auth.spec.ts apps/web/tests/e2e/enterprise-auth-fixture.spec.ts --config=playwright.enterprise-auth.config.ts --workers=1 --trace=off
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/legacy-auth-fixture.spec.ts --config=playwright.legacy-auth.config.ts --workers=1 --trace=off
NODE_OPTIONS=--import=tsx pnpm exec tsx apps/web/tests/helpers/owned-web.ts e2e apps/web/tests/e2e/auth-flow.spec.ts
```

## 企业 E2E 辅助进程组合

FS-88 在 FS-40 的 enterprise Web 已取得固定 loopback origin 后，先把该 origin 的精确
`/api/integrations/feishu/events` 作为 callback URL 交给同一 FSM-05 CLI/HTTP Mock，再从 Mock
run-owned runtime 文件投影 `baseUrl`、tenant/app、app secret 和 callback wire key 到 Web
allowlist，最后复用原句柄在同端口重启 Web。Mock 的 `adminToken` 只保留在 fixture 控制面，
不会进入 Web、worker 或 collab 子进程环境。

随后 fixture 以独立白名单环境启动 FS-07 enterprise worker、两个不同 loopback 端口的
`apps/collab-server` 进程和 `node:24-alpine` 的 run-labelled SMTP receiver。组合测试只检查
health、worker 已进入 started 状态、SMTP 可收件，以及 Mock 的 URL verification callback 确实
回到 Web；不取 Cookie、不声明后续 v3 ticket、内省、撤销或通知语义。关闭按 SMTP→辅助子进程
→Mock→Web→PG 顺序执行，所有失败合并报告并继续收齐其它 run-owned 资源。

## 双模式正常 Cookie 流程 fixture

FS-89 在 FS-40 的独立 Web/PG fixture 上补齐两条正常认证路径。enterprise fixture 先以
`FEISHU_DIRECTORY_DEPARTMENT_IDS`、`ENTERPRISE_OTP_HMAC_KEY` 和 `ENTERPRISE_DELIVERY_KEY`
完成同源 Web 重启，再由浏览器 POST `/api/auth/enterprise/request` 获取 opaque pairing
结果与 `__Host-megaui.enterprise-flow`；FSM-05 Mock 通过该 Web 的 callback 投递同一
`/login token` 私聊，verified inbox 由 bot-login 消费并创建 challenge。测试只读取本 run
生成的合成 8 位码，随后通过浏览器 POST `/api/auth/enterprise/verify`，由 Web runtime
组装的 OTP consumer 写 grant/session 并回送 Better Auth Cookie；fixture 没有 Cookie、session
或 token 注入参数，Mock `adminToken` 只存在控制面。enterprise runtime 的目录 reader
固定 fail-closed，资格只读当前隔离 PG 的目录快照、水位线和身份记录。

legacy fixture 不创建 enterprise pairing 或 session 元数据，使用既有 signup/signin 页面并
通过同一 run-labelled SMTP receiver 探活；清除首次 signup Cookie 后重新登录，确保 Cookie
来自既有登录路由。两条 spec 的数据库、Web 进程、Mock/SMTP 句柄均由 finally 统一回收，
并在 `apps/web/tests/e2e/catalog/` 登记行为与运行命令。production build 另以
`FEISHU_PROVIDER=feishu` 且不设置 simulator 配置执行，不把该构建门当作真实 provider/live
验收。

## Web 默认受保护资格守卫

FS-15 的 `resolveWebActor` 是页面中间件、Mega BFF route guard 与
`apps/web/lib/adapter/session.ts` 的共同入口。它先以 Better Auth 的签名 session Cookie
做一次权威 `getSession`（显式 `disableCookieCache`，并禁用 refresh 写入），再以返回的
server-side session id 查询 enterprise grant、identity、auth epoch 与 auth method；不会从
请求 Cookie 直接读取这些授权字段。enterprise 模式随后复用 FS-10 的
`authenticationEligibility`，在同一受保护 PG pool 上检查 identity、目录 snapshot 水位、ban、
policy mode 与 epoch；任何缺行、歧义、停用或数据库异常都返回未授权。legacy 模式只保留
既有 Better Auth session，maintenance 或不完整企业装配不产生业务 actor。

Better Auth 的 `session.cookieCache` 明确关闭，且没有配置 `secondaryStorage`；因此停用提交
后的新请求不能继续使用旧 Cookie cache 或另一份未受撤销控制的 session 副本。页面和 BFF
只消费 resolver 返回的 `userId`，不再把“存在 user”当作企业访问资格。可重复契约位于
`apps/web/tests/contract/enterprise-access.spec.ts`，覆盖同一 resolver、停用/旧 epoch、
数据库故障、legacy/maintenance 及 session 存储配置。

## 上传、设置和长流资格接线

FS-30 的上传 route、profile settings、collab ticket mint 和首页 CTA 都只消费
`resolveWebActor` 返回的 actor；失效的 session、停用 identity、旧 auth epoch 或资格数据库
故障不会退回普通 user/session 存在性。collab context 在 enterprise 模式固定取
`enterprise_profile.backend_username`，不从 email、请求参数或本地 user id 派生。

agent/SSE 在开始输出后每 15 秒再次调用同一 resolver，在下一个敏感 delta 或 done 事件前
停止并删除未完成 assistant；因此撤销后的增量输出保留 30 秒以内的明确预算。验证入口为
`apps/web/tests/contract/enterprise-access-consumers.spec.ts`，并以
`apps/web/tests/e2e/enterprise-offboarding.spec.ts` 覆盖真实 enterprise Cookie 在页面、BFF、
上传、设置和 collab ticket 上的撤销闭环。

## collab v3 票据与建连校验

FS-16 的 `mega-collab.v3` 票据只由 Web 在已通过 `resolveWebActor` 的请求中铸造，显式
绑定 `userId`、服务器读取的 `identityId` 与 `authEpoch`，并将 TTL 限制为最多五分钟；
collection ticket 继续绑定完整 room 名称。legacy 请求保持 v1/v2 兼容，企业或 maintenance
collab 进程拒绝没有 identity/epoch 的旧票据、拒绝 epoch 不是当前 policy 水位的票据，
并在 doc／collection 授权前向 FS-41 内省路径核验 `{localUserId, identityId, authEpoch}`。
内省返回 false、超时、畸形响应或服务不可用均以未授权 fail-closed；room 绑定仍由
collab 认证层精确比较，不把 `MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED` 当作企业旁路。
可重复验证位于 `apps/collab-server/src/enterprise-ticket.test.ts`、core ticket 与
engine token tests；FS-30 offboarding E2E 覆盖停用后仍在 Cookie 下请求 collab ticket
的拒绝。

## 服务凭据保护的资格内省 API

FS-41 只公开精确 `POST /api/internal/enterprise/eligibility`。中间件仅为该路径的 POST
放行匿名请求，route 自己要求独立 `Authorization: Bearer` service key
`ENTERPRISE_INTROSPECTION_KEY`；它绝不接受 `MEGA_COLLAB_INTERNAL_TOKEN`、Cookie 或其它
internal 路径作为回退。请求体是 strict 的 `localUserId`、`identityId`、非负安全整数
`authEpoch`，服务端固定当前 Web scope/tenant/app 并调用 FS-10 的同一
`authenticationEligibility`，不接受调用方替换范围。资格读取缺行、歧义、数据库故障或装配
不可用时返回固定 `503 ENTERPRISE_INTROSPECTION_UNAVAILABLE`，不返回旧结果、用户 token 或
数据库细节。契约测试位于 `apps/web/tests/contract/enterprise-introspection.spec.ts`。

## 持久认证策略内省合同

FS-64 在同一已鉴权路径增加严格 `{ "op": "policy" }` 请求；未知字段、其它
discriminant 或把 eligibility 参数混入 policy 请求都会拒绝。响应使用
`@megaui/core` 的共享 `EnterprisePolicyResponse` DTO，包含 `schema_version`、当前
`effective_mode`、数据库 `policy_epoch`、可信 `instance_id` 与不可变部署的
`artifact_sha`，应用层不复制另一份协议类型。

每次 policy 请求都从当前 Web scope 对应的 `enterprise_policy` 行读取，并以统一
`resolveEffectiveAuthMode` 组合环境模式与持久 activation；行缺失、重复、归属／部署
不匹配、非法 epoch、模式冲突、artifact 缺失或数据库不可用均返回固定
`503 ENTERPRISE_INTROSPECTION_UNAVAILABLE`，不返回缓存或旧 policy。响应不含 Cookie、
session、ticket、验证码或其它用户 token。契约验证位于
`apps/web/tests/contract/enterprise-introspection.spec.ts`。

## 既有 collab 连接重验与按用户断连

FS-17 在 collab 进程内维护既有连接的周期重验器，默认每 15 秒从 FS-65 policy bridge
读取当前权威策略；企业/maintenance 连接必须再次满足 `identityId`、`authEpoch` 与
资格内省，legacy 连接也参与 policy 兼容性检查。策略读取或资格内省失败时不使用旧结果，
受影响连接立即关闭；重验器为单飞执行，资格检查并行且不扫描通讯录，因而在 30 秒撤销预算内
收敛。启动、销毁会分别启动和停止计时器，`unref` 不阻止宿主进程退出。

停用路径可向每个 collab 实例发送 `POST /internal/revoke`。该端点只接受严格的
`{userId, authEpoch}` 请求，并要求独立 `ENTERPRISE_COLLAB_REVOKE_KEY` Bearer；绝不
回退 `MEGA_COLLAB_INTERNAL_TOKEN` 或 ticket secret。按 user/epoch 的撤销记录幂等关闭该用户
的所有文档连接，同时拒绝旧票据重连；其它用户连接保持不变。engine 侧的
`enterprise.collab-revoke` durable job 只保存 user、epoch 和 reason，按实例独立凭据并行
投递，响应必须是严格 `{data:{revoked:true,closed}}`，失败抛出稳定
`COLLAB_REVOKE_UNAVAILABLE` 供 worker 重试。

重复撤销、丢失通知和 policy 故障最终都由周期重验收敛。验证入口是
`apps/collab-server/src/enterprise-revoke.integration.test.ts`；Web 侧继续复用
`apps/web/tests/e2e/enterprise-offboarding.spec.ts` 的隔离停用 fixture。恢复时先修正
policy/资格服务或实例凭据，再按 durable dedupe key 重试，不重置房间或删除内容。

## 成员停用与撤销事务

FS-18 的 `createEnterpriseOffboardingService` 是目录明确离职和本地 quarantine 共用的
事务入口，底层 `createEnterpriseOffboardingStore` 只接受调用方持有的 PG pool。它在一个
READ COMMITTED 事务中按 policy→identity 锁序，核对可选的 identity version，然后把 identity
置为 `resigned` 并递增 `identity_version`，递增当前 scope 的 `auth_epoch`；旧 challenge
变成 `revoked` 并清空 code HMAC，pairing 变成 `expired`，grant 与该用户全部 session
一并删除。原有业务内容和 user 主键不删除，因此历史文档继续保留原 `author_id`/user 外键。

同一事务会以 `(user_id, auth_epoch)` 幂等键写入 `enterprise_revocations` pending outbox；
worker 可按 `reason` 和 `authEpoch` 重试 FS-17 的 `enterprise.collab-revoke` durable job，
不会把 ticket、验证码或 service key 写入 payload。重复停用返回第一次 revocation/epoch，
不会再次递增版本；预期 identity version 过期或任一 SQL/锁超时则整笔回滚。已停用身份的
旧 Contact 事件只能进入待处理 inbox，不能恢复 `active` 或旧 watermark 资格；Contact 删除
事件 effect 可经 `VerifiedEventOffboardingPort` 显式接入同一事务入口。

验证入口是 `packages/engine/src/services/enterprise/offboarding.integration.test.ts`：
隔离 PostgreSQL 覆盖八项 AC、内容归属、幂等重放、旧版本冲突及下游失败的全事务回滚；
Web 侧继续复用 `apps/web/tests/e2e/enterprise-offboarding.spec.ts`。恢复时使用原
revocation/dedupe key 前滚，不删除用户或历史内容，也不把本地 quarantine 转为可登录状态。

## 企业认证 operation 白名单

FS-19 的 `createEnterpriseOperationPolicy` 同时挂在 Better Auth 的 HTTP
`onRequest` 和 endpoint `before` hook：前者核对 `/api/auth` 后的原始 pathname，后者覆盖
`auth.api.*` 直接 dispatch。因此 enterprise effective mode 只接受六个精确 operation：
`/enterprise/request`、`/enterprise/status`、`/enterprise/verify`、`/enterprise/session`、
`/get-session`、`/sign-out`。`admin/*`、`delete-user`、未登记 endpoint、尾斜杠、重复/编码
路径不会因为路由归一化而获得入口。

策略 resolver 每次请求从当前 `enterprise_policy` 读取 scope、activation state 和 epoch，并
重新组合部署 env 与持久策略；SQL/配置错误返回不可用，持久激活存在时把 env 改回 legacy
不会恢复旧认证。未激活 legacy 不安装有效限制，保持既有兼容行为；企业模式的 operation
拒绝统一为 404，策略不可用为 503，响应不返回 session、OTP、token 或数据库细节。

运行探活不再依赖 Better Auth 的 `/ok` operation，而使用独立 `/api/health`，避免测试或部署
readiness 依赖绕过企业认证白名单。

## 公开 session 与 profile DTO 隔离

FS-39 新增 `GET /api/auth/enterprise/session` 与 direct `auth.api.getEnterpriseSession`。
两者先读取不可缓存的服务端 session，再按当前 enterprise qualification 端口核对
`local_user_id`、`identity_id`、`auth_epoch` 和 `auth_method`；资格、资料或策略读取失败统一
返回 `null`，不把内部 session 当作授权结果。maintenance 与无 Cookie 也返回 `null`。

返回值只包含 `{ session: { id, expiresAt }, user: { id, name, email, image } }`：企业模式的
`user.id` 保持原本地 `user.id`，`name` 来自 `enterprise_profile.display_name`，`email` 来自可空
`notification_email`（空值序列化为空字符串），不暴露 `backend_username`、Better Auth
兼容邮箱、session token、OTP 或企业 grant 元数据。legacy 模式仍返回普通公开姓名/邮箱的同一
DTO，兼容客户端的 string 字段合同。

浏览器 `authClient.useSession()` 与 `getSession()` 保留 Better Auth API 表面，但 client adapter
把请求透明改发到 `/enterprise/session`；该 adapter 只有 GET 路径，不提供写入 enterprise
session 元数据的动作。企业模式下 `update-user`、admin 和其它写入口仍由 FS-19 operation
白名单拒绝。

## mega2 get-session 兼容与稳定 actor

FS-45 在本仓 `/api/auth/get-session` 的 GET/POST 路径上保留 mega2 兼容投影。每次请求先读取
不可缓存的 Better Auth session，再经 Web actor resolver 重新读取企业 authority 并执行当前资格
检查；无 Cookie、过期 session、资格失败或数据库异常均返回 HTTP 200 与 JSON `null`，不把旧
Cookie 当作 principal。真实 mega2 实例的 `/api/v1/user/` 与 `website_user_id` 检查仍属于
DEFER-FS-03，不由本卡声称完成。

有效响应只保留 `{ session: { id, expiresAt }, user: { id, name, email, image, banned } }`。
enterprise 的 `user.id` 是原本地 ID，`name` 始终是冻结的 `backend_username`，`email` 只取
`notification_email`（可空），`image` 保留公开头像，`banned` 固定为 `false`；兼容邮箱、OTP、
grant、authority 和 session token 不出现在响应。legacy 使用 REF-10 的逐字节 actor 算法：保留
非空姓名，否则使用邮箱 `@` 前 local-part 的 Unicode trim。客户端 `useSession/getSession`
仍走 FS-39 的公开 DTO，不依赖该历史兼容路径。

## 维护模式的认证 operation 拦截

FS-77 让持久 policy 的 `maintenance` 成为 fail-closed 认证边界：HTTP 与 direct `auth.api` 的
enterprise request/status/verify 以及其它未登记 operation 都返回稳定 404；只有 sign-out 保持
可执行。`GET/POST /api/auth/get-session` 和 `GET /api/auth/enterprise/session` 是两个只读例外，
在 maintenance 下都直接返回 HTTP 200 与 JSON `null`，不会读取或转换旧 session，也不会触发
authority、profile 或 qualification port。policy 失效仍返回 503，legacy 不受该 maintenance 分支
覆盖。

## 维护模式的业务入口封锁

FS-78 让页面中间件、Mega BFF、上传、collab ticket 和 agent/SSE 继续只调用同一份
`resolveWebActor` 资格门，不在各 route 复制 mode 判断。共享门先读取已装配 Web runtime
对应的持久 `enterprise_policy`：effective mode 为 `maintenance` 或 `reject` 时立即返回
`null`，不读取 Better Auth session、旧 Cookie 或企业 authority；因此把 `AUTH_MODE` 改回
`legacy` 也不能在已声明 scope 的部署中恢复业务访问。未声明 scope 的 legacy 仍保留历史
兼容路径，便于未激活的独立部署运行。

业务入口因此统一返回既有未授权合同（页面重定向登录，BFF/上传/SSE 返回 401），而不是
泄漏维护状态或旧用户资料。批准的 Feishu callback、health、enterprise eligibility 内省和
sign-out 仍由各自的精确匿名/退出边界处理；它们不是业务 actor。agent/SSE 开始输出后的
15 秒重验器不变，维护或资格失效会在不超过 30 秒预算内停止敏感增量并清理未完成响应。
双语维护提示保留在 i18n `errors.auth.maintenance`，供页面层在需要时使用。

## 本人私聊配对登录页

FS-20 的 enterprise 登录页不接受邮箱、密码或公开注册。用户只输入已批准的飞书登录名，
浏览器向 `/api/auth/enterprise/request` 发起一个本 flow 的 pairing，并在内存中展示一次性
`/login <pairingToken>` 指令；页面不自动向飞书发 DM，也不把 token 写入日志或持久审计。配对
状态只轮询 `pending`、`confirmed` 或 `expired`，响应中的 `challengeId` 是不透明句柄，不含
OTP、明文消息或 pairing token。

确认后页面接受严格的 8 位 ASCII 字母数字验证码，调用同一 flow 的 `/enterprise/verify`；
服务端成功设置 Better Auth Cookie，客户端只将受 `resolvePostAuthPath` 约束的站内相对路径作为
跳转目标。错误、重发等待和状态提示均有中英文词条；重发沿用服务端的 60 秒预算，不创建第二
个并行 flow。legacy 模式仍保留既有邮箱/密码页面，enterprise 模式的 signup、forgot-password
和 reset-password 旧入口由 middleware 返回 404，避免形成旁路认证面。

## 登录通知模板与地址保护

FS-31 的企业登录邮件是纯通知，不参与认证，也不发送验证码、session token、grant 元数据或
带 token 的登录链接。模板只接收收件人显示名、登录时间、设备、脱敏来源、应用名和不带查询参数
或 fragment 的普通站点入口，并提供 `en` / `zh-CN` 两套文案。发送失败不应改变登录事务；无有效
通知地址时由后续 outbox/worker 跳过并计数。

`EmailSender` 在 provider 调用前拒绝 `identity.invalid` 兼容地址（包括 `to`、`cc` 和 `bcc`），
避免把内部 user.email 兼容键当作收件地址。企业资料中的 `notification_email` 才是通知目的地；
engine 以显式 `@megaui/email` 生产依赖运行通知 worker，不从框架认证邮件或兼容键推导地址。

## collab 权威策略桥与降级封锁

FS-65 的 `apps/collab-server/src/enterprise-policy.ts` 是 Web → collab 的唯一策略桥。
collab 不连接 website PostgreSQL，也不把内存 policy 当故障 fallback；声明企业 scope 时，
启动前和每次 doc／collection 建连前都用独立 `ENTERPRISE_INTROSPECTION_KEY` 向固定
`BETTER_AUTH_URL` origin POST `{ "op": "policy" }`，严格解析共享 DTO，并核对本地
`ENTERPRISE_DB_INSTANCE_ID`、`ENTERPRISE_ARTIFACT_SHA`。请求失败、超时、HTTP 非 2xx、
畸形/过大响应、实例或 artifact 漂移均拒绝启动/建连。

本地 `AUTH_MODE` 只作为兼容性守卫：legacy 只能消费未激活的 legacy policy，enterprise
可消费 enterprise 或 maintenance，maintenance 只能消费 maintenance。健康端点在企业桥
启用时报告当前 `effective_mode` 与 `policy_epoch`；策略不可用返回稳定 503。即使
`MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED=1`，也不能绕过已激活策略或跳过建连前内省。契约与
恢复验证位于 `apps/collab-server/src/enterprise-policy.integration.test.ts`，FS-30
offboarding E2E 继续覆盖 Web 侧停用后的 collab ticket 拒绝。

FS-93 通过 Next 公开的 Node `instrumentation.register()` 等待初始化，再允许 HTTP 请求。模块 import 不创建 Pool 或读取必需认证密钥，标准 production build 不连接数据库。运行时预检失败以固定 `ENTERPRISE_WEB_UNAVAILABLE` 拒绝启动；配置解析只返回固定错误，不打印配置或底层 SQL 异常。

未声明任何 scope 字段且为 legacy 的标准 Next 启动，仍需在同一数据库确认所有 policy 都未激活且 epoch 为零；查询失败不会被当成空数据库。独立 legacy CLI／测试保持旧的同步 lazy `getAuth()`，这一独立路径没有异步持久预检，不能当作企业 Web 启动入口。只要模式非 legacy，或任一 scope 字段／approved-targets 字段出现（包括空字符串），就要求完整显式 scope：

| 字段 | Web 启动合同 |
|---|---|
| `ENTERPRISE_PROCESS_ROLE` | 必须为 `web` |
| `ENTERPRISE_OWNER_FINGERPRINT`、`ENTERPRISE_DB_INSTANCE_ID` | 非空、最多256字符、没有ASCII空白或控制字符 |
| `ENTERPRISE_DEPLOYMENT_ROLE` | `development`／`test`／`canary`／`production`，精确匹配 policy 的 environment 和 deployment_role |
| `ENTERPRISE_APPROVED_TARGETS` | Web 不允许非空值，不创建或 bootstrap policy |
| `FEISHU_TENANT_KEY`、`FEISHU_APP_ID` | enterprise 配对能力的固定企业／应用，不能从请求覆盖 |
| `ENTERPRISE_IP_HMAC_MASTER_KEY` | 独立32字节随机密钥，43字符规范 base64url、无 padding；样例占位不可运行 |
| `ENTERPRISE_TRUSTED_PROXY_CIDRS` | enterprise 下必填JSON数组，可为 `[]`，最多64项、原文最多8192字节；CIDR语义由既有公共配对工厂校验 |
| `BETTER_AUTH_URL` | enterprise 下必须是固定 http(s) origin；没有userinfo、query、fragment或业务路径。HTTP仅允许development/test的字面 `127.0.0.1` 或 `[::1]`，其它情况使用HTTPS |

`env.example` 默认仍为未声明 scope 的 legacy；scope字段作为可选注释，启用时须完整填写。maintenance／legacy不构造配对服务，也不要求未启用能力的IP、provider或OTP密钥。enterprise在持久policy为maintenance时仍要求本能力完整配置，但每次配对操作继续检查当前policy，不因启动成功获得长期许可。本卡没有交付配对HTTP插件、完整maintenance拦截或真实生产准入。

实际SQL权限须是DML角色；预检按固定scope读取恰好一条policy，核owner、environment、deployment_role、已知activation与合法epoch，拒绝缺失、歧义和模式冲突。session_user与current_user必须一致；核实际CREATEDB等高权角色属性、可SET ROLE的角色，以及当前数据库、非系统schema与对象的创建／所有权能力，不能把数据库CREATE ACL当作CREATEDB属性。对象所有权通过当前数据库的`pg_shdepend` ownership依赖检查，覆盖operator、publication等对象，不限于table/function/type；数据库本身的owner与CREATE检查仍保留。有效角色先取当前角色及session_user可SET的起点，再并入每个起点可USAGE的角色，覆盖先切换再继承的权限；特殊属性仅核可SET起点。ACL函数由实际可SET起点调用，让PostgreSQL计算其继承权限，避免把不可SET角色的SUPER属性当成可用ACL；owner仍核完整集合。完整集合拒绝全部`pg_*`预定义角色（含只读/监控组）及任一直接ADMIN OPTION（包括普通DML组管理权），不能沿纯MEMBER链误判。完全隔断、无ADMIN的成员关系仍允许。Web不会接受这些DDL、建库或预定义管理能力，普通自建DML组成员关系仍可使用；不审计其它数据库或任意SECURITY DEFINER函数体。使用现有公共数据库工厂创建标准原生Pool，Auth的Drizzle对象与配对service共享这一Pool；连接最多10个，获取1秒、statement/query 3秒、lock 1秒、idle transaction 5秒。PostgreSQL URL必须显式指定凭据、host和database，不接受query形式的目标覆盖；未写port固定5432。URL的超时、options和pipeline覆盖被移除，受控超时及非空固定options写入最终URL，`PGOPTIONS`不能放宽这些预算。 TLS仅从URL的已知`sslmode`取值配置，缺省保持原生驱动的无TLS默认值；本能力拒绝`sslcert`／`sslkey`／`sslrootcert`路径，因为驱动同步文件读取不受连接计时器约束。`PGBINARY`、`PGSSLMODE`、`PGSSLNEGOTIATION`、`PGCLIENT_ENCODING`、`PGREPLICATION`须不存在；最终URL固定UTF8、普通非replication连接及postgres TLS握手，防止后续Client读取漂移的环境值。这些约束不改变独立legacy CLI的旧驱动行为。

## 开发最终树发布与计划收口

FS-29 只聚合证据，不增加产品行为。开发态收口使用同一 HTTP simulator、FSM-05 已验交接版本、run-owned 隔离 PostgreSQL、Web/worker/collab fixture 和双模式浏览器门；真实 Feishu provider、真实 tenant、canary callback、production deployment 与 LIVE-FS-01..03 均明确保持 `DEFER-FS-03`，不把 simulator 或缺失的 CI/live 结果标成上线成功。

本次最终树本地证据如下：`pnpm turbo run typecheck lint build` 37/37 通过，依赖方向守卫报告 1161 modules / 4638 dependencies，文档链接 53/53 通过；`NODE_OPTIONS=--import=tsx pnpm exec playwright test --config=playwright.enterprise.config.ts --workers=1 --trace=off` 7/7 通过，legacy 配置同命令 1/1 通过；FS-27 `cutover.integration.test.ts` 3/3 无 skip，FS-53 conversion 2/2、FS-52 ready-check 6/6 和 FSM-05 交接证据保持。完整 `pnpm vitest run` 已实际执行，但当前环境仍有既有数据库连接、owned Web/worker 超时、provenance/exports/secret guard 与资源竞争失败（35 files / 307 passed / 2 skipped；20 failed / 2668 passed / 181 skipped），不归因于本卡且不等待 GitHub Actions。

恢复规则：停止受影响企业操作、保持 maintenance 或当前持久 marker，修复后用新提交和新 operation 前滚；不倒签验收、不删除 user/identity/actor/ACL 历史、不把 `AUTH_MODE=legacy` 当作已激活策略的恢复路径。每次本地运行只清理本 run 登记的 Web、进程、Mock、SMTP、PG、临时副本和对象存储资源；清理失败必须保留 `cleanup-pending` 并报告，不能删除其它 run 资源。FS-27提交 `a81e01fb3bc0f6f9c26a3803edab3422d27a376b` 与 FS-29主收口提交 `f933f2b0a5ecc0b66dc5830611846745e228c329` 均带 DCO/gpgsig 并已推送；随后证据镜像同步提交 `7f5992231c969e4e73b753edaccb528336b68617`、ref纠偏提交均保持同一main链，并在每次推送后由 `libra status` 核对本地与远端精确同步；main CI 不在本轮等待范围。

同JS realm的初始化Promise、Auth、Pool、配对能力与私有配置摘要一起保存在稳定的全局registry中。实际Next不同bundle及HMR只能复用同一配置／装配协议；已观察到配置变化、初始化失败或关闭后不能通过清除scope恢复legacy，也不能在同进程重新创建装配。修正配置后须重启宿主。密钥和配置快照不进入HTTP输出、日志或客户端代码。

初始化总期限10秒。显式 `closeEnterpriseWebRuntime()` 先同步封闭getter及捕获的配对入口，只执行一次Pool关闭，并等待已知连接的实际end/remove责任。五秒内完成返回 `closed`；失败或超期返回并永久保留 `cleanup-pending`，迟到清理不会把先前失败改写为成功。标准Pool没有任意故障下的强制全连接回收接口；`cleanup-pending`由拥有该Next进程的宿主停止进程、等待真实退出，再核对应PG backend消失及未提交事务回滚。Next自己的信号退出不等于它会等待任意应用async signal listener，退出码也不承诺为零。

本卡测试使用具名safe Vitest配置、隔离源副本与FS-57数据库，管理观察连接和Web DML角色分离。真实App／Pages探针、注释触发的HMR和关闭探针仅写入测试副本；未修改产品的零数据库连接构建与含探针构建分开验证。三个旧mint helper及直接SSE消费者必须从副本cwd和合成环境执行，因为它们自身会尝试读取 `apps/web/.env`；不能只靠safe Vitest配置替代源副本隔离。
