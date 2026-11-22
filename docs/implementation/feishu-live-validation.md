# 飞书登录真实租户验证记录（FSL-143）

本文记录 FSL-143 在真实飞书测试租户上的手工验证结果。执行步骤与预期见 [飞书登录](./feishu-login.md)「真实租户部署与验证」。按 ER-11 只记录脱敏摘要：不记录任何凭据、邮箱、姓名、open_id、message_id、用户 ID 或验证码；日志只记录时间窗口与稳定日志键的计数。

## 部署

| 项 | 记录 |
|---|---|
| 被验证提交 | megaui `main` `d6a5672950a942712269a4e7e4be4e3eba68abf5`（FSL-184 的 C 之后的 `origin/main`，已含 FSL-142；`libra ls-remote` 与 `origin/main` 核对一致） |
| 镜像 | `megaui-web:d6a5672950a942712269a4e7e4be4e3eba68abf5`（`apps/web/Dockerfile` 的 `runner` 目标）、`megaui-collab:d6a5672950a942712269a4e7e4be4e3eba68abf5`，只打本地标签 |
| 部署形态 | 在执行者本机以 Docker 运行 dev/test 部署；Web 与 collab 镜像设置 `NODE_ENV=production`；站点为回环地址 `http://127.0.0.1:3300` |
| 数据库 | 新建的 `postgres:16` 实例；迁移角色拥有数据库、schema 与全部表，22 个迁移全部应用；运行角色只获授 DML 与序列 `USAGE`（GC-15） |
| Web 配置键名 | `AUTH_MODE`、`AUTH_PROVIDER`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`ENTERPRISE_OTP_HMAC_KEY`、`DATABASE_URL`、`BETTER_AUTH_URL`、`APP_BASE_URL`、`BETTER_AUTH_SECRET`、`BETTER_AUTH_TRUSTED_ORIGINS`、`EMAIL_PROVIDER`、`EMAIL_DEFAULT_FROM`、`MEGA2_PUBLIC_BASE_URL`、`MEGA_COLLAB_INTERNAL_URL`、`MEGA_COLLAB_INTERNAL_TOKEN`、`S3_ENDPOINT`、`S3_REGION`、`S3_ACCESS_KEY_ID`、`S3_ACCESS_KEY_SECRET`、`S3_BUCKET`、`S3_PUBLIC_URL`、`S3_FORCE_PATH_STYLE` |
| collab 配置键名 | `AUTH_MODE`、`AUTH_PROVIDER`、`MEGA_COLLAB_INTERNAL_TOKEN`（不连接数据库） |
| 启动时间（UTC） | 2026-11-22T15:46:48Z |
| 启动核对 | Web 日志中 `DATABASE_ROLE_SCOPE_REJECTED` 与 `DATABASE_ROLE_SCOPE_WARNING` 均为 0 次；Web `GET /api/health` 200；collab `GET /health` 200，只含 `ok`、`service`、`documents`、`connections`；访客请求 `/zh-CN/signin` 得到 307 并转到 `/zh-CN/signin/feishu` |
| 账号计数基线 | `users=0`、`identities=0`、`feishu_sessions=0`、`feishu_login_key_check=0` |
| `.mega_cedar.json` 核对 | 不适用：本地部署没有运行 Mega2 实例，也没有可核对的 `/.mega_cedar.json` 副本；新数据库在验证前没有飞书用户 |

日志计数均在仓库外的临时目录中取 `docker logs --since <开始> --until <结束> megaui-web`，`docker logs` 退出码均为 0，计数有效。

## 结果

