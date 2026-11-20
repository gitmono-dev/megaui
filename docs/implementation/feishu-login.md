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

`packages/engine/src/services/feishu-login/issue.ts` 的 `createFeishuLoginIssuer(options).issueFeishuLoginCode({ flowHash, email })`（FSL-122）实现签发主流程。验证码表 `feishu_login_codes` 的读写集中在 `packages/database/src/feishu-login-store.ts`（`createFeishuLoginCodeStore(pool)`，由 `@megaui/database` 导出）。**当前状态：** 本服务尚未接入任何进程，由 FSL-123 的 request 端点与 FSL-150 的 Web 接线调用。

### 构造

- 服务只用 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`ENTERPRISE_OTP_HMAC_KEY`（解码后的 32 字节）与 `BETTER_AUTH_URL` 构造，另传入 FSL-148 选出的冻结 provider 目标与数据库连接池。
- 现有凭据类型与消息客户端要求的 `tenantKey` 取内部标签 `app:<FEISHU_APP_ID>`（`feishuLoginTenantKey`），只作 token 缓存键，从不发送给飞书，也不写入任何表。
- 私聊文案中的可信站点取 `BETTER_AUTH_URL`。
- 验证码生成器以构造参数 `generateCode` 注入：engine 不依赖 `@megaui/auth`，由 FSL-150 注入 `@megaui/auth` 的 8 位 CSPRNG 生成器，测试注入同一生成器。
- 服务构造的 `FeishuTransport`（token、通讯录查询与私聊发送共用）一律 `maxAttempts: 1`（FSL-149）：每次传输层请求（`request()`）恰好一次 HTTP 请求，传输层不再重试；私聊的重试只由本服务按下文「发送结果」控制，查询阶段的瞬时失败按 provider 失败作废本行，用户可在冷却后重新请求。可选构造参数 `attemptTimeoutMs`（单次 HTTP 尝试的超时，默认 `FEISHU_OPERATION_BUDGET_MS` 即 20 秒）与 `retryBackoffMs`（服务重试的退避基数，默认 250 毫秒，第 n 次重试前等待基数 × 2^(n−1)）只供测试缩短等待。
- `FeishuTransport` 的 `maxAttempts` 是可选参数（正整数，默认 `FEISHU_MAX_ATTEMPTS` = 3，非正整数在构造时以 `INVALID_FEISHU_TRANSPORT_MAX_ATTEMPTS` 拒绝），未传入的现有调用行为不变。

### 主流程

邮箱先去首尾空白并整体转小写（长度 1–254），再计算邮箱 HMAC。每一步都不在飞书调用期间持有事务或锁。

1. **预约**：一个事务先取得与激活相同的邮箱锁（`pg_advisory_xact_lock(<类键>, <邮箱 HMAC 派生键>)`，见第 3 步），再写入本次请求的 `reserved` 行并提交。该行只含邮箱 HMAC、flow 哈希（flow Cookie 值的 SHA-256，64 位小写十六进制）、创建时间与预约到期时间（创建后 2 分钟；创建时间取得锁之后以 `clock_timestamp()` 读取一次，等待邮箱锁不会缩短预约有效期）。`flow_seq` 取该 flow 现有最大值加 1，`email_seq` 取该邮箱 HMAC 现有最大值加 1（同一条 `insert … select max(...) + 1` 语句，在邮箱锁内执行），因此同一邮箱的预约在锁下串行，已提交的 `email_seq` 在同一邮箱内严格递增且与提交顺序一致，激活只按它判定先后，不依赖 `created_at`（时间戳相同或倒序都不影响）。预约与激活持有同一把邮箱锁，所以在激活读出「没有 `email_seq` 更大的预约」之后、写入 `active` 之前，同一邮箱不可能提交新的预约（FSL-149）。FSL-163 的唯一索引 `feishu_login_codes_email_seq_uidx`（`(email_hmac, email_seq)`）与 `feishu_login_codes_flow_seq_uidx`（`(flow_hash, flow_seq)`）保留为纵深防御：绕过邮箱锁的写入取到同一序号时后提交者以唯一冲突失败（不同邮箱、同一 flow 的两次并发预约取到同一 `flow_seq` 时同样如此），服务返回 `{ status: "retry" }`，由 request 端点按预约失败返回 503 重试。FSL-145 在此之上增加冷却、全局预算与全局锁，全局锁在邮箱锁之后获取（先邮箱锁、后全局锁）。
2. **查询**：在事务外以 `FeishuContactClient`（见「飞书接口」）按邮箱查找唯一成员，再按 open_id 读取在职状态。
3. **激活**：激活事务先以 `pg_advisory_xact_lock(<类键>, <邮箱 HMAC 派生键>)` 串行化同一邮箱（类键为常量 `0x46534c01`，派生键为邮箱 HMAC 前 32 位的有符号整数），再以单独一条 `SELECT … FOR UPDATE`（按 `id` 排序）锁定本行与该邮箱 HMAC 的全部 `active` 行（即激活将要作废的行），之后用下一条语句读取状态并校验（FSL-149；到期以取得全部锁之后的 `clock_timestamp()` 判断，而不是事务开始时的 `now()`，因此等待邮箱锁或任一行锁期间到期的预约同样不激活；校验之后的更新不再等待锁。只有持邮箱锁的激活会产生 `active` 行，期间不会出现新的 `active` 行），三条同时满足才激活：
   - 本行仍是 `reserved`；
   - 本行未过期（`expires_at > clock_timestamp()`）；
   - 该邮箱 HMAC 没有 `email_seq` 更大的预约行（不论其状态与 flow）。

   满足时，先以条件更新（`where id = $1 and state = 'reserved' and expires_at > clock_timestamp()`）把本行由 `reserved` 置为 `active`（写入时再次判断到期，校验之后、写入之前到期的预约同样不激活，此时本行置为 `void`、不改动其它行），该更新生效后再把同一邮箱 HMAC 的其它全部 `active` 行（不论 flow）置为 `void` 并在同一语句中清空邮箱、open_id、姓名与验证码 HMAC；本行激活时写入邮箱、open_id、姓名（`base_info.name.name.default_value`，空字符串照样保存）、验证码 HMAC 与到期时间（激活后 5 分钟）。不满足时不发送、不改动其它行，服务返回 `{ status: "not_reserved" }`（存储层的 `reason` 为 `not_reserved`、`expired` 或 `superseded`）：本行仍是 `reserved` 但已过期或已被更晚的预约取代时，在同一事务内置为 `void`（并清空敏感字段）；本行已不是 `reserved`（已作废、已消费）时保持原状。因此较早的预约在较晚的预约之后完成飞书查询时不发送私聊，作废或过期的行不能复活。
