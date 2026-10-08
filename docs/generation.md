# 生成物

SQL migration 与原生 Zod schema 是源码，生成文件不是业务数据。

## HTTP 与执行协议

`bun scripts/generate-api.ts` 离线生成以下文档，不建立应用连接、不调用供应商：

- `packages/contract/generated/openapi.json`：公开 HTTP OpenAPI 3.1。
- `authentication.openapi.json`：Better Auth 原生认证接口。
- `execution-command.schema.json`、`execution-delivery.schema.json`：私有进程协议。

公开 TypeScript DTO 直接从 Zod 推导。没有生成客户端、独立编译器、SDK 分发或补丁链；其他语言可消费标准文档，HTTP 测试直接使用 Fetch。

生成先在临时目录完成，再替换目标目录；过时文件随之删除。不要并发生成，也不要把开发期替换当作在线原子发布、回滚或断电耐久协议。发生替换失败时重新生成即可。

```sh
sh scripts/check.sh test scripts/generate-api.test.ts
sh scripts/check.sh run .github/verify-api.ts
```

需要导出时只挂载公开产物的父目录，不挂载 checkout、秘密或 Docker socket：

```sh
image=$(docker build --quiet -f deploy/docker/checks.Dockerfile .)
docker run --rm --network none \
  --mount "type=bind,src=$PWD/packages/contract,dst=/artifacts" \
  "$image" bun scripts/generate-api.ts --outdir /artifacts/generated
```

## 数据库

```sh
sh scripts/database-check.sh generate
sh scripts/database-check.sh verify
```

在一次性空 PostgreSQL 中应用全部前向 migration，再生成 Kysely 类型和 schema dump。核对完整输出，不从生产库反推结构、不修改历史 migration、不手改生成文件。类型更新失败不会改变业务库；无需为生成物维护事务恢复系统。

当前 `kysely-codegen → micromatch → braces@3.0.3` 开发依赖链有未修补 HIGH advisory [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)：深度嵌套 pattern 可导致栈耗尽。官方尚无 patched version，不能宣称 `bun audit` 全绿。生成入口只传源码内固定的 `{auth,product,execution}.*` pattern，数据库表名是匹配目标而非 pattern；不开放外部 pattern 或在线生成。生产应用冻结依赖闭包不包含 codegen/braces，需在每次打包时继续核验；开发生成链的风险仍保留并跟踪上游，不用删除生成器或伪造 override 隐藏它。
