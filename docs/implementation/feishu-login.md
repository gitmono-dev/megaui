# 飞书邮箱验证码登录

本文记录飞书邮箱验证码最小登录路径的实现约定（`docs/plan/plan-20261118.md`）。各节由对应任务卡在其提交中补充；产品行为以源码与测试为准。

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

### 未实测分支

以下分支无法在单人测试租户上构造，依据为官方文档（<https://open.feishu.cn/document/directory-v1/employee/search>、<https://open.feishu.cn/document/directory-v1/employee/mget>，2026-11-19 核对）与 `contact.test.ts` 中的替身用例，标为「未实测，按文档 + 替身」：

- 多名成员精确匹配；
- `has_more=true`；
- 各种不在职状态（`active_status` 为 1、3、4、5，以及 `is_resigned=true`）。

### 真实租户复测

`contact.live.q2.test.ts`（Q2）与 `contact.live.q3.test.ts`（Q3）只在 `FEISHU_LIVE_CONTRACT === "1"` 时运行，默认跳过。凭据只来自仓库根目录被忽略的 `.env`，以 `set -a; source .env; set +a` 加载。每个用例都通过包装 `fetchImpl` 记录每次 Directory v1 交换的 `{ path, status, code }`，并与期望列表做严格相等比较。复测结果的脱敏摘要分别追加在 `feishu-live-contract-lookup.md` 与 `feishu-live-contract-member.md` 的「复测（FSL-117）」一节。
