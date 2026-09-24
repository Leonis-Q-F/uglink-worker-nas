# 部署 UGLINK Worker NAS

管理控制台可以运行在本地 Docker 或 Cloudflare Workers。两种方式都把 Gateway 部署到 Cloudflare，访问 NAS 时无需经过本地控制台。

## Cloudflare 账户与权限

### 获取 Cloudflare Account ID

登录 [Cloudflare Dashboard](https://dash.cloudflare.com)，进入 **Workers & Pages** 页面，在右侧即可找到你的 Account ID：

<p align="center">
  <img src="../assets/cloudflare-account-id.png" alt="在 Cloudflare Workers & Pages 页面找到 Account ID" width="720" />
</p>

### 创建 API Token

前往 [API Tokens](https://dash.cloudflare.com/profile/api-tokens) 页面创建一个自定义 Token，所需权限如下：

<p align="center">
  <img src="../assets/cloudflare-api-token-permissions.png" alt="API Token 权限配置" width="720" />
</p>

> [!WARNING]
> **不要使用 Global API Key。** 只需要授予以下最小权限，并把范围限制到目标账户：
>
> | 权限 | 级别 |
> |------|------|
> | Account / Workers Scripts | Edit |
> | Account / Workers KV Storage | Edit |


## Docker 管理控制台

安装 Docker 和 Docker Compose，在空目录下载项目提供的配置：

```bash
mkdir uglink
cd uglink
curl -fL https://raw.githubusercontent.com/Leonis-Q-F/uglink-worker-nas/main/compose.yaml -o compose.yaml
curl -fL https://raw.githubusercontent.com/Leonis-Q-F/uglink-worker-nas/main/.env.example -o .env
# 仅运行发布镜像，不从源码构建
docker compose up -d --no-build
```

配置中的 `build` 用于源码开发。只有配置文件的安装方式请使用 `--no-build`。

打开 `http://设备地址:5173`，连接 Cloudflare，填写 UGREENlink ID、NAS 本地登录用户名及密码，然后添加服务域名和端口并发布。NAS 用户名与 UGREENlink ID 是两个不同字段。

控制台默认监听所有网络接口，仅供可信局域网使用。需要远程访问时，应配置具有身份验证和 HTTPS 的反向代理或 Cloudflare Access。具体见 [安全策略](../SECURITY.md)。

镜像支持 `linux/amd64` 和 `linux/arm64`。数据保存在 `uglink-data` 卷内；重建容器不会删除该卷。

### Compose 配置

下列变量写入 Compose 项目目录的 `.env`。完整示例见 [`.env.example`](../.env.example)。

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `UGLINK_BIND_ADDRESS` | 主机监听地址；仅本机使用时填 `127.0.0.1` | `0.0.0.0` |
| `UGLINK_CONSOLE_PORT` | 主机端口 | `5173` |
| `UGLINK_IMAGE` | 镜像地址及版本 | `ghcr.io/leonis-q-f/uglink-worker-nas:latest` |

### 会话加密密钥

Docker 首次启动自动生成会话加密密钥并保存在数据卷中，通常无需手动设置。

如果必须提供自己的密钥，先用下面的命令生成 32 字节 base64url 密钥，保存在密码管理器中：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

在 `.env` 中添加 `SESSION_ENCRYPTION_KEY`，并在现有 `compose.yaml` 的 `services.console` 下添加以下配置，其他字段保持原样：

```yaml
environment:
  SESSION_ENCRYPTION_KEY: "${SESSION_ENCRYPTION_KEY:?Set SESSION_ENCRYPTION_KEY in .env}"
```

仅在 `.env` 中设置变量不会自动传入容器。密钥变更后，旧的加密会话将无法读取；迁移时应保留原密钥。

### 更新

```bash
docker compose pull
docker compose up -d --no-build
```

`latest` 随主分支发布。需要固定版本时，在 `.env` 中设置 `UGLINK_IMAGE=ghcr.io/leonis-q-f/uglink-worker-nas:1.0.3` 等已发布标签。

更新控制台不会自动更新已经部署的 Gateway。涉及网关变更时，请按照 [Release 说明](https://github.com/Leonis-Q-F/uglink-worker-nas/releases)，在更新后的控制台进入「故障诊断 → 覆盖部署」。该操作使用已发布配置更新项目管理的同名 Worker，保留现有 NAS 密码，无需修改服务配置来启用发布按钮。

### 为已部署的网关启用 Smart Placement

新版本通过控制台发布或 Wrangler 部署 Gateway 时，会默认开启 Smart Placement，由 Cloudflare 根据请求耗时选择执行位置。

- Docker 用户：更新到包含此功能的镜像后，执行一次「故障诊断 → 覆盖部署」。只更新或重启控制台容器不会改变线上 Worker 的设置。
- 源码部署用户：更新源码后，通过新版控制台覆盖部署，或执行 `npm run deploy:gateway`。使用 Wrangler 前，请确认部署配置仍指向原来的 Worker、KV 和域名。
- 暂时不升级的用户：可以在 Cloudflare 的「Workers & Pages → 目标 Worker → Settings → General → Placement」中选择 Smart。旧版控制台不保证后续发布时保留该设置，建议升级后由项目统一管理。

开启后可能需要最多 15 分钟分析，并且需要来自多个位置的持续请求。启用配置不代表已经迁移执行位置，也不保证所有访问都变快。机制与适用条件见 [Cloudflare Placement 文档](https://developers.cloudflare.com/workers/configuration/placement/)。

## 数据持久化与备份

- `uglink-data` 卷保存自动生成的会话加密密钥、本地 KV、加密 API Token、服务配置与诊断记录。
- 已发布的非秘密配置同步到目标 Worker 的 `UGLINK_CACHE` KV；API Token、NAS 密码和本地草稿不会同步。
- 更新时使用 `docker compose pull && docker compose up -d`；不要执行 `docker compose down --volumes` 或手动删除 `uglink-data`。
- 加密备份包含 Cloudflare 连接、UGREENlink ID、NAS 登录用户名、服务配置和诊断记录，需要至少 12 个字符的独立备份密码。
- NAS 登录密码由 Cloudflare Worker Secret 保存，Cloudflare 不允许读取 Secret 明文，因此不会进入备份文件。
- 完整灾难恢复应停止控制台后成组备份整个卷；卷备份和应用导出的加密备份都应按敏感数据保管。

完整卷备份示例：

```bash
mkdir -p backup
docker compose stop console
docker run --rm -v uglink-data:/data:ro -v "$PWD/backup:/backup" alpine \
  tar czf /backup/uglink-data.tgz -C /data .
docker compose start console
```

如需直接管理宿主机文件，可以把卷改为 `/volume1/docker/uglink:/data` 等绝对路径；该高级方案需要提前为容器内 UID/GID `1000:1000` 配置写入权限。


## 将管理控制台部署到 Cloudflare

此方式不需要 Docker。建议使用 Node.js 22.12+ 的 22.x 版本和 npm 10+。

```bash
git clone https://github.com/Leonis-Q-F/uglink-worker-nas.git
cd uglink-worker-nas
npm ci
npx wrangler login
npx wrangler kv namespace create CONSOLE_SESSIONS --config wrangler.jsonc
```

将创建结果中的命名空间 ID 填入 `wrangler.jsonc` 的 `kv_namespaces`，替换 `CONSOLE_SESSIONS` 对应的全零占位 ID。按需修改 `name`；后续密钥配置和部署必须使用同一个 Worker 名称。

然后配置控制台会话密钥。以下命令直接通过标准输入提交新密钥，不把密钥写入仓库：

```bash
npm run --silent secret:key | npx wrangler secret put SESSION_ENCRYPTION_KEY --config wrangler.jsonc
```

如果 Wrangler 提示目标 Worker 尚不存在，确认创建。已有部署迁移时应使用原密钥，不要随意重新生成。

```bash
npm run deploy:console
```

部署成功后通过 Wrangler 输出的地址打开控制台，并在控制台连接目标 Cloudflare 账户。Wrangler 的登录用于部署控制台，不替代控制台内的 API Token 连接。

云端控制台应配置访问控制。`.dev.vars` 只用于本地开发，不会替代生产环境的 Worker Secret。

## 直接部署 Gateway

高级使用者可以通过 Wrangler 部署 Gateway，不必使用管理控制台。此路径与控制台的配置存储相互独立。

1. 安装依赖并执行 `npx wrangler login`。
2. 修改 `uglink.config.json`，填写设备、用户名和服务映射，见 [配置说明](configuration.md)。
3. 执行 `npx wrangler kv namespace create UGLINK_CACHE --config wrangler.gateway.jsonc`，将返回的命名空间 ID 填入 `wrangler.gateway.jsonc` 对应的 KV 绑定，并确认目标 Worker 名称。
4. 执行 `npm run config:generate`。
5. 执行 `npx wrangler secret put PASSWORD --config wrangler.gateway.generated.json`，按提示输入 NAS 密码；Worker 尚不存在时确认创建。
6. 执行 `npm run deploy:gateway`。

生成的 `wrangler.gateway.generated.json` 包含服务映射和自定义域名路由，不应手动修改或提交。此路径不会自动写入控制台用于恢复的云端配置记录。

返回 [项目首页](../README.md)。
