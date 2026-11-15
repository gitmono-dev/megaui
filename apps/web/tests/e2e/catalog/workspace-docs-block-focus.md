# workspace-docs-block-focus e2e catalog

> 来源：2026-10-27 人工验证发现 `?block=` 模式回车产生不可见同级行。

| ID | 场景 | 断言 |
|---|---|---|
| S-01 | 聚焦叶块连续回车输入 | 第一行回车后创建可见子块，文字进入新行；再次回车创建第二个可见子块；Escape 后两行仍在完整文档中。 |
| S-02 | 深链接进入与退出聚焦 | 目标及子树可编辑，其余同级块隐藏；Escape 恢复完整文档。 |
| S-03 | 右键进入聚焦 | 「Focus on block」更新 URL 并显示聚焦子树。 |
| S-04 | 菜单样式 | 块菜单保持工作区的紧凑尺寸。 |
| S-05 | 聚焦根块编辑引用后回车 | 新行保持在当前子树内可见，能够继续输入。 |
| S-06 | 侧栏根块编辑引用后回车 | 新行在侧栏可见，并同步到正文，不产生隐藏同级块。 |

使用真实会话和 stub 文档，在重新构建的 Compose UI 上运行：
`E2E_BASE_URL=http://127.0.0.1:17001 E2E_SKIP_WEBSERVER=1 pnpm exec playwright test apps/web/tests/e2e/workspace-docs-block-focus.spec.ts`。
数据库与认证环境按主测试目录的 live-tier runbook 注入。
