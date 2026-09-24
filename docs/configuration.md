# 配置说明

## 控制台配置与本地文件

控制台将草稿和已发布配置存入自身 KV，并在发布时将非秘密配置同步到目标 Gateway 的 KV，供以后确认导入。它不会自动修改源码目录中的 `uglink.config.json`。

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
| `services[].enabled` | 是否发布此服务映射，省略时启用 |

每个启用的服务使用独立域名。密码不放入此文件，而是作为 Gateway 的 `PASSWORD` Secret 配置。密码更新后，应在控制台重新输入并发布，或通过 Wrangler 更新同一个 Secret。

完整字段约束见 [`uglink.config.schema.json`](../uglink.config.schema.json)。本地文件可通过 `npm run config:validate` 检查。

## 各配置文件的用途

| 文件 | 用途 |
| --- | --- |
| `wrangler.jsonc` | 控制台开发和云端部署 |
| `wrangler.gateway.jsonc` | 独立部署 Gateway 的基础配置 |
| `wrangler.gateway.bundle.jsonc` | 将 Gateway 打包到控制台中，供控制台发布 |
| `docker/wrangler.json` | Docker 内运行已构建的控制台 |
| `.env` | Docker Compose 的变量替换输入 |
| `.dev.vars` | 本地 Wrangler/Vite 开发使用的密钥 |

这些文件对应不同运行方式，不应合并成一个部署配置。`.env`、`.dev.vars`、生成文件和运行时状态均不应提交。

返回 [项目首页](../README.md) · [部署与备份](deployment.md)。
