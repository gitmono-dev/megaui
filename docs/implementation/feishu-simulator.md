# 飞书 Mock 开发依赖

飞书 Mock 用于本地企业身份功能开发和 E2E 测试。

## 当前交付能力

已交付：源码依赖隔离守卫（FSM-17）、Mock workspace 工具链（FSM-21）、CLI 开发准入 validator（FSM-22）、可运行的 Mock CLI 与独占 runtime（FSM-01）、有界 JSON HTTP 边界（FSM-06）、受保护控制面与合成目录（FSM-07）、本 run 的资源注册、reset 与进程生命周期（FSM-08）、tenant token 签发与准入（FSM-02）、Contact 目录分页与游标读取（FSM-09）Contact 单人读取（FSM-18）DM 请求准入 validator（FSM-20）定向 DM 与 uuid 幂等（FSM-10）、成员在职状态控制（FSL-140）和有界 provider 故障注入（FSM-04）与异步故障受理与取消（FSM-19）、复用 CLI 启动夹具（FSM-15）、逐测 reset 及夹具清理（FSM-16）和 API-only E2E 与 CI（FSM-05），以及 Directory v1 员工路由（FSL-118）。FSL-140 起 Mock 不再发送企业回调、不再记录事件：callback 编码与投递、消息注入、URL 握手、成员事件与事件重放均已删除。

- `apps/feishu-mock` 是 workspace 内的私有包 `@megaui/feishu-mock`，具备 `typecheck`/`build`/`lint`/`dev` 脚本，`tests/` 纳入类型检查，lockfile 由 CMD-10 生成了空 importer，且不引入任何第三方依赖。
- `resolveMockConfig(env)` 只接收调用方提供的环境对象，不读 `process.env`，不监听端口、不写 runtime。它要求 `FEISHU_SIMULATOR_ENABLED` 精确为 `1`、`NODE_ENV` 为 `development` 或 `test`，监听地址固定 `127.0.0.1`，端口取冻结默认 `19400` 或 `0..65535` 的整数；配置不含回调地址，已退场的 `FEISHU_SIMULATOR_CALLBACK_URL` 与其它未知 `FEISHU_SIMULATOR_*` 键一律以 `simulator_unknown_key` 拒绝；返回的配置被冻结。被拒绝的值不会回显到错误消息。
- CLI（`pnpm --filter @megaui/feishu-mock run dev`）只以该 validator 的结果启动：在 `127.0.0.1` 上监听，生成每 run 独立的四个随机秘密（`appSecret`/`verificationToken`/`encryptKey`/`adminToken`），把它连同 `schemaVersion:1`、`baseUrl`、`appId`、`tenantKey` 写入独占 runtime 文件（不含回调地址；`verificationToken`/`encryptKey` 仍随 runtime 生成，但 Mock 不再使用它们），然后向 stdout 输出唯一一行 `{"baseUrl":...,"runtimeFile":...}`；这一行不含任何秘密或 runtime 内容。
- runtime 默认写在系统临时目录下由 CLI 独占创建的 0700 目录中，文件以 0600 独占创建；`FEISHU_SIMULATOR_RUNTIME_FILE` 可指定调用方路径，但已存在或为符号链接时拒绝启动。CLI 在运行期间保持该文件的描述符和自建目录的句柄打开，使它们的 inode 不会被回收复用。正常退出、SIGINT 或 SIGTERM 时，CLI 只删除本进程创建的那个 runtime 文件（以打开描述符的 dev/ino 核对，替换过的文件不删）；写入失败时先删除半写文件并清空归属记录。自建目录只在身份（dev/ino）仍匹配且为空时删除，调用方指定的目录永不删除。路径式删除无法与替换操作做成原子，这一窗口需要同一用户在同一路径上并发替换才会命中，属于本工具的既有边界。
- 本片只提供 listener：未由前序卡交付的路由一律返回冻结的 404 形状 `{"code":4,"msg":"not_found"}`。

控制面只有 `GET /__mock/state`、`POST /__mock/reset`、`POST /__mock/faults` 与 `PATCH /__mock/users/:open_id`；其它控制路径一律返回冻结的 404。

## HTTP 边界（FSM-06）

本片把 listener 扩展为有界 JSON HTTP 表面，并冻结后续各卡复用的输入与错误合同。当前只交付 `GET /health`，返回 `{"ok":true,"service":"feishu-mock"}`。

请求侧的合同：

