# Security Policy

## 凭证

- 绿联密码只能存放在 Cloudflare Worker Secret `PASSWORD` 中。
- Cloudflare API Token 只允许保存在控制台的加密服务端会话中，不得写入浏览器存储或项目配置。
- 已发布的服务配置会写入目标 Worker 的 KV 以支持恢复，其中不得包含 API Token、NAS 密码或会话凭据。
- API Token 应只授予 `Workers Scripts Write` 与 `Workers KV Storage Write`，并把资源范围限制到目标账户。
- 不要使用权限覆盖整个 Cloudflare 账户的 Global API Key。
- 不要把真实密码写入 issue、日志、配置文件、截图或 Git 提交。
- `.dev.vars` 和 `.env` 已被忽略；首次本地启动会自动生成会话加密密钥，示例文件只能保留空值或明确的占位符。
- 代理 Cookie、RSA Token 和登录响应中的敏感字段不得记录到日志。

## Docker

- 镜像构建上下文会排除 `.dev.vars`、`.env`、Wrangler 状态和生成目录；不要使用 `--build-arg` 传递任何密钥。
- Compose 默认只绑定 `127.0.0.1`。在 NAS 上改为局域网监听前，应确认端口不会从公网访问。
- Compose 默认使用 Docker 管理的 `uglink-data` 卷，避免宿主机目录权限迫使容器以 root 身份运行。
- `uglink-data` 卷包含会话加密密钥和加密后的 Cloudflare 连接。备份、迁移和删除该卷时应按敏感数据处理；不要执行 `docker compose down --volumes`。
- 如需远程访问控制台，应放在具备身份验证和 HTTPS 的反向代理或 Cloudflare Access 后面。

## 暴露 NAS 服务的风险

配置 Custom Domain 后，对应 NAS HTTP 服务将可从公网访问。项目只负责取得绿联代理凭证，不会自动替后端服务增加用户认证。

建议：

- 后端服务开启自己的认证和强密码。
- 对管理后台配置 Cloudflare Access。
- 只开放确实需要的端口。
- 定期查看 Worker 日志和绿联账户登录记录。

## 报告漏洞

请使用仓库的私密安全报告渠道联系维护者。不要在公开讨论区提交密码、Token、Cookie、真实远程地址或可复现的个人服务链接。
