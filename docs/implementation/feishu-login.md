# 飞书邮箱验证码登录

本文记录飞书邮箱验证码最小登录路径的实现约定（`docs/plan/plan-20261118.md`）。各节由对应任务卡在其提交中补充；产品行为以源码与测试为准。

## 配置

`@megaui/core` 的 `resolveAuthMode({ AUTH_MODE, AUTH_PROVIDER })`（`packages/core/src/auth/mode.ts`，FSL-116）是认证模式与提供方的单一解析规则。它是不读取环境的纯函数，按下表返回结果或拒绝。**当前状态：** 本函数接入了 Web 的会话入口与中间件（FSL-126，见「会话」）、Web 的认证实例构造与启动钩子（FSL-150，见「HTTP 接口」的「启用条件」），这些 Web 路径都只在 `AUTH_PROVIDER` 已设置时调用它；另接入了 collab-server（FSL-128，见「协作服务」）。其它 Web 路径与 engine 仍按各自现有路径解析 `AUTH_MODE`。`AUTH_MODE=enterprise`、`AUTH_PROVIDER=feishu` 时 Web 注册飞书登录端点（FSL-150）；登录页 `/[lang]/signin/feishu` 由 FSL-129 提供（见「页面」），入口切换由后续卡 FSL-131 完成。`resolveAuthMode` 拒绝的组合不启用飞书登录：会话入口按「会话」视为未登录，认证实例构造与启动钩子沿用现有路径，Web 不因此拒绝启动。

| `AUTH_MODE` | `AUTH_PROVIDER` | 结果 |
|---|---|---|
| 未设置 / 空白 / `legacy` | 未设置 / `local` | `{ mode: "legacy" }` |
| `enterprise` | `feishu` | `{ mode: "enterprise", provider: "feishu" }`：飞书邮箱验证码登录 |
| `enterprise` | 未设置 | `{ mode: "enterprise", provider: undefined }`：过渡期，仍走现有企业实现 |
| `maintenance` | 未设置 | `{ mode: "maintenance" }`：过渡期，保持现状 |
| 任意（含非法值） | `local`、`feishu` 以外的值 | 以 `INVALID_AUTH_PROVIDER` 拒绝（先校验提供方） |
| `legacy` / `maintenance` | `feishu` | 以 `INVALID_AUTH_PROVIDER` 拒绝 |
| `enterprise` | `local` | 以 `INVALID_AUTH_PROVIDER` 拒绝 |
| `maintenance` | `local` | 以 `INVALID_AUTH_PROVIDER` 拒绝 |
| 其它值 | 未设置 / `local` / `feishu` | 以 `INVALID_AUTH_MODE` 拒绝 |

取值去掉首尾空白后再判断，空白值视为未设置。错误信息只写键名，不写取值。

### 飞书登录的键

`readFeishuLoginConfig(source)`（`apps/web/lib/feishu-login-config.ts`，FSL-121）读取并校验飞书登录的必填键。它与 `resolveAuthMode` 一样是不读取环境的纯函数，由调用方传入原始取值。**当前状态：** 只在飞书模式（`AUTH_MODE=enterprise`、`AUTH_PROVIDER=feishu`）下，Web 以 `process.env` 调用本函数（FSL-150，见「HTTP 接口」的「启用条件」）：启动钩子 `register()` 先调用一次，配置无效时 `register()` 以 `INVALID_FEISHU_LOGIN_CONFIG` 拒绝且不启动清理；构造认证实例时再读取一次，供签发服务与 verify 使用。其它模式不调用本函数。

| 键 | 必填 | 规则 |
|---|---|---|
| `FEISHU_APP_ID` | 是 | 非空，最多 256 个字符，不含空白或 ASCII 控制字符 |
| `FEISHU_APP_SECRET` | 是 | 同上；只保存在进程内存中，不写入日志或响应 |
| `ENTERPRISE_OTP_HMAC_KEY` | 是 | 恰为 32 字节的规范 base64url 编码：43 个字符、无填充，解码后再编码须与原值逐字符相等；验证码 HMAC 与身份 HMAC 共用，以不同用途标签区分 |
| `FEISHU_PROVIDER` | 否 | 取值 `feishu` 或 `simulator`，去掉首尾空白后判断；未设置或空白时为 `feishu`（FSL-148） |
| `FEISHU_SIMULATOR_ORIGIN` | 否 | 仅 `FEISHU_PROVIDER=simulator` 时读取，须恰为 `http://127.0.0.1:<端口>`（FSL-148） |

必填键的取值不去除首尾空白：带空白的取值视为非法，而不是被截断后接受；空字符串与只含空白的取值视为缺失。任一必填键缺失或非法时，函数抛出 `FeishuLoginConfigError`，其 `code` 为 `INVALID_FEISHU_LOGIN_CONFIG`，`keys` 按上表顺序列出全部有问题的键，message 为 `INVALID_FEISHU_LOGIN_CONFIG: <键名, …>`。错误只含键名，不含任何取值。成功时返回冻结的 `{ appId, appSecret, otpHmacKey, target }`，其中 `otpHmacKey` 是解码后的 32 字节，`target` 是下文选出的冻结 provider 目标。飞书登录不需要 `FEISHU_TENANT_KEY`、部门、scope、投递、IP、代理与 introspection 等键（ADR-FSL-12）。

#### provider 选择

函数按 `@megaui/core` 现有的 `admitProvider` 准入规则（`packages/core/src/enterprise/provider-admission.ts`）选出唯一的冻结目标 `target = { provider, origin }`，没有备用 provider，也不能按请求替换（FSL-148）。可信与否只看调用方传入的 `NODE_ENV`：`development`、`test` 视为可信；其它取值或未设置时按 `production` 处理。

| `FEISHU_PROVIDER` | 条件 | 结果 |
|---|---|---|
| 未设置 / 空白 / `feishu` | 任意 `NODE_ENV`；不读取 `FEISHU_SIMULATOR_ORIGIN` | `{ provider: "feishu", origin: "https://open.feishu.cn" }`，官方地址不可配置 |
| `simulator` | `NODE_ENV` 为 `development` / `test`，且 `FEISHU_SIMULATOR_ORIGIN` 恰为 `http://127.0.0.1:<1–65535>` | `{ provider: "simulator", origin: <FEISHU_SIMULATOR_ORIGIN> }` |
| `simulator` | `NODE_ENV` 为其它取值或未设置 | 以 `INVALID_FEISHU_LOGIN_CONFIG` 拒绝，`keys` 含 `FEISHU_PROVIDER` |
| `simulator` | `NODE_ENV` 可信，但 `FEISHU_SIMULATOR_ORIGIN` 缺失或不是上述回环形式（如 `localhost`、`127.1`、`[::1]`、`https`、缺端口、带路径） | 以 `INVALID_FEISHU_LOGIN_CONFIG` 拒绝，`keys` 含 `FEISHU_SIMULATOR_ORIGIN` |
| 其它取值（含大小写不同的 `Feishu`、`SIMULATOR`） | 任意 | 以 `INVALID_FEISHU_LOGIN_CONFIG` 拒绝，`keys` 含 `FEISHU_PROVIDER` |

provider 键的错误与必填键的错误一并报告，排在必填键之后。错误同样只含键名，不含 provider 或地址取值。simulator 不能在 production 启用。

**弃用声明（ADR-FSL-13）：** 现有企业模式已弃用，将由本文的飞书邮箱验证码登录取代。弃用范围：`AUTH_MODE=maintenance`、未设置 `AUTH_PROVIDER` 的 `AUTH_MODE=enterprise`、企业认证接口 `/api/auth/enterprise/*`（配对登录与企业 OTP）、飞书事件回调、内部资格接口、collab 企业撤销接口、企业 worker 任务与通讯录同步、admin CLI，以及 20 张 `enterprise_*` 表与 `session` 的企业列。弃用窗口期间（FSL-116 起共 33 个双仓版本）旧企业路径保持可用。自 FSL-132 所在版本起，`AUTH_MODE=enterprise` 但未设置 `AUTH_PROVIDER` 的配置，以及 `AUTH_MODE=maintenance`，都将以配置错误拒绝启动；之后的版本删除现有企业实现。

## 飞书接口

按邮箱查找成员、读取成员在职状态，都通过 `packages/engine/src/services/feishu/contact.ts` 的 `FeishuContactClient`（FSL-117）完成。两个请求都使用飞书开放平台 Directory v1 接口。不使用 Contact v3，原因有两点：真实租户实测中，Contact v3 的 `users/batch_get_id` 查不到登记在 `enterprise_email` 中的企业邮箱；`users/:open_id` 在当前权限下不返回 `status`（见 `feishu-live-contract-lookup.md`、`feishu-live-contract-member.md`）。

### 请求

两个请求共用同一组 `required_fields`：

```text
base_info.employee_id
base_info.email
base_info.enterprise_email
base_info.name
base_info.active_status
base_info.is_resigned
work_info.staff_status
```

- **按邮箱查找**（`findByEmail(email)`）：`POST /open-apis/directory/v1/employees/search?employee_id_type=open_id`，请求体为 `{ query: <邮箱>, required_fields: [...], page_request: { page_size: 10 } }`。只读取第一页。
- **读取成员**（`readMember(openId)`）：`POST /open-apis/directory/v1/employees/mget?employee_id_type=open_id`，请求体为 `{ employee_ids: [<open_id>], required_fields: [...] }`。

两个请求都带 `Authorization: Bearer <tenant_access_token>`。token 由现有的 `FeishuTokenManager` 取得，经固定源的 `FeishuTransport` 发送。

### 所需权限

- 接口权限：`directory:employee:search`（搜索员工）、`directory:employee:read`（获取员工信息）。
- 字段权限：
  - `directory:employee.base.enterprise_email:read`
  - `directory:employee.base.email:read`
  - `directory:employee.base.active_status:read`
  - `directory:employee.base.is_resigned:read`
- 以 `tenant_access_token` 调用时，返回的数据受应用「通讯录权限范围」约束，范围外的成员不会出现在结果中。

### 本地精确匹配

搜索接口对邮箱做模糊匹配，因此客户端在本地对 `data.employees[]` 逐项精确比较，大小写不敏感：

- 候选的 `base_info.enterprise_email` 为非空字符串时，只用它比较。
- `enterprise_email` 恰为空字符串时，才改用 `base_info.email` 比较。字段缺失不视为空字符串，而是判为无效响应。
- 恰好一名候选匹配，且 `data.page_response.has_more` 为 `false` 时，返回该候选的 `base_info.employee_id`（open_id）。
- 零名或多名候选匹配，或 `has_more` 为 `true` 时，返回「无唯一目标」，不发码。

### 在职判定

`readMember` 要求 `data.employees` 恰有一项，且该项的 `base_info.employee_id` 等于请求的 open_id。

- `base_info.active_status == 2`（激活）且 `base_info.is_resigned == false` 时，判为在职，姓名取 `base_info.name.name.default_value`。
- `active_status` 为 1（未激活）、3（冻结）、4（主动退出）、5（未加入），或 `is_resigned == true` 时，判为不在职，不发码。
- `work_info` 与 `name.name.i18n_value` 不参与判定。实测中 `work_info` 为 `{}`，`staff_status` 不返回。

### fail-closed 与传输层错误

- 客户端不修改传输层。下面两类错误由传输层抛出，客户端原样传播：
  - HTTP 2xx 以外的响应：`FeishuTransportError`。例如 HTTP 400 为 `transport_permanent`，带 `status`，不读取响应体。
  - HTTP 200 且 `code` 为非零数字：`transport_permanent`，带 `businessCode`。
- 传输层放行的 HTTP 200 响应由客户端逐字段校验，出现以下任一情况时，以 `FEISHU_CONTACT_INVALID_RESPONSE` 失败，错误 message 恰为该稳定键，不含邮箱、open_id、token 或响应值：
  - `code` 不是数字 0；
  - 任一必需字段缺失或类型不符；
  - `employee_id` 为空白字符串；
  - `active_status` 不是 1–5 的整数；
  - `data.employees` 的数量或身份不符。
- 实测的鉴权失败形状：
  - 缺少 `Authorization`：HTTP 400，`code=99991661`。
  - 伪造 token：HTTP 400，`code=99991663`。

### 发送验证码私聊

验证码通过 `packages/engine/src/services/enterprise/feishu/message.ts` 的 `FeishuMessageClient` 发送：`POST /open-apis/im/v1/messages?receive_id_type=open_id`，请求体为 `{ receive_id, msg_type: "text", content, uuid }`，同一次投递的重试复用同一 `uuid` 与同一载荷。

发送成功判据（FSL-170，按 `feishu-live-contract-message.md` Q4 的实测）：传输层放行的 2xx 响应（传输层只对 `response.ok` 的响应解析业务体，客户端不再单独检查状态码）同时满足以下三条，即判为 `accepted`，`messageId` 取 `data.message_id`：

- `code` 为数字 `0`；
- `data.message_id` 为非空白字符串；
- `data.msg_type` 为 `"text"`。

这三条是充分条件，不比对回显：不要求 `msg`，不要求 `data.receive_id`（真实响应没有该字段），也不比对正文（真实正文位于 `data.body.content`，经服务端重新序列化，与发送的 `content` 不逐字节相等）。

失败分类：

- HTTP 2xx 以外的响应，以及 2xx 且 `code` 为非零数字，由传输层抛出 `FeishuTransportError`，映射为 `rejected`（`permission` / `provider`，带 `status` 与 `businessCode`）或 `unknown`（超时、暂时性失败）。
- 传输层放行、但 `code` 缺失或不是数字 `0`，或 `data.message_id`、`data.msg_type` 不满足上述条件时，返回 `rejected`（`invalid_response`）。
- token 失败、传输失败的分类与同一 UUID 重试不受该判据影响。

### 未实测分支

以下分支无法在单人测试租户上构造，依据为官方文档（<https://open.feishu.cn/document/directory-v1/employee/search>、<https://open.feishu.cn/document/directory-v1/employee/mget>，2026-11-19 核对）与 `contact.test.ts` 中的替身用例，标为「未实测，按文档 + 替身」：

- 多名成员精确匹配；
- `has_more=true`；
- 各种不在职状态（`active_status` 为 1、3、4、5，以及 `is_resigned=true`）。

### 真实租户复测

`contact.live.q2.test.ts`（Q2）与 `contact.live.q3.test.ts`（Q3）只在 `FEISHU_LIVE_CONTRACT === "1"` 时运行，默认跳过。凭据只来自仓库根目录被忽略的 `.env`，以 `set -a; source .env; set +a` 加载。每个用例都通过包装 `fetchImpl` 记录每次 Directory v1 交换的 `{ path, status, code }`，并与期望列表做严格相等比较。复测结果的脱敏摘要分别追加在 `feishu-live-contract-lookup.md` 与 `feishu-live-contract-member.md` 的「复测（FSL-117）」一节。

## 发码

`packages/engine/src/services/feishu-login/issue.ts` 的 `createFeishuLoginIssuer(options)`（FSL-122）实现签发主流程，FSL-145 在其预约事务中加入全局锁、邮箱冷却与全局预算。FSL-154 把签发拆为两个端口：`reserveFeishuLoginCode({ flowHash, email })`（第 1 步预约，只访问数据库，request 端点在 `auth.handler` 确定响应之前等待它提交）与 `deliverFeishuLoginCode(reservation)`（第 2–4 步，飞书查询、激活或作废与私聊，request 端点在 `auth.handler` 确定 202 响应之后以前者的返回值调用；响应字节何时写到客户端由宿主服务器决定，见「HTTP 接口」）；`issueFeishuLoginCode({ flowHash, email })` 依次执行两者，唯一冲突时返回 `{ status: "retry" }`。验证码表 `feishu_login_codes` 的读写集中在 `packages/database/src/feishu-login-store.ts`（`createFeishuLoginCodeStore(pool)`，由 `@megaui/database` 导出）。**当前状态：** 飞书模式的 Web 以 FSL-121、FSL-148 的配置构造本服务，把 `reserveFeishuLoginCode`、`deliverFeishuLoginCode` 作为 request 端点的两个签发端口（FSL-150，见「HTTP 接口」的「启用条件」）；`issueFeishuLoginCode` 没有进程调用。`@megaui/engine` 入口导出 `createFeishuLoginIssuer` 及其日志键与类型，输入类型以 `FeishuLoginCodeIssueInput` 导出，避免与 `@megaui/auth` 的 `FeishuLoginIssueInput` 同名。

### 构造

- 服务只用 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`ENTERPRISE_OTP_HMAC_KEY`（解码后的 32 字节）与 `BETTER_AUTH_URL` 构造，另传入 FSL-148 选出的冻结 provider 目标与数据库连接池。
- 现有凭据类型与消息客户端要求的 `tenantKey` 取内部标签 `app:<FEISHU_APP_ID>`（`feishuLoginTenantKey`），只作 token 缓存键，从不发送给飞书，也不写入任何表。
- 私聊文案中的可信站点取 `BETTER_AUTH_URL`。
- 验证码生成器以构造参数 `generateCode` 注入：engine 不依赖 `@megaui/auth`，Web 注入 `@megaui/auth` 的 8 位 CSPRNG 生成器 `generateEnterpriseOtpCode`（FSL-150），测试注入同一生成器。
- 服务构造的 `FeishuTransport`（token、通讯录查询与私聊发送共用）一律 `maxAttempts: 1`（FSL-149）：每次传输层请求（`request()`）恰好一次 HTTP 请求，传输层不再重试；私聊的重试只由本服务按下文「发送结果」控制，查询阶段的瞬时失败按 provider 失败作废本行，用户可在冷却后重新请求。可选构造参数 `attemptTimeoutMs`（单次 HTTP 尝试的超时，默认 `FEISHU_OPERATION_BUDGET_MS` 即 20 秒）与 `retryBackoffMs`（服务重试的退避基数，默认 250 毫秒，第 n 次重试前等待基数 × 2^(n−1)）只供测试缩短等待。
- `FeishuTransport` 的 `maxAttempts` 是可选参数（正整数，默认 `FEISHU_MAX_ATTEMPTS` = 3，非正整数在构造时以 `INVALID_FEISHU_TRANSPORT_MAX_ATTEMPTS` 拒绝），未传入的现有调用行为不变。
- 可选构造参数 `now`（毫秒时钟，默认单调时钟 `performance.timeOrigin + performance.now()`，不随系统时间调整跳变）同时用于发码截止时间、传输层与 token 缓存（FSL-160），只供测试注入时钟越过截止时间。

