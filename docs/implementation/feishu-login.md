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

### 主流程

邮箱先去首尾空白并整体转小写（长度 1–254），再计算邮箱 HMAC。每一步都不在飞书调用期间持有事务或锁。

1. **预约**：一个事务写入本次请求的 `reserved` 行并提交。该行只含邮箱 HMAC、flow 哈希（flow Cookie 值的 SHA-256，64 位小写十六进制）、创建时间与预约到期时间（创建后 2 分钟）。`flow_seq` 取该 flow 现有最大值加 1，`email_seq` 取该邮箱 HMAC 现有最大值加 1。并发的两次预约取到同一序号时，FSL-163 的唯一索引使后提交者失败，服务返回 `{ status: "retry" }`，由 request 端点按预约失败返回 503 重试（FSL-145 引入邮箱锁后改在锁内分配，不再冲突）。
2. **查询**：在事务外以 `FeishuContactClient`（见「飞书接口」）按邮箱查找唯一成员，再按 open_id 读取在职状态。
3. **激活**：激活事务先以 `pg_advisory_xact_lock(<类键>, <邮箱 HMAC 派生键>)` 串行化同一邮箱（类键为常量 `0x46534c01`，派生键为邮箱 HMAC 前 32 位的有符号整数），把同一邮箱 HMAC 的全部 `active` 行（不论 flow）置为 `void` 并在同一语句中清空邮箱、open_id、姓名与验证码 HMAC，再把本行由 `reserved` 置为 `active`，写入邮箱、open_id、姓名（`base_info.name.name.default_value`，空字符串照样保存）、验证码 HMAC 与到期时间（激活后 5 分钟）。本行已不是 `reserved` 时整个事务回滚、不发送（`{ status: "not_reserved" }`）；激活前的到期与最新预约校验由 FSL-149 补齐。
4. **发送**：激活提交后经 `FeishuMessageClient` 私聊发送，`uuid` 取本行 ID（同一请求的稳定 UUID），成功判据见「发送验证码私聊」。每次私聊 HTTP 尝试之前输出 `FEISHU_LOGIN_SEND_ATTEMPT`：服务包装传给传输层的 `fetch`，凡请求私聊地址都先输出该键，因此传输层在一次 `send` 调用内对 5xx、429、超时与连接中断以同一载荷所做的重试（至多 3 次 HTTP 请求）也逐次计入，该键条数恒等于发出的私聊请求数（该键在请求发出之前输出，未能到达飞书的请求同样计入）。本卡对每个请求只发起一次 `send` 调用；发送结果的三分支处理、签发服务的同 UUID 重试与传输层单次尝试（`maxAttempts: 1`）由 FSL-149 实现。

未命中、多人或不在职，以及查询阶段的飞书调用（token、按邮箱搜索、按 open_id 读取）失败时，本行在与激活相同形态的事务中（同一把邮箱锁，条件 `state = 'reserved'`）置为 `void`，不生成验证码、不发送。

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

预约冲突（`retry`）与激活时本行已不是 `reserved`（`not_reserved`）不输出日志键。

### 测试

`packages/engine/src/services/feishu-login/issue.integration.test.ts` 使用一次性 PG 与真实的 `apps/feishu-mock` 进程，以 Mock 收件箱断言私聊条数与正文，服务经测试内的记录代理访问 Mock，代理在请求到达时计数并原样转发；测试断言各分支的日志键、`FEISHU_LOGIN_SEND_ATTEMPT` 条数等于接收侧收到的发送请求数（含以 Mock 故障注入 `500`、`disconnect_after_accept` 触发的传输层重试），以及请求中不出现 `app:<FEISHU_APP_ID>` 标签。