- `Host` 必须精确等于 listener 的 `host:port`；带 `X-Forwarded-Host` 的请求一律拒绝，不信任任何转发头。
- 声明了 body 的请求（`Content-Length` 或 `Transfer-Encoding`）只接受 `application/json`（可带参数）。
- body 必须是 JSON 对象且不含该路由 schema 未定义的字段；当前没有任何已交付路由接受 body，因此 body 出现字段即被拒绝。
- 查询参数不得重复、不得为空值。
- body 上限 32KiB；body 读取与 header 读取各有 5 秒预算，两者独立计时。

错误按冻结映射输出，`code` 是稳定机器键，响应体只含 `{"code":…,"msg":…}`，不回显请求正文或秘密：

| `code` | HTTP | 含义 | 本片使用的 `msg` |
|---|---|---|---|
| 1 | 400 | 输入非法 | `mock_host_mismatch`、`mock_forwarded_host_rejected`、`mock_content_type_invalid`、`mock_query_duplicate`、`mock_query_invalid`、`mock_unknown_field`、`mock_body_invalid`、`mock_body_too_large`、`mock_request_invalid` |
| 4 | 404 | 路由不存在或未交付 | `not_found` |
| 7 | 504 | 读取超时 | `mock_read_timeout` |

其余 `code`（2/3/5/6/8）已在映射表中冻结，留给后续卡使用。

读取预算的实现方式：body 由 `readJsonBody` 计时，超时后停止读取而不销毁请求，先回冻结的 504 再关闭连接——直接销毁请求会让客户端只看到连接重置而不是冻结的错误。header 预算由 listener 自己实现：Node 的 `server.headersTimeout` 在当前运行时不会打断未完成的 header，因此连接一旦开始接收请求字节就必须在 5 秒内交付完整 header，超时同样回冻结的 504；从未收到任何字节的空闲连接按 Node 关闭空闲 keep-alive 连接的方式直接关闭，不会收到多余响应。

## 控制面与合成目录（FSM-07）

控制面只属于 Mock 进程，不是网站产品路由，当前只交付 `GET /__mock/state`：

- 只接受本 run 独立生成的 admin Bearer（`Authorization: Bearer <adminToken>`）。缺该 header 返回 `401 {"code":2,"msg":"mock_admin_token_missing"}`；header 存在但不是 Bearer、scheme 不对或 token 不匹配返回 `401 {"code":2,"msg":"mock_admin_token_invalid"}`。比较用摘要后的常量时间比较，不泄露 token 内容。
- 带 `Origin` 的控制面请求返回 `403 {"code":3,"msg":"mock_control_origin_rejected"}`；任何响应都不带 CORS 头，预检请求同样拿不到 CORS 头。
- provider token 不能访问 `/__mock/**`。已删除的 `POST /__mock/messages`、`POST /__mock/verify-callback`、`POST /__mock/replay` 与 `/__mock/users/:open_id` 上除 `PATCH` 以外的方法返回冻结的 404（FSL-140）。
- `GET /__mock/state` 返回 `{"code":0,"data":{"users","inboxes","faults"}}`。`users` 是冻结的目录成员子集，`inboxes` 按 `open_id` 分组，`faults` 是故障规则；状态不含事件，runtime 配置、token 和 secret 都不在其中。

合成目录是固定的 fixture，不含任何真实人员数据：

| 成员 | `open_id` | 部门 | 通知邮箱 | 其它 |
|---|---|---|---|---|
| Mock Alice | `ou_mock_alice` | `od_mock_engineering` | `alice@example.com` | `user_id=u_mock_alice`、`union_id=on_mock_alice`、`mobile=+15550000001` |
| Mock Bob | `ou_mock_bob` | `od_mock_engineering` | `bob@example.com` | `user_id=u_mock_bob`、`union_id=on_mock_bob`、`mobile=+15550000002` |
| Mock Carol | `ou_mock_carol` | `od_mock_operations` | 空 | `user_id=u_mock_carol`、`union_id=on_mock_carol`、`mobile=+15550000003` |
| Mock Dave | `ou_mock_dave` | 无 | 空 | `enterprise_email=dave@corp.example.com`、`user_id=u_mock_dave`、`union_id=on_mock_dave`、`mobile=+15550000004` |
| Mock Erin | `ou_mock_erin` | 无 | 空 | `enterprise_email=shared@corp.example.com`、`user_id=u_mock_erin`、`union_id=on_mock_erin`、`mobile=+15550000005` |
| Mock Frank | `ou_mock_frank` | 无 | 空 | `enterprise_email=shared@corp.example.com`、`user_id=u_mock_frank`、`union_id=on_mock_frank`、`mobile=+15550000006` |

