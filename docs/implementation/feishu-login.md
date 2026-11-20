# 飞书邮箱验证码登录

本文记录飞书邮箱验证码最小登录路径的实现约定（`docs/plan/plan-20261118.md`）。各节由对应任务卡在其提交中补充；产品行为以源码与测试为准。

## 配置

`@megaui/core` 的 `resolveAuthMode({ AUTH_MODE, AUTH_PROVIDER })`（`packages/core/src/auth/mode.ts`，FSL-116）是认证模式与提供方的单一解析规则。它是不读取环境的纯函数，按下表返回结果或拒绝。**当前状态：** 本函数尚未接入任何进程；Web、collab 与 engine 仍按各自现有路径解析 `AUTH_MODE`。由 FSL-126（Web 会话入口）、FSL-150（Web 接线，同时接入 FSL-121 的 `readFeishuLoginConfig`）、FSL-128（collab）接入后，下表规则才对相应进程生效。飞书登录端点由 FSL-150 接线、FSL-131 切换入口；在此之前，设置 `AUTH_PROVIDER=feishu` 不会启用飞书登录。

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

`readFeishuLoginConfig(source)`（`apps/web/lib/feishu-login-config.ts`，FSL-121）读取并校验飞书登录的必填键。它与 `resolveAuthMode` 一样是不读取环境的纯函数，由调用方传入原始取值。**当前状态：** 本函数尚未接入 Web，由 FSL-150 接线后才在 `AUTH_MODE=enterprise`、`AUTH_PROVIDER=feishu` 的 Web 启动时生效。

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

`packages/engine/src/services/feishu-login/issue.ts` 的 `createFeishuLoginIssuer(options)`（FSL-122）实现签发主流程，FSL-145 在其预约事务中加入全局锁、邮箱冷却与全局预算。FSL-154 把签发拆为两个端口：`reserveFeishuLoginCode({ flowHash, email })`（第 1 步预约，只访问数据库，request 端点在 `auth.handler` 确定响应之前等待它提交）与 `deliverFeishuLoginCode(reservation)`（第 2–4 步，飞书查询、激活或作废与私聊，request 端点在 `auth.handler` 确定 202 响应之后以前者的返回值调用；响应字节何时写到客户端由宿主服务器决定，见「HTTP 接口」）；`issueFeishuLoginCode({ flowHash, email })` 依次执行两者，唯一冲突时返回 `{ status: "retry" }`。验证码表 `feishu_login_codes` 的读写集中在 `packages/database/src/feishu-login-store.ts`（`createFeishuLoginCodeStore(pool)`，由 `@megaui/database` 导出）。**当前状态：** 本服务尚未接入任何进程，由 FSL-123 的 request 端点与 FSL-150 的 Web 接线调用。

### 构造

- 服务只用 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`ENTERPRISE_OTP_HMAC_KEY`（解码后的 32 字节）与 `BETTER_AUTH_URL` 构造，另传入 FSL-148 选出的冻结 provider 目标与数据库连接池。
- 现有凭据类型与消息客户端要求的 `tenantKey` 取内部标签 `app:<FEISHU_APP_ID>`（`feishuLoginTenantKey`），只作 token 缓存键，从不发送给飞书，也不写入任何表。
- 私聊文案中的可信站点取 `BETTER_AUTH_URL`。
- 验证码生成器以构造参数 `generateCode` 注入：engine 不依赖 `@megaui/auth`，由 FSL-150 注入 `@megaui/auth` 的 8 位 CSPRNG 生成器，测试注入同一生成器。
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