### 主流程

邮箱先去首尾空白并整体转小写（长度 1–254），再计算邮箱 HMAC。每一步都不在飞书调用期间持有事务或锁。

1. **预约**（`reserveFeishuLoginCode`，request 响应之前，FSL-154）：一个事务按固定顺序取得三把事务级咨询锁——先取得 flow 锁（`pg_advisory_xact_lock(0x46534c03, <flow 哈希派生键>)`，派生键为 flow 哈希前 32 位的有符号整数，FSL-154），再取得与激活相同的邮箱锁（`pg_advisory_xact_lock(<类键>, <邮箱 HMAC 派生键>)`，见第 3 步），最后取得全局锁（`pg_advisory_xact_lock(0x46534c02, 0)`，FSL-145）——持锁后先以一条语句作废该 flow 中 `flow_seq` 最大的一行（见下文「flow 绑定」），再做冷却与预算判定（见下文「冷却与全局预算」），通过判定才写入本次请求的 `reserved` 行并提交，提交即释放三把锁，之后才调用飞书，飞书调用期间不持有任何锁或事务；被拒绝时不写入新行（只提交上述作废），服务返回 `{ status: "cooldown" }` 或 `{ status: "budget" }`（提交之后输出日志键时日志函数抛错被忽略，不改变该结果），不调用飞书。预约不访问飞书、不查询账号。该行只含邮箱 HMAC、flow 哈希（flow Cookie 值的 SHA-256，64 位小写十六进制）、创建时间与预约到期时间（创建后 2 分钟；创建时间在取得三把锁并执行作废语句之后以 `clock_timestamp()` 读取一次，冷却与预算判定使用同一时刻，写入的创建时间恰为该时刻，等待锁不会缩短预约有效期）。`flow_seq` 取该 flow 现有最大值加 1，`email_seq` 取该邮箱 HMAC 现有最大值加 1（同一条 `insert … select max(...) + 1` 语句，在 flow 锁与邮箱锁内执行），因此同一 flow 的预约在 flow 锁下串行、同一邮箱的预约在邮箱锁下串行：已提交的 `flow_seq` 在同一 flow 现存的行中、`email_seq` 在同一邮箱现存的行中各自严格递增且与提交顺序一致（清理删除创建超过 24 小时的行后，序号只在现存行中比较，见「flow 绑定」），作废、校验与激活只按它们判定先后，不依赖 `created_at`（时间戳相同或倒序都不影响）。预约与激活持有同一把邮箱锁，所以在激活读出「没有 `email_seq` 更大的预约」之后、写入 `active` 之前，同一邮箱不可能提交新的预约（FSL-149）。FSL-163 的唯一索引 `feishu_login_codes_flow_seq_uidx`（`(flow_hash, flow_seq)`）与 `feishu_login_codes_email_seq_uidx`（`(email_hmac, email_seq)`）保留为纵深防御：绕过 flow 锁或邮箱锁的写入取到同一序号时后提交者以唯一冲突失败、整个预约事务回滚（什么都不改变），`reserveFeishuLoginCode` 抛出 `FEISHU_LOGIN_RESERVE_RETRY`（`issueFeishuLoginCode` 返回 `{ status: "retry" }`），request 端点按预约失败返回 503 重试。
2. **开始发码与查询**：发码（`deliverFeishuLoginCode`，FSL-154）开始时先以一个事务（flow 锁、邮箱锁，再以单独一条 `SELECT … FOR UPDATE` 锁定本行，存储函数 `beginDelivery`）检查本行：已过期（`expires_at <= clock_timestamp()`，创建后 2 分钟）的 `reserved` 行置为 `void` 并清空敏感字段，已不是 `reserved` 的行保持原状，两种情况都不调用飞书（不取 token、不查询、不发送），服务返回 `{ status: "not_reserved" }`、不输出日志键（FSL-145）。仍有效时先经 `FeishuTokenManager` 取得本次发码唯一的 token（共享刷新，见下文「绝对截止时间」），再在事务外以 `FeishuContactClient`（见「飞书接口」）用这一 token 按邮箱查找唯一成员，再按 open_id 读取在职状态。
3. **激活**：激活事务先取得本行的 flow 锁（FSL-154），再以 `pg_advisory_xact_lock(<类键>, <邮箱 HMAC 派生键>)` 串行化同一邮箱（类键为常量 `0x46534c01`，派生键为邮箱 HMAC 前 32 位的有符号整数），再以单独一条 `SELECT … FOR UPDATE`（按 `id` 排序）锁定本行与该邮箱 HMAC 的全部 `active` 行（即激活将要作废的行），之后用下一条语句读取状态并校验（FSL-149；到期以取得全部锁之后的 `clock_timestamp()` 判断，而不是事务开始时的 `now()`，因此等待邮箱锁或任一行锁期间到期的预约同样不激活；校验之后的更新不再等待锁。只有持邮箱锁的激活会产生 `active` 行，期间不会出现新的 `active` 行），三条同时满足才激活：
   - 本行仍是 `reserved`；
   - 本行未过期（`expires_at > clock_timestamp()`）；
   - 该邮箱 HMAC 没有 `email_seq` 更大的预约行（不论其状态与 flow）。

   满足时，先以条件更新（`where id = $1 and state = 'reserved' and expires_at > clock_timestamp()`）把本行由 `reserved` 置为 `active`（写入时再次判断到期，校验之后、写入之前到期的预约同样不激活，此时本行置为 `void`、不改动其它行），该更新生效后再把同一邮箱 HMAC 的其它全部 `active` 行（不论 flow）置为 `void` 并在同一语句中清空邮箱、open_id、姓名与验证码 HMAC；本行激活时写入邮箱、open_id、姓名（`base_info.name.name.default_value`，空字符串照样保存）、验证码 HMAC 与到期时间（激活后 5 分钟）。不满足时不发送、不改动其它行，服务返回 `{ status: "not_reserved" }`（存储层的 `reason` 为 `not_reserved`、`expired` 或 `superseded`）：本行仍是 `reserved` 但已过期或已被更晚的预约取代时，在同一事务内置为 `void`（并清空敏感字段）；本行已不是 `reserved`（已作废——含被同一 flow 较晚的请求作废、已消费）时保持原状。因此较早的预约在较晚的预约之后完成飞书查询时不发送私聊，作废或过期的行不能复活。
4. **发送**：激活提交后经 `FeishuMessageClient` 私聊发送，`uuid` 取本行 ID（同一请求的稳定 UUID，每次尝试的载荷逐字节相同），成功判据见「发送验证码私聊」。每次私聊 HTTP 尝试之前输出 `FEISHU_LOGIN_SEND_ATTEMPT`（该键在请求发出之前输出，未能到达飞书的请求同样计入）。自 FSL-160 起由服务在每次发送尝试开始时输出：截止时间已过的尝试不输出该键、不发请求；否则先输出该键，再交给传输层，传输层在输出之后、调用 `fetch` 之前作最后一次截止检查（读时钟、设计时器、调用 `fetch` 在同一段同步执行中），因此耗时的日志输出不会使请求在截止之后发起。仅当在日志输出之后、传输层最后一次检查之前（日志输出本身、消息准备与正文序列化或进程调度期间）越过截止时间时，该键已输出而传输层拒绝发出请求；因此该键条数不少于私聊请求数，正常情况下二者相等。发送结果见下文。

未命中、多人或不在职，以及查询阶段的飞书调用（token、按邮箱搜索、按 open_id 读取）失败或遇到截止时间（`transport_deadline`，见下文）时，本行在与激活相同形态的事务中（先 flow 锁、后邮箱锁，再以与激活同一条 `SELECT … FOR UPDATE` 锁定本行与该邮箱的 `active` 行，存储函数 `voidReservation`，条件 `state = 'reserved'`）置为 `void`，不生成验证码、不发送（失败与截止时间同样返回 `{ status: "provider_failed" }`、输出 `FEISHU_LOGIN_PROVIDER_FAILED`）。

### flow 绑定

FSL-154 按 ADR-FSL-11「flow 绑定」把 flow 只绑定到最近一次请求：

- **作废语句**：预约事务取得三把锁之后、冷却与预算判定之前，以一条语句（`FEISHU_LOGIN_SUPERSEDE_FLOW_SQL`）把该 flow 中 `flow_seq` 最大的一行置为 `void` 并清空邮箱、open_id、姓名与验证码 HMAC（只使用 FSL-119 的现有列）：不论该行属于哪个邮箱，也不论其为 `reserved`、`active` 还是 `void`；为 `consumed` 时不改写。每次预约都先作废当时序号最大的行，激活又只接受仍为 `reserved` 的行，所以同一 flow 中可能有效的行至多一行且必为 `flow_seq` 最大的行，作废它即可；该语句恰好改写 0 或 1 行（0 只在 flow 尚无记录或最新行已消费时出现，与邮箱是否对应成员无关），改写行数不随该 flow 的历史行数增长，也不取决于前次请求的飞书结果。被冷却或预算拒绝的请求同样提交这一作废，只是不写入新行。该语句在全部咨询锁之后才等待行锁：该行正被 verify、激活或清理锁定时等到其事务结束（被 verify 消费的行随后不再改写）。
- **`flow_seq` 的分配**：获准时新行的 `flow_seq` 为 `coalesce(max(flow_seq), 0) + 1`，在 flow 锁内分配，因此在该 flow 现存的行中严格递增且与预约提交顺序一致，不依赖时间戳或 UUID（清理删除创建超过 24 小时的行，一个 flow 的行全部被删除后序号可重新从 1 开始；此时该 flow 已无可能有效的行，不影响绑定）；第二个预约在 flow 锁上等待后提交时取得更大的序号。`(flow_hash, flow_seq)` 唯一索引 `feishu_login_codes_flow_seq_uidx`（FSL-163）只作纵深防御（见第 1 步）。verify 同样按 `flow_seq` 选取该 flow 的最新行，只在其为未过期 `active` 时比较（见「HTTP 接口」的 verify）。
- **锁顺序**：全部咨询锁按 flow → 邮箱 → 全局的固定顺序取得。预约取三把；发码的每个写回事务（`beginDelivery`、激活、`voidReservation`、`voidRejectedSend`）先以不加锁的读取取得本行的 flow 哈希（行的 flow 哈希不会改变），再取 flow 锁与邮箱锁，之后才取行锁；verify 与清理不取咨询锁。每个事务取得的咨询锁都是该顺序的前缀，行锁都在咨询锁之后取得，因此咨询锁之间不会形成等待环。
- **写回形态与结果无关**：`deliver` 无论命中、未命中、多人、不在职或飞书调用失败，都以同一形态的「flow 锁 → 邮箱锁 → 本行与该邮箱 `active` 行的行锁」事务写回本行（激活或作废），后续请求遇到的锁等待不随结果变化。
- **线性化点**：`reserve` 事务的提交。request 只在其提交之后返回 202，此时该 flow 更早请求的预约与验证码均已失效（verify 读取到的最新行已是新预约行，或被作废的行）。在激活之前被作废的预约不会激活，即使其飞书查询稍后完成也不发码；激活已提交、私聊尚未送达时被作废的请求，其私聊仍可能送达，但其中的验证码在后一次 `reserve` 提交时已无效——保证的是有效性，不是送达。因此同一 flow 中更换邮箱或重发后，无论新邮箱是否命中、发送是否成功、是否被冷却或预算拒绝，旧验证码都失效。
- **与账号无关**：`reserve` 不访问飞书、不查询账号，响应体、状态码与 Cookie 与邮箱是否对应成员无关；响应前的数据库工作（三把锁、改写 0 或 1 行的作废语句、判定与至多一行插入）也不依赖前次请求的飞书结果。耗时随数据库负载与锁等待波动，不承诺严格常数时间。

### 绝对截止时间

FSL-160 按 ADR-FSL-11「请求预算」以预约到期时间（创建后 2 分钟）作为本次 `deliver` 全部飞书请求的绝对截止时间：

- **截止时间的取值**：服务在预约事务之前读取一次时钟（构造参数 `now`，默认单调时钟），截止时间 = 该读数 + `FEISHU_LOGIN_RESERVATION_TTL_SECONDS`（120 秒），即该时刻之后经过 2 分钟。预约行的创建时间由数据库在该时刻之后读取，`expires_at` 为其后 2 分钟，因此截止时间不晚于该行的 `expires_at`。两侧各自只用本时钟的经过时间，服务时钟与数据库时钟之间的固定偏差相互抵消，不需要两时钟对齐；默认单调时钟不受服务所在主机系统时间跳变的影响。等待锁只会使截止时间相对 `expires_at` 更早。由此得到的保证以真实经过时间计：每个飞书请求都在预约创建后 2 分钟内开始。数据库所在主机的系统时间若发生跳变，`clock_timestamp()` 读出的「当前时刻」会相对 `expires_at` 移动（这同样影响 FSL-145 的冷却与预算窗口和 FSL-149 的到期判定），此时「不晚于 `expires_at`」只在数据库时钟不跳变的前提下成立，真实时间上的 2 分钟上界不受影响。
- **传到每次 HTTP 尝试**：`FeishuTransport.request(path, { deadline })` 的可选 `deadline` 为绝对毫秒时间（与传输层 `now` 同一时钟，非有限数在请求前以 `INVALID_FEISHU_TRANSPORT_DEADLINE` 拒绝）。已过截止时间时不发起请求并抛出 `FeishuTransportError`（`code = "transport_deadline"`）；单次尝试的超时取 `min(传输预算, deadline − 当前时间)`，传输层重试的退避同样不越过截止时间，截止时间之后不再开始重试（抛出最后一次尝试的错误）。在途尝试在截止时间被中止时仍为 `transport_timeout`（请求已发出）。`FeishuTokenManager.getToken(credentials, { deadline })`、`FeishuContactClient.findByEmail` / `readMember(…, { token, deadline })` 与 `FeishuMessageClient.send(input, { token, deadline })` 接受同一 `deadline` 并原样传给传输层；客户端收到显式 `token` 时直接使用、不再向 token 来源取 token。
- **共享刷新**：token 需要刷新时由第一个调用方以其截止时间发起（刷新请求的单次超时受该截止时间约束）；其后加入同一次在途刷新的调用方各自只等待到自己的截止时间，到期即以 `transport_deadline` 返回，不取消共享刷新，刷新结果照常交给其它调用方并写入缓存。刷新完成时按同一时钟再次检查每个带截止时间的调用方：事件循环延迟导致刷新结果晚于其截止时间到达时，加入者无论刷新成功还是失败都得到 `transport_deadline`，发起者在刷新成功时同样得到 `transport_deadline`（刷新失败时得到刷新本身的错误，其请求已受自身截止时间约束），token 仍写入缓存。已过截止时间的调用方直接得到 `transport_deadline`，不发起请求。传输层每次尝试先准备好请求（序列化正文等），再读取一次时钟，并在同一段同步执行中（中间没有 `await`）以该读数判定能否开始、设置该尝试的计时器并调用 `fetch`；读数已到截止时间时不调用 `fetch`。计时器到期时中止在途请求；中止由事件循环触发，事件循环被阻塞时中止会相应推迟，这是 Node 运行时的限制，不是可配置的余量。
- **每个预约至多 1 次 token 请求**：`deliver` 开始时取一次 token（经共享刷新），本次全部通讯录与发送调用都使用这一 token，`deliver` 期间不再刷新；token 在截止前失效时该次调用失败并按各自规则处理（查询作废本行，发送按「发送结果」累计）。因此 token 有效期短于刷新余量、首次刷新失败或发送重试时，每个预约都至多发起 1 次 token HTTP 请求（缓存命中时为 0 次）。
- **查询阶段**遇到 `transport_deadline` 时把本行置为 `void`（见上文）；**发送阶段**遇到时停止重试：被截止时间拒绝的尝试没有离开进程、飞书未收到，消息客户端报告为 `rejected`（`reason = "deadline"`），按 FSL-149 的累计规则定终态——此前已有 `unknown` 时保持 `active`（`send: "unknown"`），否则以条件更新作废本行（`send: "rejected"`）。
- 由此每个飞书请求的发起前检查都在预约创建后 2 分钟内通过，按检查时刻计任意 60 秒滑动窗口内的请求只来自此前 180 秒内的预约（ADR-FSL-11「请求预算」时间语义）。中止计时器以检查时采样的剩余时间设置相对延迟，实际到期晚于截止的部分只来自采样到注册计时器之间的经过时间；检查通过后到 `fetch` 之间、以及中止与等待者返回，都可能因同步执行耗时、进程挂起或事件循环受阻而推迟，这些偏差不计入上述上界。不传 `deadline` 的现有调用方（企业目录、身份与投递路径）行为不变。

### 冷却与全局预算

FSL-145 按 ADR-FSL-11「请求预算」在预约事务中持有 flow 锁、邮箱锁与全局锁时（FSL-154 起，作废语句之后）判定，判定以取锁并作废之后读取的同一时刻 `t`（`clock_timestamp()`）为准，依次为：

| 判定 | 条件（`t` 为取锁后的时刻） | 服务返回 | 日志键 |
|---|---|---|---|
| 邮箱冷却 | 同一邮箱 HMAC 存在 `created_at > t − 60 秒` 的行 | `{ status: "cooldown" }` | `FEISHU_LOGIN_COOLDOWN` |
| 全局预算 | 全部邮箱 `created_at > t − 60 秒` 的行数达到 120 | `{ status: "budget" }` | `FEISHU_LOGIN_GLOBAL_BUDGET` |