部门为 `od_mock_engineering`（Mock Engineering）与 `od_mock_operations`（Mock Operations）。「通知邮箱」列是成员的 `email` 字段。Alice、Bob、Carol 的 `enterprise_email` 为空；Dave、Erin、Frank 是 FSL-118 为 Directory v1 员工路由加入的固定成员：Dave 只有 `enterprise_email`、`email` 为空，Erin 与 Frank 共用同一个 `enterprise_email`。这三名成员不属于任何部门，因此不出现在部门分页（`find_by_department`）里；它们是固定 fixture，不经控制面写操作产生，reset 后恢复。

成员状态用冻结的四个布尔字段表达：`active` = `true/false/false/false`，`suspended` = `true/true/false/false`，`resigned` = `false/false/true/true`（依次为 `is_activated`/`is_frozen`/`is_resigned`/`is_exited`）。初态成员都是 `active`。

## 生命周期与 reset（FSM-08）

本 run 的资源只能通过 `src/lifecycle.ts` 的注册接口进入运行态：业务 store 用 `registerStore` 注册，异步任务用 `startTask` 启动。未注册的资源既不参与 reset，也不能在 reset 之后写回。

- `MockLifecycle` 维护一个 generation。`reset()` 先递增 generation，因此旧 generation 的异步完成无法写回新状态；随后取消全部已注册在途任务并等待它们结束，再逐个调用已注册 store 的重置器，只有这些都完成后才报告成功。
- 异步任务通过 `context.commit(effect)` 写回：只有当任务没有被取消且 generation 仍是当前值时写入才会生效，否则返回 false。
- synthetic 目录是一个已注册 store，reset 后恢复冻结初态（成员与其在职状态、部门复原，inbox、故障清空）。本 run 的 App 配置与 admin token 不属于任何 store，reset 后保留。
- `POST /__mock/reset`（admin Bearer，body 为 `{}` 或无 body）执行 reset，返回 `{"code":0,"data":{"generation":N}}`。
- 关闭与信号：SIGINT/SIGTERM 先关闭 listener 并取消已注册任务，再由 FSM-01 的 `removeRuntimeTarget` 清理 runtime 文件；调用方指定的目录永不删除。
- IPC：由父进程以 `stdio` 里的 `ipc` 启动时，父进程关闭 IPC 通道会让本进程收到进程级 `disconnect` 事件，随后 cleanup 并以 0 退出；手工启动（没有 IPC 通道）不会因为缺少 IPC 而自动退出。

## tenant token 与 provider 准入（FSM-02）

本片交付 legacy tenant token 接口与 provider Bearer 的准入判定：

- `POST /open-apis/auth/v3/tenant_access_token/internal`（body 为 `{app_id,app_secret}`，未知字段拒绝）用本 run 的 app 凭据签发 token。成功响应是顶层 legacy 合同 `{"code":0,"msg":"ok","tenant_access_token":…,"expire":7200}`，token 不放在 `data` 里。
- app 凭据不匹配时拒绝签发：`401 {"code":2,"msg":"mock_app_credentials_invalid"}`；字段缺失或类型不对是 `400 {"code":1,"msg":"mock_body_invalid"}`。
- token 有效期 7200 秒，活跃上限 32 个；达到上限时拒绝新签发：`429 {"code":6,"msg":"mock_token_capacity_exceeded"}`。到期 token 在签发时回收，容量随之释放。
- provider Bearer 的准入判定是纯函数 `MockTokenStore.validate(bearer, appId)`：只接受本 run 签发、未到期且属于该 app 的 token；跨进程或其它 run 的 token 一律不获准。本片不提供受保护的 provider 路由，那属于后续卡。
- token store 是已注册的 store，reset 后本 run 之前签发的 token 立即失效。

## Contact 目录与游标（FSM-09）

