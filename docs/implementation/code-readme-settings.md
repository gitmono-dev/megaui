# Code 根页面 README 的后台设置

Code 根页面（`/<lang>/workspace/code`）在根目录文件列表下方显示一段 Markdown README。内容由 mega2 管理员在「设置 → 管理 → Code README」（`/<lang>/workspace/settings?section=code-readme`）中编辑，保存在 megaui 自己的数据库，不写入 mega2 仓库。

不写入仓库的原因：mega2 trunk 形态下，`git push` 到 `/` 被拒绝，产品写 API 也从不在 `/` 落地（mega2 ADR-FU-06），根目录的 `README.md` 无法修改；大型 monorepo 也不适合为改一个文件而完整 clone。

## 权限

- 谁是管理员以 mega2 为准：BFF 调用 mega2 `GET /api/v1/admin/me`（转发会话 cookie），读取 `/.mega_cedar.json` 中 `UserGroup::"admin"` 的直接成员。
- 失败即拒绝：mega2 返回 401/403 视为非管理员；其它失败（超时、5xx、响应不符合契约）原样报错，不会放行写入。
- 设置导航始终显示「管理」分组（导航本身不发请求）；非管理员打开该分区只看到无权限提示。保存时服务端会再次校验管理员身份，前端隐藏不是安全边界。

## BFF 接口

所有接口都要求已登录会话（`/api/mega/*` 统一守卫）。

| 方法与路径 | 权限 | 说明 |
|---|---|---|
| `GET /api/mega/code-readme` | 已登录用户 | 返回 `{ markdown, updatedAt, updatedBy, blocks }`；未设置时 `markdown` 为空、`blocks` 为空数组 |
| `GET /api/mega/admin/me` | 已登录用户 | 返回 `{ isAdmin }` |
| `PUT /api/mega/admin/code-readme` | mega2 管理员 | 请求体 `{ markdown }`（严格校验，不接受其它字段）；空白内容清除 README；超过 `MEGA_CODE_README_MAX_LENGTH`（100,000 个 UTF-16 码元）返回 400；非管理员返回 403 |

请求体先校验，校验通过后才询问 mega2，再写库。`blocks` 由 `markdownToProseBlocks` 在服务端生成，与仓库内 README 预览使用同一渲染规则。

## 存储

表 `mega_site_settings`（迁移 `0022_fuzzy_nehzno.sql`）：`key` 主键、`value` 文本、`updated_by` 引用 `user.id`（用户删除时置空）、`created_at` / `updated_at`。Code README 使用键 `code_readme`。部署时先执行数据库迁移（`db:migrate`），再切换 Web 版本；Web 运行时角色只需要对该表的行读写权限。

## 页面行为

- Code 根页面：README 有内容时在文件列表下方显示；读取失败只隐藏该区域，不影响文件列表。
- 设置页：Markdown 编辑框、字符计数、最后更新时间与已保存内容预览；内容未变化或超长时禁用保存按钮。