- 两项都按行计数，不论行的状态（`reserved`、`active`、`consumed`、`void`）：每一行都曾是一次预约。预约行由清理在创建 24 小时后才删除，不影响 60 秒窗口。
- 窗口为左开区间：恰好创建于 60 秒前（`created_at = t − 60 秒`）的行已不在窗口内。请求须同时通过两项判定才写入预约。
- 被拒绝的请求不写入新行（事务只提交该 flow 最新行的作废，见「flow 绑定」），因此持续重试不会延长冷却，也不占用全局预算。两项各自恢复：邮箱冷却在该邮箱最近一行滑出 60 秒窗口后恢复；全局预算在窗口内行数降到 120 以下（即足够早的行滑出窗口）后恢复；两项同时触发时，须两项都已恢复才放行。
- 两项判定与账号是否存在无关：未命中、多人与在职成员的邮箱同样计入、同样被拒绝，被拒绝的请求不访问飞书，不暴露账号存在性；request 端点（FSL-123）对被拒绝的请求照常返回 202（`deliver` 收到被拒绝的预约时不做任何事）。
- 预算约束的是预约数：每个邮箱每 60 秒至多一个预约，全部邮箱合计每 60 秒至多 120 个预约；每个预约至多触发一次发码流程（开始发码时已过期则不调用飞书，见第 2 步）。贯穿每次飞书请求的绝对截止时间见上文「绝对截止时间」（FSL-160）。
- 全局锁使全部实例的预约依次判定，同一时刻不会有两个预约同时看到最后一个名额；同一邮箱的并发请求在邮箱锁上串行，先取得锁者提交后，后者在锁释放后读到该行并被冷却拒绝。
- 常量由 `@megaui/database` 导出：`FEISHU_LOGIN_COOLDOWN_SECONDS`（60）、`FEISHU_LOGIN_GLOBAL_BUDGET_WINDOW_SECONDS`（60）、`FEISHU_LOGIN_GLOBAL_BUDGET`（120）、`FEISHU_LOGIN_GLOBAL_LOCK_CLASS`（`0x46534c02`）与 `FEISHU_LOGIN_GLOBAL_LOCK_KEY`（0）。

索引用途（FSL-163）：`feishu_login_codes_email_created_at_idx`（`(email_hmac, created_at)`）服务邮箱冷却的查找；`feishu_login_codes_created_at_idx`（`(created_at)`）服务全局预算的窗口计数（计数只数到 120 为止）与 FSL-146 的到期清理。

### 发送结果

每次发送尝试都使用本次 `deliver` 开始时取得的 token 与截止时间（FSL-160，见上文「绝对截止时间」），由 `FeishuMessageClient` 发出恰好一次私聊 HTTP 请求，发送阶段不再取 token；截止时间已过时该尝试不发出请求。结果分类（FSL-149）：

| 结果 | 条件 |
|---|---|
| `accepted` | HTTP 2xx 且业务码成功（判据见「发送验证码私聊」） |
| `rejected` | HTTP 429，或明确的业务拒绝（其它 4xx、2xx 且业务码为非零数字）：飞书未受理；截止时间已过、请求未发出（FSL-160）：飞书未收到 |
| `unknown` | HTTP 5xx、超时与连接中断；私聊请求的 HTTP 3xx（传输层拒绝跟随重定向，客户端返回 `rejected`，服务改判为 `unknown`：3xx 是对 POST 的应答，飞书可能已接收）；2xx 但响应体不是可解析的 JSON 或为 JSON `null`（传输层归为暂时性失败）；2xx 但不满足成功判据（`code` 缺失或不是数字、`data.message_id` 或 `data.msg_type` 不符，客户端返回 `rejected`/`invalid_response`，服务改判为 `unknown`）：不能证明飞书未受理，可能已接收 |

发送阶段没有 token 阶段：token 只在 `deliver` 开始时取一次，取 token 失败（含 HTTP 429）按查询阶段失败作废本行，不进入发送。消息客户端把私聊请求的 HTTP 429 归为暂时性失败（`unknown`）；服务从包装的 `fetch` 读取本次尝试私聊请求收到的 HTTP 状态（按尝试隔离的 `AsyncLocalStorage`，每次尝试各有自己的私聊请求，互不共享），把 429 改判为 `rejected`。

发送结果按全部尝试累计判定：

- 任一次尝试返回 `accepted`：不再重试，不回写（本行若发送期间未被作废、消费或过期，则仍为 `active`），服务返回 `{ status: "sent", send: "accepted" }`。
- 返回 `rejected` 的尝试不重试。
- 返回 `unknown` 时以同一 UUID 最多再重试 2 次（至多 3 次尝试、3 次私聊 HTTP 请求；重试不取 token），重试前按 `retryBackoffMs` 指数退避；截止时间已过时下一次尝试不发出、按 `rejected` 计入并结束重试（FSL-160）。
- 所有尝试都返回 `rejected`（即首次尝试即被拒绝）时，以条件更新把本行置为 `void`（仅当本行仍为 `active` 且未过期；发送期间已改变的行保持原状） 并在同一语句中清空邮箱、open_id、姓名与验证码 HMAC，输出 `FEISHU_LOGIN_SEND_REJECTED`，返回 `send: "rejected"`。
- 任一次尝试返回 `unknown` 且没有 `accepted` 时，无论后续返回 `unknown` 还是 `rejected`，都不回写，仍为 `active` 的本行保持 `active`（不能证明此前未送达，验证码在到期前有效），输出 `FEISHU_LOGIN_SEND_UNKNOWN`，返回 `send: "unknown"`。

发送结果的回写一律为条件更新（存储函数 `voidRejectedSend`，先 flow 锁、后邮箱锁；先以单独一条 `SELECT … FOR UPDATE` 取得本行行锁，再执行下面的语句，因此到期以所有锁等待之后的时间判断）：

```sql
update feishu_login_codes
   set state = 'void', email = null, open_id = null, display_name = null, code_hmac = null
 where id = $1 and email_hmac = $2 and state = 'active' and expires_at > clock_timestamp()
```

发送期间该行已被新请求或清理作废、已被 verify 消费，或已过期（即使清理尚未运行，也包括在回写等待邮箱锁期间过期）时，回写不恢复、不覆盖其状态；过期行只由清理处理。任何置为 `void` 的行都在同一语句中清空敏感字段（FSL-119 的双向 CHECK 同时强制）。

### HMAC

两种 HMAC 共用 `ENTERPRISE_OTP_HMAC_KEY`，以用途标签区分，输出小写十六进制：

| 用途 | 输入 | 函数 |
|---|---|---|
| 邮箱 | `"feishu-login-email:v1:" + 规范化邮箱` | `feishuLoginEmailHmac(key, email)` |
| 验证码 | `"feishu-login-code:v1:" + 行 ID + ":" + 验证码` | `feishuLoginCodeHmac(key, rowId, code)` |

验证码 HMAC 绑定行 ID，只能与本行比对。验证码明文不写入数据库与日志。

### 日志键

日志只输出下列稳定键，不含邮箱、open_id、姓名、验证码、token 或 message_id：

| 键 | 时机 | 服务返回 |
|---|---|---|
| `FEISHU_LOGIN_SEND_ATTEMPT` | 每次私聊 HTTP 尝试之前（截止时间已过的尝试不输出） | `{ status: "sent", send: "accepted" \| "rejected" \| "unknown" }` |
| `FEISHU_LOGIN_NO_TARGET` | 零名、多名匹配或 `has_more=true`，本行置为 `void` | `{ status: "no_target" }` |
| `FEISHU_LOGIN_INACTIVE` | 唯一成员不在职，本行置为 `void` | `{ status: "inactive" }` |
| `FEISHU_LOGIN_PROVIDER_FAILED` | token、通讯录请求失败、响应形状无效或查询阶段已过截止时间（FSL-160），本行置为 `void` | `{ status: "provider_failed" }` |
| `FEISHU_LOGIN_SEND_UNKNOWN` | 发送结束时有 `unknown` 尝试而没有 `accepted`，不回写（仍为 `active` 的本行保持 `active`） | `{ status: "sent", send: "unknown" }` |
| `FEISHU_LOGIN_SEND_REJECTED` | 所有发送尝试都返回 `rejected`，本行经条件更新置为 `void`（仅当仍为 `active` 且未过期） | `{ status: "sent", send: "rejected" }` |
| `FEISHU_LOGIN_COOLDOWN` | 同一邮箱 HMAC 60 秒内已有预约行，不写入新行、不调用飞书（FSL-145） | `{ status: "cooldown" }` |
| `FEISHU_LOGIN_GLOBAL_BUDGET` | 全部邮箱最近 60 秒内的预约行数达到 120，不写入新行、不调用飞书（FSL-145） | `{ status: "budget" }` |

预约冲突（`FEISHU_LOGIN_RESERVE_RETRY`，`issueFeishuLoginCode` 的 `retry`）、开始发码时预约已过期或已不是 `reserved`，以及激活前状态校验未通过（`not_reserved`：已不是 `reserved`（含被同一 flow 较晚的请求作废）、已过期或已被更晚的预约取代）不由本服务输出日志键；预约失败由 request 端点输出 `FEISHU_LOGIN_RESERVE_FAILED`（见「HTTP 接口」）。

### 测试

`packages/engine/src/services/feishu-login/issue.integration.test.ts` 使用一次性 PG 与真实的 `apps/feishu-mock` 进程，以 Mock 收件箱断言私聊条数与正文，服务经测试内的记录代理访问 Mock，代理在请求到达时计数，默认原样转发；测试断言各分支的日志键、`FEISHU_LOGIN_SEND_ATTEMPT` 条数等于接收侧收到的发送请求数（含以 Mock 故障注入 `500`、`disconnect_after_accept` 触发的服务重试），以及请求中不出现 `app:<FEISHU_APP_ID>` 标签，并对每个非 `active` 行断言敏感字段为空。

FSL-149 的用例另由代理按路径脚本化单个请求：暂扣后转发（构造查询逆序完成、查询期间作废或推进到期）、暂扣后自行应答（构造发送期间的同 flow 重发、消费、清理与「过期但清理未运行」四种交错）、转发给 Mock 后不应答（Mock 已记录送达、服务侧超时）以及既不转发也不应答（超时且未送达）。`email_seq` 的先后另在存储层以相同或倒序的 `created_at` 断言。同一邮箱的两次预约之间须隔开 60 秒冷却（FSL-145），这些用例把前一预约的 `created_at` 改写到 61 秒前（`expires_at` 不变，预约仍未过期）再做第二次预约。两个连接并发调用 `reserve` 预约同一邮箱时，后者在前者提交前阻塞于邮箱锁，先取得邮箱锁者提交，后者在锁释放后被邮箱冷却拒绝且不新增行；持有邮箱锁约 1 秒令 `reserve` 等待时（前一同邮箱预约位于冷却窗口之外），`created_at` 不早于锁释放时刻且 `expires_at - created_at` 恰为 2 分钟。预约与激活的串行以受控交错断言：A 的预约移出冷却窗口后，A 的激活在「最新预约」校验之后、激活写入之前暂停并持有邮箱锁，同一邮箱的预约 B 在邮箱锁上等待，直到 A 提交后才提交并取得更大的 `email_seq`，随后 B 的激活作废 A。唯一索引的纵深防御以两个连接构造：前一同邮箱预约位于冷却窗口之外，`reserve` 在冷却与预算判定通过之后、插入之前暂停，此时另一连接绕过邮箱锁直接插入同一序号并停在提交前，`reserve` 随后在唯一索引上等待，断言另一连接提交成功、`reserve` 返回 `retry`（而不是 `cooldown`）。另以第三个连接持有邮箱锁、本行行锁或将被作废的旧 `active` 行的行锁，断言在激活或回写等待锁期间到期的行不被激活、不被回写，且旧 `active` 行保持不变；自 FSL-160 起 token 在 `deliver` 开始时取得，两个并发请求共用一次被暂扣后返回 HTTP 429 的 token 刷新时，断言两者都判为查询失败（`provider_failed`）、本行作废、只有 1 次 token 请求且不查询、不发私聊。

FSL-160 的用例向服务注入时钟（真实时钟加偏移），代理以该时钟记录每个请求的到达时刻：分别在开始发码前（暂停 `beginDelivery` 的语句）、两次通讯录调用之间（暂扣按邮箱搜索）、激活之后首次发送之前（暂扣按 open_id 读取）与两次发送尝试之间（暂扣首次发送并应答 HTTP 500）把服务时钟推过截止时间（数据库时钟不变），断言没有任何飞书请求在截止时间之后到达（服务在测试读取 `startedAt` 之后才读时钟，截止时间不早于 `startedAt + 120 秒`，因此断言每个请求的到达时刻都早于该值；两次通讯录调用之间的用例另以服务时钟比数据库慢、快 10 分钟各运行一次），以及 token、通讯录或发送请求的条数与终态（前两者作废本行，首次发送前越过时按 `rejected` 作废本行，重试之间越过时按此前的 `unknown` 保持 `active`）；另以「token 有效期（30 秒）短于刷新余量（60 秒）」「首次 token 刷新返回 HTTP 500」「发送 `unknown` 重试 2 次」三种情形断言每个预约只有 1 次 token 请求。

FSL-145 的用例以代理收到的全部请求数断言飞书调用次数：同一邮箱 60 秒内的第二次请求（含未命中邮箱的重复请求）不发起任何飞书请求、不写入新行；冷却边界（58 秒内拒绝、61 秒后放行）；以注入时钟（预约提交之后，测试连接池把后续语句读取的 `clock_timestamp()` 推后 121 秒）使预约在开始发码时已过期，断言不发起任何飞书请求且本行置为 `void`；最近 60 秒内已有 120 行时新请求（已知与未知邮箱）不调用飞书、不写入新行，119 行或窗口外的行不阻止预约；冷却与预算各自在窗口即将结束时每 50 毫秒重试一次，断言重试期间行数不变、窗口结束后立即放行；另以一个连接持有全局锁，断言预约先持有邮箱锁、再等待全局锁。并发用例以多个连接交错执行：同一邮箱的两个请求（一个停在预约提交前、另一个在邮箱锁上等待，以及不加控制的并发）恰好触发一次飞书查询；预算剩余 1 个名额时，不同邮箱的多个请求（一个停在预约提交前、其余各自持有邮箱锁并在全局锁上等待，以及不加控制的并发）合计只触发一次飞书查询；飞书查询被代理暂扣期间以 `pg_locks` 断言没有任何已授予的咨询锁，并断言 `FEISHU_LOGIN_COOLDOWN` / `FEISHU_LOGIN_GLOBAL_BUDGET` 日志键的条数。

FSL-154 起上述用例中断言已授予或正在等待的咨询锁集合的，按新的锁顺序包含 flow 锁（预约先持有 flow 锁与邮箱锁、再等待全局锁）。`packages/engine/src/services/feishu-login/flow-binding.integration.test.ts`（FSL-154）同样使用一次性 PG、真实 `apps/feishu-mock` 进程与记录代理，以 `consumeFeishuLoginCode` 判定验证码是否有效（本套件不建绑定、也不传入 `newUserId`，因此不建号：有效的验证码返回 `unbound` 且事务回滚、不改变该行）：同一 flow 中 A 的验证码有效后，B 的 `reserve` 提交即令其无效，B 分别为命中、未命中、被冷却拒绝与被预算拒绝（后两者不写新行）；A 激活已提交、代理暂扣 A 的私聊期间插入 B，断言 A 的私聊随后仍送达而其验证码无效；代理暂扣 A 的按邮箱搜索期间 B 被冷却拒绝或获准，断言 A 不发私聊；两个连接并发与受控交错（B 在 A 激活持有的 flow 锁上等待）后该 flow 至多一行 `active` 且为序号最大的行；`reserve` 期间代理未收到请求、飞书调用期间没有已授予的咨询锁；前次请求为命中、未命中、多人时后一次 `reserve` 的作废语句影响行数都为 1，本 flow 预置 1000 行历史记录时只有序号最大的一行产生新版本（`xmin`），`created_at` 相同或倒序时按 `flow_seq` 作废，在 flow 锁上等待后提交的预约取得更大的 `flow_seq`；命中、未命中、多人、不在职与飞书调用失败五种结果下，预约、开始发码与写回事务取得的咨询锁序列（flow → 邮箱 → 全局，flow → 邮箱）与加锁语句都相同。

`packages/engine/src/services/enterprise/feishu/http.test.ts` 以脚本化的 `fetch` 固定传输层现有的重试基线（默认 3 次、暂时性失败重试、永久性失败不重试），并断言 `maxAttempts: 1` 对 5xx、429、连接中断与超时都只发起一次 HTTP 请求；FSL-160 另断言已过截止时间时不调用 `fetch` 并抛出 `transport_deadline`、单次尝试的计时器恰为 `min(传输预算, deadline − 当前时间)`（含传输层重试的第二次尝试）、截止时间之后不再重试，以及不传 `deadline` 时重试与预算不变。`token.test.ts` 以本地 HTTP 服务断言已过截止时间的调用不发请求、两个截止时间不同的调用共享一次刷新时较早截止者在其截止时间以 `transport_deadline` 返回而共享刷新照常完成、刷新请求的单次超时受首个调用方截止时间约束，以及不传 `deadline` 的调用方照旧共享并等待同一次刷新。

## HTTP 接口

飞书登录的 HTTP 端点由 `@megaui/auth` 的 better-auth 插件 `feishuLogin`（`packages/auth/src/feishu-login/`，插件 ID `megaui-feishu-login`）提供。`createAuth` 只在收到 `feishuLogin` 选项（`{ issue: { reserve, deliver }, log?, verify? }`；`issue` 缺少任一端口时构造即抛出 `INVALID_FEISHU_LOGIN_PLUGIN_CONFIG`）时注册该插件，未传入时两个端点都不存在（404）；verify 端点另外只在选项含 `verify`（`{ pool, appId, otpHmacKey, log? }`：数据库连接池、`FEISHU_APP_ID`、解码后的 32 字节 `ENTERPRISE_OTP_HMAC_KEY` 与只接收稳定日志键的 `log`（默认 `console.warn`，FSL-152），缺少应用 ID、密钥不是 32 字节或 `log` 不是函数时构造即抛出 `INVALID_FEISHU_LOGIN_PLUGIN_CONFIG`）时注册，否则为 404。Web 只在飞书模式下传入该选项（含 `verify`），见下文「启用条件」。

### 启用条件

Web（`apps/web/lib/auth.ts`，FSL-150）只在 `AUTH_PROVIDER` 去掉首尾空白后非空、且 `resolveAuthMode`（见「配置」）的结果为 `enterprise` + `feishu` 时（`isFeishuWebMode`）启用飞书登录：

