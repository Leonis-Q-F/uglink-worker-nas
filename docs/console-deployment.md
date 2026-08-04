# 控制台部署配置

UGLINK Control 直接使用用户填写的 Cloudflare API Token 管理 Worker、会话缓存和访问域名。部署控制台本身只需要一个 Workers KV 命名空间和一个会话加密密钥。

## 1. 创建会话存储

在仓库根目录执行：

```powershell
npx wrangler kv namespace create CONSOLE_SESSIONS
```

将返回的命名空间 ID 写入根目录 `wrangler.jsonc` 中 `CONSOLE_SESSIONS` 绑定的 `id` 字段。该命名空间保存加密后的 API Token 会话和短期发布状态，不保存 NAS 密码。

## 2. 配置会话加密密钥

生成密钥并按提示写入控制台 Worker Secret：

```powershell
npm run secret:key
npx wrangler secret put SESSION_ENCRYPTION_KEY
```

本地开发不需要手动执行以上命令；首次运行 `npm run dev` 时会自动在根目录 `.dev.vars` 中生成密钥，后续启动会稳定复用。不要删除或提交该文件。

## 3. 发布控制台

```powershell
npm install
npm run check
npm run deploy:console
```

正式环境可以继续使用 `workers.dev`，也可以在 Cloudflare 中为控制台添加自定义域名。生产环境必须通过 HTTPS 访问。

## 4. 创建 API Token

在 Cloudflare 的 API Tokens 页面创建自定义 Token：

- Account / `Workers Scripts Write`
- Account / `Workers KV Storage Write`
- Account Resources / Include / 需要部署服务的账户

可以按需设置有效期或来源 IP。Token 只展示一次，应立即安全保存；不要使用 Global API Key。

## 5. 完成服务设置

1. 打开控制台，填写 Cloudflare Account ID、API Token 和 Worker 名称。
2. 控制台验证目标账户、Workers 与 Workers KV 的可访问性。
3. 填写 NAS 地址、登录用户名、访问域名和端口。
4. 首次发布填写 NAS 密码；以后留空会保留当前密码。
5. 点击“发布更改”。

服务状态异常时，可直接点击服务列表中的错误状态进入“故障诊断”。页面会显示失败阶段、错误码、HTTP 状态和最近检查时间，并提供“重新检查”和“覆盖部署”：

- “重新检查”只检查 Worker 服务入口和域名绑定，不会请求 NAS 的根路径或业务接口。
- “覆盖部署”使用浏览器中保存的已发布配置重新上传并替换当前项目管理的同名 Worker。
- 控制台不会覆盖不属于本项目的同名 Worker，也不会把 API Token、NAS 密码或代理 Cookie 写入诊断日志。

诊断记录按当前控制台会话、Cloudflare 账户和 Worker 隔离，保存在 `CONSOLE_SESSIONS` KV 中，最多保留 100 条并在 30 天后过期。

Token 失效、被撤销或权限发生变化时，可在“权限与安全”中选择“重新配置 API Token”。该操作只清除控制台保存的加密凭据；如需让 Token 在 Cloudflare 全局失效，应在 Cloudflare API Tokens 页面将其删除。
