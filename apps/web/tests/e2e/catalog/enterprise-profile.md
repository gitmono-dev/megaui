# FS-24 / FS-59 企业资料与通知设置隔离

| Spec | Scope | Tier |
|---|---|---|
| `enterprise-profile.spec.ts` | 企业 OTP 登录后验证目录资料字段只读、本地 notification_email 展示、保存简介不调用 Better Auth `update-user`，workspace 不回退显示兼容邮箱；legacy fixture 验证显示名仍可编辑 | enterprise / legacy / FSM-05 simulator |

```sh
NODE_OPTIONS=--import=tsx pnpm exec playwright test apps/web/tests/e2e/enterprise-profile.spec.ts --config=playwright.enterprise.config.ts --workers=1 --trace=off
```

企业模式的显示名和头像由服务端 `resolveWebActor` 判定后交给目录资料投影，通知邮箱只读展示并允许为空；页面禁用文件、URL 与显示名编辑控件，workspace 和协作编辑器使用 public profile，不回退兼容邮箱；本地简介仍写入 `profile-prefs`。legacy 模式继续使用 Better Auth 的旧资料编辑合同。