- **认证实例：** `getAuth()` 不查询企业运行时注册表，返回飞书模式的认证实例（`createFeishuWebAuth`）。它以 `readFeishuLoginConfig(process.env)` 的应用 ID、应用密钥、HMAC 密钥与 provider 目标，以 `BETTER_AUTH_URL` 作为私聊中的可信站点，以 `@megaui/auth` 的 `generateEnterpriseOtpCode` 作为验证码生成器，在 `DATABASE_URL` 上的共享连接池上构造 engine 的签发服务（`createFeishuLoginIssuer`），再以 `feishuLogin: { issue: { reserve, deliver }, log, verify: { pool, appId, otpHmacKey, log } }` 传给 `createAuth`：request 与 verify 两个端点、操作白名单（见「操作白名单」）与密钥一致性检查因此都注册。不传入任何现有企业配置项（`enterprisePairing`、`enterpriseOperationPolicy`、`enterpriseSession`），也不传入社交登录 provider。插件与 verify 的 `log` 只经 `console.warn` 输出稳定日志键；签发服务的日志键沿用 engine 默认的 `console.info`。实例在同一 JS 模块实例内缓存，认证密钥与地址、邮件配置、`NODE_ENV` 或飞书登录的键变化时重新构造。配置无效时 `getAuth()` 以 `INVALID_FEISHU_LOGIN_CONFIG` 抛错。
- **中间件：** `/api/auth/*` 在「会话」所述的 `/get-session`、`/sign-out` 之外放行 `/feishu-login/request` 与 `/feishu-login/verify`，同样按路径逐字匹配，变体返回 404。
- **启动钩子：** `apps/web/instrumentation.ts` 的 `register()`（Node 运行时；Next 在处理任何请求之前等待它）在飞书模式下不初始化企业运行时，改为调用 `startFeishuWebRuntime`：先以 `readFeishuLoginConfig` 校验配置（无效时 `register()` 以 `INVALID_FEISHU_LOGIN_CONFIG` 拒绝、不启动清理），再以共享连接池（`@megaui/database` 默认连接超时 5 秒）调用 `startFeishuLoginCleanup` 并等待它的第一次执行结束（成功或失败，见「数据」的「到期清理」）。它不构造认证实例，因此第一次清理不依赖惰性的 `getAuth()`。同一 JS 模块实例中再次调用时等待已有的启动，不启动第二个调度。启动钩子不安装任何信号处理器，清理定时器 `unref()`，关闭沿用 Next 的默认行为。
- **其它模式：** `legacy`（`AUTH_PROVIDER` 未设置或为 `local`）、未设置 `AUTH_PROVIDER` 的 `enterprise` 与 `maintenance`，以及 `resolveAuthMode` 拒绝的组合，`getAuth()` 与 `register()` 都沿用本卡之前的路径，不注册插件、不启动清理。两个端点在 `legacy` 下由 better-auth 返回 404，在其余情形下由中间件返回 404 `{ "error": "NOT_FOUND" }`。

**测试：** `apps/web/tests/contract/feishu-login-request.spec.ts` 使用一次性 PG、真实 Feishu Mock 进程（simulator provider）与生产的 `getAuth()`（不替换认证实例），经真实中间件与 `/api/auth/[...all]` 路由断言：飞书模式下 request 返回 202 并设置 flow Cookie；以 Mock 收件箱中的验证码完成 verify、取得会话 Cookie，以该会话经中间件与 BFF 的 `collab/token` 取得协作票据，以相同 `AUTH_MODE` / `AUTH_PROVIDER` 与票据密钥启动的 collab-server 进程接受以该票据建立的 Hocuspocus 连接（客户端在独立进程中运行；collab 的文档访问使用开发用的放行判定），伪造的票据被拒绝；`legacy`（`AUTH_PROVIDER` 未设置或为 `local`）与 `AUTH_PROVIDER` 未设置或空白的 `enterprise` 下两个端点为 404、不写入验证码表、认证实例上没有插件端点；以 `createFeishuWebAuth({ nodeEnv: "production" })` 构造 production 限流（飞书配置与 Mock 不变）并冻结 `Date` 时，同一地址在 100 个受理请求之后，已知与未知邮箱得到的 429 状态码、全部响应头与响应体相同，不设置 Cookie、不写入验证码表，另一地址仍得到 202。`apps/web/tests/unit/feishu-login-wiring.test.ts` 以一次性 PG 预置已过期的 `active` 行，直接调用 `register()` 且不发任何请求，断言返回时该行已为 `void` 且敏感字段为空、`createAuth` 未被调用、未初始化企业运行时、`SIGTERM` / `SIGINT` 监听器数不变；再次调用不启动第二个调度；配置无效时 `register()` 拒绝且不启动清理；`legacy`（含 `local`）、未设置 `AUTH_MODE`，以及 `AUTH_PROVIDER` 未设置或空白的 `enterprise` 不启动清理（该行保持 `active`）并仍调用企业运行时初始化（以替身替换）。`apps/web/tests/contract/feishu-login-shutdown.spec.ts` 在 `OwnedWeb` 的源码副本与一次性 PG 上以飞书模式启动独立的 `next dev` 子进程（Mock 作为 simulator），在首个健康检查成功且预置的过期行已为 `void` 之后向该进程发送一次 `SIGTERM`，断言它在 10 秒内以 0 或该信号退出、其进程组在进程表中没有存活成员，并静态断言 `instrumentation.ts` 不注册 `SIGTERM` / `SIGINT` 处理器。该用例只覆盖 `next dev`，不覆盖 standalone 构建。

### request

`POST /api/auth/feishu-login/request`（插件路径 `/feishu-login/request`，FSL-123），请求体恰为 `{ "email": "<邮箱>" }`（JSON，至多 4096 字节）。

**输入校验**（`input.ts` 的 `normalizeFeishuLoginEmail`）：先去掉首尾空白、整体转小写，再要求长度为 1–254 个字符且符合本应用既有的邮箱语法，即 better-auth 邮箱路由与 Web 表单所用的 zod 4 `z.email()` 默认模式（`zod@4.5.4` `v4/core/regexes.js` 的 `email`，复制为等价写法，`@megaui/auth` 不直接依赖 zod）。

| 情形 | 状态码 | 响应体 | flow Cookie | 签发端口 |
|---|---|---|---|---|
| 媒体类型不恰为 `application/json`；请求体超过 4096 字节、为空或不是合法 JSON；请求体不是恰含 `email` 一个字段的对象；或 `email` 不是字符串、规范化后为空、缺少 `@`、超过 254 个字符、含内部空白或其它不符合语法 | 400 | `{ "code": "INVALID_INPUT" }` | 不设置 | 都不调用 |
| 合法邮箱，密钥指纹与已存值不同或检查失败（FSL-161，仅在传入 `verify` 选项时检查，见「数据」的「密钥一致性检查」） | 503 | `{ "status": "unavailable" }` | 不设置 | 都不调用 |
| 合法邮箱，`reserve` 拒绝或同步抛错（预约事务失败，含唯一冲突，FSL-154） | 503 | `{ "status": "retry" }` | 不设置 | `reserve` 已调用，`deliver` 不调用 |
| 合法邮箱，`reserve` 成功（含被冷却或预算拒绝），请求不带有效 flow Cookie | 202 | `{ "status": "accepted" }` | 签发新 flow | `reserve` 在 `auth.handler` 确定响应之前完成，`deliver` 在响应确定之后调用（见下文「签发端口」） |
| 合法邮箱，`reserve` 成功（含被冷却或预算拒绝），请求带有效 flow Cookie | 202 | `{ "status": "accepted" }` | 以同一值重新设置 | `reserve` 在 `auth.handler` 确定响应之前完成，`deliver` 在响应确定之后调用（见下文「签发端口」） |

上表的 400、503 与 202 带 `Cache-Control: no-store`（限流 429 由 better-auth 返回，不保证带该头）。媒体类型须恰为 `application/json`（可带 `charset` 等参数，不区分大小写）。上表的 400 由插件的 `onRequest` 钩子在框架解析请求体之前给出（位于限流之后、端点之前，各环境都执行）：钩子读取请求的副本，按实际读取的字节计（不依赖 `Content-Length`），累计读取超过 4096 字节（`FEISHU_LOGIN_PRECHECK_MAX_BODY_BYTES`）即停止并取消读取（按流的分块计：越限的那一块已被读入，因此已读字节至多为 4096 加一个分块的大小，不会继续读取后续分块），只有媒体类型相符、请求体不超过 4096 字节、是合法 JSON 且通过上述校验的请求才进入端点，其余请求一律返回 400 `INVALID_INPUT`。因此任何请求体都不会在通过这一有界检查之前被完整读取，框架自身的 415 与 `BAD_REQUEST` 不会出现在本路径上；端点内仍保留同一校验作为纵深防御。

**限流**：better-auth 自带的按地址与路径限流在 production 照常以其默认窗口与上限作用于端点会受理的请求，触发时返回 better-auth 的 429，只取决于地址与路径、与邮箱无关。better-auth 在进入任何端点与插件钩子之前判定限流，因此 `createAuth` 为本路径登记限流规则函数 `feishuLoginRequestRateLimitRule`：它读取请求的副本（累计超过 4096 字节即停止，按分块计，见上文；原请求体保持完整），只有端点会受理的请求才沿用 better-auth 解析出的规则并计数；其余请求（媒体类型不符、超过 4096 字节、非合法 JSON 或未通过上述校验）不计数、不受限流，由上述钩子返回 400。这样保持 ADR-FSL-11 的响应顺序「输入非法 400 先于限流 429」，且豁免的请求都不会被受理，不构成限流绕过。非法输入不做任何签发工作。

**flow Cookie**（`cookie.ts`）：名称 `__Host-megaui.feishu-login-flow`，属性 HttpOnly、Secure、SameSite=Lax、Path=/、Max-Age=600，不带 Domain。flow 是 CSPRNG 生成的 256 位随机值，以无填充 base64url 编码（43 个字符）。请求的 `Cookie` 头恰含一个该名称的 Cookie 且其值是规范的 32 字节 base64url 时视为有效，沿用该 flow 并以同一值重新设置 Cookie，Max-Age 重新计为 600 秒（剩余有效期不足 5 分钟的 Cookie 也续期 10 分钟，保证新验证码 5 分钟有效期内 Cookie 不会先到期）；没有该 Cookie、值不规范或重复出现时签发新 flow。服务端不保存 flow 明文：签发端口与验证码表只接收其 SHA-256（64 个小写十六进制字符）。

**签发端口**（FSL-154 起分为两段；飞书模式的 Web 注入 engine 的 `reserveFeishuLoginCode` 与 `deliverFeishuLoginCode`，FSL-150）：

- **`reserve({ flowHash, email })`**：只访问数据库的预约事务（作废本 flow 最新行、冷却与预算判定、写入预约，见「发码」的「flow 绑定」）。端点在校验输入、确定 flow 之后等待它完成，`auth.handler` 只在它兑现（即预约事务已提交，含被冷却或预算拒绝）之后才返回 202；它的返回值不被端点读取，原样交给 `deliver`。它拒绝或同步抛错时返回 503 `{ "status": "retry" }`、不设置 Cookie、不调用 `deliver`，只输出稳定日志键 `FEISHU_LOGIN_RESERVE_FAILED`（不输出错误对象、邮箱或 flow）；用户重试即可。拒绝通常意味着预约事务已回滚、数据库未改变（含唯一冲突的 `FEISHU_LOGIN_RESERVE_RETRY`）；只有在提交阶段连接中断时提交结果未知，此时作废与预约可能已经提交，503 不保证数据库未改变（重试同样先作废该 flow 的最新行）。engine 的 `reserveFeishuLoginCode` 在事务提交之后不再抛错：被冷却或预算拒绝时输出日志键失败（日志函数抛错）被忽略，结果照常兑现，request 照常返回 202。
- **`deliver(reservation)`**：飞书查询、激活与私聊。端点在 202 的响应确定之后以 `setImmediate` 把它排到当前同步执行段之后，在同一 Node 进程内异步执行，请求不等待其结果：`auth.handler` 返回的 `Response` 在 `deliver` 被调用之前已经完整确定（状态码、响应体与 Cookie 都不依赖 `deliver`）。本插件的保证止于 `auth.handler` 的边界：响应字节何时写到客户端由宿主服务器（FSL-150 的 Next 路由）决定，`deliver` 调用可能早于字节写出，但不能改变已经确定的响应。`deliver` 的返回值不被读取；它拒绝或同步抛错时只输出稳定日志键 `FEISHU_LOGIN_ISSUE_FAILED`，请求仍为 202。进程在 `deliver` 执行前退出时本次验证码不会发出，用户重新请求即可（ADR-FSL-11）。

两个日志键与密钥检查的 `FEISHU_LOGIN_KEY_MISMATCH` 默认经 `console.warn` 输出；日志函数本身抛错时被吞掉，不产生未处理的 Promise 拒绝。

请求路径不访问飞书、不查询账号或身份，因此已知、未知与多人邮箱的状态码、响应体与 Cookie 属性相同（202 与 503 两种结果各自如此）；带同一 flow Cookie 时 `Set-Cookie` 逐字节相同。响应前只做数据库预约（FSL-154），其工作量与锁序列不依赖前次请求的飞书结果，耗时随数据库负载与锁等待波动，不承诺严格常数时间。

`packages/auth/src/feishu-login/request.test.ts` 以 `createAuth` 加注入的 `reserve` / `deliver` 端口构造，经 `auth.handler` 断言上述响应、Cookie 属性与续期、`reserve` 收到的规范化邮箱与 flow 哈希、`deliver` 收到 `reserve` 的返回值、400 时不设置 Cookie 且两个端口都不调用、`reserve` 未完成时响应未返回、响应先于 `deliver` 调用返回、`reserve` 拒绝或同步抛错时为 503 `{ "status": "retry" }`（不设置 Cookie、不调用 `deliver`、已知 / 未知 / 多人邮箱同形）、`deliver` 出错时仍为 202 且只记录稳定日志键、缺少任一端口时构造失败、未传入选项时端点为 404，以及 production 限流配置下同一地址超限后非法输入（含超过 4096 字节的请求体）仍返回 400、已知 / 未知 / 多人邮箱返回相同的 429。

### verify

`POST /api/auth/feishu-login/verify`（插件路径 `/feishu-login/verify`，FSL-124 成功路径，FSL-151 失败路径与并发，FSL-125 首次登录建号，FSL-152 建号的冲突、回滚与并发，FSL-169 会话签发失败的补偿），请求体恰为 `{ "code": "<验证码>" }`（JSON，至多 4096 字节），flow 取自请求的 flow Cookie（读取规则同 request）。

**输入校验**（`verify.ts` 的 `normalizeFeishuLoginCode`）：`code` 须为字符串，去掉首尾空白并整体转大写后恰为 8 个字符，且每个字符都属于验证码字母表 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（与发码所用生成器同一字母表）。

| 情形 | 状态码 | 响应体 | 会话 Cookie | 验证码行 |
|---|---|---|---|---|
| 媒体类型不恰为 `application/json`；请求体超过 4096 字节、为空或不是合法 JSON；请求体不是恰含 `code` 一个字段的对象；或 `code` 不符合上述格式 | 400 | `{ "code": "INVALID_INPUT" }` | 不设置 | 不读取 |
| 格式合法，密钥指纹与已存值不同或检查失败（FSL-161，见「数据」的「密钥一致性检查」） | 503 | `{ "status": "unavailable" }` | 不设置 | 不读取 |
| 没有有效 flow Cookie；该 flow 没有任何行；该 flow 中 `flow_seq` 最大的行不是未过期的 `active` 行（已过期、`reserved`、`void`（含因错误次数达到上限而作废）、`consumed`，含已消费后再次提交）；该行 `failed_attempts` 已达 5 | 401 | `{ "status": "invalid" }` | 不设置 | 不改变 |
| 该行为未过期的 `active` 行且 `failed_attempts` 小于 5，验证码不相等 | 401 | `{ "status": "invalid" }` | 不设置 | `failed_attempts + 1`；加 1 后达到 5 时同一语句置为 `void` 并清空四个敏感字段 |
| 验证码相等且绑定存在 | 200 | `{ "status": "ok" }` | 设置 better-auth 会话 Cookie | `consumed`，四个敏感字段为空 |
| 验证码相等、`(app_id, open_id_hmac)` 没有绑定且建号成功（首次登录，见下文「建号」） | 200 | `{ "status": "ok" }` | 设置新用户的 better-auth 会话 Cookie | `consumed`，四个敏感字段为空 |
| 验证码相等、没有绑定，但同邮箱的本地用户已存在（插入 `user` 违反 `user_email_unique`；见下文「建号」） | 409 | `{ "status": "account_conflict" }` | 不设置 | `consumed`，四个敏感字段为空（只回滚建号，消费照常提交） |
| 验证码相等、没有绑定，建号因其它原因失败（见下文「建号」） | 500（端点抛出 `FEISHU_LOGIN_ACCOUNT_CREATE_FAILED`，由 better-auth 给出） | better-auth 的错误响应，不含数据库错误 | 不设置 | 整个事务回滚，保持 `active` |
| 校验事务已提交（验证码消费，首次登录时用户与绑定一同提交），随后读取用户失败、签发会话失败（`createSession` 抛出 better-auth `APIError` 以外的错误）或写入来源标记失败（FSL-169，见下文「会话失败的补偿」） | 503 | `{ "status": "retry" }` | 不设置 | `consumed`，四个敏感字段为空 |
| 校验事务已提交，better-auth 有意拒绝签发会话（`APIError`，例如已封禁用户；见下文「会话失败的补偿」） | better-auth 给出的状态码（已封禁用户为 403 `BANNED_USER`） | better-auth 的错误响应 | 不设置 | `consumed`，四个敏感字段为空 |

上表中的 400、401、409、503 与 200 响应带 `Cache-Control: no-store`（500 与 better-auth 有意拒绝签发时的错误响应由 better-auth 给出，本文不约定其头）。400 与 request 一样由插件的 `onRequest` 钩子在框架解析请求体之前给出（读取请求副本，累计超过 4096 字节即停止，按分块计），端点内保留同一校验作为纵深防御；所有 401 的状态码、响应体与头（不设置会话 Cookie）相同，响应不区分失败原因。