4. **发送**：激活提交后经 `FeishuMessageClient` 私聊发送，`uuid` 取本行 ID（同一请求的稳定 UUID，每次尝试的载荷逐字节相同），成功判据见「发送验证码私聊」。每次私聊 HTTP 尝试之前输出 `FEISHU_LOGIN_SEND_ATTEMPT`：服务包装传给传输层的 `fetch`，凡请求私聊地址都先输出该键，该键条数恒等于发出的私聊请求数（该键在请求发出之前输出，未能到达飞书的请求同样计入）。发送结果见下文。

未命中、多人或不在职，以及查询阶段的飞书调用（token、按邮箱搜索、按 open_id 读取）失败时，本行在与激活相同形态的事务中（同一把邮箱锁，条件 `state = 'reserved'`）置为 `void`，不生成验证码、不发送。

### 发送结果

一次发送尝试分两段：先由服务向 `FeishuTokenManager` 取 token（缓存命中时没有 HTTP 请求，需要刷新时恰好一次 token 请求，并发刷新共用同一次），取得 token 后再由 `FeishuMessageClient` 发出恰好一次私聊 HTTP 请求；token 阶段失败时本次尝试没有私聊请求。结果分类（FSL-149）：

| 结果 | 条件 |
|---|---|
| `accepted` | HTTP 2xx 且业务码成功（判据见「发送验证码私聊」） |
| `rejected` | HTTP 429，或明确的业务拒绝（其它 4xx、2xx 且业务码为非零数字）：飞书未受理 |
| `unknown` | HTTP 5xx、超时与连接中断；私聊请求的 HTTP 3xx（传输层拒绝跟随重定向，客户端返回 `rejected`，服务改判为 `unknown`：3xx 是对 POST 的应答，飞书可能已接收）；2xx 但响应体不是可解析的 JSON 或为 JSON `null`（传输层归为暂时性失败）；2xx 但不满足成功判据（`code` 缺失或不是数字、`data.message_id` 或 `data.msg_type` 不符，客户端返回 `rejected`/`invalid_response`，服务改判为 `unknown`）：不能证明飞书未受理，可能已接收 |

token 阶段由服务自己调用 `getToken` 并按抛出的 `FeishuTransportError` 分类（HTTP 429、永久性拒绝与重定向为 `rejected`，其它为 `unknown`；token 阶段的 3xx 仍为 `rejected`，因为该阶段尚未发出私聊请求）；并发等待同一次刷新的各请求得到同一个错误对象（含状态码），因此分类一致。消息客户端只读取本次尝试已取得的 token，不再自行刷新。消息客户端把私聊请求的 HTTP 429 归为暂时性失败（`unknown`）；服务从包装的 `fetch` 读取本次尝试私聊请求收到的 HTTP 状态（按尝试隔离的 `AsyncLocalStorage`，每次尝试各有自己的私聊请求，互不共享），把 429 改判为 `rejected`。

发送结果按全部尝试累计判定：

