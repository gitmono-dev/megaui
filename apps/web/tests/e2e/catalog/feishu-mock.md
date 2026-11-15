# feishu-mock

Mock 自身的 API-only 集成：不启动网站、浏览器或数据库，只用真实 CLI 与真实 HTTP
协议。专用配置 `playwright.feishu-mock.config.ts` 只收集 `feishu-mock.spec.ts`，
workers 2、fullyParallel，trace/video/screenshot 全部关闭。

## 用例

| 名称 | 覆盖 |
|---|---|
| runs the whole protocol over real http | 签发 tenant token、目录分页读取、单人读取、provider 定向消息写入成员 inbox、控制面发送 p2p 事件并由 callback 目标接收 |
| resets every resource of the run at once | reset 后 token、cursor、inbox、uuid、event、fault 全部清空，旧 generation 的 token 不再获准 |
| keeps a second instance isolated inside the same worker | 同一 worker 内第二个实例的端口、状态与凭据互不影响，跨实例 token 被拒 |

## 运行

```sh
pnpm exec playwright test --config playwright.feishu-mock.config.ts
```