- `GET /open-apis/contact/v3/users/find_by_department`（provider Bearer）按部门分页读取成员。必须带 `department_id`；`department_id_type` 只接受 `open_department_id`、`user_id_type` 只接受 `open_id`（缺省即这两个冻结值，其它值一律拒绝）；`page_size` 取 1..100、缺省 2。
- 响应是 provider 形状：`{"code":0,"msg":"ok","data":{"items":[User],"has_more":…,"page_token":…}}`。`items` 只含冻结的 User 子集，成员顺序按 fixture 固定，分页稳定。部门不存在返回 `404 {"code":4,"msg":"mock_department_not_found"}`。
- 游标是不透明随机 token，绑定完整查询（部门、两种 ID 类型、page_size）。篡改、跨查询或跨 page_size 使用都返回 `400 {"code":1,"msg":"mock_cursor_invalid"}`。
- 游标 TTL 300 秒、至多 128 个。到期游标在写入前回收；满额时拒绝新建并返回 `429 {"code":6,"msg":"mock_cursor_capacity_exceeded"}`，且不淘汰仍有效的记录。
- cursor store 已注册到 reset，重置后旧游标不再获准（重置同时作废本 run 签发的 token，因此需要重新签发才能再次访问目录）。

## Contact 单人读取（FSM-18）

- `GET /open-apis/contact/v3/users/:user_id`（provider Bearer）按 open_id 读取单个成员。路径值只按 open_id 解释；请求必须带 `user_id_type=open_id` 与 `department_id_type=open_department_id`，缺一个返回 `400 {"code":1,"msg":"mock_id_type_required"}`，写成别的值返回 `400 {"code":1,"msg":"mock_id_type_invalid"}`。
- 成功响应是 provider 形状：`{"code":0,"msg":"ok","data":{"user":User}}`，`user` 是当前 synthetic 目录里的冻结 User 子集；未知或已删除的 open_id 返回 `404 {"code":4,"msg":"mock_user_not_found"}`。
- 该路由复用 FSM-02 的 tenant validator 与同一份当前目录，与分页路由读到的是同一批成员。

## Directory v1 员工路由（FSL-118）

两条路由按真实租户实测的形状应答（FSL-115、FSL-164，见 `feishu-live-contract-lookup.md`、`feishu-live-contract-member.md`），处理逻辑在 `apps/feishu-mock/src/employees.ts`，直接读取本 run 的当前成员（与部门分页、单人读取是同一份目录），不依赖部门目录模块。

- `POST /open-apis/directory/v1/employees/search?employee_id_type=open_id` 与 `POST /open-apis/directory/v1/employees/mget?employee_id_type=open_id` 都必须带 `employee_id_type=open_id`：缺省返回 `400 {"code":1,"msg":"mock_id_type_required"}`，写成别的值返回 `400 {"code":1,"msg":"mock_id_type_invalid"}`。非 `POST` 返回冻结的 404。
- `search` 的 body 为 `{query, required_fields?, page_request?}`，`query` 必须是非空白字符串；`mget` 的 body 为 `{employee_ids, required_fields?}`，`employee_ids` 是 1..100 个非空字符串。未知字段返回 `mock_unknown_field`，类型不符返回 `400 {"code":1,"msg":"mock_body_invalid"}`。`required_fields` 只做类型校验，响应总是下文的固定字段集；`page_request` 只做类型校验（`page_size` 取 1..100）。
- 模糊搜索语义：成员的姓名、`email` 或 `enterprise_email` 以大小写不敏感的方式包含 `query` 即为候选（空字段不参与匹配），离职成员从不返回，冻结成员照常返回。Mock 一次返回全部候选，顺序按 fixture；真实接口分页未完的情形由 FSL-117 的替身测试覆盖，Mock 不模拟。
- `mget` 按请求顺序返回已知成员（重复 id 只返回一次），离职成员同样返回；未知或已删除的 open_id 不出现在 `data.employees` 中，只记入 `data.abnormals`，项为 `{"id":<open_id>,"row_error":0,"field_errors":{"base_info.employee_id":2002}}`（按官方文档，2002 为「用户不存在」；未实测）。
- 状态派生：`active` → `active_status=2`、`is_resigned=false`；`suspended` → `3`、`false`；`resigned` → `4`、`true`。状态取自成员的四个冻结布尔字段（`is_resigned` 或 `is_exited` 为真即 `resigned`，否则 `is_frozen` 为真即 `suspended`，其余为 `active`）。

成功响应（员工字段两条路由相同）：

```json
{"code":0,"msg":"","data":{
  "employees":[{"base_info":{"employee_id":"ou_mock_dave","enterprise_email":"dave@corp.example.com","email":"",
    "name":{"name":{"default_value":"Mock Dave","i18n_value":{"zh_cn":"Mock Dave","en_us":"Mock Dave","ja_jp":"Mock Dave"}}},
    "active_status":2,"is_resigned":false},"work_info":{}}],
  "page_response":{"has_more":false,"page_token":""}}}
```

