# 部署说明

项目提供三种互不依赖的运行与部署方式。

## Docker 本地控制台（推荐）

Docker 镜像包含构建后的控制台 Worker、静态页面和本地 Cloudflare 兼容运行时，不包含 `.dev.vars`、Cloudflare Token 或 Wrangler 本地状态。

```sh
docker compose pull
docker compose up -d
```

Compose 默认匿名拉取 `ghcr.io/leonis-q-f/uglink-worker-nas:latest`，把控制台绑定到宿主机 `127.0.0.1:5173`，并使用 `uglink-data` 具名卷保存自动生成的会话加密密钥和本地 KV。普通的 `docker compose down` 会保留数据；删除数据卷会使原有加密会话失效。需要从当前源码构建镜像时，执行 `docker compose up --build -d`。

需要从 NAS 局域网访问时，在未跟踪的 `.env` 中设置 `UGLINK_BIND_ADDRESS`。不要把控制台端口直接映射到公网；确需远程访问时应使用受认证的反向代理或 Cloudflare Access。

## 可视化控制台（推荐）

管理控制台只要求用户填写 Cloudflare Account ID 和限定权限的 API Token。配置完成后，控制台直接执行：

1. 校验 NAS 上游地址、用户名、服务域名与端口。
2. 在所选账户中创建或复用 `<Worker 名称>-uglink-cache` KV。
3. 上传代理 Worker、运行时变量和 KV 绑定，并保留已有 Secret。
4. 首次部署写入 `PASSWORD`，以后可按需轮换。
5. 添加新 Custom Domains；全部添加成功后再移除不再使用的旧域名。
6. 同步 workers.dev 与 Preview URL 设置。
7. 检查每个服务的 Worker 状态端点。

服务配置保存在用户当前浏览器，API Token 加密保存在控制台的服务端会话存储中。整个流程不依赖其他发布服务。

## 本地命令行

仍然可以直接在项目根目录使用 Wrangler：

```sh
npm ci
npm run check
npm run deploy:gateway
```

`npm run deploy:gateway` 会校验 `uglink.config.json`，生成临时 Wrangler 配置，再部署 Worker、变量、KV 绑定和 Custom Domains。运行前需在 `wrangler.gateway.jsonc` 中填写 `UGLINK_CACHE` 的命名空间 ID，并设置 `PASSWORD` Secret。

三种方式可以共存。Docker 和 `npm run dev` 都是管理控制台的本地运行方式；同一项服务仍应选定控制台或命令行中的一种日常配置来源，以免本地文件和浏览器配置互相覆盖。
