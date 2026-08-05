import {
  ArrowRight,
  ArrowUpRight,
  ArchiveRestore,
  Cloud,
  Database,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Route,
  ServerCog,
  ShieldCheck
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { apiPost, ConsoleApiError } from '../lib/api';
import type { BootstrapResponse } from '../../../application/console/contracts';
import { Brand } from './Brand';
import { BackupDialog } from './BackupDialog';

interface ConnectScreenProps {
  bootstrap: BootstrapResponse;
}

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    return error.detail ? `${error.message}（${error.detail}）` : error.message;
  }
  return error instanceof Error ? error.message : 'Cloudflare 连接失败，请稍后重试。';
}

export function ConnectScreen({ bootstrap }: ConnectScreenProps) {
  const [accountId, setAccountId] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [workerName, setWorkerName] = useState('uglink-worker');
  const [busy, setBusy] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();
  const [restoringBackup, setRestoringBackup] = useState(false);
  const canConnect = accountId.trim().length === 32
    && apiToken.trim().length >= 20
    && workerName.trim().length > 0;

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canConnect || busy) return;
    setBusy(true);
    setConnectionError(undefined);
    try {
      await apiPost<BootstrapResponse>('/api/connections/cloudflare', bootstrap.csrfToken, {
        accountId,
        apiToken,
        workerName
      });
      setApiToken('');
      window.history.replaceState({}, '', '/');
      window.location.reload();
    } catch (error) {
      setApiToken('');
      setConnectionError(errorMessage(error));
      setBusy(false);
    }
  };

  return (
    <div className="connect-shell">
      <header className="connect-header">
        <Brand />
        <div className="connect-header__right">
          <span>安全管理控制台</span>
        </div>
      </header>

      <div className="connect-layout">
        <aside className="connect-rail">
          <div>
            <p className="eyebrow">初始设置</p>
            <h1>配置<br />Cloudflare</h1>
            <p className="connect-rail__lead">填写访问凭据与发布目标，即可统一管理服务配置和访问域名。</p>
          </div>
          <ol className="setup-steps">
            <li className="is-current">
              <span>1</span>
              <div><strong>填写访问凭据</strong><small>Account ID 与 API Token</small></div>
            </li>
            <li>
              <span>2</span>
              <div><strong>确认发布目标</strong><small>设置 Worker 服务名称</small></div>
            </li>
            <li>
              <span>3</span>
              <div><strong>配置服务</strong><small>填写地址、域名和端口</small></div>
            </li>
          </ol>
          <div className="rail-security">
            <ShieldCheck size={19} />
            <p><strong>凭据保护</strong><br />API Token 只会加密保存在服务端会话中，不会写入浏览器存储。</p>
          </div>
        </aside>

        <main className="connect-main">
          <div className="connect-card">
            <div className="connect-card__heading">
              <p className="eyebrow">Cloudflare 连接</p>
              <h2>配置 API Token</h2>
              <p>使用只包含必要权限的 API Token，控制台验证凭据后直接建立安全连接。</p>
            </div>

            {connectionError && (
              <div className="inline-alert inline-alert--error" role="alert">
                <LockKeyhole size={18} />
                <div><strong>连接没有完成</strong><p>{connectionError}</p></div>
              </div>
            )}

            <div className="connection-list">
              <article className="connection-row">
                <span className="connection-row__logo connection-row__logo--cloudflare" aria-hidden="true">
                  <Cloud size={23} strokeWidth={1.9} />
                </span>
                <div className="connection-row__copy">
                  <div className="connection-row__title"><h3>Cloudflare API Token</h3></div>
                  <p>资源范围建议限定到一个账户，并仅授予 Worker 与 KV 写入权限。</p>
                </div>
                <a
                  className="button button--secondary"
                  href="https://dash.cloudflare.com/profile/api-tokens"
                  target="_blank"
                  rel="noreferrer"
                >
                  创建 Token <ArrowUpRight size={15} />
                </a>
              </article>
            </div>

            <form onSubmit={(event) => void connect(event)}>
              <section className="target-picker" aria-labelledby="connection-fields-title">
                <div>
                  <p className="eyebrow">连接信息</p>
                  <h3 id="connection-fields-title">Cloudflare 与发布目标</h3>
                </div>
                <div className="target-picker__fields">
                  <label className="field">
                    <span>Account ID</span>
                    <input
                      value={accountId}
                      onChange={(event) => setAccountId(event.target.value.trim().toLowerCase())}
                      placeholder="32 位 Cloudflare Account ID"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={32}
                    />
                    <small>可在 Cloudflare 账户概览中复制。</small>
                  </label>
                  <label className="field">
                    <span>服务名称</span>
                    <input
                      value={workerName}
                      onChange={(event) => setWorkerName(event.target.value.toLowerCase())}
                      placeholder="uglink-worker"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={63}
                    />
                    <small>同名 UGLINK Worker 存在时，会提示导入其已发布配置。</small>
                  </label>
                  <label className="field field--wide">
                    <span>API Token</span>
                    <input
                      type="password"
                      value={apiToken}
                      onChange={(event) => setApiToken(event.target.value)}
                      placeholder="粘贴 Cloudflare API Token"
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <small>Token 不会写入浏览器存储或日志，只会在服务端加密保存。</small>
                  </label>
                </div>
              </section>

              <section className="resource-review" aria-labelledby="resource-review-title">
                <div className="resource-review__heading">
                  <div><p className="eyebrow">Token 权限</p><h3 id="resource-review-title">所需权限</h3></div>
                  <span>限定目标账户</span>
                </div>
                <ul>
                  <li><ServerCog size={17} /><span><strong>Workers Scripts Write</strong><small>创建和更新 Worker、Secret 与访问域名</small></span><KeyRound size={15} /></li>
                  <li><Database size={17} /><span><strong>Workers KV Storage Write</strong><small>创建并绑定会话缓存命名空间</small></span><KeyRound size={15} /></li>
                  <li><Route size={17} /><span><strong>账户资源范围</strong><small>只包含上面填写的 Cloudflare 账户</small></span><KeyRound size={15} /></li>
                </ul>
              </section>

              <div className="security-note">
                <LockKeyhole size={17} />
                <p>API Token 通过服务端校验后使用 AES-256-GCM 加密保存；浏览器只接收 HttpOnly 会话标识。</p>
              </div>

              <div className="connect-actions">
                <span>连接成功后即可进入服务配置</span>
                <button className="button button--primary" type="submit" disabled={!canConnect || busy}>
                  {busy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}
                  验证并继续
                </button>
              </div>
            </form>
            <div className="connect-restore">
              <div><strong>已经有控制台备份？</strong><p>使用备份密码恢复 Cloudflare 连接和服务配置。</p></div>
              <button className="button button--secondary" type="button" onClick={() => setRestoringBackup(true)}>
                <ArchiveRestore size={15} /> 恢复备份
              </button>
            </div>
          </div>
        </main>
      </div>
      <BackupDialog
        csrfToken={bootstrap.csrfToken}
        mode={restoringBackup ? 'restore' : undefined}
        onClose={() => setRestoringBackup(false)}
        onRestored={() => window.location.reload()}
      />
    </div>
  );
}
