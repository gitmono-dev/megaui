# megaui workspace 参照盘点（AU-01）

> **核对日期:** 2026-09-02  
> **参照仓:** `../megaui` @ `0ff3a9d`（`git -C ../megaui rev-parse --short HEAD`）  
> **monoengine:** `../monoengine` @ `80ddff4`（仅登记；契约核对属 EG-11，本卡不展开）  
> **用途:** Phase 3/4 卡 `Reference source` 对照基底；路径引用形态 `megaui:` + 仓根相对路径 + `@0ff3a9d`，均相对 megaui 仓根。

## REF 现场复核

| REF | 登记 sha | 现场 sha | 结论 |
|---|---|---|---|
| REF-01 / 03 / 04 / 05 / 07 / 08 | `0ff3a9d` | `0ff3a9d` | 确认，无需 re-pin |
| REF-02 / 06 | `80ddff4` | `80ddff4` | 确认，无需 re-pin |

路径抽样（本文件引用）在 `0ff3a9d` 均可解析；见文末「锚点可解析清单」。

## 共享壳与数据通道

| 项 | 路径 | 说明 |
|---|---|---|
| Layout | `megaui:apps/next-app/app/[lang]/workspace/layout.tsx@0ff3a9d` | `MegaQueryProvider` + `MegaSettingsProvider` + JetBrainsMono 本地字体 |
| Shell client | `megaui:apps/next-app/app/[lang]/workspace/workspace-shell-client.tsx@0ff3a9d` | rail / palette / favorites；设计源 `megaui:docs/mega/shell.jsx@0ff3a9d` |
| 客户端数据通道 | `megaui:libs/react-shared/components/mega/query/fetcher.ts@0ff3a9d`、`megaui:libs/react-shared/components/mega/query/keys.ts@0ff3a9d`、`megaui:libs/react-shared/components/mega/query/provider.tsx@0ff3a9d` → `/api/mega/**` | **客户端查询**不直连 monoengine |
| Code SSR 直连例外 | `megaui:apps/next-app/app/[lang]/workspace/code/components/code-ssr.tsx@0ff3a9d` + `megaui:libs/mega/services/code.ts@0ff3a9d` | 当 `MEGA_CODE_DATA_BACKEND=monoengine` 时，SSR preload **仅** `getSourceFile` / `getReadmeBlocks` **直接调用** `megaui:libs/mega/services/monoengine/code-backend.ts@0ff3a9d`，绕过 BFF。树数据由 `megaui:apps/next-app/app/[lang]/workspace/code/[...path]/code-path-client.tsx@0ff3a9d` 经 `/api/mega` 拉取，**不**属 SSR 直连。megaui 须按 ADR-ARCH-03 把该 SSR 路径迁入 DIR-03 / BFF，不得照抄直连 |
| i18n 根 | `megaui:libs/i18n/locales/en.ts@0ff3a9d`、`megaui:libs/i18n/locales/zh-CN.ts@0ff3a9d` | workspace 用户可见字符串主域 `workspace.*`；auth 页用 `auth.*` |

**`workspace.*` 键域（en.ts 现场二级键）:** `metadata` / `title` / `description` / `nav` / `palette` / `home` / `code` / `tags` / `session` / `agent` / `chat` / `settings` / `inbox` / `docs` / `docDetail` / `docEdit` / `clsList` / `clDetail` / `issues`

## 24 个 page 路由清单

计数：`find apps/next-app/app/[lang]/workspace -name page.tsx` → **24**（2026-09-02）。

### Home（1）

| # | 路由 | 页面文件 | 核心组件 | 关键交互 | i18n 键域 |
|---|---|---|---|---|---|
| 1 | `/{lang}/workspace` | `megaui:apps/next-app/app/[lang]/workspace/page.tsx@0ff3a9d` | `HomeHero`（`megaui:apps/next-app/app/[lang]/workspace/components/hero.tsx@0ff3a9d`）、`KpiStrip`（`megaui:apps/next-app/app/[lang]/workspace/components/kpi-strip.tsx@0ff3a9d`）、`HomeCardGrid`（`megaui:apps/next-app/app/[lang]/workspace/components/home-cards/home-card-grid.tsx@0ff3a9d`）；数据型 `HomeDashboard` | 仪表盘交互：Hero → Agent / New Doc（`docs?new=1`）；八卡网格含 待我评审或最近变更单→`/cls`、Assigned Issues→`/issues`、Activity→`/inbox`、Latest release→`/tags`、Agent sessions→`/agent`、Recent docs→`/docs`、Active channels→`/channels/[id]`；QuickActions：New CL / Report issue / Ask agent / Write doc / Draft release→`/tags`，**Search code 打开 ⌘K palette（不导航到 Code）** | `workspace.home` / `workspace.nav` |