`mget` 的 `data` 是 `{"employees":[…],"abnormals":[…]}`，没有 `page_response`。`name.name.i18n_value` 三个语言值都取成员的合成姓名；`work_info` 恒为 `{}`（实测租户未返回 `work_info.staff_status`）。`search` 成功响应的 `msg` 为空串是实测值；`mget` 成功响应的 `msg` 未实测（官方文档示例为 `"success"`），Mock 取空串，不作为验收判据。

鉴权失败形状（实测），只用于这两条路由：

- 请求没有可解析的 Bearer token（缺少 `Authorization` 头，或头不是 `Bearer <token>`）：HTTP 400，`{"code":99991661,"msg":"Missing access token for authorization. …","error":{"log_id":…,"troubleshooter":…}}`，没有 `data`。
- Bearer token 不被接受（非本 run 签发、已到期或属于其它 app）：HTTP 400，`{"code":99991663,"msg":"Invalid access token for authorization. …","error":{"message":…,"log_id":…,"troubleshooter":…}}`，没有 `data`。
- `error` 的各值是 Mock 的固定串，不回显请求里的 token。过期 token 在真实租户的形状未实测，Mock 按伪造 token 处理（`99991663`）。

其它 provider 路由的鉴权错误不变：token 签发仍是 `mock_app_credentials_invalid`，部门分页、单人读取与发消息仍是 `401 {"code":2,"msg":"mock_provider_unauthorized"}`。这两条路由不消费故障注入队列（故障 target 仍只有 `token`/`directory`/`user`/`message`）。

## DM 请求准入（FSM-20）

本片只做纯输入判定，不发送消息、也不提供 DM 路由：调用方注入已交付的目录快照，拿到一份可供发送器与 uuid 去重复用的规范载荷。

- `admitMessageInput(input, directory)` 要求 `receive_id` 是非空字符串、`msg_type` 恰为 `text`、`content` 是 JSON 字符串且恰好只含一个 `text` 字段（其值为字符串）。
- 文本上限 4096 字符，超出返回 `400 {"code":1,"msg":"mock_text_too_long"}`；content 结构不符返回 `400 {"code":1,"msg":"mock_content_invalid"}`。
- 收件人不在注入的目录快照里时拒绝：`404 {"code":4,"msg":"mock_user_not_found"}`。
- 规范载荷固定三个字段 `receive_id`/`msg_type`/`content`，同一输入总是得到同一份载荷，供 uuid 比较复用；`uuid` 本身只做类型校验，不进入规范载荷。

## 定向 DM 与 uuid 幂等（FSM-10）

- `POST /open-apis/im/v1/messages?receive_id_type=open_id`（provider Bearer）按成员定向投递。请求必须带 `receive_id_type=open_id`（缺省报 `mock_id_type_required`，写成别的值报 `mock_id_type_invalid`），body 为 `{receive_id,msg_type,content,uuid}`，未知字段拒绝。
- 请求先过 FSM-02 的 tenant validator，再过 FSM-20 的准入判定，两者都通过才写入收件人的 inbox。
- 成功响应采用 FSL-165 Q4 实测的真实形状（FSL-170）：`{"code":0,"msg":"success","data":{"message_id":…,"msg_type":"text","body":{"content":…},"chat_id":"oc_<receive_id>","create_time":…,"update_time":…,"deleted":false,"updated":false,"sender":{"id":"cli_mock_megaui","id_type":"app_id","sender_type":"app","tenant_key":"tenant_mock_megaui"}}}`。不含 `data.receive_id`，也不含顶层 `data.content`；`sender` 取 Mock 固定值，`update_time` 等于 `create_time`。`message_id` 由 `(app_id, uuid)` 稳定派生，同一个 uuid 永远是同一个 id。
- `data.body.content` 是请求 `content` 的确定性重新序列化，文本相同但与请求原文不逐字节相等：先紧凑序列化并把非 ASCII 字符转义为 `\uXXXX`；若结果仍与原文相同（ASCII 文本恰以该形式发送），改用一空格缩进的形式。
- 首次应答与同一 uuid 的台账应答由同一构造函数 `messageSuccessResponse` 从同一条账本记录生成，两者深相等。
- uuid 账本以 `(app_id, uuid)` 为键：同一 uuid 的同一规范载荷返回原结果且不新增 inbox 条目；同一 uuid 的不同规范载荷返回 `409 {"code":5,"msg":"mock_uuid_conflict"}`。
- 成员 inbox 上限 100 条，满额时拒绝新消息：`429 {"code":6,"msg":"mock_inbox_full"}`；但既有 uuid 的同载荷重试仍返回原结果。
- 账本保留到本 run reset 或进程结束，token 到期不释放它。消息与 uuid store 已注册到 reset，重置后 inbox 与账本都为空。