- 任一次尝试返回 `accepted`：不再重试，不回写（本行若发送期间未被作废、消费或过期，则仍为 `active`），服务返回 `{ status: "sent", send: "accepted" }`。
- 返回 `rejected` 的尝试不重试。
- 返回 `unknown` 时以同一 UUID 最多再重试 2 次（至多 3 次尝试、3 次私聊 HTTP 请求；token 需要刷新时另有 token 请求），重试前按 `retryBackoffMs` 指数退避。
- 所有尝试都返回 `rejected`（即首次尝试即被拒绝）时，以条件更新把本行置为 `void`（仅当本行仍为 `active` 且未过期；发送期间已改变的行保持原状） 并在同一语句中清空邮箱、open_id、姓名与验证码 HMAC，输出 `FEISHU_LOGIN_SEND_REJECTED`，返回 `send: "rejected"`。
- 任一次尝试返回 `unknown` 且没有 `accepted` 时，无论后续返回 `unknown` 还是 `rejected`，都不回写，仍为 `active` 的本行保持 `active`（不能证明此前未送达，验证码在到期前有效），输出 `FEISHU_LOGIN_SEND_UNKNOWN`，返回 `send: "unknown"`。

发送结果的回写一律为条件更新（存储函数 `voidRejectedSend`，同一把邮箱锁；先以单独一条 `SELECT … FOR UPDATE` 取得本行行锁，再执行下面的语句，因此到期以所有锁等待之后的时间判断）：

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
| `FEISHU_LOGIN_SEND_ATTEMPT` | 每次私聊 HTTP 尝试之前 | `{ status: "sent", send: "accepted" \| "rejected" \| "unknown" }` |
| `FEISHU_LOGIN_NO_TARGET` | 零名、多名匹配或 `has_more=true`，本行置为 `void` | `{ status: "no_target" }` |
| `FEISHU_LOGIN_INACTIVE` | 唯一成员不在职，本行置为 `void` | `{ status: "inactive" }` |
| `FEISHU_LOGIN_PROVIDER_FAILED` | token、通讯录请求失败或响应形状无效，本行置为 `void` | `{ status: "provider_failed" }` |
| `FEISHU_LOGIN_SEND_UNKNOWN` | 发送结束时有 `unknown` 尝试而没有 `accepted`，不回写（仍为 `active` 的本行保持 `active`） | `{ status: "sent", send: "unknown" }` |
| `FEISHU_LOGIN_SEND_REJECTED` | 所有发送尝试都返回 `rejected`，本行经条件更新置为 `void`（仅当仍为 `active` 且未过期） | `{ status: "sent", send: "rejected" }` |

预约冲突（`retry`）与激活前状态校验未通过（`not_reserved`：已不是 `reserved`、已过期或已被更晚的预约取代）不输出日志键。

### 测试

`packages/engine/src/services/feishu-login/issue.integration.test.ts` 使用一次性 PG 与真实的 `apps/feishu-mock` 进程，以 Mock 收件箱断言私聊条数与正文，服务经测试内的记录代理访问 Mock，代理在请求到达时计数，默认原样转发；测试断言各分支的日志键、`FEISHU_LOGIN_SEND_ATTEMPT` 条数等于接收侧收到的发送请求数（含以 Mock 故障注入 `500`、`disconnect_after_accept` 触发的服务重试），以及请求中不出现 `app:<FEISHU_APP_ID>` 标签，并对每个非 `active` 行断言敏感字段为空。

FSL-149 的用例另由代理按路径脚本化单个请求：暂扣后转发（构造查询逆序完成、查询期间作废或推进到期）、暂扣后自行应答（构造发送期间的同 flow 重发、消费、清理与「过期但清理未运行」四种交错）、转发给 Mock 后不应答（Mock 已记录送达、服务侧超时）以及既不转发也不应答（超时且未送达）。`email_seq` 的先后另在存储层以相同或倒序的 `created_at` 断言。两个连接并发调用 `reserve` 预约同一邮箱时，后者在前者提交前阻塞于邮箱锁，两者依次提交、`email_seq` 依次为 1、2；持有邮箱锁约 1 秒令 `reserve` 等待时，`created_at` 不早于锁释放时刻且 `expires_at - created_at` 恰为 2 分钟。预约与激活的串行以受控交错断言：A 的激活在「最新预约」校验之后、激活写入之前暂停并持有邮箱锁，同一邮箱的预约 B 在邮箱锁上等待，直到 A 提交后才提交并取得更大的 `email_seq`，随后 B 的激活作废 A。唯一索引的纵深防御以两个连接构造：一个连接绕过邮箱锁直接插入同一序号并停在提交前，`reserve` 在唯一索引上等待，断言恰有一个提交成功、另一个返回 `retry`。另以第三个连接持有邮箱锁、本行行锁或将被作废的旧 `active` 行的行锁，断言在激活或回写等待锁期间到期的行不被激活、不被回写，且旧 `active` 行保持不变；并以两个并发请求共用一次被暂扣后返回 HTTP 429 的 token 刷新，断言两者都判为 `rejected`、不重试、不发私聊。

`packages/engine/src/services/enterprise/feishu/http.test.ts` 以脚本化的 `fetch` 固定传输层现有的重试基线（默认 3 次、暂时性失败重试、永久性失败不重试），并断言 `maxAttempts: 1` 对 5xx、429、连接中断与超时都只发起一次 HTTP 请求。
