# megaui 计划索引

本目录存放 `megaui` 仓库的工程实施计划。

| 计划 | 类型 | 状态与摘要 |
|---|---|---|
| [`plan-20261117.md`](plan-20261117.md) | 日期计划 | **草案，未开工**（飞书真实租户端到端登录，标准模式为「推送验证码」：页面输入邮箱或手机号 → worker 按飞书通讯录的 HMAC 查找键定位唯一成员 → 飞书私聊发码 → 页面输入，不需要公网回调；`AUTH_USER_SOURCE` 确定用户来源（FSL-57 解析、FSL-64 冲突检测、FSL-09 服务端关闭建号），`feishu` 来源完全关闭注册；独立登录页 `/[lang]/signin/feishu` 与 `/[lang]/signin/feishu/verify`；FSL-38 修订 ER-08 协同细则，FSL-22、FSL-29、FSL-71、FSL-72、FSL-43（G-08 家族 REL-01，由发布点 FSL-66 一次发布）、FSL-39 修复双仓 `release-gate` 主干 CI 查询与判定脚本；FSL-26 协调同 flow 验证码投递顺序，FSL-41 以请求编号辨认有效码；FSL-33 为 request 设固定耗时下限并以并发受控统计验证其不可区分；FSL-49 建立 verify 可信入口、FSL-58 在框架之前加地址级限流；FSL-64、FSL-09、FSL-10、FSL-74、FSL-37、FSL-58、FSL-60、FSL-40、FSL-65、FSL-24、FSL-27、FSL-46、FSL-88、FSL-28 按兼容审计为 `minor`；FSL-04 已废弃，其余 100 张活跃卡均为 `pending`） |