## 成员在职状态控制（FSL-140）

- `PATCH /__mock/users/:open_id`（admin Bearer，`{status:"active"|"suspended"|"resigned"}`）只修改目标成员的在职状态，其他成员与 inbox、故障队列都不变；后续单人读取与 Directory v1 员工路由立即读到新状态。成功返回 `{"code":0,"data":{"user":…}}`。
- 它是 engine 飞书集成测试构造不在职成员的测试控制：不发送回调、不产生事件，也不需要 app secret。
- 同一路径的其它方法（`DELETE`、`GET`、`POST`、`PUT` 等）返回冻结的 `404 {"code":4,"msg":"not_found"}`，不改变状态。
- 未知成员（含无法解码的路径值）返回 `404 {"code":4,"msg":"mock_user_not_found"}`，非法 status 返回 `400 {"code":1,"msg":"mock_status_invalid"}`，body 出现未定义字段按 HTTP 边界拒绝；reset 恢复冻结初态的在职状态。

## 有界 provider 故障注入（FSM-04）

- `POST /__mock/faults`（admin Bearer，`{target,kind,count?,skip?}`）向本 run 的规则队列加入一条规则。target 只接受 `token`/`directory`/`user`/`message`，kind 只接受本片交付的 `429`/`403`/`500`；`count` 取 1..10（缺省 1），`skip` 取 0..10（缺省 0）。
- 队列最多 16 条，满额时 `429 {"code":6,"msg":"mock_fault_capacity_exceeded"}`。规则按加入顺序按 target 消费：先跳过 `skip` 次，再逐次扣减 `count`，归零后移除。
- 注入响应：403 → `{"code":3,"msg":"mock_fault_forbidden"}`；429 → `{"code":6,"msg":"mock_fault_rate_limited"}`；500 → **HTTP 500** 加 `{"code":8,"msg":"mock_provider_failure"}`（这是冻结的故障 override，code 8 的默认映射为 503）。
- 只有通过各自输入/鉴权的 provider 请求才消费规则；被拒绝的请求不消耗。控制面、health 与 reset 不受故障队列影响。
- `timeout` 与 `disconnect_after_accept` 由 FSM-19 受理：timeout 等待 1 秒后返回 `504 {"code":7,"msg":"mock_provider_timeout"}`；`disconnect_after_accept` 只对 `message` 有效，在消息与 uuid 落库后断开连接（客户端看到连接错误），同 uuid 重试从账本返回原结果、不产生第二条消息。
- 延迟 timer 注册为任务，reset 会在其成功返回前取消它；旧 generation 的完成不会写回新状态。
- 故障队列是已注册的 store，reset 后清空。

## 复用 CLI 启动夹具（FSM-15）

`apps/web/tests/e2e/helpers/feishu-mock.ts` 导出 `startFeishuMock()`：

- 以冻结协议直接启动真实 CLI：`spawn(process.execPath, ["--import","tsx",<repo>/apps/feishu-mock/src/index.ts], {cwd: repoRoot, shell:false, stdio:["ignore","pipe","pipe","ipc"]})`，子进程环境只有冻结的模拟器键（`FEISHU_SIMULATOR_ENABLED`/`NODE_ENV`/`FEISHU_SIMULATOR_PORT`），不接受调用方传入的 env 对象。
- listener 由 port0 实际分配；FSL-140 起夹具不再创建 callback receiver，也不再设置回调地址。
- 启动在 15 秒预算内等待 ready 行、runtime 文件与 `/health` 三者一致，任一处不符或进程早退都会失败并清理本片创建的资源。
- 成功返回 `{baseUrl, runtime, runtimeFile, pid, reset, stop}`；`stop()` 先 SIGTERM 再按需 SIGKILL，并确认进程真实退出。

## 逐测 reset 与夹具清理（FSM-16）

- 夹具的 `reset()` 把本 run 恢复到 synthetic 初态：reset 先取消旧 generation 的在途任务（如延迟的故障应答）再应答。
- `stop()` 成功与失败共用同一条 finally 清理路径：先 reset，再停进程；任一步失败都不会被吞掉，teardown 失败会让测试失败。
- 停进程最多等 3 秒 SIGTERM，未退出再 SIGKILL 并最多等 3 秒，且以真实 exit 事件判定，不用 `child.killed` 冒充退出。
- 兜底清理只触及 ready 回执确认归本 run 的资源（runtime 文件、本片子进程）；其它 run 一律不动。

