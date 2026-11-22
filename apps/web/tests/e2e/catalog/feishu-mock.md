# feishu-mock

Mock 自身的 API-only 集成：不启动网站、浏览器或数据库，只用真实 CLI 与真实 HTTP
协议。专用配置 `playwright.feishu-mock.config.ts` 只收集 `feishu-mock.spec.ts`，
workers 2、fullyParallel，trace/video/screenshot 全部关闭。

## 用例

| 名称 | 覆盖 |
|---|---|
| runs the whole protocol over real http | 签发 tenant token、单人读取、provider 定向消息写入成员 inbox；已退场的部门分页路由 `find_by_department` 返回 404（FSL-167），已退场的消息注入路由返回 404，`PATCH /__mock/users/:open_id` 只修改目标成员的在职状态，状态快照不含事件（FSL-140） |
| resets every resource of the run at once | reset 后 token、inbox、uuid、fault 全部清空，旧 generation 的 token 在保留的单人读取路由上返回 401，重新签发的 token 获准 |
| keeps a second instance isolated inside the same worker | 同一 worker 内第二个实例的端口、状态与凭据互不影响，跨实例 token 在单人读取路由上被拒（401） |

## 运行

```sh
pnpm exec playwright test --config playwright.feishu-mock.config.ts
```
