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
| `AUTH_MODE` | 否 | 认证模式：仅 `legacy` / `enterprise` / `maintenance`；缺省或空白按 `legacy`，其它取值构建失败 |
| `AUTH_PROVIDER` | 否 | 认证提供方。规则由 `@megaui/core` 的 `resolveAuthMode`（FSL-116）定义：`AUTH_MODE=enterprise` 时为 `feishu`（飞书登录）或在过渡期缺省（仍走现有企业实现），`AUTH_MODE=legacy` 时缺省或为 `local`，`AUTH_MODE=maintenance` 在过渡期只接受缺省；非法的 `AUTH_PROVIDER` 取值或不允许的组合以 `INVALID_AUTH_PROVIDER` 拒绝（先校验提供方），提供方合法而 `AUTH_MODE` 为其它值时以 `INVALID_AUTH_MODE` 拒绝。过渡期（至 FSL-131）允许的「`enterprise` 不设提供方」与「`maintenance`」自 FSL-132 起拒绝。**当前尚无进程读取该键**：由 FSL-121、FSL-126、FSL-128 接入后生效，飞书登录由 FSL-150、FSL-131 启用 |
| `FEISHU_TENANT_KEY` / `FEISHU_APP_ID` | 飞书 callback | v2 业务信封必须精确匹配的 tenant 与 app 标识 |
| `FEISHU_EVENT_VERIFICATION_TOKEN` / `FEISHU_EVENT_ENCRYPT_KEY` | 飞书 callback | URL/业务信封 token 校验，以及 raw wire 签名与 AES-256-CBC 解密；仅从部署 secret store 注入 |
| `ENTERPRISE_OTP_HMAC_KEY` | 飞书登录 | 飞书邮箱验证码登录的 HMAC 密钥：恰为 32 字节的规范 base64url 编码（43 个字符、无填充），验证码、邮箱与身份绑定（`open_id_hmac`）的 HMAC 共用，以用途标签区分；完整合同见 [飞书邮箱验证码登录 · 配置](./implementation/feishu-login.md#配置)。**不可轮换（FSL-161）：** 飞书登录首次检查时把以该密钥对 `FEISHU_APP_ID` 计算的 HMAC 指纹写入 `feishu_login_key_check`；此后该密钥或 `FEISHU_APP_ID` 任一变化（新配置随进程重启加载），到达该检查的飞书登录 request 与 verify 持续返回 503 `{ "status": "unavailable" }`（输入非法的 400 与限流的 429 仍先于它返回）并输出 `FEISHU_LOGIN_KEY_MISMATCH`。不支持轮换该密钥或更换应用，也不提供身份迁移；唯一恢复方式是由运维恢复原密钥与原 `FEISHU_APP_ID`，不得通过清空 `feishu_identities` 或 `feishu_login_key_check` 绕过该检查（见 [飞书邮箱验证码登录 · 密钥一致性检查](./implementation/feishu-login.md#密钥一致性检查)）。**当前状态：** 飞书登录端点由 FSL-150 接入 Web，在此之前没有部署运行该检查 |

> **弃用声明（plan-20261118，ADR-FSL-13）：** 现有企业模式已弃用，弃用范围：`AUTH_MODE=maintenance`、未设置 `AUTH_PROVIDER` 的 `AUTH_MODE=enterprise`、企业认证接口 `/api/auth/enterprise/*`（配对登录与企业 OTP）、飞书事件回调、内部资格接口、collab 企业撤销接口、企业 worker 任务与通讯录同步、admin CLI，以及 20 张 `enterprise_*` 表与 `session` 的企业列。弃用窗口期间（FSL-116 起共 33 个双仓版本）旧企业路径保持可用。现有企业模式将由飞书邮箱验证码登录（`AUTH_MODE=enterprise` + `AUTH_PROVIDER=feishu`）取代。自 FSL-132 所在版本起，`AUTH_MODE=enterprise` 但未设置 `AUTH_PROVIDER`、以及 `AUTH_MODE=maintenance` 都将以配置错误拒绝启动，之后的版本删除现有企业实现。新配置见 [飞书邮箱验证码登录 · 配置](./implementation/feishu-login.md#配置)。

`AUTH_MODE` 由所有进程共享：`enterprise` 缺少当前能力必需配置时拒绝启动，部署持有持久激活标记时拒绝 `legacy`。解析器在 `@megaui/core` 内是纯函数（不读环境、不持 secret），客户端可见配置白名单之外的键默认 server-only；见[企业身份配置合同](./implementation/enterprise-auth.md)。

标准 Next Node 启动现在先等待企业 Web 装配预检：显式 scope 必须对应现有 policy 和实际 DML 数据库角色，未声明 scope 的 legacy 也会检查数据库尚未激活企业认证。企业 Auth 与配对能力共享已验证的标准 Pool；重复启动和 HMR 复用整套装配，配置变化须重启。仅 enterprise 模式要求独立 IP 摘要密钥、显式代理 CIDR 数组和固定登录 origin；配对 HTTP 端点仍由后续任务交付。关闭超过五秒会返回 `cleanup-pending` 并永久停止准入，由宿主 owner 完成进程退出及数据库连接清理，不能直接重试初始化。独立 legacy CLI 的同步 getter 边界及恢复步骤见[Web企业启动与恢复](./implementation/enterprise-auth.md#web企业启动与恢复)。

目录对账由 durable job 每 5 分钟执行：job 不保存 provider credential；只有 numeric `code === 0`、合法 `data.items`、明确 boolean `has_more`、runtime 类型正确的成员字段、完整且不重复/循环的续页 token 构成的全部同 scope 分页才进入数据库事务，畸形 HTTP 200 或 cursor 循环都按不完整快照零写入。generation 原子 CAS 后，snapshot 元数据的 `member_count`按全部 provider 成员计算，但不持久化逐成员快照投影；只有 `activated=true, frozen=false, resigned=false, exited=false` 的成员推进身份水位。权限缩小由 job 持续携带旧 scope，直到完整快照 applied 后从旧水位产出 `out_of_scope`；失败分页保留上一完整快照。15 分钟陈旧身份不能取得资格，旧 generation 不能恢复 active，冻结/离职成员因身份与 scope generation 不一致而 fail-closed；目录恢复不覆盖本地 ban，也不授予本地 admin 权限。

统一资格服务由 server-only factory 固定 tenant/app、批准部门、policy scope、已解析 `AUTH_MODE`、数据库/provider reader 与 clock，调用方只能使用 `directoryAdmission(openId)` 或 `authenticationEligibility(localUserId, identityId, epoch)`。前者只在管理员准备流程通过固定源精确读取单成员，严格要求 numeric `code === 0`、合法 `data.user`、open_id 回显、批准部门及 active 四状态位，不缓存成员资格；后者每次只用一条 PostgreSQL statement snapshot 读取精确绑定、local ban、policy、identity/scope 水位与同 generation 完整快照，不调用 provider。只有目录 observation 不在未来且不超过 15 分钟、epoch 匹配、无 active ban 且 env/policy 组合得到 enterprise 时批准；PostgreSQL `timestamptz` 的正负 infinity 按显式 `banned` 标志与到期边界处理，未 ban 用户不会因遗留 infinity 单独被拒绝。缺失、歧义、畸形或读取错误均 fail-closed，错误不回显 provider body、token、secret 或成员私密字段。

管理员写命令通过 `pnpm --filter @megaui/engine run enterprise:admin -- <verb>` 进入。进程只持有 `ENTERPRISE_APPROVAL_PUBLIC_KEY`，不能从审批文件替换验签公钥。共同参数、未知或重复 flag 在 handler 前校验；审批签名、verb、target、operation id、manifest、时效和 payload digest 使用同一个 RFC 8785 规范化函数，任一不符都拒绝。输入文件只读取一次。带文件参数的命令需要本机 `python3`：它从 `/` 逐级以 `O_NOFOLLOW` 打开并持有原描述符读取；没有 `python3` 时命令以依赖失败退出，而不是当成审批摘要错误。当前已交付写 verb 为 `maintenance`、`reserve-actors`、`provision`、`apply`、`convert`、`activate`、`quarantine` 和 `repair`。`maintenance`：首次把持久 policy 转为 maintenance 时递增 `auth_epoch`，后续 maintenance 不再递增且不清除 activation 标记；相同 operation/payload 重放原始结果，不同 payload 拒绝。`convert` 只在 maintenance、全run已完成绑定且通过完整 manifest/digest 与签名 `--batch-number` 时执行，每批最多100行；它保留 user.id、profile/identity 外键、ACL、display/backend 字段，将原框架邮箱写入独立 `notification_email`（已有通知地址优先）后置为兼容键，失败按 checkpoint 前滚重试。`activate` 只允许可信 development/test 目标，在同一批准事务中重跑当前 ready-check、核验迁移 run 全部 converted 后，将 policy 固定为 enterprise、递增 `auth_epoch` 并删除全部旧 session；production/canary 在业务写入前拒绝，enterprise 标记不能回退为 legacy。生产 dispatch 表的只读位为已交付 `preview` 与 `ready-check`，所有写 verb 必须经受控 capability 接入 approval/scope/epoch/operation 事务，未交付或未注册的 verb 不会被执行，审批正文和密钥不进入输出。

历史映射可用 `enterprise:admin -- preview --target <instance> --manifest /absolute/path/migration.json --out /absolute/path/report.json` 只读预检。它要求可信 admin/test scope 和 tenant/app，但不要求写审批或 provider secret；完整清单最多10 MiB/10,000行，以显式local_user_id定位，在一个数据库一致只读快照中核验全部actor库存及绑定。报告仅含行号、固定冲突键、计数和可批准的规范摘要；有冲突时退出3且摘要为空，输出文件以0600排他新建。字段、版本计算与恢复规则见[历史映射preview命令](./implementation/enterprise-auth.md#历史映射preview命令)。

迁移前置可用 `enterprise:admin -- ready-check --target <instance> --manifest /absolute/path/bindings.json --digest <sha256> --out /absolute/path/ready.json`。该命令只允许 development/test，在强制 `REPEATABLE READ READ ONLY` 事务中核对完整 actor 库存、quarantine、目录 generation/15分钟新鲜度、worker 与双 collab epoch；它不调用 provider、不写 policy 或 operation 账本。成功输出目标 fingerprint 与就绪摘要，冲突退出3，报告文件0600排他创建；配置/输入错误退出2，依赖错误退出4。运行实例由 `ENTERPRISE_WORKER_READY=1` 和两个相同的 `ENTERPRISE_COLLAB_POLICY_EPOCHS` 显式声明，真实生产 callback proof 仍按延期门处理。详情见[ready-check审批前置合同](./implementation/enterprise-auth.md#ready-check审批前置合同)。

迁移阶段账本通过内部 `createMigrationLedger` 接口固定初始批准摘要，并在同一个已批准事务中记录每批最多100行的合法后态和 checkpoint。后续批次核对整个迁移 run 的当前后态，外部资料或归属变化会拒绝继续；第二批失败不撤销已提交第一批。全部成员完成转换后才通过激活前置检查。`convert` 与 development/test `activate` 已接入统一审批事务；activate 会在写入前重跑目录/actor/worker/collab ready-check，并在同一事务中递增 epoch、撤销旧 session 和固化 enterprise 标记。production/canary 激活仍由 DEFER-FS-03 承接；调用与恢复合同见[迁移审批digest与阶段水位协议](./implementation/enterprise-auth.md#迁移审批digest与阶段水位协议)、[维护窗口兼容键转换](./implementation/enterprise-auth.md#维护窗口兼容键转换)及[sticky activation命令](./implementation/enterprise-auth.md#sticky-activation命令)。

`enterprise:admin -- apply` 已支持通过签名审批预绑定历史账号：提交完整原清单、preview规范摘要和必填 `--batch-number`（0起始），每次最多100人。仅核选中成员的目录准入，legacy下保留原用户ID、邮箱、角色、账号和会话；新profile保留原显示名且通知邮箱为空。成功v3 JSON的 `applied` 按完整清单行号返回原ID，并随业务绑定/checkpoint原子持久化；同operation重放无需provider配置或网络。参数、重放和失败恢复见[历史映射apply命令](./implementation/enterprise-auth.md#历史映射apply命令)。

管理员写事务先核验签名、部署 scope 与 epoch，再在同一个 PostgreSQL 事务中写入业务和 operation 账本。同一 operation 与 payload 的重放返回首次结果，不同 payload 拒绝；handler 失败使业务和账本共同回滚，可以安全重试。审批正文和密钥不进入输出。

历史主体可通过受审批的 `quarantine` 持久隔离，并以显式映射的 `repair` 修复。两者清单最多1 MiB/100行，以完整严格数组的 JCS SHA-256批准，user版本使用FS-37原用户SHA；repair同时绑定identity版本、profile摘要及当前quarantine operation。修复前先批准`reserve-actors`重封存库存；修复保留原user/session/角色、冻结actor/显示名/通知地址，重新读取目录准入并清除旧身份水位，之后必须完整目录对账才能恢复资格，maintenance仍拒绝登录。释放后再次批准库存封存并重新preview。私有逐行审计仅留数据库，公开输出保持v1计数。操作顺序和边界见[隔离与受控修复](./implementation/enterprise-auth.md#隔离与受控修复)。

管理员 CLI 写命令的正常成功输出是单行 JSON，固定含 `schemaVersion`、`operationId`、`policyEpoch`、`resultCounts` 与 `replayed`；失败只把稳定错误键写到 stderr。输入错误（包括未知 verb）退出 `2`，审批/scope/epoch 冲突退出 `3`，临时依赖失败退出 `4`。离线签发前可用 `--emit-approval-request --out /absolute/path/request.json` 生成未签名、无秘密的规范请求：它不要求现成审批、不调用写 handler，并在 PostgreSQL read-only transaction 完成 scope guard 后才排他创建该文件。审批方随后在独立进程以 `enterprise:approve` 重新计算 request 的 JCS digest、使用本机 Ed25519 私钥生成一个 bundle；该进程不加载 DB 或网站环境，成功输出只含非秘密元数据，目标端只以公钥验签。详情及恢复边界见[企业身份配置合同](./implementation/enterprise-auth.md)。

企业登录存储已新增配对、challenge、共享预算和加密DM四张表：配对token与flow只存摘要，HMAC可在恢复期后清除并保留消费元数据，DM绑定原challenge期限且每generation唯一；申请服务见下文，HTTP、发码、发送和验证由后续任务交付。字段与恢复边界见[配对challenge与加密投递schema](./implementation/enterprise-auth.md#配对challenge与加密投递schema)。

服务端 `@megaui/auth` 提供8位字母数字码生成和秘密封装：CSPRNG整样本拒绝确保每码同时含字母与数字；独立HMAC摘要与AES-256-GCM投递密文都绑定完整身份、flow、版本和期限，错key或篡改返回拒绝。工厂不读取环境或数据库，密码验证本身不代表当前资格、未过期或未消费；输入规范化和登录事务由后续任务接线。密钥注入、封装协议及轮换步骤见[验证码生成与秘密封装](./implementation/enterprise-auth.md#验证码生成与秘密封装)。

包内输入助手已实现验证码的严格ASCII规范化：原输入最多1024个UTF-16码元，仅去除两端六种ASCII空白并转大写，再复用同一规范码谓词；内部空白、Unicode相似字符、纯数字或纯字母均拒绝。登录名保持原样，必须为3..64位ASCII小写字母、数字及允许的符号，首位只能是字母或数字。函数返回字符串或 `null`，供后续本包登录边界接线；规则及测试见[服务端验证码ASCII规范化](./implementation/enterprise-auth.md#服务端验证码ascii规范化)。

内部匿名配对预算服务在同一 PostgreSQL 事务内扣减每IP十分钟30次预算、检查每flow一个及全scope/role一万个pending，并验证配对写入后提交；饱和统一返回429。只信任批准代理链，数据库仅保存按UTC日派生的IP HMAC摘要；轮换master前须停匿名申请至少10分钟。借用Pool须符合有界获取合同，连接/锁/SQL/事务分别限制1/1/3/5秒；HTTP真实peer由后续FS-73接入。调用、告警和恢复边界见[匿名配对预算与IP隐私](./implementation/enterprise-auth.md#匿名配对预算与ip隐私)。

配对表追加了 `(scope, deployment_role, retain_until, id)` 复合索引，为固定作用域的有序清理页提供定位；原索引、约束和业务数据保留。迁移失败通过事务回滚后前滚重试。详见[配对清理的作用域复合索引](./implementation/enterprise-auth.md#配对清理的作用域复合索引)。

匿名申请服务已由 `@megaui/engine` 的 `createEnterprisePairingService` 提供：同事务提交后才返回同形202、256bit随机token及120秒期限，未知登录名也走相同响应；不调用provider、不发送DM、不扣身份发码预算。包内auth边界复用唯一登录名解析器并产生安全preauth Cookie描述符，FS-73以唯一Node Pages入口接入真实socket peer、有限传输和实际Set-Cookie；FS-83追加同flow `POST /api/auth/enterprise/status`，只返回pending/confirmed/expired及不透明challengeId，跨flow/deployment拒绝且不回显token、OTP或目录字段；FS-75提供可信sender原子发码预算，锁定60秒sender间隔、身份10分钟5次及最多3个confirmed flow，无效token只计sender公共桶；FS-76从已验签inbox的摘要投影严格准入本人p2p/user/text指令，绑定sender与当前身份资格，拒绝群聊、机器人、陈旧目录、suspended及本地ban；legacy/maintenance不启用插件，429及失败不设Cookie。标准worker按固定scope/role以每页100条续跑清理，保留已确认配对的390秒恢复窗口；健康worker及可用数据库条件下，过期配对应在五分钟内删除。接口、运行条件和恢复步骤见[匿名配对申请与资源限额](./implementation/enterprise-auth.md#匿名配对申请与资源限额)、[配对request HTTP插件](./implementation/enterprise-auth.md#配对-request-http-插件)、[配对status HTTP合同](./implementation/enterprise-auth.md#配对-status-http-合同)、[可信 sender 发码预算](./implementation/enterprise-auth.md#可信-sender-发码预算)及[Bot 指令准入与当前资格](./implementation/enterprise-auth.md#bot-指令准入与当前资格)。

混合路由下，CL 文件、代码、文档和设置的六个导航消费者会等待完整上下文，避免把未知 search 当作默认可写页面。未知时不准入新写入或导航；已准入复合操作及子组件保存队列保持原生命周期。回归使用本次运行独占的源码副本、PG 和 Next 进程；旧 Roam 图片上传回归另启专属对象存储并验证浏览器解码，详见[混合路由导航兼容](./implementation/enterprise-auth.md#混合路由导航兼容)。

飞书事件只把已验证后的白名单业务字段写入 `enterprise_event_inbox`：event_id 与必须含非空白字符的 IM message_id 分层去重，不保存 raw body/私聊正文/明文 pairing token；pending 与过期 lease 使用各自的有界 claim 索引，租约/完成字段由状态约束守住，只有 done metadata 可按 TTL 索引分页清理。

飞书 callback 入口只有精确的匿名 `POST /api/integrations/feishu/events`；其它方法、尾斜杠和相邻路径仍需 session。入口先以 `X-Lark-Request-Timestamp`、`X-Lark-Request-Nonce`、`X-Lark-Signature` 对不超过 256 KiB 的原始 wire bytes 验签，并拒绝超出 5 分钟的时间戳；可选密文按 `SHA256(encrypt key)` 派生 key，解开 `IV16 || AES-256-CBC ciphertext`。URL verification 仅在 verification token 正确时返回 challenge；业务信封还必须匹配 tenant/app，随后才调用 `acceptVerifiedEvent(getPool(), event)` 并等待事务提交。用户 p2p text 中的 `/login <token>` 只跨边界为小写 SHA-256 摘要；回调 body、私聊正文和明文 token 不记录。配置缺失或任一校验失败均 fail-closed 且不入库；恢复时修正部署 secret/tenant/app 或飞书订阅配置后重试 callback，不要在日志中粘贴请求体或密钥。

`@megaui/engine` 的 `acceptVerifiedEvent` 只接收三个已验证事件类型，在同一事务提交 inbox 与唯一 durable job；event_id 或 IM message_id 重放返回首次提交的同一结果。标准 worker 已注册 Contact/私聊提示与 inbox 清理 handler：默认提示分派按 inbox ID 幂等写入类型化 durable follow-up job，不会因 owner handler 尚未激活而静默丢失；自定义 effect 执行时每 10 秒续租 30 秒 inbox lease，并必须按 inbox ID 幂等。提示处理不从不完整目录读取推断成员缺失；清理按 UTC 小时幂等续排，以 follow-up 唯一 dedupe key 索引排除未完成下游任务，每次最多删除 100 条超过 30 天的 done metadata，不删除 pending/leased 或等待下游消费的行。

企业 worker 是独立常驻进程（`pnpm --filter @megaui/engine run enterprise:worker`）：未声明scope的legacy目标保持claim上限100、handler并发4；scope模式使用两个独立连接池，普通任务并发3/claim100，配对清理并发1/claim1。同一租约单owner，30秒到期可接管；失败job从1秒起指数退避至最多5分钟并保持pending。enterprise/maintenance或声明scope时必须显式配置worker role和获准数据库目标，任何队列写入前核验，不能bootstrap。SIGTERM立即停止两个claim loop，通过独立控制连接取消本run查询并核验连接释放，进程在10秒内退出；取消或清理失败以非零状态和稳定错误键报告。

目录事实落在 `enterprise_directory_snapshots`（`UNIQUE(scope_hash, generation)`、事务内提交完成标记、`observed_at` 新鲜度索引）、`enterprise_directory_watermarks`（每 scope 当前水位，CAS 拒绝旧 generation）与 `enterprise_directory_identity_watermarks`（每身份最新 generation）三张表上。

通讯录快照按授权部门分页读取：快照带 scope_hash 与 generation，只有全部分页成功才标 complete；中断快照不完整，且不完整快照不产出成员缺失判定；目录状态与通知邮箱按各自 schema 校验。

飞书 HTTP 传输只使用 FS-87 冻结的 provider 源：不跟随重定向、一次操作 20 秒总预算、临时错误最多 3 次尝试、永久权限错误不重试；服务 token 按 tenant+app 缓存并在过期前 60 秒单飞刷新；错误输出不含 token 或 secret。

后端用户名的永久保留集落在 `enterprise_actor_reservations`：`backend_username` 全实例唯一，记录可不关联当前 identity，隔离主体只能停留在 `reserved`（因此名字不会被释放），同名历史主体标 `ambiguous`，上游原生 actor 标 `unclaimable`，并记录来源快照摘要。

管理员操作与迁移账本落在 `enterprise_admin_operations`（`UNIQUE(operation_id)` 去重重放、记录批准摘要与预期版本、不保存验证码）、`enterprise_batch_checkpoints`（批次绑定 `manifest_digest`）与 `enterprise_quarantine`（每用户一条的持久隔离状态）三张表上。

租约队列与撤销 outbox 落在 `enterprise_jobs`（`UNIQUE(dedupe_key)`、`claim_owner`/`lease_until`、claim 索引支撑有界 `SKIP LOCKED`、`completed_at` 索引支撑 TTL 清理）与 `enterprise_revocations`（`UNIQUE(user_id, auth_epoch)` 幂等键）两张表上，任务与撤销都持久化，不是内存队列。

登录通知 outbox 落在 `enterprise_notification_outbox`：`UNIQUE(grant_id)` 防止同一成功登录重复入队，任务保存 `notification_email` 地址版本和 FS-31 模板字段，不保存 OTP、session token 或 secret；`(state, available_at)` 与 `expires_at` 索引分别支撑有界投递和到期清理。邮件投递由 FS-21 对账 worker 承接，本表本身不发送通知。

FS-21 的通知 worker 每 60 秒按已提交的 enterprise session/grant 对账补齐 outbox；收件地址只读 `enterprise_profile.notification_email`，为空记 `skipped`，地址版本变化使未发送旧任务失效。sender 失败只重试 outbox，不撤销 session；停用身份、过期 session 或非 enterprise policy 均不会发送待发通知，批次上限为 100。

FS-84 的统一 retention worker 以小时槽续排，每次事务总计最多清理 100 行：完成超过 30 天的 durable job、到期通知 outbox、过期登录预算和恢复窗口已结束且没有 session 引用的 grant；有效 session 永不因 TTL 被删。清理事务失败会回滚并保留 leased job，沿用 worker 的 pending 指数退避重试；匿名 IP 派生摘要缓存只保留当前及前一 UTC 日。

FS-22 的内容作者投影统一使用 enterprise profile 的稳定 `login_name` 和目录显示名，Docs/评论、Issues、CL
不会把 Better Auth 兼容邮箱、通知邮箱或 `backend_username` 放进 DTO。内容仍按原 `user.id` 保持归属，通知地址或
显示名变更不改作者外键；未绑定的历史作者保留兼容展示，未知 ID 保留为不透明占位资料。详见
[内容域用户投影脱离邮箱](./implementation/enterprise-auth.md#内容域用户投影脱离邮箱)。

FS-23 的成员列表、聊天作者和 Release 作者同样复用该 public-profile 投影：成员始终按稳定的
`user.id` 分开，即使多个成员共用 `notification_email` 也不会合并；DTO 不包含兼容邮箱、通知邮箱或
`backend_username`。成员停用后，历史成员与作者仍保留原 `login_name` 和显示资料，便于内容追溯。详见
[成员聊天与Release投影脱离邮箱](./implementation/enterprise-auth.md#成员聊天与release投影脱离邮箱)。

FS-58 的 mega2 通知偏好 adapter 只消费当前 `enabled` 与事件偏好合同。响应中的旧 `email`、
`delivery_mode`、`preferred_locale` 字段会被忽略，更新请求也不会发送这些字段；通知邮箱继续只由
`enterprise_profile.notification_email` 和本地通知 outbox 负责，不从 session 兼容邮箱补值。详见
[mega2 enabled偏好与本地邮件通知分离](./implementation/enterprise-auth.md#mega2-enabled偏好与本地邮件通知分离)。

FS-59 的企业资料页由 `resolveWebActor` 判定目录身份：企业模式禁用显示名、头像文件和头像 URL
编辑，并显示目录资料来源说明；保存操作只更新本地简介，不调用已封禁的 Better Auth `update-user`。
说明提供中英文词条，legacy 模式继续保留原有资料编辑合同。详见
[企业资料编辑入口只读化](./implementation/enterprise-auth.md#企业资料编辑入口只读化)。

FS-24 的设置页从受保护的 `profile-prefs` 投影读取 enterprise
`notification_email`，该地址只读且允许为空；通知偏好仍只通过 mega2 当前的
`enabled`/事件偏好合同更新，不能写入身份绑定。workspace 与协作编辑器使用 public
profile 的显示名/用户名，不再从兼容邮箱回退。详见
[Web资料与通知设置隔离](./implementation/enterprise-auth.md#web资料与通知设置隔离)。

数据库目标由 `packages/database/src/enterprise-scope.ts` 守卫：目标必须携带登记的 owner、instance 与 environment，SQL 角色的实际权限不得超出登记范围，陌生目标不会被自动初始化，`db:migrate` 在连接目标前先做预检，预检失败则一次 DDL 都不会发生。

企业身份与通知资料由三张表承载：`enterprise_identity`（外部身份三元组与本地用户的绑定，唯一约束 `tenant_key+app_id+open_id` 与 `local_user_id+tenant_key+app_id`）、`enterprise_profile`（租户内唯一的 `login_name`、实例内唯一的不可变 `backend_username`、可空且不参与唯一约束的 `notification_email`）与 `enterprise_policy`（实例归属与单调激活水位 `auth_epoch`）。三张表都继续引用原 `user.id`。

测试用的 Postgres 由 `packages/database/src/test-support/isolated-pg.ts` 隔离器独占：它在本次运行内创建带 run_id 标签的独立容器与一次性数据库，不读 `DATABASE_URL`，只销毁本次运行登记的资源；迁移一致性因此由隔离器证明，而不是拿环境里的数据库跑。

企业密钥的残留由 `scripts/check-enterprise-secrets.sh` 守卫：它持有企业密钥的单一清单，生产面不得给这些 key 赋值，样例文件只能放占位前缀，命中或扫描工具出错都以非零退出，失败输出只报 `文件:行:key`、不回显被检查的值；CI 在 `Enterprise secret guard` 步骤真实执行它。

provider 的准入与唯一目标同样由 `@megaui/core` 的 `admitProvider` 拥有：启用该能力时必须显式选择 `feishu`（源固定官方 `https://open.feishu.cn`）或 `simulator`（仅可信 development/test 部署角色与 `NODE_ENV`，源只接受独立 Mock 合同的精确 loopback origin）；结果是冻结的单目标，没有备用 provider，也没有失败后切源的能力，请求参数不能覆盖 provider 或源。

完整注释清单见 [`env.example`](../env.example)。

旧内部通知邮件路由（`/api/internal/notifications/email`）只在 `AUTH_MODE=legacy` 保留，继续要求
`MEGA2_INTERNAL_MAIL_BEARER`，并拒绝 `identity.invalid` 兼容地址和未知认证事件。enterprise
及 maintenance 模式对该退场路由固定返回 HTTP 410；不会重启 mega2 邮件或从兼容邮箱推导通知地址。

FS-90 新增完整 actor 库存快照表：每个 policy scope 保留批准操作、源文件与归属摘要、观测时间及上游归属数组，支持空库存；数据库约束 UUID、摘要格式与有限时间。迁移失败可回滚 DDL/journal 后前滚重试，旧 actor 保留行不变。FS-70 已接入完整扫描封存与覆盖检查，新增同名主体、缺失回执和过期来源均拒绝覆盖；恢复命令见[企业身份实现说明](./implementation/enterprise-auth.md#完整-actor-库存快照-schema)。

FS-71 提供新成员 actor 认领事务 port。可信 factory 固定目录 authority、tenant/app、policy scope 和创建步骤；新成员仅在持久 enterprise 激活、目录准入和完整新鲜库存均通过时创建。每个 READ COMMITTED 事务只接受一次 1–100 成员整批调用；全部准入与创建完成后，统一锁定库存输入直到外层提交，锁等待、SQL 和事务空闲均限制为最多 5 秒。新 actor 为 `mgu_` 加本地 ID 的 SHA-256 前 32 位 hex；alias 不得碰撞历史保留或批内生成 actor。整批 user/identity/profile、永久认领及本地覆盖摘要一起提交或回滚，上游来源与观测时间保持不变；发现其它主体漂移则拒绝。既有 owner 检查只读，支持 maintenance 下核对隔离主体，不释放名字、不授予登录资格。`provision` CLI 已通过 FS-05 接入同一事务和批次 checkpoint。

新成员使用受审批的 `provision --manifest <绝对路径> --digest <原文件SHA-256>` 创建；清单最多1 MiB、1–100人，外部身份必须与可信部署tenant/app和批准部门一致。通知邮箱独立可空，不按邮箱或姓名合并账号，不授予管理员或创建密码/session。仅此命令返回v2行号/本地ID映射；同operation重放返回原ID，不再访问目录。首次执行按能力读取 `FEISHU_DIRECTORY_DEPARTMENT_IDS` 严格JSON数组及固定provider配置，emit/重放不需要provider secret；具体输入、配置与恢复方式见[新成员provision命令](./implementation/enterprise-auth.md#新成员provision命令)。

## CI 守卫工具

quality 在安装项目依赖前，通过 `scripts/install-ci-ripgrep.sh` 取得官方 ripgrep 15.1.0 Linux x86_64 归档并验证固定 SHA-256，再供后续秘密与品牌守卫使用。安装不依赖 APT；下载最多45秒，整个步骤最多2分钟，任何失败都会阻止后续步骤。已有类型、构建、lint、全量测试、Mock E2E及守卫保持。来源、临时目录与失败恢复见[CI守卫工具与恢复](./implementation/enterprise-auth.md#ci守卫工具与恢复)。
