# 参与贡献

欢迎提交问题、功能建议和 Pull Request。较大的行为变更请先通过 Issue 说明场景与方案，避免重复工作。具体故障的排查过程放在对应 Issue，README 保持为项目介绍和使用入口。

## 本地开发

建议使用 Node.js 22.13+ 的 22.x 版本和 npm 10+；完整版本约束以 `package.json` 的 `engines` 为准。

```bash
npm ci
npm run dev
```

控制台开发服务器默认运行在 `http://127.0.0.1:5173`。首次启动会生成本地 `.dev.vars` 会话密钥。若已启动 Docker 控制台，请先停止它或调整端口，避免占用冲突。

独立调试 Gateway：

```bash
npm run dev:gateway
```

该命令使用 `uglink.config.json`。具体配置方式见 [配置说明](docs/configuration.md)。空配置只提供 setup 状态，不会连到真实 NAS。

## 使用 Docker 运行当前源码

```bash
npm run docker:up
```

该命令通过 Compose 构建当前源码并启动。`npm run docker:build` 只构建，两者使用相同的 Compose 镜像配置。停止服务使用 `npm run docker:down`，该命令保留数据卷。

源码开发与拉取发布镜像是两条路径。按 README 的 `docker compose up -d --no-build` 启动的是指定镜像，不会重新构建当前源码。

调试生产 Node.js 入口可先运行 `npm run build:console`，再以 `UGLINK_DATA_DIR=./data PORT=5173 npm run start:console` 启动。它使用 SQLite；`npm run dev` 仍使用 Wrangler 的本地开发环境。不要将测试进程指向正在使用的数据卷。

## 验证

```bash
npm test
npm run typecheck
npm run check
```

`npm run check` 包含公开发布文件审计、配置校验、Gateway 与 Console 测试、类型检查和构建。测试与构建不需要真实 NAS 凭证，也不会部署到 Cloudflare。

修改界面时，启动控制台后执行浏览器回归：

```bash
npm run qa:browser
```

脚本使用模拟 API 数据，不验证真实 NAS 连接。默认访问 `http://127.0.0.1:5173`，可通过 `QA_BASE_URL` 覆盖。Windows 会尝试常见的 Chrome/Edge 安装位置；其他位置以及 macOS/Linux 需要通过 `CHROME_PATH` 指定浏览器可执行文件。

截图与报告输出到系统临时目录下的 `uglink-control-qa`。README 预览图取自其中的 `services-healthy.png`，更新图片前应确认只有示例数据。

PR 自动运行完整检查；主分支和版本标签的镜像发布也必须通过这套检查。GitHub Actions 检查不替代真实设备验证，涉及绿联接口的改动应单独说明设备测试范围。

## 目录与依赖方向

```text
src/
  domain/          核心模型、配置规则和代理路由
  application/     控制台及 Gateway 用例编排
  infrastructure/  Cloudflare、绿联、KV、SQLite 与加密适配
  interfaces/      HTTP 入口和 React 界面
test/              Gateway 与 Console 测试
scripts/           配置生成、构建辅助、发布审计和浏览器回归
docs/              部署、配置与备份说明
```

领域层不依赖外层；应用层通过接口调用外部能力；基础设施层不依赖界面层。`test/domain/layering.test.ts` 检查这些依赖方向。

不同 Wrangler 配置对应不同入口，用途见 [配置文件说明](docs/configuration.md#各配置文件的用途)。不要仅因文件名称相似就合并它们。

## 提交要求

- 聚焦一个问题，说明触发条件、修改后的行为和验证范围。
- 修改行为时补充对应回归用例；文档或格式修改无需增加重复实现的测试。
- 不提交真实设备 ID、账号、密钥、Cookie、个人服务地址或未脱敏的日志和截图。
- 不提交 `.env`、`.dev.vars`、`.wrangler`、生成配置、构建产物或依赖目录。
- 不将本地测试、模拟 API 测试或构建成功描述为生产环境验证通过。
- 用户可见行为变化应同步相关文档；版本变更记录统一维护在 GitHub Releases。

## 报告问题

请附上镜像版本或提交号、部署方式、复现步骤、预期结果与实际结果，以及脱敏后的错误日志。NAS 兼容性问题还应注明设备型号和系统版本。不要提交完整数据卷或带凭证的备份。

发现安全问题时，按 [SECURITY.md](SECURITY.md#报告漏洞) 私密报告，不公开利用细节。
