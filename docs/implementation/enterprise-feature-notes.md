# 企业身份功能说明索引

本文汇总企业身份（飞书私聊配对登录）及其周边能力的实现说明，每一项都链接到 [企业身份：配置合同](./enterprise-auth.md) 中的详细章节。内容自项目 README 迁入。

## 飞书 Mock 开发依赖

项目内 Mock 按独立计划逐片交付。当前已提供源码依赖隔离守卫（Mock 生产源码只依赖白名单内的 `node:*` 与本 App 内部模块，其它 apps/packages 不得 import Mock 源码）、`apps/feishu-mock` workspace 骨架、CLI 开发准入 validator、只监听 loopback 的 Mock CLI 与独占 runtime、有界 JSON HTTP 边界（`GET /health`、Host 精确匹配、只接受 `application/json`、未知字段与非法查询拒绝、body 上限 32KiB、body 与 header 读取各有 5 秒预算、冻结的错误码映射，未交付路由一律 404），以及受保护控制面与合成目录（`GET /__mock/state` 只接受本 run 的 admin Bearer、带 Origin 拒绝、不开放 CORS、固定 synthetic 成员与部门）和本 run 的资源注册、reset 与进程生命周期（store 与异步任务只能经注册接口进入运行态，reset 递增 generation、取消在途任务后恢复 synthetic 初态，IPC 通道关闭即 cleanup 退出），以及 tenant token 签发与准入（`POST /open-apis/auth/v3/tenant_access_token/internal` 顶层 legacy 合同、有效期 7200 秒、活跃上限 32 个、到期回收、reset 后旧 token 失效）和 Contact 目录分页读取（`GET /open-apis/contact/v3/users/find_by_department` 需 tenant Bearer，page_size 1..100 缺省 2，游标绑定完整查询、TTL 300 秒、上限 128 个）与 Contact 单人读取（`GET /open-apis/contact/v3/users/:user_id` 需 tenant Bearer 与冻结的两种 ID 类型，未知 open_id 404），以及纯 DM 请求准入 validator（冻结的 text content 结构、文本上限 4096 字符、收件人须在目录快照内、规范载荷固定 receive_id/msg_type/content，不发送消息）与定向 DM 幂等投递（`POST /open-apis/im/v1/messages` 按成员写 inbox，uuid 账本保证同载荷同结果、不同载荷 409、inbox 上限 100），callback 签名与加密 wire codec（冻结 v2 信封、Unix 秒时间戳、随机 nonce、签名覆盖实际 wire bytes、AES-256-CBC 封装与明文模式）与 callback 目的地/投递回执（只投冻结目标、不跟随 redirect、按实际状态判成败、2 秒预算、在途上限 8、事件账本上限 100、投递任务可 abort），p2p 消息事件与 URL 握手（`POST /__mock/messages` 与 `POST /__mock/verify-callback`，随机 challenge 必须原样返回才算通过，可显式选明文模式）成员变更 Contact 事件（`PATCH`/`DELETE /__mock/users/:openId`，先预留事件容量再提交目录，callback 失败不撤回目录事实）有界 provider 故障注入（`POST /__mock/faults`，16 条规则上限、按 target 顺序消费 skip/count、同步 403/429/500）、异步故障受理（timeout 1 秒后 504、disconnect_after_accept 仅在消息落库后断连、reset 取消延迟 timer）、有界事件重放（`POST /__mock/replay` 保留身份与 payload、重生成时间戳与 nonce、不占新容量）、复用 CLI 启动夹具（`startFeishuMock({callbackUrl?})` 按冻结协议直起真实 CLI、双端 port0、15 秒启动预算、stop 只释放本片资源）、逐测 reset 及有界 teardown（reset 先取消旧 callback、stop 成功失败同路径、SIGTERM/SIGKILL 各最多 3 秒并核真实 exit）与 API-only E2E 交接（`playwright.feishu-mock.config.ts` 只收集 `feishu-mock.spec.ts`，quality 实际执行 E2E、独立类型门与交接回执）；控制面的其余写verb与provider 的其余路由仍待后续卡交付，尚不能进行企业身份登录或模拟飞书发送。边界、检查命令与当前能力见[开发说明](./feishu-simulator.md)。

