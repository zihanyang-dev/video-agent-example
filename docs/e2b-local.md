# E2B 本地验证

## 专用资源与启动顺序

使用项目 `.cache/e2b/` 内的 Lima `e2b`，不操作 Colima、已有数据库/Redis/对象存储，不挂载仓库、home、Docker socket 或操作员配置到工具 VM。仅 Lima 命令使用独立 `HOME` / `LIMA_HOME`：

```sh
env HOME="$PWD/.cache/e2b/host-home" LIMA_HOME="$PWD/.cache/e2b/lima" limactl list
```

Linux host 的 Embed 5008 管理接口无认证，不能公开。**启动 Compose 前**必须安装 `eth0` 新入站 TCP 的 INPUT 与 DOCKER-USER DROP 规则。此前实例设置了 `unless-stopped`；因此正常结束时先 `docker compose stop --timeout 10`，再正常停止 Lima，避免下次启动自动绕过防火墙。plain Lima 不转发应用端口，只保留本机 SSH 控制通道。不能把 SDK debug kill 当成删除证明。

已验证 host：Apple M5、Lima 2.2.0/VZ/ARM64/嵌套虚拟化，Ubuntu 26.04 `7.0.0-28-generic`、4096 字节页、KVM/TUN/cgroup v2，Docker 29.8.2、Compose 5.6.0。工具 VM 为 ARM64 `6.1.177+`。

## 精确部署与实际证明

2026-10-04 使用官方 Runtime `92197909dce5a1bef33e764ae4af76f0732fd7a8`（2026-10-03）的 Embed compose 配置。**配置中的镜像/组件 pins 不等于该提交的 HEAD 编译产物**：实际 API 镜像 `v0.14.202609170000-908833e4c12`、tools 镜像 `v0.3.202609120109-ad1cddd091b`。未升级或重编译这些组件。

官方 e2b 2.52.0 SDK 的 `pause({keepMemory:false})` 提交 filesystem-only 请求，后续 `connect` 支持 `onResume:'reboot'`。公开 SDK 没有生命周期更新方法；创建显式设置 `{onTimeout:'kill',autoResume:false}`，恢复后保留 TTL kill。SDK 声明不是部署证明。

以下真实验证使用固定 Bun 1.4.2 镜像，无付费模型/fal/E2B Cloud：

```sh
sh scripts/sandbox-check.sh
sh scripts/sandbox-check.sh --restart
```

第一项验证原生二进制 I/O、非零命令诊断、明确无网络/凭据传递、同一 ID 暂停恢复的 Agent 自定路径文件，以及前台 PID 取消后的文件保存。原生 snapshot 的数据库 `config.filesystemOnly` 实际为 `true`。测试额外使用官方 **默认 restore**（不是只用 reboot）恢复，等待已确认启动的后台进程原定时长，确认旧进程没有继续写文件；防止 RAM fallback 被 reboot 参数掩盖。

第二项在有 ownership label 的测试容器 writable layer 保存私有原生引用，先正常停止 Embed，再正常停止/启动整台专用 Lima VM，安装 guards **后**启动 Compose。恢复相同 sandboxID，文件仍在，旧进程不会继续。测试结束按 ownership metadata 清理 sandbox；shell 仅删除 label 匹配的测试容器，不使用 prune 或 down -v。SDK 请求和 guest 中的 Docker 操作都有超时；官方 Lima stop/start 直接调用，不另设通用执行框架。测试镜像通过私有 source archive 在专用 VM 的 Docker 内构建，不使用 host 默认 Docker context，宿主 tar/SSH 客户端由 `check-lifecycle.sh` 的有界阶段持有，远端使用原生 timeout 并在中断时先停止 attached client，再按 label 删除测试容器。控制日志位于 `.cache/e2b/current-*.log`，不输出 team key 或 SDK sandbox info。

出站探测使用 guest 内 TEST-NET `203.0.113.254/32` 单个端口，先证明允许网络的阳性对照确实到达服务，再证明拒绝网络的 sandbox 无法到达。规则和 alias 有界清理，管理接口仍被保护。这不是所有协议/IPv6/DNS 的全面证明。

## Agent 环境语义

环境属于 thread，不每轮 kill、不复制目录、不规定 materials/workspace/output 路径。持久化针对 filesystem-backed 工作文件，而非所有 guest 路径：本地 `base` 的真实 filesystem-only pause / reboot 实验保留了 `/home/user` 文件，却清除了 `/tmp` 文件。跨轮工作应由 Agent 选择 `/home/user` 或经验证的持久目录，`/tmp` 只作临时空间；不能把同一 sandboxID 当成 RAM、进程或临时目录保留的证明。此行为需要在 Cloud 目标和不同 template 分别验证。数据库持有不透明 `{provider,id}`，新身份必须 fenced 持久化后才能开始模型/工具。私有 Pi / OpenAI 原生 state 保留在 worker native-state 卷，不进入 SQL 或 VM。