| 步骤 | 窗口（UTC） | 结果 |
|---|---|---|
| 1. 首次登录 | 2026-11-22T15:55:40Z – 15:58:08Z | 通过。用户在飞书收到该应用机器人的私聊验证码，输入后进入工作区 `/zh-CN/workspace`（FSL-184）。`users` 0→1、`identities` 0→1、`feishu_login_key_check` 0→1，新用户已建立；`FEISHU_LOGIN_SEND_ATTEMPT` 1 次、`FEISHU_LOGIN_NO_TARGET` 0 次。会话计数在用户完成第 6 步并退出之后才读取，窗口结束时为 0（退出删除会话行，来源标记随之级联删除），因此首次登录时 `feishu_sessions` 的增量未单独记录；会话的建立以用户进入工作区与第 6 步的会话读取为证，第 2 步记录了再次登录时 `feishu_sessions` 0→1 |
| 6. 工作区显示名 | 首次登录之后、退出之前（同上窗口内） | 通过。预期值类别为「姓名」；首页问候、侧栏显示名与头像缩写三项均与按 FSL-153 规则得出的显示名经 FSL-182 原有表达式的结果一致（runbook 第 6 步的辅助核对输出三项均为 `true`） |
| 2. 退出后再次登录 | 2026-11-22T15:58:08Z – 16:04:06Z | 通过。控制台退出返回 200；同一邮箱再次收到私聊验证码并登录，进入工作区。`users` 与 `identities` 保持 1（未新建用户），`feishu_sessions` 0→1；`FEISHU_LOGIN_SEND_ATTEMPT` 1 次、`FEISHU_LOGIN_NO_TARGET` 0 次 |
| 3. 错误验证码 | 2026-11-22T16:04:06Z – 16:06:19Z | 通过。提交格式合法的错误验证码后页面停留在验证码步骤并显示「验证码无效或已过期。」；随后提交收到的验证码登录成功。`users` 与 `identities` 保持 1；`FEISHU_LOGIN_SEND_ATTEMPT` 1 次 |
| 4. 未知邮箱不发码 | 2026-11-22T16:40:14Z – 16:44:33Z | 通过。用户本人在浏览器中以测试租户邮箱域名下随机本地部分的地址只请求一次（页面与已知成员一样切换到验证码步骤，飞书没有收到私聊），随即关闭标签页；窗口内无其它登录请求，`FEISHU_LOGIN_NO_TARGET` 恰 1 次、`FEISHU_LOGIN_SEND_ATTEMPT` 0 次。此前的两次浏览器尝试（窗口 16:06:19Z–16:11:46Z 与 16:11:57Z–16:26:13Z）各含两次未知邮箱请求，计数分别为 `FEISHU_LOGIN_NO_TARGET` 2 次、`FEISHU_LOGIN_SEND_ATTEMPT` 0 次，不满足「窗口内只有一次请求」，不作为证据；执行者在 16:26:36Z–16:29:43Z 以一次受控请求做的诊断（计数 1 与 0）只用于确认单次请求的计数，也不作为证据 |
| 5. 注册页 404 | 2026-11-22T16:30Z 前后 | 通过。`curl` 请求 `/zh-CN/signup` 得到 404、响应体 `{"error":"NOT_FOUND"}`、`Cache-Control: no-store`；用户在 Chrome 中打开同一地址看到相同的 JSON 响应，没有注册表单 |

## 文档链接

`bash scripts/check-docs-links.sh` 在加入本文后通过（`check-docs-links: OK`，退出码 0）。

## 观察与后续

- **退出入口：** 飞书模式的界面没有退出登录入口，验证中按 runbook 以浏览器控制台调用 `POST /api/auth/sign-out` 退出。这是可用性问题，不影响本次验收；如需在界面提供退出入口，另立任务卡。
- **先行验证：** 用户曾在 `34080d2` 的本地部署上完成第 1、2、6 项。期间用户决定登录成功后直接进入工作区（FSL-184），因此那一轮不作为本卡证据，上表全部在以 `d6a5672` 重新构建、使用新建空数据库的部署上重新执行。

## 证据卫生门

本文在提交前通过 ER-04 的证据卫生门 EH-1..EH-4（扫描对象为本文；结果只记录时间与退出码）：

| 门 | 结果 |
|---|---|
| EH-1 凭据值形态扫描 | 退出码 1（零命中） |
| EH-2 实际凭据字面值扫描 | 在加载根 `.env` 的同一 shell 中确认 `FEISHU_APP_SECRET` 非空后扫描，退出码 1（零命中） |
| EH-3 个人数据扫描 | 退出码 1（零命中） |
| EH-4 验证码字面值扫描 | 首次扫描 2026-11-22T16:38:30Z；本文最终版本的扫描时间 2026-11-22T16:46:23Z，EH-1..EH-4 结果均与上表相同；用户把本次验证中收到的全部验证码写入仓库外权限 600 的临时文件（执行者规范化为大写的 8 位形式，扫描忽略大小写，不读取、不打印其内容）；含其中一个验证码的负例文件命中（退出码 0，扫描有效，负例文件随即删除）；本文零命中（退出码 1）；临时文件位于以 `mktemp -d` 创建、权限 700 的仓库外目录中（文件权限 600），在本文最终扫描完成后立即连同目录删除，删除时间记录在计划 FSL-143 的状态证据中 |
