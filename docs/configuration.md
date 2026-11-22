# 配置参考

本文列出 megaui 使用的环境变量。完整的带注释样例见仓库根目录的 [`env.example`](../env.example) 与 [`.env.test.example`](../.env.test.example)；复制 `env.example` 到 `apps/web/.env`（或仓库根 `.env`）后按需修改。企业身份相关变量的详细合同见 [企业身份：配置合同](./implementation/enterprise-auth.md)。

## 环境变量表

| 变量 | 必需 | 用途 |
|---|---|---|
| `APP_BASE_URL` | 是 | 应用对外 URL |
| `BETTER_AUTH_URL` / `BETTER_AUTH_SECRET` / `BETTER_AUTH_TRUSTED_ORIGINS` | 是 | Better Auth |
| `DATABASE_URL` | 是 | Postgres（联调栈库名 `megaui`；mega2 后端使用独立 `mega2` 库） |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 否 | Google OAuth |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 否 | GitHub OAuth |
| `EMAIL_PROVIDER` | 是 | Better Auth 邮件：仅 `test` / `smtp` / `resend`；缺失、空白或未知值 fail-closed，无默认值 |
| `EMAIL_DEFAULT_FROM` | 是 | Better Auth 发件人；缺失或空白 fail-closed，无 `noreply@example.com` fallback |
| `SMTP_HOST` / `SMTP_PORT` | 当 `EMAIL_PROVIDER=smtp` | host 必填；port 必须是 `1..65535` 的十进制整数。`test` / `resend` 下忽略 |
| `SMTP_USER` / `SMTP_PASS` | 当 `EMAIL_PROVIDER=smtp` | 必须成对非空，或都空以省略 auth。`test` / `smtp` 下忽略 |
| `RESEND_API_KEY` | 当 `EMAIL_PROVIDER=resend` | 必填。`test` / `smtp` 下忽略 |
| `MEGA2_PUBLIC_BASE_URL` / `MEGA2_INTERNAL_MAIL_BEARER` | 联调 | mega2 |
| `S3_*` | 上传 | S3 兼容对象存储 |
| `MEGA_COLLAB_INTERNAL_URL` / `MEGA_COLLAB_INTERNAL_TOKEN` | 协作 | collab 内网 + ticket HMAC |
| `ENTERPRISE_COLLAB_REVOKE_KEY` | 企业协作 | 独立 revoke service credential；不回退 ticket secret |
| `NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL` | 协作 | 浏览器 WS |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | Agent | OpenAI-compatible |
| `AUTH_MODE` | 否 | 认证模式：仅 `legacy` / `enterprise`；缺省或空白按 `legacy`。由 `@megaui/core` 的 `resolveAuthMode` 解析，Web 与 collab 启动时校验：`maintenance` 与未设置 `AUTH_PROVIDER` 的 `enterprise` 以 `INVALID_AUTH_PROVIDER` 拒绝启动（FSL-132）；其它取值在提供方合法时于 Web 以 `INVALID_AUTH_MODE` 拒绝启动（提供方非法时先以 `INVALID_AUTH_PROVIDER` 拒绝），collab 先按自身规则以 `EnterprisePolicyError` 拒绝 |
| `AUTH_PROVIDER` | 否 | 认证提供方。规则由 `@megaui/core` 的 `resolveAuthMode`（FSL-116）定义：`AUTH_MODE=enterprise` 时必须为 `feishu`（飞书邮箱验证码登录），`AUTH_MODE=legacy` 时缺省或为 `local`；非法的 `AUTH_PROVIDER` 取值或不允许的组合（含 `enterprise` 不设提供方与任何 `maintenance`）以 `INVALID_AUTH_PROVIDER` 拒绝（先校验提供方），提供方合法而 `AUTH_MODE` 为其它值时以 `INVALID_AUTH_MODE` 拒绝。Web（会话入口、认证实例与启动钩子）与 collab 读取该键，见 [飞书邮箱验证码登录 · 配置](./implementation/feishu-login.md#配置) |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书登录 | 飞书应用凭据，Web 只在飞书模式下读取（`readFeishuLoginConfig`），完整合同见 [飞书邮箱验证码登录 · 配置](./implementation/feishu-login.md#配置)。Web 不再读取 `FEISHU_TENANT_KEY` 与飞书事件回调的密钥（FSL-132 删除了回调入口） |
| `ENTERPRISE_OTP_HMAC_KEY` | 飞书登录 | 飞书邮箱验证码登录的 HMAC 密钥：恰为 32 字节的规范 base64url 编码（43 个字符、无填充），验证码、邮箱与身份绑定（`open_id_hmac`）的 HMAC 共用，以用途标签区分；完整合同见 [飞书邮箱验证码登录 · 配置](./implementation/feishu-login.md#配置)。**不可轮换（FSL-161）：** 飞书登录首次检查时把以该密钥对 `FEISHU_APP_ID` 计算的 HMAC 指纹写入 `feishu_login_key_check`；此后该密钥或 `FEISHU_APP_ID` 任一变化（新配置随进程重启加载），到达该检查的飞书登录 request 与 verify 持续返回 503 `{ "status": "unavailable" }`（输入非法的 400 与限流的 429 仍先于它返回）并输出 `FEISHU_LOGIN_KEY_MISMATCH`。不支持轮换该密钥或更换应用，也不提供身份迁移；唯一恢复方式是由运维恢复原密钥与原 `FEISHU_APP_ID`，不得通过清空 `feishu_identities` 或 `feishu_login_key_check` 绕过该检查（见 [飞书邮箱验证码登录 · 密钥一致性检查](./implementation/feishu-login.md#密钥一致性检查)）。**当前状态：** 飞书登录端点由 FSL-150 接入 Web，在此之前没有部署运行该检查 |

> **弃用声明（plan-20261118，ADR-FSL-13）：** 现有企业模式已弃用，弃用范围：`AUTH_MODE=maintenance`、未设置 `AUTH_PROVIDER` 的 `AUTH_MODE=enterprise`、企业认证接口 `/api/auth/enterprise/*`（配对登录与企业 OTP）、飞书事件回调、内部资格接口、collab 企业撤销接口、企业 worker 任务与通讯录同步、admin CLI，以及 20 张 `enterprise_*` 表与 `session` 的企业列。现有企业模式由飞书邮箱验证码登录（`AUTH_MODE=enterprise` + `AUTH_PROVIDER=feishu`）取代。自 FSL-132 所在版本起，`AUTH_MODE=enterprise` 但未设置 `AUTH_PROVIDER`、以及 `AUTH_MODE=maintenance` 都以 `INVALID_AUTH_PROVIDER` 拒绝启动，Web 的企业配置与接线（企业运行期装配、企业认证接口、飞书事件回调、内部资格接口、企业登录表单与目录托管资料界面）已删除；其余企业实现由后续版本删除。新配置见 [飞书邮箱验证码登录 · 配置](./implementation/feishu-login.md#配置)。

`AUTH_MODE` 由所有进程共享。Web 只经 `@megaui/core` 的 `resolveAuthMode` 解析它与 `AUTH_PROVIDER`（纯函数，不读环境、不持 secret）；collab 先按自身规则检查 `AUTH_MODE` 的取值（未知取值以 `EnterprisePolicyError` 拒绝），再以 `resolveAuthMode` 判定组合。被拒绝的组合在两者中都拒绝启动；客户端可见配置白名单之外的键默认 server-only。

企业 worker 与管理员 CLI 已删除（FSL-137）：`@megaui/engine` 不再提供 `enterprise:worker`、`enterprise:admin` 与 `enterprise:approve` 脚本，也不再导出企业服务（资格、配对、事件、目录对账、通知、保留期清理、离职与协作撤销）；这些进程读取的 worker 与管理员配置不再有任何读取方。飞书邮箱验证码登录不需要常驻 worker 或管理员命令，见[飞书邮箱验证码登录](./implementation/feishu-login.md)。

以下企业表的段落只描述仍保留的表结构：写入、读取或清理这些表的 engine 企业服务、企业 worker 与管理员 CLI 已由 FSL-137 删除，这些表不再被写入。唯一仍在的读取是 Web 飞书会话的 Mega2 主体冲突检查（`apps/web/lib/mega2-session.ts`）对 `enterprise_profile.backend_username` 的只读联表，由 FSL-139 随企业数据库代码一并删除；表本身由 FSL-168 删除。

企业登录存储已新增配对、challenge、共享预算和加密DM四张表：配对token与flow只存摘要，HMAC可在恢复期后清除并保留消费元数据，DM绑定原challenge期限且每generation唯一；写入这些表的配对申请、发码与投递服务已随企业服务删除（FSL-137），删表见 FSL-168。字段与恢复边界见[配对challenge与加密投递schema](./implementation/enterprise-auth.md#配对challenge与加密投递schema)。

服务端 `@megaui/auth` 提供8位字母数字码生成和秘密封装：CSPRNG整样本拒绝确保每码同时含字母与数字；独立HMAC摘要与AES-256-GCM投递密文都绑定完整身份、flow、版本和期限，错key或篡改返回拒绝。工厂不读取环境或数据库，密码验证本身不代表当前资格、未过期或未消费；输入规范化和登录事务由后续任务接线。密钥注入、封装协议及轮换步骤见[验证码生成与秘密封装](./implementation/enterprise-auth.md#验证码生成与秘密封装)。

包内输入助手已实现验证码的严格ASCII规范化：原输入最多1024个UTF-16码元，仅去除两端六种ASCII空白并转大写，再复用同一规范码谓词；内部空白、Unicode相似字符、纯数字或纯字母均拒绝。登录名保持原样，必须为3..64位ASCII小写字母、数字及允许的符号，首位只能是字母或数字。函数返回字符串或 `null`，供后续本包登录边界接线；规则及测试见[服务端验证码ASCII规范化](./implementation/enterprise-auth.md#服务端验证码ascii规范化)。

配对表追加了 `(scope, deployment_role, retain_until, id)` 复合索引，为固定作用域的有序清理页提供定位；原索引、约束和业务数据保留。迁移失败通过事务回滚后前滚重试。详见[配对清理的作用域复合索引](./implementation/enterprise-auth.md#配对清理的作用域复合索引)。

混合路由下，CL 文件、代码、文档和设置的六个导航消费者会等待完整上下文，避免把未知 search 当作默认可写页面。未知时不准入新写入或导航；已准入复合操作及子组件保存队列保持原生命周期。回归使用本次运行独占的源码副本、PG 和 Next 进程；旧 Roam 图片上传回归另启专属对象存储并验证浏览器解码，详见[混合路由导航兼容](./implementation/enterprise-auth.md#混合路由导航兼容)。

`enterprise_event_inbox` 原用于保存已验证飞书事件的白名单业务字段（event_id 与非空白 IM message_id 分层去重，不保存 raw body、私聊正文或明文 pairing token，pending/lease 各有有界 claim 索引，done metadata 按 TTL 索引清理）。飞书事件回调入口已由 FSL-132 删除，事件接收服务与处理它的 worker 已由 FSL-137 删除，当前没有写入或处理该表的代码，表结构保留到 FSL-168 删表。

目录事实落在 `enterprise_directory_snapshots`（`UNIQUE(scope_hash, generation)`、事务内提交完成标记、`observed_at` 新鲜度索引）、`enterprise_directory_watermarks`（每 scope 当前水位，CAS 拒绝旧 generation）与 `enterprise_directory_identity_watermarks`（每身份最新 generation）三张表上。

飞书 HTTP 传输只使用 FS-87 冻结的 provider 源：不跟随重定向、一次操作 20 秒总预算、临时错误最多 3 次尝试、永久权限错误不重试；服务 token 按 tenant+app 缓存并在过期前 60 秒单飞刷新；错误输出不含 token 或 secret。

后端用户名的永久保留集落在 `enterprise_actor_reservations`：`backend_username` 全实例唯一，记录可不关联当前 identity，隔离主体只能停留在 `reserved`（因此名字不会被释放），同名历史主体标 `ambiguous`，上游原生 actor 标 `unclaimable`，并记录来源快照摘要。

管理员操作与迁移账本落在 `enterprise_admin_operations`（`UNIQUE(operation_id)` 去重重放、记录批准摘要与预期版本、不保存验证码）、`enterprise_batch_checkpoints`（批次绑定 `manifest_digest`）与 `enterprise_quarantine`（每用户一条的持久隔离状态）三张表上。

租约队列与撤销 outbox 落在 `enterprise_jobs`（`UNIQUE(dedupe_key)`、`claim_owner`/`lease_until`、claim 索引支撑有界 `SKIP LOCKED`、`completed_at` 索引支撑 TTL 清理）与 `enterprise_revocations`（`UNIQUE(user_id, auth_epoch)` 幂等键）两张表上，任务与撤销都持久化，不是内存队列。

登录通知 outbox 落在 `enterprise_notification_outbox`：`UNIQUE(grant_id)` 防止同一成功登录重复入队，任务保存 `notification_email` 地址版本和 FS-31 模板字段，不保存 OTP、session token 或 secret；`(state, available_at)` 与 `expires_at` 索引分别支撑有界投递和到期清理。本表本身不发送通知；原先承接投递的 FS-21 对账 worker 与通知服务已随企业 worker 删除（FSL-137），本表不再有写入方或投递方，删表见 FSL-168。

成员、聊天、cls、文档评论、文档、议题与发布的作者及成员资料统一经 `packages/engine/src/services/public-profile.ts` 的公开资料投影生成（FSL-137 起位于该路径）：自 FSL-136 起不再读取企业资料，飞书用户按 FSL-153 的显示名规则、其余用户按 legacy 规则投影，DTO 不包含兼容邮箱或登录邮箱。规则与测试见[飞书邮箱验证码登录 · 公开资料](./implementation/feishu-login.md#公开资料)。

FS-58 的 mega2 通知偏好 adapter 只消费当前 `enabled` 与事件偏好合同。响应中的旧 `email`、
`delivery_mode`、`preferred_locale` 字段会被忽略，更新请求也不会发送这些字段，也不从 session 兼容邮箱补值。原先由 `enterprise_profile.notification_email` 与本地登录通知 outbox 承担的企业登录通知已随通知服务删除（FSL-137）。

数据库目标由 `packages/database/src/enterprise-scope.ts` 守卫：目标必须携带登记的 owner、instance 与 environment，SQL 角色的实际权限不得超出登记范围，陌生目标不会被自动初始化，`db:migrate` 在连接目标前先做预检，预检失败则一次 DDL 都不会发生。

企业身份与通知资料由三张表承载：`enterprise_identity`（外部身份三元组与本地用户的绑定，唯一约束 `tenant_key+app_id+open_id` 与 `local_user_id+tenant_key+app_id`）、`enterprise_profile`（租户内唯一的 `login_name`、实例内唯一的不可变 `backend_username`、可空且不参与唯一约束的 `notification_email`）与 `enterprise_policy`（实例归属与单调激活水位 `auth_epoch`）。三张表都继续引用原 `user.id`。

测试用的 Postgres 由 `packages/database/src/test-support/isolated-pg.ts` 隔离器独占：它在本次运行内创建带 run_id 标签的独立容器与一次性数据库，不读 `DATABASE_URL`，只销毁本次运行登记的资源；迁移一致性因此由隔离器证明，而不是拿环境里的数据库跑。

企业密钥的残留由 `scripts/check-enterprise-secrets.sh` 守卫：它持有企业密钥的单一清单，生产面不得给这些 key 赋值，样例文件只能放占位前缀，命中或扫描工具出错都以非零退出，失败输出只报 `文件:行:key`、不回显被检查的值；CI 在 `Enterprise secret guard` 步骤真实执行它。

provider 的准入与唯一目标同样由 `@megaui/core` 的 `admitProvider` 拥有：启用该能力时必须显式选择 `feishu`（源固定官方 `https://open.feishu.cn`）或 `simulator`（仅可信 development/test 部署角色与 `NODE_ENV`，源只接受独立 Mock 合同的精确 loopback origin）；结果是冻结的单目标，没有备用 provider，也没有失败后切源的能力，请求参数不能覆盖 provider 或源。

完整注释清单见 [`env.example`](../env.example)。

旧内部通知邮件路由（`/api/internal/notifications/email`）只在 `AUTH_MODE=legacy` 保留，继续要求
`MEGA2_INTERNAL_MAIL_BEARER`，并拒绝 `identity.invalid` 兼容地址和未知认证事件。飞书模式（以及
`resolveAuthMode` 拒绝的组合）对该退场路由固定返回 HTTP 410；不会重启 mega2 邮件或从兼容邮箱推导通知地址。

FS-90 新增完整 actor 库存快照表：每个 policy scope 保留批准操作、源文件与归属摘要、观测时间及上游归属数组，支持空库存；数据库约束 UUID、摘要格式与有限时间。迁移失败可回滚 DDL/journal 后前滚重试，旧 actor 保留行不变。原先写入与核对该表的 FS-70 库存扫描、封存与覆盖检查及其管理员命令已随企业服务与管理员 CLI 删除（FSL-137），该表不再有写入方，删表见 FSL-168。

## CI 守卫工具

quality 在安装项目依赖前，通过 `scripts/install-ci-ripgrep.sh` 取得官方 ripgrep 15.1.0 Linux x86_64 归档并验证固定 SHA-256，再供后续秘密与品牌守卫使用。安装不依赖 APT；下载最多45秒，整个步骤最多2分钟，任何失败都会阻止后续步骤。已有类型、构建、lint、全量测试、Mock E2E及守卫保持。来源、临时目录与失败恢复见[CI守卫工具与恢复](./implementation/enterprise-auth.md#ci守卫工具与恢复)。
