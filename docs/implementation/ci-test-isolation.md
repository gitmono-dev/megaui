# CI 全量测试隔离与并行

quality 的 CMD-05 保持 `pnpm vitest run`，仅在该步骤设置 `VITEST_MAX_WORKERS=3`，job 时限为 120 分钟。根配置的完整收集范围、文件隔离、既有测试预算、后续 Mock 与守卫均保持。三个 worker 是测试文件执行并发上限，不是容器总数上限；部分既有隔离测试内部会创建多个数据库。

八组旧 BFF 契约使用 `apps/web/tests/helpers/owned-contract.ts`：aggregation、agent SSE、content、docs comments、issues body、issues reactions、code 和基础 BFF。每个文件先登记一个惰性 lifetime，并在 `afterAll` 登记清理，再于原 `beforeAll` 中启动。启动失败会保留失败结果；不会因没有外部数据库或 mint 失败而空过认证断言。

fixture 复用 `OwnedWeb`，在本 run 的无实际 `.env` 副本中运行原 mint helper，配用 FS-57 新建的专属 PostgreSQL。复制与专属 PG 创建、迁移并行准备，所有分支实际结束后才发布 ready 或处理失败和取消；PG 创建成功后立即登记，不能用提前拒绝留下迟到资源。迁移与 seed 由该库的 bootstrap writer 执行；BFF、直接业务查询及 mint 使用同库的独立 DML 角色。它们不向调用方传入的 `DATABASE_URL` 迁移或 seed。父测试环境中的应用配置只在本文件有效，结束后还原；子进程采用合成白名单环境，不继承 provider 凭据。口令、Cookie 和 mint 原始输出只留内存。

原 mint CLI 的注册、登录和成功 JSON 形状保持。成功或失败都在 `finally` 中等待共享 Pool 关闭，然后自然退出；关闭或认证失败返回非零退出码，不通过 `process.exit()` 绕过清理，也不等待空闲连接回收定时器。

关闭会先封住新操作，等待进行中的 setup 确实结束，再关闭父进程共享 Pool 和 owner 的进程、观察连接、数据库及临时源副本。父 Pool 关闭超过五秒会留下可见的清理失败，仍继续尝试 owner 清理，不把截止时间视为已取消数据库操作。仅清理本 run 登记资源。审批文件的故障清理断言通过已有 `temporaryRoot` 参数局限于自身目录，不扫描全局临时目录中其他 run 的资源。

两个专有验证分别核公开 Vitest 配置及真实 worker 重叠、真实 PG/mint 与成功或故障清理。准备阶段覆盖 abort、copy 失败，以及真实 PG 已创建后迁移失败且 copy 仍在途；mint 的权限失败覆盖真实 Pool 关闭、自然非零退出和无成功 Cookie 结果。八个 BFF 文件及审批集成测试，以及共享 owner 的 navigation-compat、enterprise-runtime-next 消费者，均执行强制指定文件回归。A 和审查 PASS 后的 C 都从冷服务数据库与无实际环境副本执行完整根 CMD-05，以 `VITEST_MAX_WORKERS=2` 记录集合计数、耗时、资源峰值和清理结果。预迁移共享服务库、缩小集合、额外 skip、增加重试或放宽测试预算不能代替该门。

FS-93 的提交 `bebc07d` 对应 quality `43126075348`：25 个步骤成功，全量 299 文件、2673 用例通过，2 文件、2 用例为既有 skip；但 job 因当时的 30 分钟总时限被取消。这个结果不是 D PASS。FIX-FS-02 完成隔离产品审查、最终 C、签名推送并获得新精确 head 的整体 CI 成功后，才核对 FS-93 的九个非 README、非 owned-web 文件哈希及 README 原文件前缀，并确认 owned-web 增量已审、原消费者已重验，然后恢复并收口 FS-93。既有失败记录保留，后续 HTTP 功能仍按依赖链推进。
