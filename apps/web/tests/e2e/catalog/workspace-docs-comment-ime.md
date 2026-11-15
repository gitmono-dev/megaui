# 文档评论中文输入

- Spec：`apps/web/tests/e2e/workspace-docs-comment-ime.spec.ts`
- 运行：`pnpm exec playwright test apps/web/tests/e2e/workspace-docs-comment-ime.spec.ts`
- 依赖：真实 web、数据库、collab；独立测试账号和文档，结束后删除测试文档。
- 使用 Chromium CDP `Input.imeSetComposition` 触发组合输入事件并提交中文，不依赖直接设置 textarea.value。
- 场景：正文曾获得光标后，在评论框连续组合输入、中英文混输、换行及提交；整篇文档、块聚焦与侧栏打开各验证一次。
- 断言：每个组合输入阶段焦点与滚动位置保持不变，提交后评论显示完整文字且清空草稿，正文块数和内容不被评论文字污染。
- 单元回归：`packages/ui/src/content/editor/editor-focus.test.tsx` 验证评论重渲染不会让正文重新执行转换。
