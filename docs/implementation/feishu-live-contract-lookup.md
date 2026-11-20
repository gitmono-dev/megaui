# 飞书真实租户契约核对：按邮箱查询（FSL-115）

本文记录 `plan-20261118` FSL-115 在真实飞书测试租户上的只读核对结果。参与者只有用户本人，测试应用为同一租户中的自建应用；用户确认此前从未与该应用的机器人会话（2026-11-19）。凭据只从仓库根目录 `.env` 以 `source` 加载；本文不含凭据、完整邮箱、完整 open_id 或 message_id，响应已按 ER-11 脱敏。核对日期为 2026-11-19。

## Q2: 按邮箱换取 open_id

### 计划假设

`POST /open-apis/contact/v3/users/batch_get_id?user_id_type=open_id`，请求体为 `{"emails": [<邮箱>]}`，命中时 `data.user_list[].user_id` 为 open_id。

### 实测一：Contact v3 `batch_get_id`（计划假设的接口）

- 请求参数：查询参数 `user_id_type=open_id`；请求体 `{"emails": ["<用户本人企业邮箱>"], "include_resigned": false}`；请求头 `Authorization: Bearer <tenant_access_token>`。
- 所需权限：调用返回 `code=0`，说明应用已具备该接口的调用权限（通讯录「通过手机号或邮箱获取用户 ID」类权限）。本次未在开发者后台逐项导出权限名，权限名记为「未取得（按调用结果推断已开通）」。
- 以用户本人邮箱实测（命中预期）：HTTP 200，`code=0`，`msg="success"`，`data.user_list` 恰有 1 项，只含 `email`（`<邮箱>`），**不含 `user_id`**。
- 以测试租户域名下的随机地址实测（未命中）：HTTP 200，`code=0`，`data.user_list` 恰有 1 项，只含 `email`，同样不含 `user_id`。命中与未命中的响应形状完全相同。
- 原因（与 Directory v1 结果交叉印证）：用户本人的地址登记在成员的 `enterprise_email`（企业邮箱）字段，`email` 字段为空；`batch_get_id` 只按 `email` 匹配，因此查不到企业邮箱。结论：计划假设的接口无法按企业邮箱查到成员，记为「未取得」。

### 实测二：Directory v1（替代接口）

用户决策（2026-11-19）：按邮箱查询改用 Directory v1，邮箱优先级为 `enterprise_email`（企业邮箱）> `email`（个人邮箱）。

- `POST /open-apis/directory/v1/employees/filter?employee_id_type=open_id`，条件 `{"field":"base_info.email","operator":"eq","value":"\"<邮箱>\""}`：命中与未命中均为 HTTP 200、`code=0`、`data.employees=[]`。原因同上，用户本人的 `email` 字段为空。
- 同一接口以 `base_info.enterprise_email` 作为过滤字段：HTTP 400，`code=2220012`（该字段不支持过滤），命中与未命中相同。
- `POST /open-apis/directory/v1/employees/search?employee_id_type=open_id`，请求体 `{"query":"<用户本人企业邮箱>","required_fields":["base_info.employee_id","base_info.email","base_info.enterprise_email","base_info.name","base_info.active_status","base_info.is_resigned","work_info.staff_status"],"page_request":{"page_size":10}}`：HTTP 200，`code=0`，`data.employees` 恰有 1 项。在本地按「`enterprise_email` 优先、否则 `email`」做大小写不敏感的精确比较，恰有 1 项匹配。响应形状（脱敏）：
  - `base_info.employee_id`：string，open_id（`ou_` 前缀，长度 35）
  - `base_info.enterprise_email`：string，等于输入地址
  - `base_info.email`：string，空串
  - `base_info.name.name.default_value`：string；`base_info.name.name.i18n_value.{zh_cn,en_us,ja_jp}`：string
  - `base_info.active_status`：int，实测为 `2`（已激活）
  - `base_info.is_resigned`：boolean，实测为 `false`
  - `work_info`：`{}`（请求了 `work_info.staff_status`，但未返回，推断应用未开通该字段权限）
  - `data.page_response`：`{has_more: false, page_token: <string>}`
- 所需权限（按官方文档）：`directory:employee:search`（搜索员工），并按字段分别需要 `directory:employee.base.enterprise_email:read`、`directory:employee.base.email:read`、`directory:employee.base.active_status:read`、`directory:employee.base.is_resigned:read`；以 `tenant_access_token` 调用时数据受应用「通讯录权限范围」约束。实测上述字段均已返回，说明对应权限已开通。
- 搜索语义（按官方文档）：`query` 对 ID 与手机号精确匹配，对姓名与邮箱模糊匹配；不返回离职人员与外部企业成员；只能用 `page_token` 顺序翻页。因此实现必须在本地对候选结果做精确比较，并对零条、多条或任何未识别形状按「不唯一或未命中」fail-closed。

### 鉴权失败形状（Directory v1 `employees/search`）

2026-11-19 以缺失或伪造的 tenant token 调用 `POST /open-apis/directory/v1/employees/search?employee_id_type=open_id`：

- 缺少 `Authorization` 头：HTTP 400，`code=99991661`，`msg` 以 `Missing access token for authorization` 开头，`error` 含 `log_id`、`troubleshooter`（均为 string）。
- 伪造的 token：HTTP 400，`code=99991663`，`msg` 以 `Invalid access token for authorization` 开头，`error` 含 `message`、`log_id`、`troubleshooter`（均为 string）。
- 两种情形的响应都没有 `data`。

### 多人情形

- 核查的官方文档：<https://open.feishu.cn/document/directory-v1/employee/search>、<https://open.feishu.cn/document/directory-v1/employee/filter>、<https://open.feishu.cn/document/directory-v1/employee/mget>（核对日期 2026-11-19）。
- 标记：未实测，按文档。文档说明 `email`、`mobile`「在企业内的在职员工中不可重复」，但未单独说明 `enterprise_email` 的唯一性。`search` 是模糊匹配，可能返回多名候选。
- 文档所述的多人响应形状：`data.employees` 为数组，可含多项，并可能 `has_more=true` 带 `page_token`。按计划 FSL-117 / FSL-122 的约定，本地精确匹配后零条、多条或分页未完都按「不唯一或未命中」fail-closed，不发码。

### 差异与处理

计划假设的 Contact v3 `batch_get_id` 无法按企业邮箱查到成员；改用 Directory v1 `employees/search` 加本地精确匹配（`enterprise_email` 优先于 `email`）后，可以唯一定位用户本人。这一差异改变了计划设计（ADR-FSL-11 的接口选择，以及 FSL-117 查询客户端、FSL-118 Mock 的实现），按 FSL-115「no-go 恢复步骤」②，需要代码改动的差异记为 `no-go（差异已登记）`：由承接卡按 Directory v1 实现，并在真实租户复测 Q2，以「契约已验证」作为承接卡的验收。

来源：2026-11-19 真实测试租户只读调用（Contact v3 `batch_get_id`；Directory v1 `employees/filter`、`employees/search`），以及上列官方文档。

结论：no-go（差异已登记）