FSL-154 起上述用例中断言已授予或正在等待的咨询锁集合的，按新的锁顺序包含 flow 锁（预约先持有 flow 锁与邮箱锁、再等待全局锁）。`packages/engine/src/services/feishu-login/flow-binding.integration.test.ts`（FSL-154）同样使用一次性 PG、真实 `apps/feishu-mock` 进程与记录代理，以 `consumeFeishuLoginCode` 判定验证码是否有效（本套件不建绑定，有效的验证码返回 `unbound` 且事务回滚、不改变该行）：同一 flow 中 A 的验证码有效后，B 的 `reserve` 提交即令其无效，B 分别为命中、未命中、被冷却拒绝与被预算拒绝（后两者不写新行）；A 激活已提交、代理暂扣 A 的私聊期间插入 B，断言 A 的私聊随后仍送达而其验证码无效；代理暂扣 A 的按邮箱搜索期间 B 被冷却拒绝或获准，断言 A 不发私聊；两个连接并发与受控交错（B 在 A 激活持有的 flow 锁上等待）后该 flow 至多一行 `active` 且为序号最大的行；`reserve` 期间代理未收到请求、飞书调用期间没有已授予的咨询锁；前次请求为命中、未命中、多人时后一次 `reserve` 的作废语句影响行数都为 1，本 flow 预置 1000 行历史记录时只有序号最大的一行产生新版本（`xmin`），`created_at` 相同或倒序时按 `flow_seq` 作废，在 flow 锁上等待后提交的预约取得更大的 `flow_seq`；命中、未命中、多人、不在职与飞书调用失败五种结果下，预约、开始发码与写回事务取得的咨询锁序列（flow → 邮箱 → 全局，flow → 邮箱）与加锁语句都相同。

`packages/engine/src/services/enterprise/feishu/http.test.ts` 以脚本化的 `fetch` 固定传输层现有的重试基线（默认 3 次、暂时性失败重试、永久性失败不重试），并断言 `maxAttempts: 1` 对 5xx、429、连接中断与超时都只发起一次 HTTP 请求；FSL-160 另断言已过截止时间时不调用 `fetch` 并抛出 `transport_deadline`、单次尝试的计时器恰为 `min(传输预算, deadline − 当前时间)`（含传输层重试的第二次尝试）、截止时间之后不再重试，以及不传 `deadline` 时重试与预算不变。`token.test.ts` 以本地 HTTP 服务断言已过截止时间的调用不发请求、两个截止时间不同的调用共享一次刷新时较早截止者在其截止时间以 `transport_deadline` 返回而共享刷新照常完成、刷新请求的单次超时受首个调用方截止时间约束，以及不传 `deadline` 的调用方照旧共享并等待同一次刷新。

## HTTP 接口

飞书登录的 HTTP 端点由 `@megaui/auth` 的 better-auth 插件 `feishuLogin`（`packages/auth/src/feishu-login/`，插件 ID `megaui-feishu-login`）提供。`createAuth` 只在收到 `feishuLogin` 选项（`{ issue: { reserve, deliver }, log?, verify? }`；`issue` 缺少任一端口时构造即抛出 `INVALID_FEISHU_LOGIN_PLUGIN_CONFIG`）时注册该插件，未传入时两个端点都不存在（404）；verify 端点另外只在选项含 `verify`（`{ pool, appId, otpHmacKey }`：数据库连接池、`FEISHU_APP_ID` 与解码后的 32 字节 `ENTERPRISE_OTP_HMAC_KEY`，缺少应用 ID 或密钥不是 32 字节时构造即抛出 `INVALID_FEISHU_LOGIN_PLUGIN_CONFIG`）时注册，否则为 404。**当前状态：** Web 尚未传入该选项，由 FSL-150 在飞书模式下接线；在此之前任何部署都不暴露这些端点。

### request

`POST /api/auth/feishu-login/request`（插件路径 `/feishu-login/request`，FSL-123），请求体恰为 `{ "email": "<邮箱>" }`（JSON，至多 4096 字节）。

**输入校验**（`input.ts` 的 `normalizeFeishuLoginEmail`）：先去掉首尾空白、整体转小写，再要求长度为 1–254 个字符且符合本应用既有的邮箱语法，即 better-auth 邮箱路由与 Web 表单所用的 zod 4 `z.email()` 默认模式（`zod@4.5.4` `v4/core/regexes.js` 的 `email`，复制为等价写法，`@megaui/auth` 不直接依赖 zod）。

| 情形 | 状态码 | 响应体 | flow Cookie | 签发端口 |
|---|---|---|---|---|
| 媒体类型不恰为 `application/json`；请求体超过 4096 字节、为空或不是合法 JSON；请求体不是恰含 `email` 一个字段的对象；或 `email` 不是字符串、规范化后为空、缺少 `@`、超过 254 个字符、含内部空白或其它不符合语法 | 400 | `{ "code": "INVALID_INPUT" }` | 不设置 | 都不调用 |
| 合法邮箱，`reserve` 拒绝或同步抛错（预约事务失败，含唯一冲突，FSL-154） | 503 | `{ "status": "retry" }` | 不设置 | `reserve` 已调用，`deliver` 不调用 |
| 合法邮箱，`reserve` 成功（含被冷却或预算拒绝），请求不带有效 flow Cookie | 202 | `{ "status": "accepted" }` | 签发新 flow | `reserve` 在 `auth.handler` 确定响应之前完成，`deliver` 在响应确定之后调用（见下文「签发端口」） |
| 合法邮箱，`reserve` 成功（含被冷却或预算拒绝），请求带有效 flow Cookie | 202 | `{ "status": "accepted" }` | 以同一值重新设置 | `reserve` 在 `auth.handler` 确定响应之前完成，`deliver` 在响应确定之后调用（见下文「签发端口」） |

