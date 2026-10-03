# 本地反向代理验收

本夹具使用独立 Compose 项目 `uglink-proxy-qa`、独立数据卷和回环发布端口，不访问真实 Cloudflare 账户。需要 Docker、OpenSSL、项目 npm 依赖以及 Chromium（可用 `CHROME_PATH` 指定）。在仓库根目录执行：

```powershell
New-Item -ItemType Directory -Force test-results/proxy-certs | Out-Null
@'
[req]
distinguished_name = dn
[dn]
'@ | Set-Content test-results/proxy-certs/openssl.cnf
openssl req -config test-results/proxy-certs/openssl.cnf -x509 -newkey rsa:2048 -nodes -keyout test-results/proxy-certs/key.pem -out test-results/proxy-certs/cert.pem -days 2 -subj /CN=proxy.test -addext 'subjectAltName=DNS:proxy.test,DNS:relay.test'
docker build -t uglink-proxy-qa:local .
docker compose -p uglink-proxy-qa -f test/fixtures/proxy/compose.yaml up -d --wait
node scripts/proxy-browser-qa.mjs
docker compose -p uglink-proxy-qa -f test/fixtures/proxy/compose.yaml down
```

请检查每一步退出码成功后再执行下一步。证书和密钥只生成于被 Git/Docker 忽略的 `test-results`，不可用于生产。浏览器仅在这个测试上下文忽略自签名证书错误，通过 resolver 将两个测试域名指向本机。子网 `192.0.2.0/24` 为隔离夹具的文档保留网段，如与本机已有网络冲突需同步调整夹具地址和可信 CIDR。

测试直接操作实际 Docker 应用，无 API 响应拦截：

- LAN HTTP、标准单值头 TLS 代理、保留 Host 的 TLS 代理首次 bootstrap。
- 浏览器实际存储/回传 Secure、HttpOnly、SameSite=Lax、host-only Cookie；合法写入与缺失 CSRF 拒绝。
- 三个域名/IP 的会话隔离、旧非 Secure Cookie 升级、页面刷新、错误恢复与容器重启持久化。
- Docker 发布端口客户端伪造转发头、跨允许来源写入、可信代理多值头拒绝、代理清洗客户端转发头。

零配置验收使用以下覆盖文件，清空应用全部来源环境变量，代理改写 Host 并丢弃全部转发头：

```powershell
docker compose -p uglink-proxy-qa -f test/fixtures/proxy/compose.yaml -f test/fixtures/proxy/compose.auto.yaml up -d --wait
$env:QA_AUTO_ORIGIN = 'true'
node scripts/proxy-browser-qa.mjs
Remove-Item Env:QA_AUTO_ORIGIN
```

自动模式额外验证真实 Chrome 的跨站请求触发预检并被拒绝。首次 Cookie 由实际前端初始化生成后再进行协议探测。完整业务连接和部署的外部调用由单元测试模拟；本夹具不执行真实云端部署。真实 NAS 链路须另外验收，不能由本地测试推断。