**错误次数上限**（FSL-151，`FEISHU_LOGIN_MAX_FAILED_ATTEMPTS = 5`）：错误次数按验证码行计（`failed_attempts`，预约行写入时为 0）。只有与验证码实际比较过的错码才计数，即该 flow 中 `flow_seq` 最大的行是未过期 `active` 行且 `failed_attempts` 小于 5 时；无 flow Cookie、该 flow 无行、行已过期、已作废、已消费或已达上限时不比较、不计数。第 5 次计数的错码在同一条语句中把该行置为 `void` 并清空 `email`、`open_id`、`display_name`、`code_hmac`；此后同一 flow 提交正确验证码也返回 401，用户须重新请求验证码。上限只作用于单个验证码行：同一 flow 或同一邮箱重新请求得到的新验证码从 0 开始计数（按地址的请求限流见下文）。

**限流**：verify 路径没有自定义限流规则。better-auth 的按地址与路径限流在 production 以默认窗口与上限作用于全部 verify 请求（含格式非法的请求），触发时由 better-auth 在插件钩子之前返回 429；因此 verify 的顺序是 429 先于 400，ADR-FSL-11「输入非法 400 先于限流 429」的顺序只适用于 request。

**校验事务**（`@megaui/database` 的 `consumeFeishuLoginCode`，一个事务）：

1. 以单独一条 `SELECT … FOR UPDATE` 锁定该 flow 的 SHA-256 对应的、`flow_seq` 最大的一行（不论状态；该语句只返回行 ID）。这是本事务在 `feishu_login_codes` 中锁定的唯一一行（清理、激活与发码的作废写回锁定多行时按 ID 顺序）；选中同一行的并发 verify 在此等待，直到持锁事务提交或回滚；
2. 在下一条语句（因而在任何锁等待之后，按该行最新提交的版本与一次 `clock_timestamp()` 取样）重新读取被锁定的行：只有其为 `active`、`expires_at > clock_timestamp()`、在该语句的快照中仍是该 flow 中 `flow_seq` 最大的行（锁定语句的快照之后、该语句开始之前提交的新预约会使其失去资格；该语句开始之后才提交的新预约本事务看不到；这无碍正确性：同一 flow 的每次预约都先作废该 flow 的最新行（FSL-154），该作废须等待本行锁——在本事务之前提交的预约已使本行为 `void`，在本行锁上等待的预约则在本事务结束后才作废它（已消费的行不再改写））且 `failed_attempts` 小于 5 时继续，否则返回 401 且不改变该行；该语句只对这样的行返回 `code_hmac`，因此在该语句的时钟取样时已过期（含尚未被清理）的行的敏感字段不会被该语句返回；
3. 以 `feishuLoginCodeHmac(key, 行 ID, 验证码)` 与本行 `code_hmac` 做常量时间比较（`timingSafeEqual`，两侧均为 32 字节）。不相等时以一条语句使 `failed_attempts + 1`，加 1 后达到 5 时同一语句置为 `void` 并清空四个敏感字段，提交后返回 401；
4. 相等时读取本行的邮箱、open_id 与姓名（该读取语句同样要求本行仍为 `active` 且按该语句的时钟取样未过期，此时已到期的行不会被读取敏感字段），再以一条语句把本行置为 `consumed` 并清空 `email`、`open_id`、`display_name`、`code_hmac`（该语句重复 `active` 与未过期条件，在两条语句之间到期的行不会被消费，返回 401）；
5. 以 `open_id_hmac` = HMAC-SHA256(`ENTERPRISE_OTP_HMAC_KEY`, `"feishu-identity:v1:" + app_id + ":" + open_id`)（`verify.ts` 的 `feishuLoginOpenIdHmac`，64 个小写十六进制字符，open_id 明文不落库）查找 `feishu_identities` 中 `(app_id, open_id_hmac)` 的绑定：存在时提交；不存在时于同一事务内取得该成员的身份锁、重新查找绑定后建号（见下文「建号」），调用方未传入 `newUserId` 时整个事务回滚（结果 `unbound`，verify 端点总是传入）。

**并发**：由于第 1 步的行锁，锁定同一行的并发提交依次执行：持锁者消费该行并提交后，后执行者在锁释放后读到已提交的 `consumed` 行，返回 401 且不计为错误次数（持锁者回滚时，后执行者照常判定）。因此锁定同一行的并发正确提交至多一个消费该行；当该行在首个持锁者重新判定时仍是可比较的最新未过期 `active` 行（期间没有新预约提交、没有其它请求先使其作废或消费）、成员有绑定且会话签发成功时，恰好一个返回 200（测试覆盖的即这一情形）。锁定同一行的并发错码同样依次计数，每个被比较的错码恰好计一次，计到 5 次后其余提交不再计数。

**会话**：事务提交后，以 better-auth `internalAdapter.createSession` 签发普通会话（只覆盖 `expiresAt` 为签发后 8 小时，不写入 `enterpriseGrantId`、`enterpriseIdentityId`、`authEpoch`、`authMethod` 任何企业字段），再以 `recordFeishuLoginSession` 在 `feishu_login_sessions` 写入一行该会话 ID，最后设置会话 Cookie（Max-Age 为 8 小时）。

**会话失败的补偿**（FSL-169，ADR-FSL-11「校验」）：会话在校验事务提交之后签发，失败时不能随事务回滚，按下列规则处理。下列前两种情形（读取用户或签发会话失败、来源标记写入失败）返回 503 `{ "status": "retry" }`、不设置会话 Cookie，并以 `log` 输出稳定日志键 `FEISHU_LOGIN_SESSION_FAILED`（只有该键，不含错误、邮箱或会话 ID；`log` 抛错时响应不变）；后两种情形（better-auth 有意拒绝签发、设置 Cookie 失败）不返回该 503，也不输出该键：

- **读取用户或签发会话失败**：`internalAdapter.findUserById` 抛错（任何错误）或找不到用户，或 `internalAdapter.createSession` 抛出 better-auth `APIError` 以外的错误时，端点没有拿到会话对象，不做删除。`createSession` 的插入若已提交而之后才抛错（例如提交时连接中断），该会话行没有来源标记，其 token 也未随响应发出。
- **来源标记写入失败**：`recordFeishuLoginSession` 抛错时，以 `internalAdapter.deleteSession`（按 token）删除刚签发的会话；来源标记行若在报错前已写入，随会话按外键 `on delete cascade` 一并删除。删除成功后 `session` 与 `feishu_login_sessions` 中都没有该会话的行。删除本身也抛错时，先输出 `FEISHU_LOGIN_SESSION_REVOKE_FAILED`，再输出 `FEISHU_LOGIN_SESSION_FAILED`，照常返回 503、不设置会话 Cookie；此时端点不能确定两表的状态（标记插入或删除可能已在数据库提交而确认丢失），只保证该会话的 token 未随响应发出（会话 Cookie 在来源标记之后才设置）。测试覆盖的是两者都在提交前失败的情形：会话行留在 `session` 表，没有来源标记。「来源标记写入失败后会话不在 `session` 表」只在补偿删除成功时成立。
- **better-auth 有意拒绝签发**：`createSession`（不含读取用户）抛出 better-auth 的 `APIError`（例如 admin 插件对已封禁用户抛出的 403 `BANNED_USER`）时不属于签发失败，端点原样抛出，由 better-auth 给出该错误响应，不输出日志键。已封禁用户由 admin 插件在插入会话之前的钩子拒绝，因此不建立会话（测试覆盖的即这一情形）；其它 `APIError` 是否在插入之前抛出取决于抛出它的钩子，本卡不另作保证。
- **设置 Cookie**：`setSessionCookie` 只在内存中签名并写入响应头、不访问数据库，不在补偿范围内；它抛错时端点抛错，由 better-auth 给出错误响应，已签发并写入来源标记的会话保留（至其 8 小时到期或被撤销）。

503 时验证码已在校验事务内消费（同一验证码再次提交返回 401），首次登录的用户与绑定也已随事务提交：用户重新请求验证码（同一 flow 即可）后以新验证码登录，校验事务找到该绑定，不再建号。


`packages/auth/src/feishu-login/verify.test.ts` 以 `createAuth` 加一次性 PG、预置用户与绑定构造，验证码经签发存储的 `reserve` / `activate` 写入，经 `auth.handler` 断言：正确验证码返回 200；响应设置会话 Cookie 且以该 Cookie 调用 `get-session` 得到绑定用户；`feishu_login_sessions` 恰有该会话一行；会话的四个企业字段为空、有效期为 8 小时；已消费的验证码再次提交返回 401 `{ "status": "invalid" }`；错码返回 401 且该行 `failed_attempts` 逐次加 1；第 5 次错码后该行为 `void` 且四个敏感字段为空，此后正确验证码返回 401；已过期的验证码返回 401 且该行既不被消费也不计数；无 flow Cookie 与该 flow 无验证码时返回同一 401；无绑定且同邮箱本地用户已存在（建号冲突）时返回 409 `{ "status": "account_conflict" }`、验证码行为 `consumed`（FSL-152）；同一验证码的两个并发正确请求恰好一个返回 200、只签发一个会话；格式非法时返回 400；未传入 `verify` 选项时 verify 为 404。`packages/database/src/feishu-login-store.integration.test.ts` 断言消费后该行为 `consumed`、四个敏感字段为空且其余各列不变；错码只使 `failed_attempts` 加 1、其余各列不变，第 5 次错码在其余各列不变的前提下置为 `void` 并清空四个敏感字段，之后正确与错误验证码都不改变该行；已达上限的 `active` 行、已过期、已消费、非最新行（含锁定之后才出现更新的预约行）与无绑定（未传入 `newUserId`）时该行不变（已过期的 `active` 行另断言事务内各语句返回的结果中四个敏感字段均为空）；另以在读取邮箱、open_id 与姓名的语句之前于同一事务内使本行到期的方式，断言该语句不返回行、结果为 401 对应的 `invalid`。并发用例使用两个连接池：第一个连接在锁定并比较之后、消费之前暂停，断言另一连接池的连接在锁定语句上等待行锁，放行后恰好一方消费、另一方为 `invalid` 且不计数；另有十个同时提交恰好一个消费、七个同时提交的错码使该行停在 5 次并作废。

### 建号

首次登录建号由 FSL-125 交付，其冲突、回滚与并发由 FSL-152 交付（ADR-FSL-11「校验」）。规则：

- **时机：** 只在校验事务第 5 步发现 `(app_id, open_id_hmac)` 没有绑定时发生，即验证码已与该 flow 最新的未过期 `active` 行常量时间比较相等、该行已在同一事务内置为 `consumed` 并清空四个敏感字段之后；错码、过期、作废、已消费等任何 401 情形都不建号。写入 `user` 与 `feishu_identities` 的只有校验事务，request 与发码路径不写这两张表。
- **同一事务：** 新用户与绑定在消费验证码的同一事务内写入：建号成功时与消费一同提交；同邮箱本地用户已存在时只有建号回滚、消费照常提交（见下文「冲突」）；其它失败时与消费一同回滚（见下文「整体回滚」）。
- **新用户：** 直接写入 better-auth 的 `user` 表一行：`id` 为本 auth 实例的 better-auth ID 生成器（`ctx.context.generateId({ model: "user" })`，未改配置时为 32 位随机字母数字）生成的新值；`email` 为该行暂存的登录邮箱（request 规范化后的小写邮箱）；`email_verified` 为 `true`；`name` 为发码时从通讯录读取并暂存的姓名；`role` 为 `'user'`（better-auth `admin` 插件为新用户写入的默认角色）；`image` 为空，`banned` 取列默认值 `false`。不创建 `account` 行（飞书用户没有密码或社交登录凭据）。
- **绑定：** 随后在 `feishu_identities` 写入一行 `(app_id, open_id_hmac, user_id)`，`app_id` 为 `FEISHU_APP_ID`，`open_id_hmac` 同第 5 步；表中没有 `open_id` 列，open_id 明文不落库（只在 `active` 行中短期暂存，消费时已清空）。
- **会话：** 事务提交后与已有绑定的用户相同：签发 8 小时普通会话、写入 `feishu_login_sessions`、设置会话 Cookie，响应 200 `{ "status": "ok" }`；其中读取用户失败、签发会话失败（better-auth `APIError` 以外的错误）或写入来源标记失败时返回 503 `{ "status": "retry" }`，用户与绑定保留，下一次登录不再建号（见上文「会话失败的补偿」）。
- **再次登录：** 同一成员（同一应用下同一 open_id）再次登录时第 5 步找到绑定，直接以该用户签发会话，不新建用户，也不新建或改写绑定；绑定不随登录邮箱变化（同一成员以另一邮箱登录时同样找到该绑定）。
- **同一成员的其它 `active` 行：** 建号只消费本 flow 的最新行，本次建号不改变同一成员其它邮箱（或其它 flow）的 `active` 行；该行此后仍受其自身的规则约束（它所在 flow 的新预约、同邮箱新验证码的激活、以它校验，都可能在到期前改变它），否则按到期与清理合同处理：到期清理在其到期前不改变它，到期后将其置为 `void` 并清空敏感字段（见「数据」）。

**冲突（FSL-152）：** 建号不合并任何既有账号。成员没有绑定、而 `user` 中已有登录邮箱的本地用户（不论其是否绑定了其它成员）时，插入 `user` 违反 `user_email_unique`：校验事务回滚到建号前设置的保存点，不新建或修改任何用户、不写入绑定，验证码的消费照常提交（该行为 `consumed`、四个敏感字段为空，同一验证码再次提交返回 401），端点以 `log` 输出稳定日志键 `FEISHU_LOGIN_ACCOUNT_CONFLICT`（只有该键，不含邮箱、open_id 或数据库错误；`log` 抛错时响应不变），返回 409 `{ "status": "account_conflict" }`，不签发会话、不设置会话 Cookie。冲突由既有账号引起，重新请求验证码不能消除它；本计划不提供合并入口。

**整体回滚（FSL-152）：** 建号的两条插入因 `user_email_unique` 以外的任何原因失败（含违反 `feishu_identities_app_open_id_hmac_unique`，只有绕过身份锁的写入方才可能引起）时，整个校验事务回滚：不写入用户与绑定，消费也被回滚（该行保持 `active`，各列不变）。端点抛出 `FEISHU_LOGIN_ACCOUNT_CREATE_FAILED`（不附带数据库错误，其明细可能含邮箱），由 better-auth 返回 500，不设置会话 Cookie。由于消费被回滚，只要该行仍是该 flow 最新的未过期 `active` 行（未到期、未被同一 flow 的新预约或同邮箱新验证码的激活作废、错误次数未达上限），同一验证码可以再次提交并重新进入校验；故障已消除、建号与会话签发都成功时，这次重试完成首次登录（测试覆盖的即这一情形）。

**并发（FSL-152）：** 校验事务以第一条语句把自身固定为 `READ COMMITTED`（不受数据库或会话默认隔离级别影响），因此其后每条语句都取新快照。第 5 步找不到绑定且需要建号时，校验事务先取得该成员的事务级咨询锁（`FEISHU_LOGIN_IDENTITY_LOCK_CLASS` = `0x46534c04`，第二个键为 `feishuLoginIdentityLockKey(open_id_hmac)`，即 `open_id_hmac` 前 32 位的有符号整数；持有到事务结束），再以新的语句重新查找绑定：找到时（同一成员经另一 flow 的并发首次登录已在此期间提交）以该用户签发会话，不新建用户；仍不存在时才建号。因此同一成员经两个 flow（两行 `active` 验证码）同时首次登录时至多建立一个用户和一条绑定：后取得身份锁者在先取得者提交后找到其绑定、以该用户继续（先取得者回滚时，后取得者照常建号）。两次校验在各自的消费语句执行时都仍满足消费条件（该行仍是各自 flow 最新的未过期 `active` 行且验证码正确）、没有同邮箱的本地用户、建号插入与两次会话签发都成功时，两者都返回 200 且会话属于同一用户（测试覆盖的即这一情形）。身份锁只由校验事务取得，且在本事务唯一的验证码行锁之后；持有它的事务不再等待 `feishu_login_codes` 的行锁或 flow、邮箱、全局三把咨询锁（只可能等待另一事务对同一邮箱的 `user` 插入，而那个事务不等待本事务），因此不引入死锁。已有绑定的再次登录不取身份锁。

`packages/auth/src/feishu-login/signup.test.ts` 以 `createAuth` 加一次性 PG（不预置用户与绑定）构造，验证码经签发存储的 `reserve` / `activate` 写入，经 `auth.handler` 断言：首次登录返回 200 且 `user` 表恰好新增一行，`get-session` 返回该用户；新用户的邮箱等于登录邮箱、`email_verified` 为 `true`、姓名等于发码时暂存的姓名（含中文），`role` 为 `user`、未封禁、无头像；`feishu_identities` 恰有一行 `(app_id, open_id_hmac, user_id)` 且 `open_id_hmac` 等于独立计算的 HMAC；同一成员以新验证码再次登录返回 200、`user` 与 `feishu_identities` 各行不变，会话属于同一用户；同一成员以另一邮箱登录时同样如此。回归断言：已消费行的四个敏感字段为空；`feishu_identities` 的列恰为 `app_id`、`created_at`、`open_id_hmac`、`user_id`，其行内容不含 open_id 明文；同一成员第二个邮箱同时存在的 `active` 行在首次登录后仍为 `active`，邮箱、open_id、姓名、验证码 HMAC、到期时间与错误次数不变；以注入时钟清理时，到期前的清理不改变该行任何列，到期后的清理将其置为 `void` 并清空敏感字段。另断言错码与过期验证码不建号。

FSL-152 的用例：同邮箱本地用户已存在而无绑定时返回 409 `{ "status": "account_conflict" }`（带 `Cache-Control: no-store`、不设置会话 Cookie、不签发会话），注入的 `log` 恰好收到一次 `FEISHU_LOGIN_ACCOUNT_CONFLICT`，验证码行为 `consumed` 且四个敏感字段为空，同一验证码再次提交返回 401；冲突前后 `user` 表全部行的全部列不变（含另一无关本地用户），且不写入绑定；持有该邮箱的是另一成员首次登录建立的用户时，该用户与其绑定同样不变；未传入 `log` 时 `console.warn` 恰好收到该键，`log` 抛错时仍返回 409。以测试数据库中的触发器分别在插入 `user` 与插入绑定（插入 `user` 之后）时注入故障（错误消息含新行内容，即含邮箱），断言返回 500、不设置会话 Cookie、响应与控制台输出都不含邮箱，`user` 与 `feishu_identities` 为空、验证码行全部列不变、没有会话，移除触发器后以同一验证码重试返回 200 且只建立一个用户。并发用例以同一成员的两个 flow 各一行 `active` 验证码（成员的两个邮箱，以及以伪造的邮箱 HMAC 构造的同一邮箱两行）两路交错执行：第三个连接先持有该成员的身份锁，两个校验事务在各自的连接上消费各自的行、未找到绑定后在身份锁上等待（以 `pg_locks` 断言恰有两个未授予的请求，此时 `user` 为空），放行后两者都返回 200、`user` 与 `feishu_identities` 各恰有一行、两个会话属于同一用户、两行都为 `consumed`；另以不加控制的两路并发重复 5 轮，每轮只建立一个用户和一条绑定；并在每个连接默认隔离级别为 `REPEATABLE READ` 的另一连接池上（verify 与 better-auth 都使用它）重复两种受控交错用例，断言结果相同。`verify.test.ts` 中无绑定且邮箱已被预置用户占用的用例同样断言 409 与 `consumed`。