FS-46 的 bot-login 通过 FS-76 与 FS-75 进入同一 sender-budget 事务：只有当前资格有效时才确认 pairing、生成 300 秒 challenge 并写入 expiry 绑定的加密 DM outbox；message_id 重放、预算超额或任一步骤失败都不重复发码，也不创建 session。运维细节见[本人私聊确认后原子发码](./enterprise-auth.md#本人私聊确认后原子发码)。

FS-12 的应用机器人私聊 client 只向服务端绑定的 `open_id` 调用 IM v1，复用 tenant token 单飞缓存并在同一 delivery UUID 下重试；消息正文包含可信登录站点与 `企业登录`用途提示但不进入日志。永久权限错误只尝试一次，超时/断连返回 `unknown`，因此 FS-13 必须沿用原 UUID 而不能再造验证码。详见[应用机器人私聊消息 client](./enterprise-auth.md#应用机器人私聊消息-client)。

FS-13 的密文 DM worker 只消费原 challenge 的 `deliveryId`：投递前复查 lease、challenge TTL、identity version、当前企业资格与 auth mode，最多三次/20 秒并始终复用同一 UUID；过期、已消费、maintenance、资格失败或 provider 永久失败均不发送，也不降级 Email。每分钟有界清理到期密文，五分钟内完成。详见[密文 DM 任务投递与清理](./enterprise-auth.md#密文-dm-任务投递与清理)。

FS-32 的 `enterprise_login_grants` 以唯一 `challenge_id` 保存一次性授权和 90 秒恢复窗；session 的 enterprise grant、identity、epoch、auth method 是 nullable 的 server-only 元数据，旧 session 保持可读，grant 不保存 session token。详见[一次性 grant 与 session 元数据 schema](./enterprise-auth.md#一次性-grant-与-session-元数据-schema)。

FS-36 的 OTP 消费在 PostgreSQL 事务内固定锁定 identity→challenge→grant，重新核对当前资格与 auth epoch；同 flow 90 秒内只恢复原 grant，错误预算按 identity/flow 跨重发共享且最多五次，HMAC 到 recover 窗结束后由每页最多100行的清理清除。详见[验证码消费与错误预算事务](./enterprise-auth.md#验证码消费与错误预算事务)。

FS-14 的 `/enterprise/verify` 通过 Better Auth internal adapter 的 `overrideAll` 创建或读回同一 grant 的 8 小时 session，复用框架 Cookie helper，响应不含 session token，且不改变私聊用户的 `emailVerified`。详见[Better Auth 企业 session 创建与同 flow 恢复](./enterprise-auth.md#better-auth-企业-session-创建与同-flow-恢复)。

FS-40 的双模式 harness 为 enterprise/legacy 各自创建一次性 PostgreSQL 与宿主机 Next dev：源副本不含真实 `.env`，Web 环境只接收白名单，缓存落在本 run，固定 loopback origin 可安全重启，失败和正常结束都只清理本 run 资源。详见[双模式 Web 与 PG 运行隔离](./enterprise-auth.md#双模式-web-与-pg-运行隔离)。

FS-88 在 enterprise Web 上追加同一 FSM-05 Mock、独立 worker、双 collab 与 run-labelled SMTP 组合，仅验证健康、callback URL verification 和有界清理；Mock adminToken 不进入任何服务环境。详见[企业 E2E 辅助进程组合](./enterprise-auth.md#企业-e2e-辅助进程组合)。

FS-89 在上述隔离 Web/PG 上覆盖 enterprise 的真实 HTTP pairing→Mock 私聊→OTP verify→Better Auth Cookie，以及 legacy 的既有 signup/signin Cookie；两条路径都只使用本 run synthetic 数据与有界清理，不直接注入 session。详见[双模式正常 Cookie 流程 fixture](./enterprise-auth.md#双模式正常-cookie-流程-fixture)。

FS-15 让页面中间件、Mega BFF 和 actor adapter 共用 Web 默认受保护资格守卫：enterprise 每次权威读取 server-side session 与 FS-10 当前资格，旧 epoch、停用、数据库故障、maintenance 和不完整装配均 fail-closed；legacy 保留普通 session，Better Auth cookie cache 与 secondary storage 均不启用。详见[Web 默认受保护资格守卫](./enterprise-auth.md#web-默认受保护资格守卫)。

FS-30 将上传、设置、collab ticket、首页 CTA 和 agent/SSE 长流接入同一资格守卫；enterprise ticket 使用冻结 `backend_username`，长流每15秒重验并在30秒预算内停止撤销后的敏感增量。详见[上传设置和长流资格接线](./enterprise-auth.md#上传设置和长流资格接线)。

FS-41 提供精确路径的 enterprise eligibility 内省 API，仅接受独立 `ENTERPRISE_INTROSPECTION_KEY`，按当前数据库资格 fail-closed，不回退 collab ticket secret 或旧 policy。详见[服务凭据保护的资格内省 API](./enterprise-auth.md#服务凭据保护的资格内省-api)。
FS-64 在同一 service-key 路径提供严格 `op=policy` 持久策略内省，返回共享 DTO 的 `effective_mode`、`policy_epoch`、`instance_id` 与 `artifact_sha`；数据库不可用或策略不一致时不返回旧值。详见[持久认证策略内省合同](./enterprise-auth.md#持久认证策略内省合同)。
FS-65 让 collab 仅通过 Web policy bridge 获取持久策略，启动及 doc/collection 建连前均 fail-closed，并在 health 暴露当前 `policy_epoch`；`MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED` 不能绕过已激活策略。详见[collab 权威策略桥与降级封锁](./enterprise-auth.md#collab-权威策略桥与降级封锁)。
FS-16 为企业 collab 铸造绑定 `identityId`/`authEpoch`、最多五分钟的 v3 ticket，并在 doc/collection 建连前调用资格内省；v1/v2 在企业模式拒绝。详见[collab v3 票据与建连校验](./enterprise-auth.md#collab-v3-票据与建连校验)。
FS-17 让既有 collab 连接每15秒按当前 policy/资格重验，policy 或资格故障 fail-closed；独立 revoke credential 可按 user/epoch 幂等关闭所有实例连接并拒绝旧票据重连，engine durable job 不携带 secret。详见[既有 collab 连接重验与按用户断连](./enterprise-auth.md#既有-collab-连接重验与按用户断连)。
FS-18 以单一 offboarding 事务把目录离职/本地隔离变为 `resigned`，递增 identity version 与 auth epoch，撤销 challenge/grant/session，并在同一事务写入幂等 revoke outbox；历史内容仍保留原 user 外键。详见[成员停用与撤销事务](./enterprise-auth.md#成员停用与撤销事务)。
FS-19 在持久企业激活后把 Better Auth HTTP 与 direct `auth.api` 收敛到六项精确 operation；admin、deleteUser、路径变体和持久策略失效均 fail-closed，独立 `/api/health` 负责运行探活。详见[企业认证 operation 白名单](./enterprise-auth.md#企业认证-operation-白名单)。

FS-39 将 Better Auth 内部 session 与公开 profile DTO 隔离：`/api/auth/enterprise/session` 和 direct `getEnterpriseSession` 均按当前企业资格 fail-closed，企业 `user.id` 保持本地 ID，`name`/`email` 只来自公开资料，不返回 token、OTP、grant 或兼容邮箱；客户端的 `useSession`/`getSession` 透明使用该只读 DTO。详见[公开 session 与 profile DTO 隔离](./enterprise-auth.md#公开-session-与-profile-dto-隔离)。

FS-45 为旧 mega2 保留 `/api/auth/get-session` 兼容投影：enterprise 每次重新执行资格检查，actor 固定取 `backend_username`，通知邮箱单独取 `notification_email`；过期 Cookie、资格失败和故障均返回 200/null，不暴露兼容邮箱、OTP、grant 或 token。详见[mega2 get-session 兼容与稳定 actor](./enterprise-auth.md#mega2-get-session-兼容与稳定-actor)。

FS-77 将持久 `maintenance` 策略接到 HTTP 与 direct `auth.api`：除 sign-out 外的认证写 operation 均 fail-closed，两个 session 只读接口不读取旧 session 而返回 200/null。详见[维护模式的认证 operation 拦截](./enterprise-auth.md#维护模式的认证-operation-拦截)。

FS-78 将维护模式继续接到所有业务入口的同一 `resolveWebActor` 门：页面、Mega BFF、上传、collab ticket 和 agent/SSE 都先读取当前持久 mode，maintenance/reject 不读取旧 session，也不能通过把 `AUTH_MODE` 改回 `legacy` 恢复访问。health、批准的 Feishu callback、enterprise eligibility 内省与 sign-out 保持各自的匿名边界；SSE 继续复用每 15 秒重验、30 秒停止预算。详见[维护模式的业务入口封锁](./enterprise-auth.md#维护模式的业务入口封锁)。

FS-20 在 enterprise 模式把登录页改为本人飞书私聊配对：页面只收批准的 alias，展示一次性 `/login <token>` 指令并轮询不含 OTP 的 pairing status；确认后输入严格 8 位字母数字码，通过同一 flow 调用 verify 并只跳转站内路径。legacy 继续使用既有邮箱/密码登录，enterprise 下 signup、forgot-password 和 reset-password 页面返回 404。详见[本人私聊配对登录页](./enterprise-auth.md#本人私聊配对登录页)。

FS-31 将企业登录邮件限定为双语安全通知：只包含时间、设备、脱敏来源和普通站点入口，不包含 OTP、session token 或免认证链接；sender 会拒绝内部 `@identity.invalid` 兼容地址，engine 显式声明 `@megaui/email` 生产依赖。详见[登录通知模板与地址保护](./enterprise-auth.md#登录通知模板与地址保护)。

## CI 与发布

### CI 全量测试并行

quality 的完整单元测试以三个 worker 执行；八组 BFF 契约各自拥有数据库、无实际环境文件的源副本和 mint 进程，审批清理验证仅观察本 run 临时目录。完整收集范围与全部质量门保持，job 时限为 120 分钟。隔离、故障清理和超时恢复规则见 [CI 全量测试隔离与并行](./ci-test-isolation.md)。

FS-26 在同一 self-hosted quality job 追加 enterprise pairing/verify、legacy Cookie 和 owned
Web/PG auth-page 三个 E2E project；每个 project/fixture 失败或清理失败都会阻断 CI。真实飞书、
provider、canary 与生产 live 门固定记录为未执行（`DEFER-FS-03`），不把缺失环境当作成功。详见
[企业认证与双模式 E2E 持续集成](./enterprise-auth.md#企业认证与双模式-e2e-持续集成)。

### 开发最终树发布与计划收口

FS-29 只聚合开发态证据，不增加产品行为。最终树使用同一 HTTP simulator、FSM-05 已验交接版本、
run-owned 隔离 PostgreSQL、Web/worker/collab fixture 和双模式浏览器门；真实 Feishu provider、
真实 tenant、canary callback、production deployment 与 LIVE-FS-01..03 均保持 `DEFER-FS-03`，
不把 simulator 或缺失的 CI/live 结果标成上线成功。`typecheck/lint/build` Turbo 37/37、依赖方向
守卫 1161 modules / 4638 dependencies、docs-links 53/53、enterprise E2E 7/7、legacy E2E 1/1
均有本地证据；完整 Vitest 的既有环境失败按原样记录，不等待 GitHub Actions。恢复遵循
maintenance/forward-only，清理只触及本 run 登记资源，失败保留 `cleanup-pending` 并报告。详情见
[开发最终树发布与计划收口](./enterprise-auth.md#开发最终树发布与计划收口)。