## API-only E2E 与 CI（FSM-05）

- `playwright.feishu-mock.config.ts` 只收集 `feishu-mock.spec.ts`，workers 2、fullyParallel，trace/video/screenshot 全部关闭；不启动网站、浏览器或数据库。
- `apps/web/tests/e2e/feishu-mock.spec.ts` 用真实 CLI 与真实 HTTP 跑完整协议：签发 tenant token、目录分页读取、单人读取、provider 定向消息写入成员 inbox、已删除的消息注入路由返回 404、在职状态控制只改目标成员；reset 后 token/cursor/inbox/uuid/fault 全部清空且旧 generation 的 token 不再获准；同一 worker 内第二个实例的端口、状态与凭据互不影响。
- quality 作业不再执行 Mock API E2E 及三个 TS 文件（`playwright.feishu-mock.config.ts`、`feishu-mock.spec.ts`、`helpers/feishu-mock.ts`）的独立类型门；两者按 CMD-07 在本地运行（命令见下文「验证 Mock API E2E」）。

## 源码边界

| 来源 | 允许的依赖 |
|---|---|
| `apps/feishu-mock/src/**` | 真实 `node:*` 内置模块，以及本 App 内部相对模块 |
| `apps/feishu-mock/tests/**` | Vitest、Playwright 等测试工具，以及 Mock 自身源码 |
| 网站、worker、协作服务、共享包及网站 E2E 复用夹具 | 通过 CLI、HTTP 与 Mock 交互；禁止直接 import Mock 源码或包入口 |

生产源码不能以裸 `fs`、第三方库、工作区包或路径别名绕过依赖边界。测试工具的依赖许可不扩展到 `src/**`。

守卫的判定是可判定的，不依赖还原运行期别名：

- Mock 生产源码的静态导入只能指向 `src/**` 内的相对模块，或下面这组明确的 `node:*` 内置模块：`node:assert`、`node:assert/strict`、`node:buffer`、`node:crypto`、`node:events`、`node:fs`、`node:fs/promises`、`node:http`、`node:net`、`node:os`、`node:path`、`node:path/posix`、`node:process`、`node:stream`、`node:stream/consumers`、`node:stream/web`、`node:string_decoder`、`node:timers`、`node:timers/promises`、`node:url`、`node:util`、`node:util/types`、`node:zlib`。这是一份白名单：Node 中可加载、求值或派生进程的能力（`node:module`、`node:vm`、`node:worker_threads`、`node:inspector`、`node:repl`、`node:child_process`、`node:sqlite` 等）因此在构造上就被排除。被 tsconfig `paths` 重写过的 `node:` 说明符同样拒绝。
- Mock 生产源码的动态加载必须使用字面量说明符，且该字面量是上述白名单里的内置模块或 `src/**` 内的相对模块。
- Mock 生产源码使用 ESM 导入语法；`import =` 形式不在允许集合内。
- Mock 生产源码不得出现 `require`、`createRequire`、`register`、`process.getBuiltinModule`、`process.dlopen`、`eval`、`Function`、`globalThis`、`Reflect`、`WebAssembly` 以及 `.constructor` 等不透明加载器或运行期求值：计算属性、解构、全局属性和数组 `join` 等拼写同样拒绝，它们的目标无法静态判定。
- 其它 apps/packages（含网站 E2E 复用夹具）的静态导入不得指向 Mock；动态加载同样必须使用字面量说明符，计算得到的目标一律拒绝。加载器识别跟随 `node:module` 的导入绑定而非本地别名，并覆盖 `require`、`module.require`（含 `const { require } = module`）、成员与解构绑定、条件与逻辑表达式、被当作参数传入或转交给他人的加载器、加载器的 `.call/.apply/.bind`，以及锚定在 Mock 路径上的 `createRequire`。

守卫是静态判定：它拒绝一切可见的动态加载与不透明加载器写法。仍需代码评审的是那些本身不可静态识别的手段，例如先用 `fs` 读入 Mock 源码再求值——这类写法无法由静态守卫判定，因此 Mock 生产源码同时禁止 `eval`、`Function`、`globalThis`、`Reflect` 与 `.constructor`，并禁用上述可加载、求值或派生进程的内置模块；消费方的运行期求值按代码评审处理。

