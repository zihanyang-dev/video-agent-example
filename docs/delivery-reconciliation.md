# 投递调查（只读）

Redis XADD 成功、发送方随后提交 `published_at`，不等于接收方已经持久接受。Redis 丢失条目后，发送方可能已标记发布，而接收方没有账本记录。SQL 行缺失也不能证明执行或付费操作从未发生。

在经审查的可信 Docker 运维环境内，使用现有管理数据库凭据（`DATABASE_URL`、`IO_TIMEOUT_MS`）调查一个原始身份。以下命令在该环境内部执行，不建议在宿主账户环境直接运行或把 checkout/home/socket 挂入检查容器：

```sh
bun scripts/reconcile-deliveries.ts command <original-command-uuid>
bun scripts/reconcile-deliveries.ts event <original-event-uuid>
```

工具在同一个只读、repeatable-read 事务中读取发送方与接收方记录。输出包含私有载荷，应留在安全的运维环境，不写入公开日志。它不会发现候选、判断恢复资格、更新发布时间、发送 Redis 条目或执行任务，也没有 `--apply` 模式或 review-file 协议。

## 人工调查

1. 核对实际数据库、角色、SQL 持久性与连续历史、故障时间线及原始执行环境。如果 SQL 曾被恢复、删除、回滚，或完整性未知，停止调查后的恢复动作。
2. 在考虑另行授权的恢复前，暂停受影响的发布方与接收 intake，并等待正在接受的工作收尾。在线调查只是证据，不是锁，也不是重新入队的授权。
3. 对照保留的发送载荷和索引身份，检查接收账本、run 状态、事件 ordinal／终态、历史，以及原始供应商和环境证据。仅凭接收记录缺失不能排除未知支出。
4. 恢复必须另有经审查的运维步骤。保留原始 command／event／run／message ID、载荷、ordinal、历史和环境身份。不能创建替代任务、清空账本、重置 lease／历史，或在未锁定权威的情况下在线重新入队，以使重放通过。
5. transport 或 COMMIT 结果未知时，只读核对原始身份。不要自动重试执行，也不要因响应丢失就推断事务已回滚。

`query_timeout` 限制客户端等待响应的时间，不会取消远端 SQL。服务端 statement／lock／idle-transaction timeout 通过公开 pg 配置提供。URL 与 startup timeout 的优先级由运维配置负责。普通 SQL／业务失败可以回滚而不使进程失败；查询 transport 结果未知时，会通知进程 owner 停止 intake。

测试验证了精确删除测试自有 XADD 条目，以及使用持久接收去重进行相同 envelope 的重新投递。这不是实际 Redis 断电实验、生产恢复授权、RPO／RTO 保证或 exactly-once 执行证明。