上表的 400、503 与 202 带 `Cache-Control: no-store`（限流 429 由 better-auth 返回，不保证带该头）。媒体类型须恰为 `application/json`（可带 `charset` 等参数，不区分大小写）。上表的 400 由插件的 `onRequest` 钩子在框架解析请求体之前给出（位于限流之后、端点之前，各环境都执行）：钩子读取请求的副本，按实际读取的字节计（不依赖 `Content-Length`），累计读取超过 4096 字节（`FEISHU_LOGIN_PRECHECK_MAX_BODY_BYTES`）即停止并取消读取（按流的分块计：越限的那一块已被读入，因此已读字节至多为 4096 加一个分块的大小，不会继续读取后续分块），只有媒体类型相符、请求体不超过 4096 字节、是合法 JSON 且通过上述校验的请求才进入端点，其余请求一律返回 400 `INVALID_INPUT`。因此任何请求体都不会在通过这一有界检查之前被完整读取，框架自身的 415 与 `BAD_REQUEST` 不会出现在本路径上；端点内仍保留同一校验作为纵深防御。

**限流**：better-auth 自带的按地址与路径限流在 production 照常以其默认窗口与上限作用于端点会受理的请求，触发时返回 better-auth 的 429，只取决于地址与路径、与邮箱无关。better-auth 在进入任何端点与插件钩子之前判定限流，因此 `createAuth` 为本路径登记限流规则函数 `feishuLoginRequestRateLimitRule`：它读取请求的副本（累计超过 4096 字节即停止，按分块计，见上文；原请求体保持完整），只有端点会受理的请求才沿用 better-auth 解析出的规则并计数；其余请求（媒体类型不符、超过 4096 字节、非合法 JSON 或未通过上述校验）不计数、不受限流，由上述钩子返回 400。这样保持 ADR-FSL-11 的响应顺序「输入非法 400 先于限流 429」，且豁免的请求都不会被受理，不构成限流绕过。非法输入不做任何签发工作。

**flow Cookie**（`cookie.ts`）：名称 `__Host-megaui.feishu-login-flow`，属性 HttpOnly、Secure、SameSite=Lax、Path=/、Max-Age=600，不带 Domain。flow 是 CSPRNG 生成的 256 位随机值，以无填充 base64url 编码（43 个字符）。请求的 `Cookie` 头恰含一个该名称的 Cookie 且其值是规范的 32 字节 base64url 时视为有效，沿用该 flow 并以同一值重新设置 Cookie，Max-Age 重新计为 600 秒（剩余有效期不足 5 分钟的 Cookie 也续期 10 分钟，保证新验证码 5 分钟有效期内 Cookie 不会先到期）；没有该 Cookie、值不规范或重复出现时签发新 flow。服务端不保存 flow 明文：签发端口与验证码表只接收其 SHA-256（64 个小写十六进制字符）。

**签发端口**（FSL-154 起分为两段，FSL-150 注入 engine 的 `reserveFeishuLoginCode` 与 `deliverFeishuLoginCode`）：

