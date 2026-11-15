# 导航上下文兼容 E2E

关联任务：FS-92。入口：`navigation-readiness.spec.ts`。

通过 `pnpm exec tsx apps/web/tests/helpers/owned-web.ts e2e apps/web/tests/e2e/navigation-readiness.spec.ts` 执行。owner 在无实际环境文件的源码副本中创建一次性页面，导入真实六组件，仅控制 Next 导航 context 和记录 router 调用；真实浏览器、合成本地会话、独立迁移 PG。页面及全部运行资源随 owner 清理，不进入生产应用。

| 场景 | 覆盖 |
|---|---|
| 六组件初始未知 | 不崩溃，不挂载依赖上下文的可写内容，不准入新业务写入和导航 |
| CL 已知→未知→已知 | file/range 保持，viewed 操作在恢复后可用 |
| 代码与设置导航 | 路径解码、tab 和 section；部分 context 为 null 时等待 |
| 文档与个人设置 | null search 不代表最新可写文档或默认 ProfileForm；快照保持只读 |
| 已准入恢复晚到 | 请求允许完成，未知 context 或已切换 query 不执行迟到的 router.replace |
| Roam 快捷操作 | 真实编辑器内创建页面、未知时卸载插件、恢复后重新可用 |

只拒绝六组件尚未准入的动作；已准入的复合操作和子组件保存队列保持既有生命周期。旧回调的精确调用边界另由真实组件单测覆盖。本门不涉及真实 mega2、飞书或企业登录；trace 关闭，结果不记录 Cookie、密码或响应秘密。