成功取得 session 后有一条生命周期 TTL heartbeat，覆盖模型/compaction 空档，而非只在 foreground command 内续租。owner abort 停止新增续租，已发控制请求有界 join 后才 pause；续租失败不重试，通知 worker 停止新 spending，并保留物理不确定性。

等待模型、工具、S3 上传、foreground command 与原生暂停后才发布终态；进程最后关闭 S3/SQL/Redis。取消通过官方 PID kill 等待 foreground 结束，再 filesystem-only pause 丢弃 RAM。**PID kill 不是 process-group kill**；filesystem-only pause 不能证明外部 TCP 或付费 jobs 已取消。失败/取消不回滚环境文件。

未知创建/命令/暂停，以及无法证明 guest writer 已停止的 ownership loss 会保留 `sandbox_recovery_required`，即使 native reference 仍为 null。SQL lease expiry 单独不授权 takeover，也不证明 physical corruption；未知 terminal COMMIT ACK 单独不标记 quarantine。原生操作未知时可以尝试暂停，但不能据此自动解除隔离。SQL fence 不能阻止失联旧 worker 操作同一 VM。后续 accepted queued runs 明确 durable failed `sandbox-recovery-required`，不连接环境、不花模型费用。

恢复 crash 后 TTL kill 可能丢失 live 状态；不能默默新建环境。`pause` 返回 false 只能表示已经暂停，不能证明既存 RAM snapshot 被转换成 filesystem-only，因此拒绝并隔离。已部署团队允许 filesystem-only snapshot 恢复，但 **RAM snapshot + `onResume:reboot` 实测返回 HTTP 400**（`Resuming without memory ... is not enabled for this team`），不能用于旧 RAM archive 的自动迁移。生产 provider 必须实际验证上述语义；不支持就明确 unavailable/recovery，不回退到 RAM 或每轮空 VM。

## 显式人工恢复

没有自动 RecoveryEngine。操作员必须先确认旧 worker **确实停止**（不是 lease 过期、断开 SSH、数据库 flag），并核对所有未知外部 jobs。暂停/恢复本身不是外部付费操作对账。

在隔离的环境上检查 provider reference、filesystem-only snapshot 和文件，明确决定保留/修复/删除。只有在旧 worker 停止、远端状态明确、无 active SQL run 时，持有 conversation 行锁确认 fence 未变化，才可由受信任运维事务清除 recovery flag 或替换 reference。若未知创建 ACK 没有 ID，用平台/thread/run/fence metadata 对账；不能以 null 为“不存在”证明。现无公开自动恢复 API；手工 SQL 必须在这一检查后执行并留下审计记录。

未知 PUT/COMMIT ACK 不删除 potentially committed `assets/generated/...`。现无原 workspace GC：需要运维制定按 accepted completed event、run/fence 与足够保留时间对账的 orphan 策略，不能按目录年龄盲删。

验证结束先停止 Compose，再停止专用 VM并确认 `Stopped`，核对现有 Colima 服务未受影响。只删除确认属于此项目、已停止的 Lima 实例；不全局 prune、不删除已有卷。Embed 是单机本地验证，不提供 Cloud 副本/HA、生产容量/保留策略或外部付费作业安全保证。

## 验证边界

原生语义的参考来源是官方 [Runtime 精确提交](https://github.com/e2b-dev/runtime/tree/92197909dce5a1bef33e764ae4af76f0732fd7a8) 的 `sandbox_pause.go`、`sandbox_connect.go`、`embed/README.md` 与 npm `e2b@2.52.0` SDK 发布源。部署镜像的短 SHA 无法在公开源码中对应时，不把镜像 tag 当成该 HEAD 的编译证明。

验证必须覆盖已到达服务的 RPC 丢失回执、同一身份暂停恢复、文件字节一致、boot ID 变化、旧后台进程不继续写入以及服务和专用 VM 的完整正常重启。RAM 快照阴性对照不能因显式 reboot 掩盖。命令未知结果后不得提交第二次推理或工具操作。

受控 HTTP 故障验证与真实 Embed 文件系统验证是不同证据。正常整机重启不证明 Cloud 异步上传完成、突然断电恢复、HA 或外部作业取消；必须按部署目标分别验证。

未知命令 RPC 后，本 session 不再发送新操作；close 仍尝试 filesystem pause，但保留拒绝，让 core SQL quarantine 保持可见。metadata 只是 ownership 对账，不是创建幂等 key，也不是 VM fence。测试输出精确 owned run IDs 供本地残留 bytes 对账；SDK kill 只证明 API 删除成功，不保证 soft-deleted snapshot bytes 已被物理回收。不能将全目录/全卷 prune 当成测试清理。

SDK 适配器验证不启动产品 PostgreSQL，不能替代真实 SQL quarantine、锁与执行事务回归。完整工程检查使用当前 frozen-lockfile 镜像；旧镜像或缓存树的局部检查不替代它。

清理只能按记录的 runID / ownership → sandboxID → soft-deleted environment → build UUID 关联核对本地 snapshot。未知归属和验证前存在的原生引用交给操作员确认，不执行 kill，不按目录年龄删除，不清理整个卷。