- **`reserve({ flowHash, email })`**：只访问数据库的预约事务（作废本 flow 最新行、冷却与预算判定、写入预约，见「发码」的「flow 绑定」）。端点在校验输入、确定 flow 之后等待它完成，`auth.handler` 只在它兑现（即预约事务已提交，含被冷却或预算拒绝）之后才返回 202；它的返回值不被端点读取，原样交给 `deliver`。它拒绝或同步抛错时返回 503 `{ "status": "retry" }`、不设置 Cookie、不调用 `deliver`，只输出稳定日志键 `FEISHU_LOGIN_RESERVE_FAILED`（不输出错误对象、邮箱或 flow）；用户重试即可。拒绝通常意味着预约事务已回滚、数据库未改变（含唯一冲突的 `FEISHU_LOGIN_RESERVE_RETRY`）；只有在提交阶段连接中断时提交结果未知，此时作废与预约可能已经提交，503 不保证数据库未改变（重试同样先作废该 flow 的最新行）。engine 的 `reserveFeishuLoginCode` 在事务提交之后不再抛错：被冷却或预算拒绝时输出日志键失败（日志函数抛错）被忽略，结果照常兑现，request 照常返回 202。
- **`deliver(reservation)`**：飞书查询、激活与私聊。端点在 202 的响应确定之后以 `setImmediate` 把它排到当前同步执行段之后，在同一 Node 进程内异步执行，请求不等待其结果：`auth.handler` 返回的 `Response` 在 `deliver` 被调用之前已经完整确定（状态码、响应体与 Cookie 都不依赖 `deliver`）。本插件的保证止于 `auth.handler` 的边界：响应字节何时写到客户端由宿主服务器（FSL-150 的 Next 路由）决定，`deliver` 调用可能早于字节写出，但不能改变已经确定的响应。`deliver` 的返回值不被读取；它拒绝或同步抛错时只输出稳定日志键 `FEISHU_LOGIN_ISSUE_FAILED`，请求仍为 202。进程在 `deliver` 执行前退出时本次验证码不会发出，用户重新请求即可（ADR-FSL-11）。

两个日志键默认经 `console.warn` 输出；日志函数本身抛错时被吞掉，不产生未处理的 Promise 拒绝。

请求路径不访问飞书、不查询账号或身份，因此已知、未知与多人邮箱的状态码、响应体与 Cookie 属性相同（202 与 503 两种结果各自如此）；带同一 flow Cookie 时 `Set-Cookie` 逐字节相同。响应前只做数据库预约（FSL-154），其工作量与锁序列不依赖前次请求的飞书结果，耗时随数据库负载与锁等待波动，不承诺严格常数时间。

`packages/auth/src/feishu-login/request.test.ts` 以 `createAuth` 加注入的 `reserve` / `deliver` 端口构造，经 `auth.handler` 断言上述响应、Cookie 属性与续期、`reserve` 收到的规范化邮箱与 flow 哈希、`deliver` 收到 `reserve` 的返回值、400 时不设置 Cookie 且两个端口都不调用、`reserve` 未完成时响应未返回、响应先于 `deliver` 调用返回、`reserve` 拒绝或同步抛错时为 503 `{ "status": "retry" }`（不设置 Cookie、不调用 `deliver`、已知 / 未知 / 多人邮箱同形）、`deliver` 出错时仍为 202 且只记录稳定日志键、缺少任一端口时构造失败、未传入选项时端点为 404，以及 production 限流配置下同一地址超限后非法输入（含超过 4096 字节的请求体）仍返回 400、已知 / 未知 / 多人邮箱返回相同的 429。

### verify

`POST /api/auth/feishu-login/verify`（插件路径 `/feishu-login/verify`，FSL-124 成功路径，FSL-151 失败路径与并发），请求体恰为 `{ "code": "<验证码>" }`（JSON，至多 4096 字节），flow 取自请求的 flow Cookie（读取规则同 request）。

**输入校验**（`verify.ts` 的 `normalizeFeishuLoginCode`）：`code` 须为字符串，去掉首尾空白并整体转大写后恰为 8 个字符，且每个字符都属于验证码字母表 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（与发码所用生成器同一字母表）。

| 情形 | 状态码 | 响应体 | 会话 Cookie | 验证码行 |
|---|---|---|---|---|
| 媒体类型不恰为 `application/json`；请求体超过 4096 字节、为空或不是合法 JSON；请求体不是恰含 `code` 一个字段的对象；或 `code` 不符合上述格式 | 400 | `{ "code": "INVALID_INPUT" }` | 不设置 | 不读取 |
| 没有有效 flow Cookie；该 flow 没有任何行；该 flow 中 `flow_seq` 最大的行不是未过期的 `active` 行（已过期、`reserved`、`void`（含因错误次数达到上限而作废）、`consumed`，含已消费后再次提交）；该行 `failed_attempts` 已达 5 | 401 | `{ "status": "invalid" }` | 不设置 | 不改变 |
| 该行为未过期的 `active` 行且 `failed_attempts` 小于 5，验证码不相等 | 401 | `{ "status": "invalid" }` | 不设置 | `failed_attempts + 1`；加 1 后达到 5 时同一语句置为 `void` 并清空四个敏感字段 |
| 验证码相等，但 `(app_id, open_id_hmac)` 没有绑定（FSL-125 交付建号之前） | 401 | `{ "status": "invalid" }` | 不设置 | 事务回滚，保持 `active` |
| 验证码相等且绑定存在 | 200 | `{ "status": "ok" }` | 设置 better-auth 会话 Cookie | `consumed`，四个敏感字段为空 |