主页和变更列表共用当前登录用户可见的 CL 数据源。个人评审卡优先展示待我评审的变更单，没有评审请求时改为最近更新的三条变更单。「待我评审」只统计分配给当前用户且尚待处理的请求。

### Code（2）

| # | 路由 | 页面文件 | 核心组件 | 关键交互 | i18n 键域 |
|---|---|---|---|---|---|
| 2 | `/{lang}/workspace/code` | `megaui:apps/next-app/app/[lang]/workspace/code/page.tsx@0ff3a9d` | `workspace-header`（`megaui:apps/next-app/app/[lang]/workspace/code/components/workspace-header.tsx@0ff3a9d`）/ `root-table`（`megaui:apps/next-app/app/[lang]/workspace/code/components/root-table.tsx@0ff3a9d`）/ `stats-bar`（`megaui:apps/next-app/app/[lang]/workspace/code/components/stats-bar.tsx@0ff3a9d`）/ `quick-links`（`megaui:apps/next-app/app/[lang]/workspace/code/components/quick-links.tsx@0ff3a9d`） | 浏览 workspace 根、包入口、快捷链到 CL/Issue | `workspace.code` |
| 3 | `/{lang}/workspace/code/[...path]` | `megaui:apps/next-app/app/[lang]/workspace/code/[...path]/page.tsx@0ff3a9d` | 主客户端 `megaui:apps/next-app/app/[lang]/workspace/code/[...path]/code-path-client.tsx@0ff3a9d`（路径解码、树加载/合并、路由 tabs、BFF 查询）；`code-ssr` preload；叶组件 `file-view-shell` / `dir-table` / outline（`code/components/`） | 目录树导航（经 BFF）、blob 阅读、README 预渲染；**blob/README 的 SSR 可直连 monoengine**（见上「Code SSR 直连例外」） | `workspace.code` |

设计源：`megaui:docs/mega/code-primitives.jsx@0ff3a9d`

### CL（6）

列表和详情链接使用 12 位英文字母数字短码，区分大小写。旧数字链接和含中划线或下划线的历史短码链接会定位到同一变更单的最新地址，并保留子页面、查询参数和锚点。

| # | 路由 | 页面文件 | 核心组件 | 关键交互 | i18n 键域 |
|---|---|---|---|---|---|
| 4 | `/{lang}/workspace/cls` | `apps/web/app/[lang]/workspace/cls/page.tsx` | 状态标签、筛选输入框、CL 列表行 | 搜索、筛选、排序、打开详情 | `workspace.clsList` |
| 5 | `/{lang}/workspace/cls/[n]` | `apps/web/app/[lang]/workspace/cls/[n]/page.tsx` | 详情标题、合并状态摘要、讨论及活动 | 查看合并条件、打开检查、阅读与回复讨论 | `workspace.clDetail` |
| 6 | `/{lang}/workspace/cls/[n]/files` | `apps/web/app/[lang]/workspace/cls/[n]/files/page.tsx` | `MegaFileTree`、`MegaPatchView`、`clFilePatchForRange` | 展开变更目录、切换文件、查看指定修订范围的差异、标记已查看 | `workspace.clDetail` |
| 7 | `/{lang}/workspace/cls/[n]/revisions` | `megaui:apps/next-app/app/[lang]/workspace/cls/[n]/revisions/page.tsx@0ff3a9d` | `CompareBar` / `RevisionCard` / `ClCommitsCard` / `TimelineRail` / `RangeSummary`（`megaui:apps/next-app/app/[lang]/workspace/cls/[n]/components/range-summary.tsx@0ff3a9d`） | 修订对比、范围摘要 | `workspace.clDetail` |
| 8 | `/{lang}/workspace/cls/[n]/checks` | `megaui:apps/next-app/app/[lang]/workspace/cls/[n]/checks/page.tsx@0ff3a9d` | `ChecksHero` / `CheckTable` / `StageFlow` / `LogConsole` / `BenchTiles`（`megaui:apps/next-app/app/[lang]/workspace/cls/[n]/components/bench-tiles.tsx@0ff3a9d`） | 检查运行列表与日志 | `workspace.clDetail` |
| 9 | `/{lang}/workspace/cls/[n]/deps` | `megaui:apps/next-app/app/[lang]/workspace/cls/[n]/deps/page.tsx@0ff3a9d` | 主图 `DepGraph`（`megaui:apps/next-app/app/[lang]/workspace/cls/[n]/components/dep-graph.tsx@0ff3a9d`）+ `ApiDiff` / `RelatedCLs` / `SymbolUsagePanel` | 依赖图与关联 CL | `workspace.clDetail` |

