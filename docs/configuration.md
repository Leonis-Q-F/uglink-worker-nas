# 配置说明

命令行部署以 `uglink.config.json` 为配置来源；可视化控制台使用结构相同的本地配置。两种入口共用 `src/domain/configuration` 中的领域校验规则。

## uglink

```json
{
  "uglink": {
    "baseUrl": "https://example.cn99.ug.link",
    "username": "your-username"
  }
}
```

- `baseUrl` 必须是纯 HTTPS Origin，不能包含用户名、密码、路径、查询参数或片段。
- `username` 是绿联云登录用户名，不是密码。
- 密码只能使用名为 `PASSWORD` 的 Worker Secret。

## services

```json
{
  "services": [
    {
      "name": "api",
      "hostname": "api.example.com",
      "port": 8317,
      "enabled": true
    }
  ]
}
```

- `name`：本地标识，必须唯一。
- `hostname`：完整域名，必须已经属于当前 Cloudflare 账户中的有效 Zone。
- `port`：NAS HTTP 服务端口，范围为 1–65535。
- `enabled`：为 `false` 时不会生成映射或域名。

域名不能重复，不能使用 IP、`localhost` 或通配符。Cloudflare Custom Domain 也不支持通配符。

## deployment

```json
{
  "deployment": {
    "workersDev": false,
    "previewUrls": false
  }
}
```

有自定义域名后，建议同时关闭 `workers.dev` 和 Preview URLs。没有启用服务时，系统会保留 `workers.dev` 作为默认访问地址。

## 添加服务

1. 在 `services` 数组增加一项。
2. 运行 `npm run check`。
3. 使用可视化控制台点击“发布更改”，或在本地运行 `npm run deploy:gateway`。

命令行模式会根据生成的 `routes` 配置 Custom Domains；控制台模式会直接调用 Cloudflare API 同步域名。如果目标主机名已绑定到其他 Worker 或不属于当前 Cloudflare 账户，发布会停止且不会覆盖现有服务。

## 删除服务

从配置删除域名后，下一次部署会把 Wrangler 中声明的路由作为最终状态。删除前请确认该域名不再需要指向 Worker。