上表各响应带 `Cache-Control: no-store`。400 与 request 一样由插件的 `onRequest` 钩子在框架解析请求体之前给出（读取请求副本，累计超过 4096 字节即停止，按分块计），端点内保留同一校验作为纵深防御；所有 401 的状态码、响应体与头（不设置会话 Cookie）相同，响应不区分失败原因。

**错误次数上限**（FSL-151，`FEISHU_LOGIN_MAX_FAILED_ATTEMPTS = 5`）：错误次数按验证码行计（`failed_attempts`，预约行写入时为 0）。只有与验证码实际比较过的错码才计数，即该 flow 中 `flow_seq` 最大的行是未过期 `active` 行且 `failed_attempts` 小于 5 时；无 flow Cookie、该 flow 无行、行已过期、已作废、已消费或已达上限时不比较、不计数。第 5 次计数的错码在同一条语句中把该行置为 `void` 并清空 `email`、`open_id`、`display_name`、`code_hmac`；此后同一 flow 提交正确验证码也返回 401，用户须重新请求验证码。上限只作用于单个验证码行：同一 flow 或同一邮箱重新请求得到的新验证码从 0 开始计数（按地址的请求限流见下文）。

**限流**：verify 路径没有自定义限流规则。better-auth 的按地址与路径限流在 production 以默认窗口与上限作用于全部 verify 请求（含格式非法的请求），触发时由 better-auth 在插件钩子之前返回 429；因此 verify 的顺序是 429 先于 400，ADR-FSL-11「输入非法 400 先于限流 429」的顺序只适用于 request。

**校验事务**（`@megaui/database` 的 `consumeFeishuLoginCode`，一个事务）：

1. 以单独一条 `SELECT … FOR UPDATE` 锁定该 flow 的 SHA-256 对应的、`flow_seq` 最大的一行（不论状态；该语句只返回行 ID）。这是本事务在 `feishu_login_codes` 中锁定的唯一一行（清理、激活与发码的作废写回锁定多行时按 ID 顺序）；选中同一行的并发 verify 在此等待，直到持锁事务提交或回滚；
2. 在下一条语句（因而在任何锁等待之后，按该行最新提交的版本与一次 `clock_timestamp()` 取样）重新读取被锁定的行：只有其为 `active`、`expires_at > clock_timestamp()`、在该语句的快照中仍是该 flow 中 `flow_seq` 最大的行（锁定语句的快照之后、该语句开始之前提交的新预约会使其失去资格；该语句开始之后才提交的新预约本事务看不到；这无碍正确性：同一 flow 的每次预约都先作废该 flow 的最新行（FSL-154），该作废须等待本行锁——在本事务之前提交的预约已使本行为 `void`，在本行锁上等待的预约则在本事务结束后才作废它（已消费的行不再改写））且 `failed_attempts` 小于 5 时继续，否则返回 401 且不改变该行；该语句只对这样的行返回 `code_hmac`，因此在该语句的时钟取样时已过期（含尚未被清理）的行的敏感字段不会被该语句返回；
3. 以 `feishuLoginCodeHmac(key, 行 ID, 验证码)` 与本行 `code_hmac` 做常量时间比较（`timingSafeEqual`，两侧均为 32 字节）。不相等时以一条语句使 `failed_attempts + 1`，加 1 后达到 5 时同一语句置为 `void` 并清空四个敏感字段，提交后返回 401；
4. 相等时读取本行的邮箱、open_id 与姓名（该读取语句同样要求本行仍为 `active` 且按该语句的时钟取样未过期，此时已到期的行不会被读取敏感字段），再以一条语句把本行置为 `consumed` 并清空 `email`、`open_id`、`display_name`、`code_hmac`（该语句重复 `active` 与未过期条件，在两条语句之间到期的行不会被消费，返回 401）；
5. 以 `open_id_hmac` = HMAC-SHA256(`ENTERPRISE_OTP_HMAC_KEY`, `"feishu-identity:v1:" + app_id + ":" + open_id`)（`verify.ts` 的 `feishuLoginOpenIdHmac`，64 个小写十六进制字符，open_id 明文不落库）查找 `feishu_identities` 中 `(app_id, open_id_hmac)` 的绑定：存在时提交；不存在时整个事务回滚。

