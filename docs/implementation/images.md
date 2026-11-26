# 镜像仓库

工作区 Images 页面展示 Mega2 OCI Registry 的仓库目录和仓库标签，支持按仓库名称搜索、分页和查看标签。页面沿用工作区配色与布局，不提供镜像推送或删除操作。

页面请求经过 MegaUI 的已登录 BFF，再访问 Mega2 的 `/v2/_catalog` 和 `/v2/{repository}/tags/list`。OCI Registry 保持其独立读取策略：页面不会转发浏览器会话或使用特权令牌，只有 Registry 允许匿名读取时可显示目录。Mega2 的 OCI 路由仅在 storage-only 且启用 OCI 时开放；Registry 未启用、无权访问或无法连接时显示不可用与重试，而不是空列表。需要私有 Registry 会话访问时，应先设计并实现与 OCI 一致的鉴权和权限范围，不能绕过现有策略。

Registry 与 Web API 分别运行时，可用 `MEGA2_OCI_BASE_URL` 指向 Registry；未设置时使用 `MEGA2_PUBLIC_BASE_URL`。

目录接口使用 `n`、`last` 实现分页，`q` 按仓库名过滤；目录包含已有 manifest 的仓库。每页最多 100 项，下一页由响应 Link 指示。标签列表使用现有 OCI 标签接口，标签搜索仅筛选当前已加载项。