FSL-169 的用例（同在 `signup.test.ts`，以测试数据库中的触发器注入故障）：首次登录时 `session` 的插入失败，与首次登录时 `feishu_login_sessions` 的插入失败（另以 `session` 上的插入审计触发器证明会话曾经签发），各自断言 503 `{ "status": "retry" }`、带 `Cache-Control: no-store`、不设置会话 Cookie、响应与控制台输出都不含注入的数据库错误（其消息含该行内容，`session` 行含 token）、`session` 与 `feishu_login_sessions` 都没有行、注入的 `log` 恰好收到一次 `FEISHU_LOGIN_SESSION_FAILED`、验证码行为 `consumed`、用户与绑定各一行；已有绑定的再次登录时把 `user` 表临时改名使读取用户抛错，或以替身使 `findUserById` 返回空、抛出 better-auth `APIError`，同样断言 503 与两表无行。这些情形随后都断言原验证码再次提交返回 401，再经 request 端点在同一 flow 重新请求验证码（其 `reserve` 为签发存储的预约，`deliver` 以 Mock 代替飞书查询与私聊、激活预约行），以新验证码登录返回 200，`user` 全部行的全部列与 `feishu_identities` 不变，会话属于原用户且恰有一行来源标记。另断言：来源标记写入与会话删除同时失败时依次输出 `FEISHU_LOGIN_SESSION_REVOKE_FAILED`、`FEISHU_LOGIN_SESSION_FAILED`，仍返回 503 且不设置会话 Cookie，`session` 留一行、`feishu_login_sessions` 无行，随后同样重新取码登录成功且不新建用户（残留的未标记会话行仍在）；未传入 `log` 时 `console.warn` 恰好收到 `FEISHU_LOGIN_SESSION_FAILED`，`log` 抛错时仍返回 503；已封禁用户登录时返回 better-auth 的 403 `BANNED_USER`，不新增会话或来源标记、不输出日志键。

## 页面

飞书模式下的登录页为 `/[lang]/signin/feishu`（`apps/web/app/[lang]/(auth)/signin/feishu/page.tsx`，FSL-129）。页面是请求时渲染的服务端组件：只在 `resolveWebSessionEntry()` 为 `feishu`（与中间件同一判定，即 `AUTH_MODE=enterprise`、`AUTH_PROVIDER=feishu`）且语言有效时渲染，其它模式下为 404。中间件只在飞书模式下把该路径（可带一个结尾斜杠）作为认证页放行：访客可直接访问，已登录用户与 `/[lang]/signin` 一样被重定向到 `/[lang]/workspace`；其它模式下它不在公开路由内，访客被重定向到 `/[lang]/signin`。登录入口切换到本页由 FSL-131 完成。

**入口（FSL-131）：** 飞书模式下 `/[lang]/signin`（`apps/web/app/[lang]/(auth)/signin/page.tsx`，请求时渲染）不渲染任何内容，以 307 转到 `/[lang]/signin/feishu`，保留全部查询参数的键与值（重新序列化，同名参数的值按原顺序保留）；判定同为 `resolveWebSessionEntry() === "feishu"`。中间件本身不变：访客访问受保护页面时仍被 302 到 `/[lang]/signin?callbackUrl=<原路径>`，再经上述 307 到达本页（本页目前不读取 `callbackUrl`，登录后进入首页）；已登录用户访问 `/[lang]/signin` 仍被中间件 302 到 `/[lang]/workspace`。因此飞书模式下不再显示邮箱密码表单、社交登录按钮与注册链接。注册、找回密码与重置密码页面（`/[lang]/signup`、`/[lang]/forgot-password`、`/[lang]/reset-password`）在飞书模式下由中间件返回 404（`{ "error": "NOT_FOUND" }`，带 `Cache-Control: no-store`）。`legacy` 与未设置 `AUTH_PROVIDER` 的 `enterprise` 部署的 `/[lang]/signin` 不变：前者渲染邮箱密码表单（含找回密码与注册链接）与已配置的社交登录按钮，后者渲染现有企业表单。

同一页面内两步，均在一个客户端组件树中完成，文案取自词典的 `auth.signin.feishu`（`zh-CN` 与 `en`）：

- **输入邮箱**（`components/feishu-login/email-form.tsx`）：邮箱输入框与提交按钮。表单关闭浏览器原生校验，邮箱语法只由服务端的 `normalizeFeishuLoginEmail` 判定；提交时去掉首尾空白，以 `{ "email": "<邮箱>" }` 调用 request。202（服务端同时设置 flow Cookie）后切换到验证码步骤；400 显示格式错误（`invalidEmail`）并停留在本步骤；其它结果（429、503 或网络失败）显示通用提示 `requestFailed` 并停留在本步骤。已知与未知邮箱的 request 结果相同，验证码步骤也相同：提示文案「如果该邮箱属于本组织成员，验证码已通过飞书发送」对两者一致，页面不显示账号是否存在。
- **验证码**（`components/feishu-login/code-form.tsx`）：验证码输入框与提交按钮。输入或粘贴时去掉全部空白、转为大写并至多保留 8 个字符（输入框不设 `maxLength`，带空格粘贴的验证码不会在去掉空格前被截断；服务端另行去掉首尾空白并转为大写，格式仍只由服务端判定），以 `{ "code": "<验证码>" }` 调用 verify；flow 取自浏览器自动携带的 HttpOnly flow Cookie，页面不读取它。200（服务端同时设置会话 Cookie）后进入首页 `/[lang]`（已登录时首页的入口指向工作区）。其它结果停留在本步骤（输入框与提交按钮仍可用、flow 不变），并只按状态码显示错误提示（FSL-130，见「verify」）：401 与 400 显示「验证码无效或已过期」（`codeInvalid`）——错码、过期、作废（含错误次数达到上限）与已消费的验证码都是同一 401，页面同样不区分，格式非法的 400 也用这一文案；409（`account_conflict`）显示账号冲突提示（`accountConflict`：该邮箱已被本站其它账号使用，无法通过飞书登录，请联系管理员）；503（`retry` 或密钥检查失败的 `unavailable`）显示「请重新获取验证码」（`codeRetry`）；其它结果（500、403、429 或网络失败）显示通用提示 `verifyFailed`。
- **重新发送与更换邮箱**（FSL-155，同在 `code-form.tsx`）：
  - **重新发送**：按钮在进入验证码步骤后 60 秒内不可用，显示倒计时（`resendWait`，`{seconds}` 为剩余秒数）。60 秒与服务端的邮箱冷却（`FEISHU_LOGIN_COOLDOWN_SECONDS`）相同：冷却内的请求虽然返回 202，却只作废当前验证码而不发出新码（见「冷却与全局预算」）。
  - 60 秒后按钮可用（`resend`），以页面状态中的同一邮箱再次发送 `{ "email": "<邮箱>" }` 调用 request；浏览器携带同一 flow Cookie，服务端在返回 202 之前作废该 flow 此前的验证码（「flow 绑定」）。
  - 202 后清空验证码输入框，显示「已重新请求验证码，此前发送的验证码不再有效」（`codeResent`），并重新开始 60 秒倒计时。
  - 其它结果（503、429 或网络失败）显示 `requestFailed`，保留输入框内容，同样重新开始 60 秒倒计时：503 或丢失的响应不能证明服务端未提交预约，冷却内立即重试会作废刚发出的验证码而不发送新码。
  - 发送期间验证码输入框与两个按钮都不可用。文案与首次请求一样不区分邮箱是否属于成员。
  - **更换邮箱**（`changeEmail`）：整页重新加载本页（路径与查询参数不变）。与刷新相同，回到空的输入邮箱步骤，flow Cookie 不变；本身不发送请求，当前验证码在此时仍有效。两步状态由 `email-form.tsx` 持有，而它引入 `code-form.tsx`，因此验证码步骤以重新加载回到第一步，不反向引入邮箱步骤（依赖方向守卫禁止循环依赖）。
  - 此后为新邮箱请求时，服务端在同一 flow 中作废旧邮箱的验证码，不论新邮箱是否命中成员。

登录邮箱只保存在页面组件的状态中，不写入 localStorage、sessionStorage 或可读的 Cookie；刷新页面回到空的输入邮箱步骤，flow Cookie 仍有效（同一 flow 再次请求时沿用，见「request」）。

**测试：** `apps/web/tests/unit/i18n-feishu-login.test.ts` 从页面与两个步骤组件的源码收集所用的 `auth.signin.feishu` 键，断言每个键在 `zh-CN` 与 `en` 中都是非空字符串、两份词典在该命名空间下的键集合相同且都被使用、文案已翻译且验证码提示在两种语言中都保留 `{email}` 占位符，并（FSL-130）断言验证码页的四条错误提示（`codeInvalid`、`accountConflict`、`codeRetry`、`verifyFailed`）在每种语言中互不相同。`apps/web/tests/e2e/feishu-login-page.spec.ts`（配置 `playwright.feishu-login.config.ts`）在真实浏览器中断言：访客可直接打开两种语言的页面，邮箱步骤显示邮箱输入框与提交按钮；已知成员与未知邮箱提交后都切换到验证码步骤，request 结果、替换邮箱后的验证码步骤 DOM 与 Cookie 名称集合相同，只有成员的 Mock 收件箱收到私聊；相邻路径（`/en/signin/feishu/extra`、`/en/signin/feishux`、`/en/signin-feishu`）对访客仍 302 到 `/en/signin`；非法邮箱显示格式错误、停留在邮箱步骤且不设置 flow Cookie；验证码步骤时浏览器存储不含邮箱，刷新后回到空的邮箱步骤且 flow Cookie 不变；以 Mock 收件箱中的验证码（以小写、中间带空格的形式粘贴）登录后进入首页、设置会话 Cookie，首页入口指向工作区，此后再访问本页被 302 到 `/[lang]/workspace`。`apps/web/tests/e2e/feishu-login-verify-errors.spec.ts`（FSL-130，同一配置）以真实 verify 端点的结果断言验证码页的错误提示，不拦截页面的请求：错码（401）与 7 位验证码（400）都显示 `codeInvalid`，停留在验证码步骤、不设置会话 Cookie，随后以正确验证码登录成功；在运行的数据库中预置与成员同邮箱的本地用户后，中英文页面提交正确验证码都得到 409 并显示 `accountConflict`，`user` 表不变；以测试数据库中 `session` 插入的触发器注入会话签发故障后得到 503 并显示 `codeRetry`，不新增会话；409 与 503 之后再次提交同一（已消费的）验证码得到 401，显示与错码相同的 `codeInvalid`。`apps/web/tests/e2e/feishu-login-resend.spec.ts`（FSL-155，同一配置）不使用假时钟。它在验证码步骤出现后实际等待 61 秒，使页面倒计时与服务端冷却都到期，并断言：60 秒内「重新发送」不可用，强制点击也不发送请求、不改变该 flow 的行；61 秒后可用；重发返回 202 时，该 flow 已写入 `flow_seq` 为 2 的新行，旧行为 `void`，新行随后激活；Mock 收件箱收到第二条私聊；页面清空输入框并重新倒计时；旧验证码提交为 401（`codeInvalid`），新验证码登录成功。以测试数据库中 `feishu_login_codes` 插入的触发器使重发的预约失败时，重发得到 503：页面显示 `requestFailed`，保留输入框中的验证码并重新倒计时，该 flow 的行与收件箱都不变，原验证码仍可登录。「更换邮箱」回到空的输入邮箱步骤，flow Cookie 不变，本身不改写该 flow 的行。随后分别为另一成员（命中）和未知邮箱（未命中）请求：旧邮箱的验证码都提交为 401。命中时新验证码可登录；未命中时新行被作废，任何成员的收件箱都不变。词典测试（FSL-155）另断言新增的四个键都被使用，且倒计时文案恰含一个 `{seconds}` 占位符。`apps/web/tests/e2e/feishu-login-entry.spec.ts`（FSL-131，同一配置）断言：访客请求两种语言的 `/[lang]/signin` 得到 307 到 `/[lang]/signin/feishu` 且保留 `callbackUrl`，浏览器打开后为飞书登录页、没有密码输入框与注册和找回密码链接；访客访问受保护页面时先 302 到 `/[lang]/signin`、再 307 到飞书登录页，浏览器最终停在该页且 `callbackUrl` 为原路径；`/[lang]/signup`、`/[lang]/forgot-password`、`/[lang]/reset-password`（含结尾斜杠）返回 404。`apps/web/tests/unit/signin-entry.test.ts`（FSL-131）渲染登录页的服务端组件并调用中间件，断言 `legacy`（及两个变量都未设置）下两种语言的登录页仍渲染邮箱与密码输入框、找回密码与注册链接，访客可直接访问登录与注册页；未设置或空白 `AUTH_PROVIDER` 的 `enterprise` 下仍渲染企业表单（无密码表单、注册链接与社交按钮）；这些模式下页面都不重定向；飞书模式下页面重定向到 `/[lang]/signin/feishu` 并保留查询参数（含同名参数的多个值）。

**E2E 基座：** `apps/web/tests/e2e/helpers/feishu-login-harness.ts` 的 `startFeishuLoginHarness` 每次运行自建 `OwnedWeb` 的源码副本（不复制、不加载真实 `.env`）与一次性 PostgreSQL（已迁移）、真实 Feishu Mock CLI 进程，再在该副本上以飞书模式（`AUTH_MODE=enterprise`、`AUTH_PROVIDER=feishu`、`FEISHU_PROVIDER=simulator` 指向 Mock，Mock 的应用 ID 与密钥，新生成的合成 `ENTERPRISE_OTP_HMAC_KEY`）启动独立的 `next dev` 进程组；验证码从 Mock 的 `/__mock/state` 收件箱读取并只留在内存中。启动中途（含数据库观察连接的创建）失败时释放已经启动的部分并抛出带资源清单的 `FeishuLoginHarnessSetupError`，`close()` 依次释放 Web（及其 PG 与源码副本）与 Mock，`withFeishuLoginHarness` 在工作函数成功或抛错时都关闭。`next dev` 的进程组由监听进程读取并登记：启动未完成时每 250 毫秒轮询一次，观察到监听即登记，启动完成后仍未登记则报错；两次轮询之间出现又消失的监听不会被登记，该情形只由 `OwnedWeb.start` 自身的失败清理覆盖。spec 以 `listFeishuLoginHarnessLeftovers` 从外部（文件系统、docker、进程表与端口）断言：在 Mock 启动后与 Web 就绪后注入的两种启动失败、抛错的工作函数与成功关闭四条路径之后，源码副本、PG 容器与端口、Mock 进程与端口、Web 端口与 Web 进程组的存活成员都不再存在（ER-14）。`OwnedWeb.start` 自身失败时由它在拒绝前停止并确认进程组退出，本 spec 不另行注入该故障。

## 操作白名单

`createAuth` 收到 `feishuLogin` 选项时，在全部插件之前注册飞书模式的 better-auth 操作策略（`packages/auth/src/feishu-login/policy.ts`，插件 ID `megaui-feishu-login-operation-policy`，FSL-127），并且不注册现有企业操作策略（`packages/auth/src/enterprise-otp/policy.ts`）：同时传入 `enterpriseOperationPolicy` 时它同样不注册，其 `resolveMode` 不被调用。未传入 `feishuLogin` 时不注册本策略，行为与本卡之前相同。

- **白名单：** 只有 `/feishu-login/request`、`/feishu-login/verify`、`/get-session` 与 `/sign-out` 四个操作可达（verify 仍只在选项含 `verify` 时注册，见「HTTP 接口」）。认证实例上的其余全部端点一律拒绝，包括邮箱密码注册与登录、社交登录、找回与重置密码、admin 插件的接口（含 `/admin/create-user`）、旧 `/enterprise/*`（同时传入企业配置项、这些端点因此存在时同样拒绝），以及之后加入的插件新增的端点（判定只看路径，不依赖端点清单）。
- **HTTP：** 策略的 `onRequest` 先于其它插件的 `onRequest`、也先于路由匹配执行。它取请求 URL 经 WHATWG URL 解析后的 pathname（better-auth 路由所用的同一个值，不解码百分号编码），去掉认证实例上下文中 `baseURL`（better-auth 补全默认路径后的值）的路径部分（即路由去掉的同一前缀，Web 挂载下为 `/api/auth`）后，与四个操作逐字比较；查询串不参与比较。尾斜杠、重复斜杠、含百分号编码的字符（如 `%2F`、`%67et-session`），以及操作部分或前缀部分的大小写不同，都不等于四个操作之一，返回 404 `{ "error": "NOT_FOUND" }`（带 `Cache-Control: no-store`），请求不到达任何端点。URL 解析本身会规范化的写法（点段 `/./`、`/../` 及其编码形式 `%2e`，以及反斜杠）在比较之前已被解析消去，按解析后的路径判定。better-auth 自身的限流（只在生产环境启用）在全部插件的 `onRequest` 之前执行，因此生产环境中超出限流的请求先得到 429，同样不到达端点。
- **直接调用：** 策略的 `before` 钩子匹配全部端点，比较被调用端点自身的路径：服务端代码经 `auth.api.*` 调用四个操作之外的端点时抛出 better-auth `APIError`（`NOT_FOUND`，消息 `AUTH_OPERATION_NOT_FOUND`），端点处理函数不执行。
- **范围：** 本策略只限制该认证实例的 better-auth 操作；Web 中间件对 `/api/auth/*` 的放行范围见「会话」（FSL-126）。