设计源：`megaui:docs/mega/data-issues-cl.jsx@0ff3a9d`、`megaui:docs/mega/v8-cls.jsx@0ff3a9d`、`megaui:docs/mega/v9-cl-tabs.jsx@0ff3a9d`

变更单概览沿用工作台的字号、间距和主题色。标题下方显示来源分支和已知的目标分支，合并摘要紧接标签导航，文件差异按需加载。布局参考 [GitHub PR Overview 公开预览](https://github.blog/changelog/2026-11-05-new-pull-request-overview-page-in-public-preview/) 和 [11 月 19 日的预览更新](https://github.blog/changelog/2026-11-19-improvements-on-the-pull-request-overview-in-public-preview/)。

首次打开工作区时，侧栏和内容区先显示骨架屏。变更单列表、详情和各标签页在数据返回后替换对应区域，后台刷新时保留已有内容。骨架屏沿用当前主题，并尊重系统的减少动态效果设置。

使用 Mega2 数据源时，概览按 Mega2 的合并条件显示操作。独立部署可在 Mega2 配置中设置 `[ci_checks]` 下的 `enabled = false`，其它合并条件满足后即可合并。接入 Orion2 时可设为 `true` 并配置 CI 回调签名密钥，当前修订等待 CI 通过后才显示合并按钮。修改该设置后重启 Mega2。

文件变更页参考 Libra PR 的 Files changed 布局。左侧目录树按路径筛选文件，右侧分组连续显示可折叠的文件差异卡片，每组最多五个文件。选择树中的文件可跨组定位并更新文件链接。工具栏显示查看进度，可在统一和并排视图间切换。有已保存的修订范围时可直接切换比较范围。真实 Mega2 变更单的查看进度保存在当前浏览器，按登录用户、变更单、修订和比较范围隔离。[Libra PR #1076 文件变更页](https://github.com/libra-tools/libra/pull/1076/changes)

Diffs 按文件名识别语言，显示语法颜色、新旧行号和增删标记。未知语言保留纯文本差异，二进制文件显示提示。长补丁按可见行渲染。[Diffs 文档](https://diffs.com/docs)

### Issues

新建议题使用独立的全宽页面 `/{lang}/workspace/issues/new`，填写标题即可创建，也可编辑和预览描述。旧的 `?new=1` 链接会跳转到新页面。创建时可以省略 Package 和优先级，未指定 Package 的议题属于整个工作区，优先级沿用数据库默认值 P2。[GitHub 创建议题流程](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue)

| # | 路由 | 页面文件 | 核心组件 | 关键交互 | i18n 键域 |
|---|---|---|---|---|---|
| 10 | `/{lang}/workspace/issues` | `megaui:apps/next-app/app/[lang]/workspace/issues/page.tsx@0ff3a9d` | `FilterQueryBar`、列表 | 过滤、开闭态切换、新建 | `workspace.issues` |
| 11 | `/{lang}/workspace/issues/[n]` | `megaui:apps/next-app/app/[lang]/workspace/issues/[n]/page.tsx@0ff3a9d` | `IssueHeader` / `IssueBody` / `IssueTimeline` / `IssueComposer` / `IssueSidebar`（`issues/components/`） | 评论、反应、状态、侧栏元数据 | `workspace.issues` |

### Docs（4）

| # | 路由 | 页面文件 | 核心组件 | 关键交互 | i18n 键域 |
|---|---|---|---|---|---|
| 12 | `/{lang}/workspace/docs` | `megaui:apps/next-app/app/[lang]/workspace/docs/page.tsx@0ff3a9d` | `DocsHeader`（`megaui:apps/next-app/app/[lang]/workspace/docs/components/docs-header.tsx@0ff3a9d`）/ `DocsSidebar`（`megaui:apps/next-app/app/[lang]/workspace/docs/components/docs-sidebar.tsx@0ff3a9d`）/ `DocsGrid`（`megaui:apps/next-app/app/[lang]/workspace/docs/components/docs-grid.tsx@0ff3a9d`）/ `NewDocDialog`（`megaui:apps/next-app/app/[lang]/workspace/docs/components/new-doc-dialog.tsx@0ff3a9d`） | 浏览库、新建文档 | `workspace.docs` |
| 13 | `/{lang}/workspace/docs/[docId]` | `megaui:apps/next-app/app/[lang]/workspace/docs/[docId]/page.tsx@0ff3a9d` | `DocArticle` / `MegaContentReader` / `DocToc` / `VersionPanel` / presence；`DocToolbar`（`megaui:apps/next-app/app/[lang]/workspace/docs/components/doc-toolbar.tsx@0ff3a9d`，分享/重命名）；`DocComments`（`megaui:apps/next-app/app/[lang]/workspace/docs/[docId]/components/doc-comments.tsx@0ff3a9d`，评论/反应/typing）；元数据 `DocMetaSidebar`（`megaui:apps/next-app/app/[lang]/workspace/docs/components/doc-meta-sidebar.tsx@0ff3a9d`）/ `DocMetaEditor`（`megaui:apps/next-app/app/[lang]/workspace/docs/components/doc-meta-editor.tsx@0ff3a9d`） | 阅读、版本、目录、协作 presence、评论/反应、分享/重命名、**元数据编辑**（tag/status/star） | `workspace.docDetail` |
| 14 | `/{lang}/workspace/docs/[docId]/edit` | `megaui:apps/next-app/app/[lang]/workspace/docs/[docId]/edit/page.tsx@0ff3a9d` | 动态 `MegaContentEditor`（`megaui:libs/react-shared/components/mega/content/editor.tsx@0ff3a9d`，`ssr:false`）+ `BlockSidePanel` / collab presence（**不含** DocMeta*） | 正文实时编辑、保存；元数据不在本路由 | `workspace.docEdit` |
| 15 | `/{lang}/workspace/docs/graph` | `megaui:apps/next-app/app/[lang]/workspace/docs/graph/page.tsx@0ff3a9d` | 渲染组件 `ContentLinkGraphView`（`megaui:apps/next-app/app/[lang]/workspace/docs/graph/components/graph-view.tsx@0ff3a9d`）；数据类型 `ContentLinkGraph` | 链接图浏览 | `workspace.docs` |

### Channels（2）

| # | 路由 | 页面文件 | 核心组件 | 关键交互 | i18n 键域 |
|---|---|---|---|---|---|
| 16 | `/{lang}/workspace/channels/new` | `megaui:apps/next-app/app/[lang]/workspace/channels/new/page.tsx@0ff3a9d` | 创建表单 + `megaPost` | 创建 channel | `workspace.chat` |
| 17 | `/{lang}/workspace/channels/[id]` | `megaui:apps/next-app/app/[lang]/workspace/channels/[id]/page.tsx@0ff3a9d` | `ChannelHeader` / `MessageList` / `ChatComposer` / `MembersPanel` / `ThreadSheet` / collection room | 发消息、反应、线程、成员 | `workspace.chat` |

设计源：`megaui:docs/mega/v10-chat.jsx@0ff3a9d`

### DM（1）

| # | 路由 | 页面文件 | 核心组件 | 关键交互 | i18n 键域 |
|---|---|---|---|---|---|
| 18 | `/{lang}/workspace/dm/[id]` | `megaui:apps/next-app/app/[lang]/workspace/dm/[id]/page.tsx@0ff3a9d` | 与 channel 共享消息/composer/collab 模式 | 一对一消息 | `workspace.chat` |

### Agent（2）

| # | 路由 | 页面文件 | 核心组件 | 关键交互 | i18n 键域 |
|---|---|---|---|---|---|
| 19 | `/{lang}/workspace/agent` | `megaui:apps/next-app/app/[lang]/workspace/agent/page.tsx@0ff3a9d` | 线程入口 / 建议提示（fixtures） | 进入/新建线程 | `workspace.agent` |
| 20 | `/{lang}/workspace/agent/[threadId]` | `megaui:apps/next-app/app/[lang]/workspace/agent/[threadId]/page.tsx@0ff3a9d` | `AgentHeader` / `AgentComposer` / `AnswerBlock` / `SourcesPanel` / `ThreadRail` | 提问、流式回答、再生成、引用源 | `workspace.agent` |

### Sessions（1）

| # | 路由 | 页面文件 | 核心组件 | 关键交互 | i18n 键域 |
|---|---|---|---|---|---|
| 21 | `/{lang}/workspace/sessions/[threadId]` | `megaui:apps/next-app/app/[lang]/workspace/sessions/[threadId]/page.tsx@0ff3a9d` | `SessionHeader` / `SessionRail` / `ObjectDetail` / `ObjectTimeline` | 会话对象时间线只读浏览 | `workspace.session` |

### Inbox（1）

| # | 路由 | 页面文件 | 核心组件 | 关键交互 | i18n 键域 |
|---|---|---|---|---|---|
| 22 | `/{lang}/workspace/inbox` | `megaui:apps/next-app/app/[lang]/workspace/inbox/page.tsx@0ff3a9d` | 通知列表 + 阅读窗格（页内） | 过滤、已读、快捷回复 | `workspace.inbox` |

### Tags（1）

| # | 路由 | 页面文件 | 核心组件 | 关键交互 | i18n 键域 |
|---|---|---|---|---|---|
| 23 | `/{lang}/workspace/tags` | `megaui:apps/next-app/app/[lang]/workspace/tags/page.tsx@0ff3a9d` | `SegmentedControl` / releases 卡片 / `TimelineDot` | 浏览 release、草稿发布入口 | `workspace.tags` |

### Settings（1 页 / 页内分区）

| # | 路由 | 页面文件 | 核心组件 | 关键交互 | i18n 键域 |
|---|---|---|---|---|---|
| 24 | `/{lang}/workspace/settings` | `megaui:apps/next-app/app/[lang]/workspace/settings/page.tsx@0ff3a9d` | `SettingsNav`（`megaui:apps/next-app/app/[lang]/workspace/settings/components/settings-nav.tsx@0ff3a9d`）+ `profile-form` + 分区组件（见下） | `?section=` 切换；各区交互见下表 | `workspace.settings` |

**现场启用分区（7，`SETTINGS_SECTIONS` @ `megaui:apps/next-app/app/[lang]/workspace/settings/settings-section.ts@0ff3a9d`）及交互：**

| section | 组件文件 | 关键交互（现场） |
|---|---|---|
| `profile` | `megaui:apps/next-app/app/[lang]/workspace/settings/components/profile-form.tsx@0ff3a9d`（由 `settings/page.tsx` 引入；含 schema、头像校验/上传、字段与保存条） | 编辑资料字段并保存；头像上传/错误文案 |
| `account-security` | `megaui:apps/next-app/app/[lang]/workspace/settings/components/account-security-section.tsx@0ff3a9d` | **无改密表单**：重置密码链到 `/{locale}/forgot-password`；本区动作 = 撤销其它会话、确认删除账户 |
| `appearance` | `megaui:apps/next-app/app/[lang]/workspace/settings/components/appearance-section.tsx@0ff3a9d` | 主题/密度等**即时应用**（无独立 Save 按钮） |
| `notifications` | `megaui:apps/next-app/app/[lang]/workspace/settings/components/notifications-section.tsx@0ff3a9d` | 通知偏好开关/保存 |
| `shortcuts` | `megaui:apps/next-app/app/[lang]/workspace/settings/components/shortcuts-section.tsx@0ff3a9d` | **只读参考**快捷键列表（无提交） |
| `ssh-keys` | `megaui:apps/next-app/app/[lang]/workspace/settings/components/ssh-keys-section.tsx@0ff3a9d` | 列表 + 添加/删除对话框与动作按钮 |
| `tokens` | `megaui:apps/next-app/app/[lang]/workspace/settings/components/tokens-section.tsx@0ff3a9d` | PAT 列表 + 创建/撤销对话框与动作按钮 |

设计源：`megaui:docs/design/v16-settings-profile.jsx@0ff3a9d`、`megaui:docs/design/v17-settings-keys.jsx@0ff3a9d`、`megaui:docs/design/v18-settings-more.jsx@0ff3a9d`、`megaui:docs/design/v19-settings-overview.jsx@0ff3a9d`。  
注：计划「适用范围」写「页内 10 区」是 megaui 目标口径；**megaui 现场启用 7 区**，megaui WA-17/WA-18 按计划拆分承接，不以 10 强行对齐 megaui 代码。

## Auth 页（对照，非 24 计数）

| 路由 | 文件 | megaui 目标 |
|---|---|---|
| `/{lang}/signin` | `megaui:apps/next-app/app/[lang]/(auth)/signin/page.tsx@0ff3a9d` | 保留 |
| `/{lang}/signup` | `megaui:apps/next-app/app/[lang]/(auth)/signup/page.tsx@0ff3a9d` | 保留 |
| `/{lang}/forgot-password` | `megaui:apps/next-app/app/[lang]/(auth)/forgot-password/page.tsx@0ff3a9d` | 保留 |
| `/{lang}/reset-password` | `megaui:apps/next-app/app/[lang]/(auth)/reset-password/page.tsx@0ff3a9d` | 保留 |
| `/{lang}/cellphone` | `megaui:apps/next-app/app/[lang]/(auth)/cellphone/page.tsx@0ff3a9d` | **非目标**（DEFER-RW-03） |
| `/{lang}/wechat` | `megaui:apps/next-app/app/[lang]/(auth)/wechat/page.tsx@0ff3a9d` | **非目标**（DEFER-RW-03） |

i18n：`auth.*`

## DEBT-01..07 现场复核

| ID | 结论 | 证据 | 本仓处理（计划承接） |
|---|---|---|---|
| DEBT-01 | **确认** | `megaui:apps/next-app/middlewares/authMiddleware.ts@0ff3a9d` L27+ `protectedRoutes` 允许清单；未列出路由默认放行 | WA-01 fail-closed |
| DEBT-02 | **确认（域已剥离）** | 同文件 L77–81 `/ai` 鉴权条目整体注释 → fail-open | N/A（SaaS 非目标） |
| DEBT-03 | **确认** | 错误处理分散：`megaui:apps/next-app/app/api/mega/[...segments]/route.ts@0ff3a9d` + `megaui:libs/mega/services/monoengine/client.ts@0ff3a9d` | WA-03 / DIR-03 单一出口 |
| DEBT-04 | **确认** | `megaui:libs/mega/fixtures/users.ts@0ff3a9d` 等 fixtures 文件存在；`megaui:libs/mega/services/store.ts@0ff3a9d` 以 fixtures/mock 初始化运行时态；多页面 `import` 自 `libs/mega/fixtures/*` | EG-01/EG-11：运行时零 mock |
| DEBT-05 | **确认** | `megaui:AGENTS.md@0ff3a9d` 三端 parity；仓布局含 `apps/{next-app,nuxt-app,tanstack-app}/` | 本仓单前端，不引入 |
| DEBT-06 | **确认** | `megaui:apps/next-app/middleware.ts@0ff3a9d` L12/40/42/49/51/57 逐请求 `console.log` | WA-01 不复现 |
| DEBT-07 | **确认** | `megaui:apps/next-app/hooks/useSubscription.tsx@0ff3a9d` L45–46：`toast.error('需要订阅')` + `router.push('/pricing')` | 域剥离；PK-03 i18n + locale 跳转 |

## 锚点可解析清单（结构门）

下列 `megaui:` + 仓根相对路径 + `@0ff3a9d` 引用在核对日均存在（`test -e`）：

- 24 × workspace `page.tsx`（上表完整路径）
- `apps/next-app/app/[lang]/workspace/layout.tsx`、`workspace-shell-client.tsx`
- `apps/next-app/app/[lang]/workspace/components/{hero,kpi-strip}.tsx`、`home-cards/home-card-grid.tsx`
- `apps/next-app/app/[lang]/workspace/code/components/code-ssr.tsx`、`libs/mega/services/code.ts`、`libs/mega/services/monoengine/code-backend.ts`
- `apps/next-app/app/[lang]/workspace/settings/settings-section.ts`、`settings/components/profile-form.tsx`、6 个 `*-section.tsx`、`settings-nav.tsx`
- `apps/next-app/app/[lang]/workspace/code/[...path]/code-path-client.tsx`
- `apps/next-app/middlewares/authMiddleware.ts`、`apps/next-app/middleware.ts`
- `apps/next-app/hooks/useSubscription.tsx`
- `libs/mega/services/store.ts`、`libs/mega/services/monoengine/client.ts`、`libs/mega/fixtures/`
- `libs/i18n/locales/{en,zh-CN}.ts`
- `docs/mega/{shell,code-primitives,data-issues-cl,v8-cls,v9-cl-tabs,v10-chat}.jsx`
- `docs/design/v16-settings-profile.jsx` … `v19-settings-overview.jsx`
- `AGENTS.md`
- 6 × `(auth)/*/page.tsx`

## 越界改动守卫（AU-01）

本卡仅允许产物：`docs/implementation/megaui-inventory.md`。不得改动本仓生产代码/配置；实现代码随 SC-01 一并入库提交。