消费者按该文件最近的 tsconfig 解析路径别名，因此网站 `@/*` 不能绕进 Mock；`file://` 说明符（含协议名大小写、多余斜杠或 `localhost`）按同一规则判定。类型断言、`satisfies` 和 `!` 不会把已知的 Mock 说明符变成允许加载。Mock 内部相对模块按文件系统解析，不依赖模块解析器。

## 检查与验证

依赖守卫已经挂入仓库标准 lint：

```sh
pnpm turbo run lint
```

单独检查依赖图：

```sh
pnpm run lint:deps
```

验证守卫的允许和拒绝行为：

```sh
pnpm vitest run tests/guards/dep-direction.test.ts
```

验证 CLI 开发准入 validator：

```sh
pnpm vitest run apps/feishu-mock/tests/unit/config.test.ts
```

验证 HTTP 边界与冻结错误合同：

```sh
pnpm vitest run apps/feishu-mock/tests/unit/http.test.ts
```

验证控制面与合成目录：

```sh
pnpm vitest run apps/feishu-mock/tests/unit/control.test.ts
```

验证资源注册、reset 与进程生命周期：

```sh
pnpm vitest run apps/feishu-mock/tests/unit/lifecycle.test.ts
```

验证 tenant token 签发与准入：

```sh
pnpm vitest run apps/feishu-mock/tests/unit/token.test.ts
```

验证 Contact 目录分页与游标：

```sh
pnpm vitest run apps/feishu-mock/tests/unit/directory.test.ts
```

验证 Contact 单人读取：

```sh
pnpm vitest run apps/feishu-mock/tests/unit/user.test.ts
```

验证 Directory v1 员工路由：

```sh
pnpm vitest run apps/feishu-mock/tests/unit/directory-v1.test.ts
```

验证 DM 请求准入：

```sh
pnpm vitest run apps/feishu-mock/tests/unit/message-input.test.ts
```

验证定向 DM 与 uuid 幂等：

```sh
pnpm vitest run apps/feishu-mock/tests/unit/messages.test.ts
```

验证控制面与成员在职状态控制：

```sh
pnpm vitest run apps/feishu-mock/tests/unit/control.test.ts
```

验证有界 provider 故障注入：

```sh
pnpm vitest run apps/feishu-mock/tests/unit/faults.test.ts
```

验证异步故障受理与取消：

```sh
pnpm vitest run apps/feishu-mock/tests/unit/async-faults.test.ts
```

验证复用 CLI 启动夹具：

```sh
pnpm vitest run apps/web/tests/unit/feishu-mock-start.test.ts
```

验证逐测 reset 与夹具清理：

```sh
pnpm vitest run apps/web/tests/unit/feishu-mock-cleanup.test.ts
```

验证 Mock API E2E：

```sh
pnpm exec playwright test --config playwright.feishu-mock.config.ts
```

测试使用真实 dependency-cruiser 和当前规则，在独占临时目录中构造源码图；同时检查真实工作区。临时图验证结束后清理，不需要飞书凭据、网站数据库或运行中的 Mock。

## 错误与恢复

依赖违规会使检查以非零退出，并输出命中的规则。应把违规依赖移回所属模块，跨进程调用使用 CLI、HTTP；不要通过测试目录或路径别名给生产源码开口。

配置准入被拒时抛出 `MockConfigError`，其 `code` 是稳定的机器键：`simulator_disabled`（`FEISHU_SIMULATOR_ENABLED` 不是精确的 `1`）、`simulator_node_env_invalid`（`NODE_ENV` 不是 `development`/`test`）、`simulator_port_invalid`（端口不是 `0..65535` 的整数）、`simulator_runtime_file_invalid`（runtime 文件路径为空）、`simulator_unknown_key`（出现未登记的 `FEISHU_SIMULATOR_*` 键）。调用方按 `code` 分支处理，不要匹配错误文案。

HTTP 侧的错误同样是机器键：`{"code":…,"msg":…}` 中的 `msg` 取值见上表。调用方按 `code` 分支处理，不要匹配错误文案，也不要假设响应会回显请求内容。超时后连接会被关闭，客户端需要重连而不是复用该连接。

本片没有持久数据或运行中的服务。撤回时按切片回退：撤回 workspace 工具链只删除 `apps/feishu-mock` 骨架并由 CMD-10 移除对应 lockfile importer，保留已交付的依赖隔离守卫；撤回依赖隔离守卫才移除 Mock 依赖规则、对应测试和说明，并恢复仓库原有包方向守卫。已推送的修改使用后续修正提交，不清理其他任务的文件。