**当前状态：** 飞书模式下 Web 向 `createAuth` 传入 `feishuLogin` 选项（FSL-150，见「HTTP 接口」的「启用条件」），本策略在飞书模式的认证实例上生效；其它模式不传入该选项，不注册本策略。

`packages/auth/src/feishu-login/policy.test.ts` 以 `createAuth` 加飞书登录配置构造（`issue` 端口为替身；`verify` 选项的连接池为替身，只应答密钥一致性检查的查询），分两种构造各跑一遍：只传飞书登录配置，以及另外同时传入 `enterprisePairing` 与 `enterpriseOperationPolicy`（`resolveMode` 恒为 `enterprise`）。断言：策略排在插件列表首位、企业操作策略未注册且 `resolveMode` 未被调用，未传入 `feishuLogin` 时不注册本策略；四个操作经 HTTP 与 `auth.api` 都可达（request 返回 202 且调用 `reserve`，无 flow Cookie 的 verify 在密钥检查后返回 401 `invalid`，无会话的 `get-session` 返回 200 `null`，`sign-out` 返回 200）；`/sign-up/email`、`/sign-in/email`、`/sign-in/social`、`/admin/create-user` 与 `/enterprise/request`（只传飞书登录配置时该端点不存在，经 HTTP 同样返回 404），以及实例上其余每个端点，经 HTTP 返回上述 404、经 `auth.api` 抛出 `NOT_FOUND`，签发端口、连接池、配对端口与邮件发送均未被调用；四个路径的尾斜杠、大小写、百分号编码与重复斜杠变体，以及 `/api/auth` 前缀的大小写、编码、尾斜杠与重复斜杠变体，都返回 404。

## 会话

页面、BFF、上传与 `get-session` 共用的 Web 会话入口 `resolveWebActor`（`apps/web/lib/enterprise-session.ts`）与中间件（`apps/web/middlewares/auth.ts`）在飞书模式下的行为（FSL-126）。

- **入口选择：** `resolveWebSessionEntry` 只在 `AUTH_PROVIDER` 去掉首尾空白后非空时调用 `resolveAuthMode`（见「配置」）：结果为 `enterprise` + `feishu` 时使用飞书会话入口；`resolveAuthMode` 拒绝的组合（如 `legacy` + `feishu`、`enterprise` + `local`）不解析任何会话，一律视为未登录，中间件按下文飞书模式的规则限制认证接口与页面；`AUTH_PROVIDER` 未设置或空白，以及 `legacy` + `local` 时沿用本卡之前的路径，行为不变，也不读取 `feishu_login_sessions`。
- **判定：** 飞书模式下会话入口自身不读取企业配置（`readEnterpriseWebConfig`）、不构造资格判定服务、不读取企业会话字段、不做资格判定。它以 `getAuth()` 返回的认证实例调用 better-auth `getSession`（关闭 Cookie 缓存与刷新）读取当前会话（飞书模式的认证实例，见「HTTP 接口」的「启用条件」），再查询 `feishu_login_sessions` 中该会话 ID 的行（同时要求 `session.user_id` 等于会话用户）。该行的年龄只在数据库时钟上计量：`created_at` 由列默认值 `now()` 写入，年龄为同一数据库在读取时的 `clock_timestamp()` 减去 `created_at`，不使用 Web 进程时钟，因此 Web 与数据库之间的时钟偏差不影响该时限。没有该行、任一读取失败、年龄超过 8 小时或为负（该行时间晚于数据库当前时间）时视为未登录；否则得到 `kind: "feishu"` 的 actor（用户 ID、邮箱、会话 ID）。时限从标记行的写入时间起算，没有请求改写该行，因此持续使用（包括 better-auth 刷新会话而推后其 `expiresAt`）不延长这 8 小时；better-auth 自身判定会话无效（已过期或已删除）时同样视为未登录。
- **非飞书会话：** 没有标记行的会话（包括同一已绑定用户在切换前以密码、社交登录或旧企业登录取得的会话）在飞书模式下视为未登录：受保护页面 302 到 `/[lang]/signin?callbackUrl=<原路径>`，中间件拦截的受保护 API 返回 401，BFF 与上传路由按各自的未登录响应处理，`get-session` 返回 200 `null`。
- **`get-session`：** `/api/auth/get-session` 由路由经 `getMega2SessionResponse` 以 `resolveWebActor` 判定：飞书会话返回该会话的投影，非飞书会话与无会话返回 200 `null`（带 `Cache-Control: no-store`）。飞书会话投影中 `user.name` 的取值，以及主体冲突或核对失败时飞书会话同样返回 200 `null` 的规则，见「Mega2 授权主体」（FSL-156）。
- **中间件：** 飞书模式下 `/api/auth/*` 只放行 `/get-session`、`/sign-out`、`/feishu-login/request` 与 `/feishu-login/verify` 四个路径（后两个由 FSL-150 加入；`resolveAuthMode` 拒绝的组合只放行前两个），按路径逐字匹配（尾斜杠、重复斜杠、编码变体，以及操作部分或 `/api/auth` 前缀本身的大小写变体都不匹配），其余路径（包括邮箱密码与社交登录、旧 `/enterprise/*`）由中间件返回 404 `{ "error": "NOT_FOUND" }`（带 `Cache-Control: no-store`）。公开页面只有首页 `/[lang]`、登录页 `/[lang]/signin` 与飞书登录页 `/[lang]/signin/feishu`（FSL-129，见「页面」；已登录的飞书会话访问这两个登录页时 302 到 `/[lang]/workspace`）；注册、找回与重置密码页由中间件返回 404，与现有企业模式相同。不属于认证的其它公开路由（健康检查、BFF、上传、内部回调）的放行不变，其中 BFF 与上传在路由内以 `resolveWebActor` 判定会话。
- **`legacy` 部署：** 会话入口与中间件的判定与本卡之前相同。

**当前状态：** 本节的会话判定由 FSL-126 实现。自 FSL-150 起，飞书模式下 `getAuth()` 返回飞书模式的认证实例，飞书登录端点签发的会话经本节判定（见「HTTP 接口」的「启用条件」；该节的端到端用例以生产的 `getAuth()` 完成登录并以该会话取得协作票据）。下述 FSL-126 契约测试仍以替身替换 `getAuth()`，验证的是会话判定本身。

`apps/web/tests/contract/feishu-login-session.spec.ts` 使用一次性 PG，以真实的中间件、`resolveWebActor` 与 `/api/auth/[...all]` 路由构造（`getAuth()` 替换为同一数据库上的 `createAuth` 实例，读取标记行的是 `DATABASE_URL` 上的共享连接池）：同一已绑定用户以 better-auth 邮箱注册取得密码会话，并按 verify 的方式（`createSession` 签发 8 小时会话后 `recordFeishuLoginSession`）取得飞书会话；断言飞书会话的页面请求得到该用户，密码会话（better-auth 本身仍认可）在页面请求中重定向到登录页、`resolveWebActor` 为 `null`；无会话与无效 Cookie 的受保护页面重定向到 `/[lang]/signin`；`get-session` 对飞书会话返回该会话、对密码会话、无会话与删除了标记行的会话返回 `null`；推进时钟（Web 进程的 `Date` 以伪造计时器推进，数据库时钟的推进以把标记行 `created_at` 回拨同样时长模拟），在 8 小时内每小时请求一次（同时经 better-auth 刷新推后会话到期时间）都被接受，超过 8 小时后 better-auth 仍认可该会话，而页面重定向到登录页、`get-session` 返回 `null`；另在不改变 Web 进程时钟的情况下只改变标记行在数据库时钟上的年龄，断言 7 小时 59 分被接受、8 小时 1 分与晚于数据库当前时间 1 小时都被拒绝。`apps/web/tests/unit/auth-middleware-feishu.test.ts` 以替身替换 better-auth 与连接池，断言 `AUTH_PROVIDER` 未设置、空白或为 `local` 时会话入口与中间件的判定不变且不读取标记表，并覆盖飞书模式下认证接口与页面的放行范围、被拒绝组合的 fail-closed，以及年龄判定（0 至恰为 8 小时接受，超过 8 小时、为负或非有限值拒绝）。

## Mega2 授权主体

Mega2 经 `GET /api/auth/get-session` 读取当前会话，并按 `WebsiteAuthUserJson::into_login_user`（mega2 `src/api/oauth/model.rs`）把投影中去首尾空白后非空的 `user.name` 原样作为 `LoginUser.username`；管理员判定以该用户名与 `.mega_cedar.json` 管理员列表逐字匹配。飞书会话（「会话」中 `kind: "feishu"` 的 actor）的投影由 FSL-156 规定（`apps/web/lib/mega2-session.ts`）：

- **主体：** 投影的 `user.name` 为 `fs_<用户 ID>`，用户 ID 即 better-auth 的 `user.id`（首次登录建号时生成，见「建号」）。不取 `user.name`（飞书显示名，可重名、可修改），也不取邮箱前缀；显示名仍保存在 `user.name`，只用于页面展示。投影的其余字段与本卡之前相同：`user.id`、`user.email`（登录邮箱）与 `user.image` 取自会话用户，`banned` 为 `false`，`session` 为会话 ID 与到期时间。
- **稳定性：** 同一成员再次登录时，verify 按 `feishu_identities` 中 `(app_id, open_id_hmac)` 的绑定找到原用户（见「建号」的「再次登录」），用户 ID 不变；主体不读取显示名，因此退出后再次登录、显示名改变都不改变主体。用户 ID 是 `user` 表主键，不同用户（包括显示名相同的两个飞书成员）的主体不同。
- **冲突核对（fail-closed）：** `fs_` 前缀本身不能阻止其他本地用户的 Mega2 用户名恰好是同一字符串。每次为飞书会话投影前，对该用户以外的每个本地用户，按与 Mega2 `into_login_user` 及现有 `deriveMega2Actor` 相同的规则派生其 Mega2 用户名：有企业资料行时取冻结主体 `enterprise_profile.backend_username`；否则 `name` 按 Unicode 空白去首尾后非空时取原 `name`；否则取邮箱第一个 `@` 之前的部分按 Unicode 空白去首尾后的值。任一派生值等于该 `fs_<用户 ID>`，或核对未能完成（查询失败或结果格式不符）时，这次 `get-session` 返回 200 `null`（带 `Cache-Control: no-store`，Mega2 视为未登录），并以 `console.warn` 输出稳定日志键 `FEISHU_LOGIN_PRINCIPAL_CONFLICT`（只有该键）。核对在 `DATABASE_URL` 上的共享连接池执行一条查询：先在数据库中筛出冻结主体等于、`name` 等于或邮箱包含该主体的用户，再在进程内对每一行按上述规则派生并比较。每次请求都重新核对、不缓存结果：全部冲突都已消除（例如冲突用户被删除，或其派生的 Mega2 用户名已改变）后，下一次核对成功的请求即恢复投影。按计划，对企业资料表的读取随企业数据库代码一并由 FSL-139 移除，此后派生规则只剩后两项。
- **核对范围：** 核对只比较本地 `user` 表（及企业资料表）中的用户，不读取 `.mega_cedar.json` 或 Mega2 的任何数据。
- **legacy 部署：** legacy actor 仍按 `deriveMega2Actor` 取 `name` 或邮箱前缀，企业 actor 仍取冻结主体，均不执行冲突核对。`AUTH_PROVIDER` 未设置、空白或为 `local`（`legacy` 模式）时不会出现飞书 actor（见「会话」的入口选择），投影与本卡之前相同。

**管理员登记：** Mega2 管理员若需授予飞书用户，在 `.mega_cedar.json` 的管理员列表中登记其 `fs_<用户 ID>`，不登记显示名或邮箱前缀。用户 ID 在该成员首次飞书登录建号后才存在，运维可在 megaui 数据库中按其登录邮箱（小写）查得，例如 `select u.id from "user" as u join feishu_identities as i on i.user_id = u.id where u.email = '<登录邮箱>'`。管理员列表中的 `fs_` 条目只能由运维按已知飞书用户 ID 登记；切换到飞书模式前，以 `rg -n '"fs_' .mega_cedar.json` 核对没有来历不明的 `fs_` 条目（每一条都对应一个已知的飞书用户 ID）。按计划，这一核对同时列入 FSL-142 runbook 的部署步骤。旧企业主体只存在于 dev/test（`DEFER-FS-03`）。

**当前状态：** 本节的投影由 FSL-156 实现。自 FSL-150 起，飞书模式下的认证实例与飞书登录端点已接线（见「HTTP 接口」的「启用条件」），飞书登录签发的会话按本节投影。下述契约测试仍以替身替换 `getAuth()`，验证的是投影与冲突核对本身；FSL-150 的端到端用例不经过 `get-session` 投影。

`apps/web/tests/contract/mega2-feishu-session.spec.ts` 使用一次性 PG，以真实的中间件与 `/api/auth/[...all]` 路由（`get-session`、`sign-out`）构造：`getAuth()` 替换为同一数据库上带飞书登录插件的 `createAuth` 实例，成员经真实的 verify 端点登录（验证码经签发存储的 `reserve` / `activate` 写入，首次登录建号与绑定），冲突核对与标记行读取使用 `DATABASE_URL` 上的共享连接池；测试按 `into_login_user` 的规则重述 Mega2 将得到的用户名。断言：投影的 `user.name` 为 `fs_<用户 ID>` 而数据库中的显示名不变；两个显示名相同的成员得到不同的用户名；同一成员退出（`sign-out` 后原 Cookie 的 `get-session` 为 `null`）再登录，用户与绑定各一行且用户名不变；修改 `user.name`、以另一显示名再次登录后用户名不变；显示名等于既有管理员用户名的成员得到的用户名不等于该管理员用户名；另一本地用户的 `name` 恰为 `fs_<用户 ID>`、`name` 全为 Unicode 空白且邮箱前缀（含首尾空白）为 `fs_<用户 ID>`、冻结主体为 `fs_<用户 ID>`，以及注入核对查询失败时，`get-session` 为 `null` 且 `console.warn` 恰好收到一次 `FEISHU_LOGIN_PRINCIPAL_CONFLICT`，而该会话仍被会话入口认可；冻结主体优先于等于主体的 `name`、非空 `name` 优先于等于主体的邮箱前缀、带首尾空白的 `name` 与更长的值都不构成冲突。`apps/web/tests/unit/mega2-session.test.ts` 以本卡之前的投影函数为基准，断言 legacy 与企业 actor 在各种 `name` / 邮箱组合下的投影与之相同、不执行核对；`AUTH_PROVIDER` 未设置、空白或为 `local` 时生产入口 `getMega2SessionResponse` 的投影与之相同且不访问连接池；并覆盖飞书分支的 fail-closed（无核对端口、查询抛错、结果格式不符、日志函数抛错）。

## 公开资料

成员、聊天、cls、文档评论、文档、议题、发布七个共享服务经 `packages/engine/src/services/enterprise/public-profile.ts` 的 `resolvePublicProfiles` 取用户的公开资料行（`id`、`username`、`displayName`、可选的 `avatarUrl`、`avatarInitials`、`avatarColor`）。对在 `feishu_identities` 中有绑定（任一应用）的用户，该行按以下规则生成（FSL-153），且不论该用户是否另有企业资料都按此规则：

- `username` 为用户 ID（不透明，不从邮箱派生）。
- `displayName`：记 N 为 `user.name` 转小写、L 为登录邮箱（`user.email`）最后一个 `@` 之前的完整本地部分转小写；N 含 `@` 或 N 含子串 L 时为用户 ID，否则为按原样存储的 `user.name`（不去除首尾空白；通讯录姓名为空字符串时显示名同样为空字符串）。只比较完整本地部分，不比较域名或本地部分的片段：姓名 `Chen Qi` 对登录邮箱 `chen.qi@corp.example` 保留，姓名 `Zhang.San Ops` 对 `zhang.san@corp.example` 改为用户 ID。
- `avatarInitials` 只由 `displayName` 派生：先取前两个以空白分隔的词的首字符并转大写（没有词时为 `U`）；该值转小写后含 `@` 或子串 L 时，依次改取第一个词的首字符转大写、该首字符原样，取第一个不含的值；没有词时改为空字符串。这覆盖姓名本身不含 L、但首字符拼出较短本地部分的情形：姓名 `Alice Brown` 对登录邮箱 `ab@corp.example` 时缩写为 `A`。单个首字符仍含 L 时 L 就是该字符、`displayName` 含有它，只在 `displayName` 为用户 ID 时出现，此时缩写取用户 ID 的首字符转大写。
- `avatarColor` 为 `#64748b`；该值转小写后含 L（如登录邮箱 `647@corp.example`）时改为 `#525252`。
- 不含 `avatarUrl`：即使 `user.image` 非空也不输出（飞书建号本身不写 `user.image`）。

登录邮箱只在读取时用于上述比较，不进入公开资料行。两个颜色除 `#` 外没有共同字符，而飞书建号写入的登录邮箱经 request 的邮箱语法校验，本地部分非空且不含 `#` 与 `@`，所以至少有一个颜色不含 L。因此读到这样的登录邮箱时，飞书用户公开资料行的各字段都不含其登录邮箱的 `@` 或完整本地部分，取自用户 ID 的值除外：`id`、`username` 与取用户 ID 的 `displayName` 在用户 ID 偶然包含本地部分时含有它，取用户 ID 首字符的缩写在本地部分恰为该字符时含有它。规则只针对登录邮箱：姓名中不含 `@` 的其它邮箱信息（例如另一邮箱的本地部分）不被识别。两次读取之间该用户被删除、读不到登录邮箱时，该行的显示名为用户 ID，缩写与颜色取由用户 ID 派生的缩写与 `#64748b`，不做上述比较。

没有飞书绑定的用户规则不变：有企业资料的用户以 `login_name` 为用户名、以去除首尾空白后的资料显示名为显示名（为空时依次取去除首尾空白后的 `user.name`、用户名）；其余（legacy）用户以邮箱第一个 `@` 前的前缀为用户名、以去除首尾空白后的 `user.name` 为显示名（为空时取用户名）；两者在 `user.image` 非空时输出 `avatarUrl`，`avatarColor` 恒为 `#64748b`。

