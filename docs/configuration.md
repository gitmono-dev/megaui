# 配置参考

本文列出 megaui 使用的环境变量。完整的带注释样例见仓库根目录的 [`env.example`](../env.example) 与 [`.env.test.example`](../.env.test.example)；复制 `env.example` 到 `apps/web/.env`（或仓库根 `.env`）后按需修改。飞书邮箱验证码登录相关变量的详细合同见 [飞书邮箱验证码登录 · 配置](./implementation/feishu-login.md#配置)。

## 环境变量表

| 变量 | 必需 | 用途 |
|---|---|---|
| `APP_BASE_URL` | 是 | 应用对外 URL |
| `BETTER_AUTH_URL` / `BETTER_AUTH_SECRET` / `BETTER_AUTH_TRUSTED_ORIGINS` | 是 | Better Auth |
| `DATABASE_URL` | 是 | Postgres（联调栈库名 `megaui`；mega2 后端使用独立 `mega2` 库） |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 否 | Google OAuth |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 否 | GitHub OAuth |
| `EMAIL_PROVIDER` | 是 | Better Auth 邮件：仅 `test` / `smtp` / `resend`；缺失、空白或未知值 fail-closed，无默认值 |
| `EMAIL_DEFAULT_FROM` | 是 | Better Auth 发件人；缺失或空白 fail-closed，无 `noreply@example.com` fallback |
| `SMTP_HOST` / `SMTP_PORT` | 当 `EMAIL_PROVIDER=smtp` | host 必填；port 必须是 `1..65535` 的十进制整数。`test` / `resend` 下忽略 |
| `SMTP_USER` / `SMTP_PASS` | 当 `EMAIL_PROVIDER=smtp` | 必须成对非空，或都空以省略 auth。`test` / `smtp` 下忽略 |
| `RESEND_API_KEY` | 当 `EMAIL_PROVIDER=resend` | 必填。`test` / `smtp` 下忽略 |
| `MEGA2_PUBLIC_BASE_URL` / `MEGA2_INTERNAL_MAIL_BEARER` | 联调 | mega2 |
| `S3_*` | 上传 | S3 兼容对象存储 |
| `MEGA_COLLAB_INTERNAL_URL` / `MEGA_COLLAB_INTERNAL_TOKEN` | 协作 | collab 内网 + ticket HMAC |
| `NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL` | 协作 | 浏览器 WS |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | Agent | OpenAI-compatible |
| `AUTH_MODE` | 否 | 认证模式：仅 `legacy` / `enterprise`；缺省或空白按 `legacy`。由 `@megaui/core` 的 `resolveAuthMode` 解析，Web 与 collab 启动时校验：`maintenance` 与未设置 `AUTH_PROVIDER` 的 `enterprise` 以 `INVALID_AUTH_PROVIDER` 拒绝启动；其它取值在提供方合法时以 `INVALID_AUTH_MODE` 拒绝启动（提供方非法时先以 `INVALID_AUTH_PROVIDER` 拒绝） |
| `AUTH_PROVIDER` | 否 | 认证提供方。规则由 `@megaui/core` 的 `resolveAuthMode`（FSL-116）定义：`AUTH_MODE=enterprise` 时必须为 `feishu`（飞书邮箱验证码登录），`AUTH_MODE=legacy` 时缺省或为 `local`；非法的 `AUTH_PROVIDER` 取值或不允许的组合（含 `enterprise` 不设提供方与任何 `maintenance`）以 `INVALID_AUTH_PROVIDER` 拒绝（先校验提供方），提供方合法而 `AUTH_MODE` 为其它值时以 `INVALID_AUTH_MODE` 拒绝。Web（会话入口、认证实例与启动钩子）与 collab 读取该键，见 [飞书邮箱验证码登录 · 配置](./implementation/feishu-login.md#配置) |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书登录 | 飞书应用凭据，Web 只在飞书模式下读取（`readFeishuLoginConfig`），完整合同见 [飞书邮箱验证码登录 · 配置](./implementation/feishu-login.md#配置) |
| `ENTERPRISE_OTP_HMAC_KEY` | 飞书登录 | 飞书邮箱验证码登录的 HMAC 密钥：恰为 32 字节的规范 base64url 编码（43 个字符、无填充），验证码、邮箱与身份绑定（`open_id_hmac`）的 HMAC 共用，以用途标签区分；完整合同见 [飞书邮箱验证码登录 · 配置](./implementation/feishu-login.md#配置)。**不可轮换（FSL-161）：** 飞书登录首次检查时把以该密钥对 `FEISHU_APP_ID` 计算的 HMAC 指纹写入 `feishu_login_key_check`；此后该密钥或 `FEISHU_APP_ID` 任一变化（新配置随进程重启加载），到达该检查的飞书登录 request 与 verify 持续返回 503 `{ "status": "unavailable" }`（输入非法的 400 与限流的 429 仍先于它返回）并输出 `FEISHU_LOGIN_KEY_MISMATCH`。不支持轮换该密钥或更换应用，也不提供身份迁移；唯一恢复方式是由运维恢复原密钥与原 `FEISHU_APP_ID`，不得通过清空 `feishu_identities` 或 `feishu_login_key_check` 绕过该检查（见 [飞书邮箱验证码登录 · 密钥一致性检查](./implementation/feishu-login.md#密钥一致性检查)）。 |
| `FEISHU_PROVIDER` / `FEISHU_SIMULATOR_ORIGIN` | 否 | 飞书登录的 provider 选择：`FEISHU_PROVIDER` 缺省或空白时为 `feishu`（固定官方源 `https://open.feishu.cn`）；`simulator` 只在 `NODE_ENV` 为 `development` / `test` 时接受，并要求 `FEISHU_SIMULATOR_ORIGIN` 恰为 `apps/feishu-mock` 的 loopback origin（`http://127.0.0.1:<port>`）；其它取值以 `INVALID_FEISHU_LOGIN_CONFIG` 拒绝。见 [飞书邮箱验证码登录 · provider 选择](./implementation/feishu-login.md#provider-选择) |

> **旧企业模式已删除（plan-20261118，ADR-FSL-13）：** 飞书私聊配对登录与企业 OTP、维护模式、企业认证接口 `/api/auth/enterprise/*`、飞书事件回调、内部资格接口、collab 企业撤销接口、企业 worker 与 admin CLI、20 张 `enterprise_*` 表与 `session` 的企业列均已删除，由飞书邮箱验证码登录（`AUTH_MODE=enterprise` + `AUTH_PROVIDER=feishu`）取代。`AUTH_MODE=maintenance` 与未设置 `AUTH_PROVIDER` 的 `AUTH_MODE=enterprise` 以 `INVALID_AUTH_PROVIDER` 拒绝启动。旧企业模式的配置键（`ENTERPRISE_OTP_HMAC_KEY` 以外的 `ENTERPRISE_*`、`FEISHU_TENANT_KEY`、`FEISHU_DIRECTORY_DEPARTMENT_IDS` 与 `FEISHU_EVENT_*`）不再有读取方，可从部署配置中删除；`ENTERPRISE_OTP_HMAC_KEY` 仍是飞书登录的必填键。数据库变化见 [飞书邮箱验证码登录 · 企业表已删除](./implementation/feishu-login.md#企业表已删除)。

`AUTH_MODE` 由所有进程共享。Web 与 collab 都只经 `@megaui/core` 的 `resolveAuthMode` 解析它与 `AUTH_PROVIDER`（纯函数，不读环境、不持 secret），被拒绝的组合在两者中都拒绝启动；客户端可见配置白名单之外的键默认 server-only。

飞书登录不需要常驻 worker 或管理员命令；飞书接口的传输、token 与私聊发送位于 `packages/engine/src/services/feishu/`，见 [飞书邮箱验证码登录 · 飞书接口](./implementation/feishu-login.md#飞书接口)。

成员、聊天、cls、文档评论、文档、议题与发布的作者及成员资料统一经 `packages/engine/src/services/public-profile.ts` 的公开资料投影生成：飞书用户按 FSL-153 的显示名规则、其余用户按 legacy 规则投影，DTO 不包含兼容邮箱或登录邮箱。规则与测试见[飞书邮箱验证码登录 · 公开资料](./implementation/feishu-login.md#公开资料)。

FS-58 的 mega2 通知偏好 adapter 只消费当前 `enabled` 与事件偏好合同。响应中的旧 `email`、
`delivery_mode`、`preferred_locale` 字段会被忽略，更新请求也不会发送这些字段，也不从 session 兼容邮箱补值。

**production 的 Web 运行角色（FSL-158、FSL-162，GC-15）：** 飞书模式（`AUTH_MODE=enterprise` + `AUTH_PROVIDER=feishu`）的 Web 以 `DATABASE_URL` 连接的角色是运行角色，它只获授 `SELECT` / `INSERT` / `UPDATE` / `DELETE` 与序列 `USAGE`；表由迁移角色拥有，迁移由 `db:migrate` 以迁移角色（另一个连接串）执行。运行角色及其可 `SET ROLE` 的全部角色都不得为超级用户、不得具有 `CREATEDB` 属性，也不得对当前数据库或其中任一 schema（`pg_catalog`、`information_schema`、`pg_toast*` 除外）持有 `CREATE`；它们也不得拥有当前数据库、上述任一 schema 或当前数据库中的任一对象（表、序列、视图、函数、类型等，表由迁移角色拥有），因此运行角色不得是迁移角色，也不得可 `SET ROLE` 到迁移角色。飞书模式的 Web 启动时检查这些事实：`NODE_ENV=production` 下任一为真或权限无法读取时以 `DATABASE_ROLE_SCOPE_REJECTED` 拒绝启动；其它环境（`development`、`test` 与其它取值，含未设置）只输出 `DATABASE_ROLE_SCOPE_WARNING` 并继续。拒绝与告警只列出角色名与命中的事实类别，不含连接串或口令。`legacy` 与未设置 `AUTH_PROVIDER` 的部署不做该检查。详见 [飞书邮箱验证码登录 · 数据库角色](./implementation/feishu-login.md#数据库角色)。

测试用的 Postgres 由 `packages/database/src/test-support/isolated-pg.ts` 隔离器独占：它在本次运行内创建带 run_id 标签的独立容器与一次性数据库，不读 `DATABASE_URL`，只销毁本次运行登记的资源；迁移一致性因此由隔离器证明，而不是拿环境里的数据库跑。

密钥残留由 `scripts/check-secret-keys.sh` 守卫：它持有仍在使用的两个密钥 `FEISHU_APP_SECRET` 与 `ENTERPRISE_OTP_HMAC_KEY` 的单一清单（`--list` 打印清单），生产面（`apps`、`packages`、`scripts`、`package.json`、`pnpm-workspace.yaml`）不得给这些 key 赋值（所有文件拒绝 `KEY=`；测试文件之外还拒绝带空白、方括号或任一 JavaScript 复合赋值运算符的赋值，如 `process.env.KEY = value`、`process.env["KEY"] = value`、`process.env.KEY += value`、`process.env.KEY ||= value`，以及以字符串字面量赋值的 `KEY: "value"`；这些形式按整个文件匹配，跨行书写同样命中；不带空白的比较 `KEY===x` 不算赋值），样例文件（`env.example`、`.env.test.example`）中这些 key 只能取占位前缀（`replace-with-` / `REPLACE_WITH_`；行首空白、`export`、`=` 两侧空白与引号不影响判定，注释掉的赋值同样检查）；命中以退出码 1、扫描出错（含目录不可读）以其它非零退出码失败，失败输出只报 `文件:行:key`、不回显被检查的值。它是按文本匹配的静态检查，不是 JavaScript 解析器：只识别上述写法，键名由运行期计算得到（字符串拼接、变量下标等）的赋值不在检测范围内；首要防线是不把真实取值写进仓库。CI 在 `Secret key guard` 步骤执行它，测试见 `tests/guards/secret-keys.test.ts`。其它敏感键的样例占位由 `scripts/check-env-placeholders.sh` 检查。恢复方式是删除生产面中的赋值、改由部署的 secret store 注入，并把样例中的值改回占位前缀；不要把真实值贴进工单或提交信息。

provider 的准入与唯一目标由 `@megaui/core` 的 `admitProvider`（`packages/core/src/feishu/provider-admission.ts`）拥有，飞书登录经它选出 provider：结果是冻结的单目标，没有备用 provider，也没有失败后切源的能力，请求参数不能覆盖 provider 或源。

完整注释清单见 [`env.example`](../env.example)。

旧内部通知邮件路由（`/api/internal/notifications/email`）只在 `AUTH_MODE=legacy` 保留，继续要求
`MEGA2_INTERNAL_MAIL_BEARER`，并拒绝 `identity.invalid` 兼容地址和未知认证事件。飞书模式（以及
`resolveAuthMode` 拒绝的组合）对该退场路由固定返回 HTTP 410；不会重启 mega2 邮件或从兼容邮箱推导通知地址。

混合路由下，CL 文件、代码、文档和设置的六个导航消费者会等待完整上下文，避免把未知 search 当作默认可写页面。未知时不准入新写入或导航；已准入复合操作及子组件保存队列保持原生命周期。回归见 `apps/web/tests/e2e/navigation-readiness.spec.ts` 与 `apps/web/tests/unit/navigation-readiness.test.tsx`。

## CI 守卫工具

quality 在安装项目依赖前，通过 `scripts/install-ci-ripgrep.sh` 取得官方 ripgrep 15.1.0 Linux x86_64 归档（`ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz`）并验证固定 SHA-256，再供后续秘密与品牌守卫使用。安装不依赖 APT、不写系统目录；下载最多45秒，整个步骤最多2分钟，下载、摘要、解压、版本或 PATH 发布任一步失败都会阻止后续步骤。排障应先核对到固定官方资产的网络可达性与实际归档摘要，不要改用任意镜像、放宽摘要或关闭检查。测试见 `tests/guards/ci-ripgrep.test.ts`。
