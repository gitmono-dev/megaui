# 文档可编辑侧栏

- Spec：`apps/web/tests/e2e/workspace-docs-sidebar.spec.ts`
- 运行：`pnpm exec playwright test apps/web/tests/e2e/workspace-docs-sidebar.spec.ts`
- 依赖：已启动的 web、数据库和 collab；使用独立测试会话与文档，结束删除测试文档。
- 中英文真实流程：正文与侧栏交替输入，光标不被另一侧抢走；另一个浏览器页面收到实时协作更新；Enter 子行可见；立即发布保存最新侧栏内容，刷新保留所有块及无关兄弟块。
- 本地回退流程：45% 默认比例、鼠标拖拽、键盘上下限、双击恢复；侧栏共享撤销／重做，关闭重开保留内容，窄区域上下布局。
