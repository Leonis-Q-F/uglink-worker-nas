# 贡献指南

## 开发环境

- Node.js 20.19 或更高的兼容版本（或 22.12 以上版本）
- npm 10 或更高版本
- 可选：用于本地 Cloudflare Worker 调试的 Wrangler 登录状态

安装依赖并运行完整检查：

```sh
npm install
npm run check
```

## 代码结构

提交代码前请遵守 [架构说明](./docs/architecture.md) 中的依赖方向：

- 业务规则放在 `src/domain`。
- 用例及端口放在 `src/application`。
- Cloudflare、绿联、KV、浏览器和加密实现放在 `src/infrastructure`。
- Worker 入口、HTTP 转换和页面组件放在 `src/interfaces`。

不要在领域层引入平台 SDK，也不要为同一配置规则分别维护浏览器版和服务端版实现。

## 提交前检查

```sh
npm test
npm run typecheck
npm run build
npm run audit:public
```

涉及配置格式时，同时更新 `uglink.config.schema.json`、配置文档和测试。涉及凭据或日志时，请先核对 [`SECURITY.md`](./SECURITY.md)。

提交内容不得包含真实 API Token、密码、Cookie、Account ID、KV ID、绿联远程地址或个人域名。

准备公开发布时，还应在本地设置 `UGLINK_AUDIT_FORBIDDEN_TERMS`（逗号分隔个人名称、域名或账号别名）并执行历史审计：

```sh
npm run audit:public -- --history
```

Docker 变更需要同时验证 `docker build`、容器 `/api/health` 以及持久卷重启后的会话可用性。