**并发**：由于第 1 步的行锁，锁定同一行的并发提交依次执行：持锁者消费该行并提交后，后执行者在锁释放后读到已提交的 `consumed` 行，返回 401 且不计为错误次数（持锁者回滚时，后执行者照常判定）。因此锁定同一行的并发正确提交至多一个消费该行；当该行在首个持锁者重新判定时仍是可比较的最新未过期 `active` 行（期间没有新预约提交、没有其它请求先使其作废或消费）、成员有绑定且会话签发成功时，恰好一个返回 200（测试覆盖的即这一情形）。锁定同一行的并发错码同样依次计数，每个被比较的错码恰好计一次，计到 5 次后其余提交不再计数。

**会话**：事务提交后，以 better-auth `internalAdapter.createSession` 签发普通会话（只覆盖 `expiresAt` 为签发后 8 小时，不写入 `enterpriseGrantId`、`enterpriseIdentityId`、`authEpoch`、`authMethod` 任何企业字段），再以 `recordFeishuLoginSession` 在 `feishu_login_sessions` 写入一行该会话 ID，最后设置会话 Cookie（Max-Age 为 8 小时）。这三步任一失败时本卡不做补偿，端点抛错、由 better-auth 返回 500（失败补偿与 503 `{ "status": "retry" }` 由 FSL-169 交付）。

`packages/auth/src/feishu-login/verify.test.ts` 以 `createAuth` 加一次性 PG、预置用户与绑定构造，验证码经签发存储的 `reserve` / `activate` 写入，经 `auth.handler` 断言：正确验证码返回 200；响应设置会话 Cookie 且以该 Cookie 调用 `get-session` 得到绑定用户；`feishu_login_sessions` 恰有该会话一行；会话的四个企业字段为空、有效期为 8 小时；已消费的验证码再次提交返回 401 `{ "status": "invalid" }`；错码返回 401 且该行 `failed_attempts` 逐次加 1；第 5 次错码后该行为 `void` 且四个敏感字段为空，此后正确验证码返回 401；已过期的验证码返回 401 且该行既不被消费也不计数；无 flow Cookie、该 flow 无验证码与无绑定时返回同一 401；同一验证码的两个并发正确请求恰好一个返回 200、只签发一个会话；格式非法时返回 400；未传入 `verify` 选项时 verify 为 404。`packages/database/src/feishu-login-store.integration.test.ts` 断言消费后该行为 `consumed`、四个敏感字段为空且其余各列不变；错码只使 `failed_attempts` 加 1、其余各列不变，第 5 次错码在其余各列不变的前提下置为 `void` 并清空四个敏感字段，之后正确与错误验证码都不改变该行；已达上限的 `active` 行、已过期、已消费、非最新行（含锁定之后才出现更新的预约行）与无绑定时该行不变（已过期的 `active` 行另断言事务内各语句返回的结果中四个敏感字段均为空）；另以在读取邮箱、open_id 与姓名的语句之前于同一事务内使本行到期的方式，断言该语句不返回行、结果为 401 对应的 `invalid`。并发用例使用两个连接池：第一个连接在锁定并比较之后、消费之前暂停，断言另一连接池的连接在锁定语句上等待行锁，放行后恰好一方消费、另一方为 `invalid` 且不计数；另有十个同时提交恰好一个消费、七个同时提交的错码使该行停在 5 次并作废。

## 数据

`feishu_login_codes` 的邮箱、open_id、姓名与验证码 HMAC 只在 `active` 期间保存（FSL-119 的双向 CHECK），消费、作废时在同一语句中清空；未使用而过期的行与超过保留期的行由到期清理处理（FSL-146）。**当前状态：** 调度器尚未接入任何进程，由 FSL-150 在 `apps/web/instrumentation.ts` 的 `register()` 中于飞书模式等待其启动。

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