`packages/engine/src/services/enterprise/public-profile.test.ts` 以一次性 PG 断言公开资料行的全部字段（`toEqual`，飞书用户另断言无 `avatarUrl`）：飞书用户分姓名与邮箱无关、姓名等于邮箱、姓名含完整本地部分（大小写不同）、姓名只含域名片段（保留，且 `user.image` 非空时仍无 `avatarUrl`）、姓名只含本地部分的片段（保留）五种，另有用户 ID 偶然包含本地部分（用户名仍为用户 ID）、首字符拼出本地部分（缩写为 `A`、姓名保留）、本地部分为 `u` 且姓名为空（缩写为空字符串）、本地部分含于 `#64748b`（颜色为 `#525252`）、本地部分为单个字母且等于用户 ID 的首字符（显示名为用户 ID、缩写为其首字符）、姓名带首尾空白（原样保留）、姓名为空字符串与另有企业资料的飞书用户各一例，并断言这些行中（最后一种取用户 ID 首字符的情形除外）不等于用户 ID 的字段值不含 `@` 与（不区分大小写的）完整本地部分；legacy 用户与企业用户各一例，断言与本卡之前的规则一致；另经议题服务创建议题，断言作者等于同一公开资料行。

## 协作服务

collab-server（`apps/collab-server`）在飞书模式下的连接校验（FSL-128）。

- **模式判定：** `createCollabServer` 先按现有规则检查 `AUTH_MODE` 的取值（未知取值仍以现有的 `EnterprisePolicyError` 拒绝构造），再以 `resolveAuthMode`（见「配置」）对进程环境中的 `AUTH_MODE` 与 `AUTH_PROVIDER` 判定是否为飞书模式（`apps/collab-server/src/auth.ts` 的 `isFeishuCollabMode`）。`resolveAuthMode` 拒绝的组合（如 `legacy` + `feishu`、`enterprise` + `local`）使构造抛出 `AuthModeError`，服务不启动。
- **飞书模式（`enterprise` + `feishu`）：** 无条件不构造企业策略桥（`legacy` 在设置了企业策略键或注入 `enterprisePolicy` 时仍会使用策略桥，飞书模式不会）：不读取 `BETTER_AUTH_URL`、`ENTERPRISE_INTROSPECTION_KEY`、`ENTERPRISE_DB_INSTANCE_ID`、`ENTERPRISE_ARTIFACT_SHA`（即使设置了也不使用），并忽略调用方传入的 `enterprisePolicy` 选项。因此启动时不要求策略服务配置、不请求 Web 策略接口，运行中不做企业策略复核，`/health` 不报告策略字段。每个连接只做普通协作票据校验：票据签名（密钥为 `ticketSecret` 选项，未传入时为 `MEGA_COLLAB_INTERNAL_TOKEN`）与有效期、频道房间要求票据绑定该房间、文档房间的文档访问判定，以及现有的连接数与文档数上限；不要求票据带企业字段（身份 ID 与 epoch），不调用资格判定。签名不符、格式无效、缺失或已过期的票据，频道房间中未绑定该房间的票据，以及无文档访问权的文档房间连接，都被拒绝；文档房间不比较票据中的房间名。这些规则与未使用策略桥的 `legacy` 相同，没有放宽。
- **未设置 `AUTH_PROVIDER`：** `AUTH_MODE=enterprise`（及 `maintenance`）的部署行为不变：从环境构造策略桥时仍要求完整的企业策略桥配置（调用方经 `enterprisePolicy` 选项注入策略桥时沿用注入的桥），启动前读取 Web 策略、读取失败时拒绝启动，只接受绑定当前策略 epoch 且通过资格判定的企业票据；`legacy` 部署同样不变。
- **撤销接口：** 本卡不改动 `/internal/revoke`（collab 企业撤销接口），飞书模式下它仍按现有规则处理请求；删除由 FSL-134 负责。

**当前状态：** 本节的 collab 侧校验由 FSL-128 实现。自 FSL-150 起，Web 在飞书模式下经 `collab/token` 为飞书会话签发不带企业字段的普通协作票据；以相同 `AUTH_MODE` / `AUTH_PROVIDER` 与票据密钥启动的 collab 接受该票据，由 FSL-150 的端到端用例验证（见「HTTP 接口」的「启用条件」；该用例中 collab 的文档访问使用开发用的放行判定）。

`apps/collab-server/src/feishu-mode.test.ts` 以真实 Hocuspocus 服务与 provider 客户端构造：飞书模式下清空全部企业策略键时服务启动成功、`/health` 返回 200 且不含策略字段、除该健康探测外没有其它 `fetch` 调用；另设置了不完整的企业策略键（在未设置 `AUTH_PROVIDER` 时会拒绝启动）并传入 `enterprisePolicy` 替身时，服务同样启动，替身的 `read` 与 `qualify` 都未被调用。不带企业字段的 v1 与 v2 票据连接文档房间被接受并能相互同步，绑定频道房间的 v2 票据连接该频道房间被接受；格式无效、空、密钥不符、签名被篡改、已过期（v1 与 v2）的票据，绑定其它频道房间的票据连接频道房间，以及无文档访问权的文档房间连接都被拒绝，且连接数为 0。未设置（或空白）`AUTH_PROVIDER` 的 `enterprise` 模式下缺少策略配置时构造仍抛出 `EnterprisePolicyError`，策略不可用时拒绝启动，普通票据与 epoch 过期的企业票据被拒绝、绑定当前 epoch 的企业票据经资格判定后被接受；未知 `AUTH_MODE` 仍以 `EnterprisePolicyError` 拒绝；`isFeishuCollabMode` 对各组合的结果，以及被拒绝组合下 `createCollabServer` 抛出 `AuthModeError`，也逐一断言。

## 数据

`feishu_login_codes` 的邮箱、open_id、姓名与验证码 HMAC 只在 `active` 期间保存（FSL-119 的双向 CHECK），消费、作废时在同一语句中清空；未使用而过期的行与超过保留期的行由到期清理处理（FSL-146）。`feishu_login_key_check` 保存 HMAC 密钥与应用 ID 的指纹，request 与 verify 以它做密钥一致性检查（FSL-159、FSL-161，见下文）。**当前状态：** 飞书模式的 Web 在 `apps/web/instrumentation.ts` 的 `register()` 中启动调度器，并等待它的第一次执行结束（FSL-150，见「HTTP 接口」的「启用条件」）；其它模式不启动调度器。

### 到期清理

`packages/database/src/feishu-login-store.ts` 的 `cleanupFeishuLoginCodes(pool, { now?, lockTimeoutMs? })`（由 `@megaui/database` 导出）在一个事务内以一条语句完成两件事：

- `expires_at <= now` 的 `reserved` 或 `active` 行置为 `void`，同一写入清空 `email`、`open_id`、`display_name`、`code_hmac`；`consumed` 与 `void` 行不因到期改变；
- `created_at < now - 24 小时` 的行（任何状态）被删除。两类行按 `created_at` 互斥，没有行既被置为 `void` 又被删除。

`now` 默认取数据库时钟 `clock_timestamp()`（与写入 `expires_at`、`created_at` 的时钟相同），只有测试注入。到期行按 `id` 顺序加行锁（`order by id for update`），与激活锁定同一邮箱各行的顺序相同（其它写入只锁一行），因此清理与登录事务、与另一实例的清理都不会死锁；后续卡新增的多行加锁也须按 `id` 顺序。行被其它事务持有时清理等待其结束（不跳过），因此该行在本次清理内处理；取得锁后按最新版本重新判定（READ COMMITTED），期间已被消费、作废或被另一清理处理的行保持不变，每行只被处理一次。反过来，登录事务可能短暂等待清理提交（单条语句）。任何一次等待行锁超过 `FEISHU_LOGIN_CLEANUP_LOCK_TIMEOUT_MS`（10 秒，PostgreSQL `lock_timeout`，按每次取锁计；`lockTimeoutMs` 只供测试缩短）时本次清理失败并整体回滚，由下一周期重试。返回 `{ voided, deleted }`。

`packages/engine/src/services/feishu-login/cleanup.ts` 的 `startFeishuLoginCleanup(pool, { log? })` 是调度器：

- **清理周期：** 启动时立即执行一次，第一次执行结束（成功或失败）后即 resolve 停止函数，不等待其后的补做（即使每次清理都超过一个周期、补做持续不断，启动也在首次执行结束时返回）；之后自启动起每 5 分钟（`FEISHU_LOGIN_CLEANUP_INTERVAL_MS`）执行一次（定时器在首次执行之前安装，首次执行变慢不推迟后续周期）。同一进程内的清理从不重叠：执行期间到达的周期不丢弃，在本次结束后立即补做一次（多个周期合并为一次）。多实例各自执行，清理幂等。
- **失败：** 单次失败只输出稳定日志键 `FEISHU_LOGIN_CLEANUP_FAILED`（默认 `console.error`，不输出错误对象：数据库错误可能引用行内容），不使启动失败，下一周期照常重试。
- **停止：** 返回的停止函数清除定时器，重复调用无副作用；定时器 `unref()`，不阻止进程退出，不安装信号处理器。

**保留期：** 敏感字段在该行到期后取样判定的下一次成功清理中清空（清理以语句内的时间样本判定到期，行在取样后才到期则由到期后取样判定的下一次成功清理处理）。在至少一个 Web 实例运行、清理成功且清理如期执行（周期定时器按时触发：进程未被挂起、事件循环未受阻；周期到达时前一次清理已结束）时，敏感字段最长保留到验证码到期后一个清理周期（5 分钟），另加处理该行的那次清理的执行时间（含等待行锁：`lock_timeout` 限制的是每一次取锁的等待，不是累计等待）；前一次清理超过一个周期时到期行还须等它结束（同一进程内清理不重叠），定时器回调的调度延迟同样后移清理，这两类偏差不计入上述上界（ADR-FSL-11「本地数据与清理」）；清理很快时即自激活起约 10 分钟；全部记录行最长保留 24 小时加一个清理周期（`FEISHU_LOGIN_CODE_RETENTION_SECONDS` = 86400），同样另加上述执行时间。所有 Web 实例停止或清理持续失败期间不清理，数据保留到下一次成功清理（下一次启动时立即补做）。

### 清理测试

`packages/database/src/feishu-login-store.integration.test.ts` 使用一次性 PG 与注入时钟，断言已过期（含恰好到期）的 `reserved`、`active` 行置为 `void` 且敏感字段为空、其余各列与插入时整行一致；创建超过 24 小时的行（各状态）被删除，恰好 24 小时与更晚的行保留；未过期的 `active`、`reserved` 行与 `consumed`、`void` 行不变；默认按数据库时钟判定。并发用例：另一连接（模拟登录事务）持有到期行的行锁时，清理等待并在锁释放后于同一次清理内处理该行，持锁者期间将其消费时清理保持不变；持锁超过锁等待上限时清理失败且不改变任何行，下一次清理处理全部到期行；两个连接同时清理时（以第三个连接持有 `id` 最大的到期行，使第一个清理按 `id` 顺序锁住其余到期行后等待、第二个清理排在其后，以及不加控制的并发）每行恰好处理一次，再次清理不再改变任何行。`packages/engine/src/services/feishu-login/cleanup.test.ts` 以假定时器与脚本化连接池断言启动即执行、每 5 分钟执行、停止函数清除定时器、定时器 `unref()`、失败（含首次）后输出日志键、释放连接且下一周期重试成功、默认日志不含错误内容，执行期间到达的周期在本次结束后立即合并补做一次，以及首次执行变慢时周期仍自启动起计时。

### 密钥指纹表

迁移 `packages/database/drizzle/0020_stiff_patriot.sql` 建表 `feishu_login_key_check`（FSL-159；schema 在 `packages/database/src/schema/auth/feishu-login-key-check.ts`，由 `@megaui/database` 导出为 `feishuLoginKeyCheck`），共 3 列：

- `id`：整数主键，默认 1，`CHECK (id = 1)`，因此表中至多一行；
- `key_check`：密钥指纹，约定为 HMAC-SHA256(`ENTERPRISE_OTP_HMAC_KEY`, `"feishu-login-key-check:v1:" + FEISHU_APP_ID`) 的小写十六进制值；表约束只接受 64 位小写十六进制串，按约定只写入 HMAC，不写入密钥本身；
- `created_at`：写入时间，默认数据库 `now()`。

该表由下文「密钥一致性检查」（FSL-161）读写。迁移只前滚：没有回滚迁移，旧版本镜像忽略该表；迁移应用后发现问题时只以新的前向修复迁移恢复。

`packages/database/src/schema/auth/feishu-login-key-check.test.ts` 使用一次性 PG 断言列集合恰为上述 3 列、`id` 不等于 1 的插入（及把已有行改为其它 `id`）被拒绝、已有一行时的第二次插入被拒绝、非 64 位小写十六进制的值被拒绝；在本迁移语句之后注入 SQL 故障时表不存在、迁移记录不含本迁移，随后完整迁移集可前滚应用。

### 密钥一致性检查

`feishu_identities` 的绑定键 `(app_id, open_id_hmac)` 依赖 `ENTERPRISE_OTP_HMAC_KEY` 与 `FEISHU_APP_ID`：任一变化后已有绑定都不再匹配，成员若同时更换了邮箱，首次登录建号（见「HTTP 接口」的「建号」）会为同一成员建出第二个账号。FSL-161 在这种情形下拒绝飞书登录：

- **指纹：** `packages/database/src/feishu-login-store.ts` 的 `feishuLoginKeyFingerprint(key, appId)` = HMAC-SHA256(`ENTERPRISE_OTP_HMAC_KEY`, `"feishu-login-key-check:v1:" + FEISHU_APP_ID`)，64 个小写十六进制字符；表中只有该 HMAC，没有密钥。
- **存储：** 同文件的 `ensureKeyCheck(pool, keyCheck)`（由 `@megaui/database` 导出）以一条语句在表为空时插入 `(1, keyCheck)`（`on conflict (id) do nothing`，从不覆盖已有行）并返回表中已存的值；只有并发的首次插入在该语句执行期间提交（该语句的快照看不到那一行）时语句不返回行，此时再执行一次。第二次仍无行或任何数据库错误时抛出；不是 64 位小写十六进制的输入在查询之前以 `INVALID_FEISHU_LOGIN_KEY_CHECK` 拒绝。
- **检查：** 插件收到 `verify` 选项时，以其中的连接池、`FEISHU_APP_ID` 与密钥构造一个检查（`request.ts` 的 `createFeishuLoginKeyCheck`），request 与 verify 两个端点共用。request 在输入校验（400）与限流（429）之后、调用 `reserve` 之前检查；verify 在输入校验（400）之后、读取 flow Cookie 与任何验证码行之前检查。表为空时（首次检查）写入当前指纹并通过。已存指纹与当前指纹不同，或检查失败（如数据库错误）时，返回 503 `{ "status": "unavailable" }`（带 `Cache-Control: no-store`，不设置任何 Cookie，对任何邮箱同形），只输出稳定日志键 `FEISHU_LOGIN_KEY_MISMATCH`：request 不调用 `reserve` 与 `deliver`，因此不写预约、不发码；verify 不读取、不计数、不消费验证码，不建号，不签发会话。request 的响应顺序因此为 ADR-FSL-11 的 400 → 429 → 503 `unavailable` → 503 `retry` → 202。
- **缓存：** 一致的结果在该插件实例内保留（密钥与应用 ID 只随重启变化），之后的请求不再查询；不一致或失败的结果不保留，每个请求重新检查。
- **未传入 `verify` 选项时：** 插件不持有连接池与密钥，不注册消费验证码或建号的端点，也不做该检查。

**不支持轮换密钥或更换应用：** 本计划不提供轮换 `ENTERPRISE_OTP_HMAC_KEY`、更换 `FEISHU_APP_ID` 或身份迁移的流程。指纹写入之后，二者任一变化（新配置随进程重启加载）时，到达该检查的 request 与 verify 持续返回 503 `unavailable`（输入非法的 400 与限流的 429 照常先于它返回；仍以原配置运行、已缓存一致结果的进程在重启前不受影响）；恢复方式是由运维恢复原密钥与原 `FEISHU_APP_ID`（新配置随进程重启生效）。不得通过清空 `feishu_identities` 或 `feishu_login_key_check` 绕过该检查：清空指纹后下一次检查会写入新指纹并放行，清空绑定则使已有成员重新建号，两者都可能为同一成员建出第二个账号。

**当前状态：** 飞书模式下 Web 向插件传入 `verify` 选项（FSL-150，见「HTTP 接口」的「启用条件」），request 与 verify 因此运行该检查；其它模式不注册插件，不运行该检查。

`packages/auth/src/feishu-login/key-check.test.ts` 以 `createAuth` 加一次性 PG 构造，断言：`feishuLoginKeyFingerprint` 与独立计算的 HMAC 相同；`ensureKeyCheck` 首次写入、之后返回已存值且不覆盖、拒绝非法输入、8 个并发首次调用都返回唯一写入的值；首次 request（或首次 verify）写入当前指纹，且表中的值不等于、不包含密钥的十六进制或 base64 编码；指纹一致时 request 返回 202 并写入预约；已存指纹来自其它密钥或其它应用 ID 时，已知、未知邮箱与带 flow Cookie 的 request 都返回相同的 503 `unavailable`、不设置 Cookie、不调用 `reserve` 与 `deliver`、不写入任何验证码行，且只输出 `FEISHU_LOGIN_KEY_MISMATCH`；不一致与预约失败同时出现时返回 `unavailable` 而非 `retry`，production 限流配置下超限后返回 429，非法输入仍返回 400；检查失败（连接池不可达）时 request 与 verify 都返回 503 `unavailable`；更换密钥或应用 ID 后，verify 对正确与错误验证码都返回 503 `unavailable`，验证码行的状态、`failed_attempts` 与四个敏感字段不变（仍为 `active`、`failed_attempts` 为 0），没有用户、绑定或会话；一致结果在实例内保留、不一致结果每次重新检查。AC7 分别以「换新密钥」与「换新 `FEISHU_APP_ID`」：先以原配置完成首次建号，再改变配置并以 Mock 通讯录使该成员的邮箱改变，request 返回 503 且不预约，以改变后配置写入的验证码 verify 也返回 503，`user` 与 `feishu_identities` 行数不变；对照用例删除指纹后同一验证码返回 200 且 `user` 增为 2 行，说明该检查拦下的正是重复建号。
