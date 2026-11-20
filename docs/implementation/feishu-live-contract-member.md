# 飞书真实租户契约核对：token 与成员状态（FSL-164）

本文记录 `plan-20261118` FSL-164 在真实飞书测试租户上的只读核对结果。参与者只有用户本人；测试应用与 FSL-115 相同，用户此前从未与其机器人会话。凭据只从仓库根目录 `.env` 以 `source` 加载；本文不含凭据、完整邮箱、完整 open_id 或 message_id。核对日期为 2026-11-19。

## Q1: 自建应用 tenant_access_token

- 请求：`POST /open-apis/auth/v3/tenant_access_token/internal`，请求体只含 `app_id`、`app_secret`。
- 实测响应字段清单（HTTP 200）：
  - `code`：int，实测为 `0`
  - `msg`：string，实测为 `"ok"`
  - `tenant_access_token`：string，非空（值不记录）
  - `expire`：int，秒数，正数
- 与现有代码对照：`packages/engine/src/services/enterprise/feishu/token.ts` 读取 `tenant_access_token`，并要求 `expire` 为正数；字段名与类型都与实测一致。

来源：2026-11-19 真实测试租户调用；`packages/engine/src/services/enterprise/feishu/token.ts:80-86`。

结论：go

## Q3: 按 open_id 读取成员与在职判定

open_id 由 FSL-115 Q2 的 Directory v1 `employees/search` 精确匹配得到，仅保存在仓库外权限为 600 的文件中。

### 实测一：Contact v3 `GET /open-apis/contact/v3/users/:open_id?user_id_type=open_id`（计划假设的接口）

- HTTP 200，`code=0`。`data.user` 含 `open_id`、`union_id`、`user_id`、`name`（string）、`en_name`、`email`（空串）、`mobile`、`department_ids`、`orders`、`avatar`、`leader_user_id`、`is_agent` 等字段。
- `is_activated`、`is_frozen`、`is_resigned`、`is_exited` 的路径：未取得。响应中没有 `status` 对象，四个字段都未出现。推断原因是应用未开通读取用户雇佣状态的字段权限；本次未在开发者后台核对权限名。
- 上述四个状态字段的类型：未取得（同上）。
- 姓名字段路径：`data.user.name`（string）。
- 与现有代码对照：`packages/engine/src/services/enterprise/feishu/directory.ts:103-117` 的 `readStatus` 要求 `status` 的四个布尔字段齐全，否则抛错；按本次实测，现有解析会对用户本人 fail-closed。

### 实测二：Directory v1 `POST /open-apis/directory/v1/employees/mget?employee_id_type=open_id`（替代接口）

- 请求体：`{"employee_ids":["<open_id>"],"required_fields":["base_info.employee_id","base_info.email","base_info.enterprise_email","base_info.name","base_info.active_status","base_info.is_resigned","work_info.staff_status"]}`。
- HTTP 200，`code=0`，`data.abnormals=[]`，`data.employees` 恰有 1 项。
- 在职相关字段的路径与类型：
  - `base_info.active_status`：int（官方文档：1 未激活、2 激活、3 冻结、4 主动退出、5 未加入），实测为 `2`
  - `base_info.is_resigned`：boolean，实测为 `false`
  - `work_info.staff_status`：已在 `required_fields` 中请求，但未返回（`work_info={}`），推断未开通 `directory:employee.work.staff_status:read`
- 姓名字段路径：`base_info.name.name.default_value`（string），以及 `base_info.name.name.i18n_value.{zh_cn,en_us,ja_jp}`。
- 邮箱字段：`base_info.enterprise_email`（string，实测非空），`base_info.email`（string，实测为空串）。
- 所需权限（按官方文档）：`directory:employee:read`（获取员工信息），以及字段权限 `directory:employee.base.active_status:read`、`directory:employee.base.is_resigned:read`、`directory:employee.base.enterprise_email:read`、`directory:employee.base.email:read`；以 `tenant_access_token` 调用时数据受应用「通讯录权限范围」约束。实测上述字段均已返回。
- 以用户本人 open_id 实测的在职判定：`active_status=2` 且 `is_resigned=false`，判定为在职（可登录）。
- 鉴权失败形状（2026-11-19，缺失或伪造的 tenant token）：缺少 `Authorization` 头时为 HTTP 400、`code=99991661`，`msg` 以 `Missing access token for authorization` 开头；伪造 token 时为 HTTP 400、`code=99991663`，`msg` 以 `Invalid access token for authorization` 开头。两种情形下 `error` 都含 `log_id`、`troubleshooter`，伪造 token 时另有 `message`（均为 string），且都没有 `data`。

### 差异与处理

计划假设的 Contact v3 成员状态字段（`status.is_activated/is_frozen/is_resigned/is_exited`）在本租户和当前权限下不返回；Directory v1 `employees/mget` 返回 `active_status` 与 `is_resigned`，可以给出确定的在职判定。按用户决策（2026-11-19，改用 Directory v1，邮箱优先级 `enterprise_email` > `email`），在职判定改为「`active_status == 2` 且 `is_resigned == false`」，其它取值或字段缺失一律 fail-closed。这一差异改变了计划设计（ADR-FSL-11 的成员状态契约，以及 FSL-117、FSL-118、FSL-122 的实现），按 FSL-115「no-go 恢复步骤」②记为 `no-go（差异已登记）`：由承接卡按 Directory v1 实现，并在真实租户复测 Q3，以「契约已验证」作为承接卡的验收。现有企业模式的 `directory.ts` 由 Phase 2 删除。

来源：2026-11-19 真实测试租户只读调用（Contact v3 `users/:open_id`；Directory v1 `employees/mget`）；官方文档 <https://open.feishu.cn/document/directory-v1/employee/mget>（核对日期 2026-11-19）；`packages/engine/src/services/enterprise/feishu/directory.ts:103-117`。

结论：no-go（差异已登记）
