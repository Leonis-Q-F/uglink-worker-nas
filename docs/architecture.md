# 架构说明

项目采用 DDD 分层与端口适配器模式，同时构建两个 Cloudflare Worker：

- 管理控制台：提供 React 页面和 `/api/*`，负责配置、发布与状态检查。
- 代理网关：按请求域名选择 NAS 端口，维护绿联代理会话并转发流量。

## 领域边界

### 服务配置与发布

负责 `UglinkConfig`、服务映射、发布目标、发布状态、服务健康状态和结构化诊断信息。配置结构、地址约束、域名规范、重复检查及默认值都由领域层统一定义，命令行、浏览器和控制台 Worker 使用同一份规则。

### 绿联访问代理

负责域名到端口的路由、代理会话状态、认证失败分类和会话失效处理。应用层只编排请求；绿联登录协议、KV 缓存和 HTTP 转发位于基础设施层。

## 分层职责

```text
interfaces
  HTTP Worker 入口、API 响应、React 页面
      ↓
application
  用例、命令、查询和基础设施端口
      ↓
domain
  实体、值、状态及业务规则

infrastructure
  实现 application 定义的端口，并由 interfaces 在组合根中装配
```

- `domain/` 不依赖其他层，也不包含 Cloudflare、React、KV 或文件系统代码。
- `application/` 只依赖领域层，通过端口描述 Cloudflare、存储、健康检查和代理传输能力。
- `infrastructure/` 实现应用层端口，可以依赖 Cloudflare Workers API、浏览器 API 和第三方库。
- `interfaces/` 是最外层，负责输入输出转换和依赖装配，不承载领域规则。

[`test/domain/layering.test.ts`](../test/domain/layering.test.ts) 会自动检查上述依赖方向。

## 构建流程

`npm run gateway:bundle` 把代理网关打包到 `.generated/gateway/worker.js`。控制台 Worker 在构建时把该模块作为文本嵌入，因此用户可以直接通过 Cloudflare API 发布网关，而不依赖 GitHub、CI 或其他外部部署服务。

命令行发布使用 `uglink.config.json` 生成临时的 `wrangler.gateway.generated.json`。该过程与控制台共享领域校验和 Worker 运行时绑定生成逻辑。

## 状态与凭据

- Cloudflare API Token 使用 AES-256-GCM 加密后保存到 `CONSOLE_SESSIONS` KV。
- 浏览器只保存服务配置草稿和已发布配置，不保存 API Token 或 NAS 密码。
- NAS 密码只写入目标 Worker 的 `PASSWORD` Secret。
- 绿联代理 Cookie 按账户命名空间和端口保存在目标 Worker 的 `UGLINK_CACHE` KV。
- 诊断记录按控制台会话、Cloudflare 账户和 Worker 隔离，只保存阶段、错误码、HTTP 状态与非敏感说明，30 天后自动过期。

## 容器运行

生产镜像采用多阶段构建，最终镜像只包含控制台 Worker bundle、静态资源、本地运行所需的 Wrangler 依赖和容器入口。构建上下文排除 `.dev.vars`、`.env`、Wrangler 状态、生成配置和历史构建目录。

容器入口在 `/data` 具名卷中自动创建 32 字节随机会话密钥，并让本地 KV 持久化到同一卷。容器以非 root 用户运行，根文件系统只读，不需要 Linux capabilities；`/api/health` 只用于容器存活检查，不创建会话或访问 Cloudflare、NAS。
