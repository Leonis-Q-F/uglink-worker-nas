# 配置说明

## 控制台配置与本地文件

控制台将草稿和已发布配置存入本地 SQLite（Docker）或自身 KV（云端），并在发布时将非秘密配置同步到目标 Gateway 的 KV，供以后确认导入。它不会自动修改源码目录中的 `uglink.config.json`。

`uglink.config.json` 是直接使用 Wrangler 部署 Gateway 时的输入文件。`npm run config:generate` 读取它和 `wrangler.gateway.jsonc`，生成 `wrangler.gateway.generated.json`。

## Gateway 配置示例

```json
{
  "$schema": "./uglink.config.schema.json",
  "version": 2,
  "uglink": {
    "id": "your-uglink-id",
    "username": "your-nas-login-username"
  },
  "services": [
    {
      "name": "nas-admin",
      "hostname": "nas.example.com",
      "port": 8443,
      "accessMode": "proxy",
      "enabled": true
    }
  ]
}
```

| 字段 | 含义 |
| --- | --- |
| `uglink.id` | 设备的 UGREENlink ID |
| `uglink.username` | NAS 网页端使用的本地登录用户名 |
| `services[].name` | 用于识别服务的名称 |
| `services[].hostname` | 绑定到 Gateway 的自定义域名 |
| `services[].port` | NAS 上目标服务的端口 |
| `services[].accessMode` | 访问方式。`proxy` 为反向代理，`ticket` 为票据入口；省略时使用 `proxy` |
| `services[].enabled` | 是否发布此服务映射，省略时启用 |

每个启用的服务使用独立域名。密码不放入此文件，而是作为 Gateway 的 `PASSWORD` Secret 配置。密码更新后，应在控制台重新输入并发布，或通过 Wrangler 更新同一个 Secret。

### 访问方式

`proxy` 是默认方式，自定义域名始终是实际访问地址，全部请求由 Gateway Worker 转发到 NAS。

`ticket` 只把自定义域名作为启动入口：

1. 浏览器访问自定义域名时，Worker 返回一个启动页，不会自动登录或签发票据。
2. 用户点击“打开服务”后，页面提交 `POST /__uglink/ticket`。
3. Worker 完成绿联登录并取得一次性 `redirect_url`，返回 `303` 跳转。
4. 浏览器随后在绿联中继域名上完成票据交接，后续流量不再经过 Gateway Worker。

票据入口模式有以下边界：

- 跳转后地址栏会变成 `*.ug.link`，自定义域名不再是应用页面的 origin。
- 依赖固定 origin 的 Cookie、PWA、OAuth 回调、WebAuthn 和深链接可能失效；此类服务应继续使用 `proxy`。
- 链接只对一次打开有效。刷新页面或重新访问服务时，需要回到自定义域名重新签发。
- 当前不支持开启二次验证的账号；账号返回 `otp_required` 时无法使用票据模式。
- 票据入口本身等价于 NAS 服务入口。若不应允许所有互联网访客自助取票，应在 Cloudflare Access 或其他身份验证层后面保护该域名。

完整字段约束见 [`uglink.config.schema.json`](../uglink.config.schema.json)。本地文件可通过 `npm run config:validate` 检查。

## 各配置文件的用途

| 文件 | 用途 |
| --- | --- |
| `wrangler.jsonc` | 控制台开发和云端部署 |
| `wrangler.gateway.jsonc` | 独立部署 Gateway 的基础配置 |
| `wrangler.gateway.bundle.jsonc` | 将 Gateway 打包到控制台中，供控制台发布 |
| `src/interfaces/http/console/node-entry.ts` | Docker 的 Node.js 启动入口及旧数据迁移 |
| `.env` | Docker Compose 的变量替换输入 |
| `.dev.vars` | 本地 Wrangler/Vite 开发使用的密钥 |

这些文件对应不同运行方式，不应合并成一个部署配置。`.env`、`.dev.vars`、生成文件和运行时状态均不应提交。

返回 [项目首页](../README.md) · [部署与备份](deployment.md)。

反向代理和多入口参数见 [部署文档：多入口与反向代理来源配置](deployment.md#多入口与反向代理来源配置)。来源必须精确匹配，可信代理只按实际 socket 对端配置；不能用允许来源列表替代代理信任或 CSRF 校验。
