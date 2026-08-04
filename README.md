# UGLINK Worker Gateway

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

通过 Cloudflare Worker，把同一绿联云账户下的多个 NAS HTTP 服务映射到不同的自定义域名，并提供一个可视化控制台完成配置、发布和健康检查。

每位使用者拥有自己的 Worker、KV、域名和凭据。项目不提供中央代理服务，也不会把 NAS 密码写入配置文件或浏览器存储。

## 功能

- 一个 Worker 支持多个“域名 → NAS 端口”映射。
- 可视化配置 Cloudflare Account ID、API Token、NAS 地址和服务列表。
- 自动创建或复用 KV、发布 Worker、设置 Secret 并同步 Custom Domains。
- 自动登录绿联云并按账户及端口隔离短期代理会话。
- 仅在绿联代理跳转到登录页时刷新会话，后端应用的 `401`、`403` 和普通重定向原样透传。
- 保留后端应用 Cookie，并拒绝客户端伪造绿联代理 Cookie。
- 不接受 URL 参数指定端口，避免 Worker 成为开放代理。
- 页面刷新后自动检查所有已发布 Worker 的服务入口和域名绑定状态，不探测 NAS 业务路径。
- 按服务入口、Worker 配置和 NAS 后端记录结构化故障信息，并支持使用已发布配置覆盖部署受管 Worker。

## 架构

仓库采用 DDD 分层，所有运行时代码集中在一套工程中：

```text
src/
├─ domain/          领域模型、配置规则、部署状态和代理路由
├─ application/     Cloudflare 连接、发布和代理请求用例及端口
├─ infrastructure/  Cloudflare、绿联、KV、加密、健康检查和浏览器存储适配器
└─ interfaces/      两个 Worker 的 HTTP 入口和 React 管理界面
```

依赖只能由外向内：`interfaces → infrastructure/application → domain`。测试中包含分层约束检查，防止领域层反向依赖框架或平台代码。详细说明见 [架构说明](./docs/architecture.md)。

## 本地运行控制台

要求 Node.js 20.19 或更高的兼容版本（也支持 Node.js 22.12 以上版本）。

```sh
npm install
npm run dev
```

首次启动会在根目录自动创建 `.dev.vars` 和随机的 `SESSION_ENCRYPTION_KEY`，后续启动会复用同一密钥且不会覆盖。访问 `http://127.0.0.1:5173` 后，控制台会要求填写 Cloudflare Account ID、限定权限的 API Token 和目标 Worker 名称。

`.dev.vars` 只用于本机且已被 Git 忽略。不要删除或提交该文件；删除后再次启动会生成新密钥，原有本地登录会话将无法解密。

控制台需要以下 Cloudflare 权限：

- `Workers Scripts Write`
- `Workers KV Storage Write`

建议把 Token 的资源范围限制在目标账户，不要使用 Global API Key。

## 使用 Docker Compose

Docker 方式运行的是本地管理控制台。公开镜像托管在 GHCR，并支持 `linux/amd64` 与 `linux/arm64`。镜像启动时会在具名卷中自动生成会话加密密钥，并把本地 KV 状态持久化到同一个卷；密钥和 Cloudflare API Token 不会写入镜像。

```sh
docker compose pull
docker compose up -d
```

默认访问地址为 `http://127.0.0.1:5173`。查看日志和停止服务：

```sh
docker compose logs -f
docker compose down
```

`docker compose down` 不会删除数据卷。只有明确执行 `docker compose down -v` 才会删除本地会话、加密密钥和已保存的 Cloudflare 连接。NAS 上需要从局域网访问时，可复制 [`.env.example`](./.env.example) 为 `.env`，再把 `UGLINK_BIND_ADDRESS` 改为 NAS 的局域网地址或 `0.0.0.0`；不要把未加保护的控制台直接暴露到公网。

公开镜像允许匿名拉取，不需要登录 GitHub。需要从当前源码重新构建时：

```sh
docker compose up --build -d
# 或者
docker build -t uglink-worker-nas:latest .
docker run --rm -p 127.0.0.1:5173:8787 -v uglink-data:/data uglink-worker-nas:latest
```

## 发布控制台到 Cloudflare

1. 创建 `CONSOLE_SESSIONS` Workers KV 命名空间。
2. 把命名空间 ID 写入 [`wrangler.jsonc`](./wrangler.jsonc)。
3. 设置生产会话加密密钥。
4. 发布控制台。

```sh
npx wrangler secret put SESSION_ENCRYPTION_KEY --config wrangler.jsonc
npm run deploy:console
```

完整步骤见 [控制台部署配置](./docs/console-deployment.md)。

## 命令行发布代理 Worker

不使用控制台时，可以编辑 [`uglink.config.json`](./uglink.config.json)：

```json
{
  "$schema": "./uglink.config.schema.json",
  "version": 1,
  "uglink": {
    "baseUrl": "https://example.cn99.ug.link",
    "username": "your-username"
  },
  "services": [
    {
      "name": "api",
      "hostname": "api.example.com",
      "port": 8317,
      "enabled": true
    }
  ],
  "deployment": {
    "workersDev": false,
    "previewUrls": false
  }
}
```

先在 [`wrangler.gateway.jsonc`](./wrangler.gateway.jsonc) 中填写 `UGLINK_CACHE` 的 KV ID，再设置密码并发布：

```sh
npm run config:generate
npx wrangler secret put PASSWORD --config wrangler.gateway.generated.json
npm run deploy:gateway
```

生成的 `wrangler.gateway.generated.json` 不会提交到 Git，不要直接编辑。

## 常用命令

```sh
npm run dev              # 启动管理控制台
npm run dev:gateway      # 启动代理 Worker
npm test                 # 运行全部测试
npm run typecheck        # TypeScript 检查
npm run build            # 构建控制台和代理 Worker
npm run check            # 完整交付检查
npm run deploy:console   # 发布管理控制台
npm run deploy:gateway   # 发布代理 Worker
npm run docker:build     # 构建本地容器镜像
npm run docker:up        # 使用 Compose 构建并启动
npm run docker:down      # 停止 Compose 服务并保留数据卷
```

健康检查地址：

```text
https://你的域名/.well-known/uglink-worker-health
```

该端点不会访问 NAS，也不会返回端口、用户名或代理凭据。

## 安全提示

配置 Custom Domain 后，对应 NAS 服务会暴露到公网。请确保后端服务自身启用了身份验证，管理后台建议额外配置 Cloudflare Access。更多内容见 [安全策略](./SECURITY.md)。

## 文档

- [架构说明](./docs/architecture.md)
- [配置说明](./docs/configuration.md)
- [部署说明](./docs/deployment.md)
- [控制台部署配置](./docs/console-deployment.md)
- [贡献指南](./CONTRIBUTING.md)

## 许可证

本项目采用 [MIT License](./LICENSE)。
