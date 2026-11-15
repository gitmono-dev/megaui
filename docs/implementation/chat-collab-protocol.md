# 聊天 collab 协议（ADR-RT-01 / ADR-RT-02 / ADR-RT-03）

本文是聊天 collab 的可执行协议（RT-01）。后续卡按本文实现，本文只写落地口径。

线索：REF-01 / REF-03（collection 房与 ticket）。本仓不把参照仓源码当作已实现。

## 房间名

| 房间 | 语法 | 本计划 |
|---|---|---|
| 文档正文 | `container:doc:{docId}` | 保持 CS-01 / ADR-ARCH-08，不改语义 |
| 频道 / DM | `collection:channel:{channelId}` | **唯一开放的 B-type 房** |
| Inbox 徽标 | `collection:inbox:{userId}` | 拒绝解析（DEFER-RT-02） |
| 文档评论时间线 | `collection:doc:{docId}` | 拒绝解析（DEFER-RT-03） |
| 其它 | 任意未知前缀 / `container:channel:*` | 拒绝解析（fail-closed） |

常量与构造函数只允许来自 `@megaui/core`：`COLLECTION_ROOM_PREFIX`、`COLLECTION_TYPE_CHANNEL`、`buildCollectionRoomName`。UI 与 collab-server 不得再内联第二份前缀。

## Y.Doc 字段

频道房的 Y.Doc **只**含提示字段，**消息正文不得进入 Y.Doc**（也不得写入 reaction 集合或未读计数）。

| 字段 | 类型 | 谁写 | 何时 |
|---|---|---|---|
| `childIds` | `Y.Array<string>` | **仅** collab-server internal append | 发送 / 回复成功后追加消息 id |
| `revision` | `Y.Map`：`{ kind, messageId, at }` | **仅** collab-server internal bump | 编辑 / reaction 成功后覆盖 |

浏览器对频道房必须是 **readOnly** 连接：不得 append `childIds`、不得改 `revision`。awareness（typing / peer lastRead）可接 hook，**不是**本计划验收项。

未读真源是 Postgres：`mega_channel_members.last_read_message_id` + `unread-math`（或 `listChannels` 投影）。禁止客户端对未读数字自行加减，禁止把未读写入 Y.Map（不复现 DEBT-RT-03）。

## Ticket

| 版本 | 格式 | HMAC 覆盖 | 用途 |
|---|---|---|---|
| v1 | `mega-collab.v1.<userId>.<expMs>.<hmac>` | `userId.expMs` | 文档房（无 `room` 查询时铸造） |
| v2 | `mega-collab.v2.<userId>.<expMs>.<roomName>.<hmac>` | `userId.expMs.roomName` | 频道房，且必须绑定该 `documentName` |

规则：

- 空 secret / 空 userId / v2 空 roomName：铸造与校验均 fail-closed。
- 过期、改 room、改签名：校验返回 null。
- 文档页不传 `room`，仍拿 v1；行为与 CS-01 一致。
- 频道房只接受 **v2 且 `ticket.roomName === documentName`**。v1 或绑了其它房的 v2 → UNAUTHORIZED / FORBIDDEN。
- ticket 与 internal token 不得进入日志（ER-11）。

铸造入口：`GET /api/mega/collab/token`。无 `room` → 仅需有效 session，产 v1。`?room=collection:channel:{id}` → session + `assertCanAccessChannel` 通过后产 v2；非成员 403；未认证 401；非法 room（含 inbox/doc collection、把 `container:doc` 塞进本参数）400。

## Internal 路径

仅 web / engine 经 `MEGA_COLLAB_INTERNAL_TOKEN` 调用。浏览器不得走这两条路径。

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/internal/collection/append` | 向指定频道房 `childIds` 追加消息 id（相同 id 不重复） |
| POST | `/internal/collection/bump` | 覆盖该房 `revision` |
| 既有 | `/internal/reset`、`/health` | 不改语义 |

无 token / 错 token → 401。未知房间 kind 或空 id → 400。不创建 inbox/doc collection。响应不得含 ticket 或消息正文。

## 写后推送与失败回退

engine 聊天写路径：send / reply **先**提交 Postgres，再 best-effort `append`；edit / `toggleReaction` 成功后 `bump`。`markChannelRead` 不推 Y（未读真源是 PG）。

- 未配置 `MEGA_COLLAB_INTERNAL_URL`：skip，与现有 bridge 一致。
- bridge `skipped` 或 HTTP 失败：**不回滚**已提交消息，不向调用方抛成发送失败。对端靠 REST 快照或轮询补洞。
- append 对相同 childId 幂等。

页面：配置了 `NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL` 且房间 connected 时，关闭常开 15s 轮询，靠 `childIds` / `revision` invalidate 消息与频道查询。URL 缺失或 status disconnected：`refetchInterval` 回到 `15_000`。`megaui-collab` 宕机不得禁用发送按钮或丢草稿。

## DEV_ALLOW 与资源上限

`MEGA_COLLAB_DEV_ALLOW_AUTHENTICATED=1` **仅**当 `parseRoomName` 得到 `container:doc` 时生效。频道房不得因此放行（不复现 DEBT-RT-02）。

文档与频道房共用单一连接 / 文档计数器。默认 `MEGA_COLLAB_MAX_DOCUMENTS` 目标 512（`env.example` 注释同步）。空闲房继续 `unloadImmediately`。按 kind 分配额见 DEFER-RT-04。

连接计数仍在鉴权成功后递增（不回退 CS-01）。

## 对照债务（不复现）

| ID | 不复现 |
|---|---|
| DEBT-RT-01 | 浏览器可写 `childIds`；仅服务端 internal append |
| DEBT-RT-02 | authenticated 即可进任意协作房；频道房必须成员校验 + 房间绑定 v2 |
| DEBT-RT-03 | 把 unread 写入 Y.Map 当徽标真源；未读只认 PG watermark |

## 完成口径（提醒）

两名成员同开一频道：一方发送 / 编辑 / reaction 后，另一方在未开 15s 轮询时收敛。未读与 watermark + `unread-math` 一致、不双计。文档房 e2e 不得回归。
