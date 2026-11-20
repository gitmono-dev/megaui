# 飞书真实租户契约核对：首次私聊与消息幂等（FSL-165）

本文记录 `plan-20261118` FSL-165 在真实飞书测试租户上的核对结果。参与者只有用户本人；测试应用与 FSL-115、FSL-164 相同。用户确认此前从未与该应用的机器人会话（2026-11-19），FSL-115、FSL-164 不发消息，因此 Q5 的消息是机器人发给用户本人的第一条消息。私聊正文是现有生成器（`packages/auth/src/enterprise-otp/code.ts` 的 `generateEnterpriseOtpCode`）生成的一次性合成验证码，套用现有登录文案；本文只记录「已收到 / 条数」，不记录验证码、完整 open_id 或 message_id。凭据只从仓库根目录 `.env` 以 `source` 加载。核对日期为 2026-11-19。

## Q5: 向从未会话过的用户本人发起首次私聊

- 请求：`POST /open-apis/im/v1/messages?receive_id_type=open_id`，请求体 `{"receive_id":"<用户本人 open_id>","msg_type":"text","content":"{\"text\":\"<应用名> 登录验证码：<合成验证码>\\n请仅在可信站点 <站点> 输入此验证码。\\n此验证码仅用于登录，请勿转发。\"}","uuid":"<随机 UUID>"}`；请求头 `Authorization: Bearer <tenant_access_token>`。open_id 来自 FSL-115 Q2 的 Directory v1 精确匹配。
- 响应：HTTP 200，`code=0`，`msg="success"`，`data.message_id` 非空。
- 是否送达：送达。用户本人确认在飞书中收到恰好 1 条机器人消息（2026-11-19）。
- 发送前置条件：应用已启用机器人能力、具备以应用身份发送单聊消息的权限，且用户本人在应用可用范围内；本次调用成功即说明以上条件均满足。

来源：2026-11-19 真实测试租户调用，以及用户本人在飞书客户端中的确认。

结论：go

## Q4: 发消息成功响应的字段与同一 uuid 的幂等

### 成功响应的字段清单（实测，路径与类型）

- `code`：int，`0`
- `msg`：string，`"success"`
- `data.message_id`：string，非空
- `data.msg_type`：string，`"text"`
- `data.body.content`：string
- `data.chat_id`：string
- `data.create_time`：string
- `data.update_time`：string
- `data.deleted`：boolean
- `data.updated`：boolean
- `data.sender.id`：string
- `data.sender.id_type`：string
- `data.sender.sender_type`：string
- `data.sender.tenant_key`：string

### 与现有代码的对照

`packages/engine/src/services/enterprise/feishu/message.ts:210-222` 的 `readMessageResponse` 要求 `data.message_id` 非空、`data.receive_id` 等于发送目标、`data.msg_type` 为 `"text"`，且顶层 `data.content` 与发送的 `content` 逐字节相等。实测中：

- `data.message_id` 非空，`data.msg_type` 为 `"text"`：一致。
- `data.receive_id`：响应中没有该字段，不一致。
- 消息内容在 `data.body.content`，没有顶层 `data.content`；且 `data.body.content` 与发送的 `content` 字符串不逐字节相等（服务端会重新序列化）。不一致。

因此现有解析会把真实的成功响应判为失败。新的发送校验应改为：`code == 0`，`data.message_id` 非空，`data.msg_type == "text"`；不再要求 `receive_id` 或逐字节相等的 `content`。

### 同一 uuid 连续两次请求

- 以同一个 `uuid` 和同一条合成验证码正文连续发送两次：两次都是 HTTP 200、`code=0`、`msg="success"`，两次返回的 `data.message_id` 相同。
- 用户本人收到的条数：恰好 1 条。用户本人在飞书客户端中确认，带该验证码的机器人消息只有 1 条（2026-11-19）。

### 判定

按 FSL-165 AC5 的判定表：送达恰好 1 条，而且只有响应字段与 `message.ts` 的校验不同，因此为 `go（ADR 已修订）`。需要修订 ADR-FSL-11 中发送结果的成功判据（字段清单见上），并在新发送路径的卡片中按修订后的判据实现。同一 `uuid` 重试只送达一次，ADR-FSL-11 的同 UUID 重试设计保持不变。

来源：2026-11-19 真实测试租户调用；用户本人在飞书客户端中的确认；`packages/engine/src/services/enterprise/feishu/message.ts:210-222`。

结论：go（ADR 已修订）
