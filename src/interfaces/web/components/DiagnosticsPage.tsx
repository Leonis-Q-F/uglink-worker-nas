import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Cloud,
  LoaderCircle,
  RefreshCw,
  Rocket,
  ServerCog,
  TriangleAlert
} from 'lucide-react';
import { useMemo } from 'react';
import type {
  DeploymentJob,
  DiagnosticEntry,
  DiagnosticStage,
  ServiceHealthResponse
} from '../../../domain/deployment/model';

interface DiagnosticsPageProps {
  entries: DiagnosticEntry[];
  health?: ServiceHealthResponse;
  healthError?: string;
  focusedHostname?: string;
  loading: boolean;
  checking: boolean;
  deploying: boolean;
  canCheck: boolean;
  job?: DeploymentJob;
  onClearFocus: () => void;
  onCheck: () => void;
  onRedeploy: () => void;
}

const STAGE_LABELS: Record<DiagnosticStage, string> = {
  service_entry: '服务入口',
  worker_configuration: 'Worker 配置',
  nas_backend: 'NAS 后端',
  configuration: '配置检查',
  cloudflare_access: 'Cloudflare 授权',
  session_cache: '会话缓存',
  worker_upload: 'Worker 发布',
  credential: '登录凭据',
  domain_routing: '域名路由',
  service_check: '服务检查'
};

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(value));
}

function stageLabel(stage?: DiagnosticStage): string {
  return stage ? STAGE_LABELS[stage] : '服务检查';
}

function matchesHostname(entry: DiagnosticEntry, hostname?: string): boolean {
  return Boolean(hostname && entry.service?.hostname.toLowerCase() === hostname.toLowerCase());
}

export function DiagnosticsPage({
  entries,
  health,
  healthError,
  focusedHostname,
  loading,
  checking,
  deploying,
  canCheck,
  job,
  onClearFocus,
  onCheck,
  onRedeploy
}: DiagnosticsPageProps) {
  const failures = useMemo(() => (
    (health?.services || [])
      .filter((service) => !service.healthy)
      .sort((left, right) => {
        const leftFocused = left.hostname.toLowerCase() === focusedHostname?.toLowerCase();
        const rightFocused = right.hostname.toLowerCase() === focusedHostname?.toLowerCase();
        return Number(rightFocused) - Number(leftFocused);
      })
  ), [focusedHostname, health]);
  const orderedEntries = useMemo(() => [...entries].sort((left, right) => {
    const focusDifference = Number(matchesHostname(right, focusedHostname))
      - Number(matchesHostname(left, focusedHostname));
    if (focusDifference !== 0) return focusDifference;
    return Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt);
  }), [entries, focusedHostname]);
  const isOverwriteJob = job?.mode === 'overwrite';
  const overwriteFailed = isOverwriteJob && job.phase === 'failed';
  const overwriteComplete = isOverwriteJob && job.phase === 'healthy';

  return (
    <div className="section-page diagnostics-page" data-testid="diagnostics-page">
      <div className="page-heading diagnostics-heading">
        <div>
          <p className="eyebrow">运行诊断</p>
          <h1>故障诊断</h1>
          <p>查看服务检查与部署阶段的具体错误，并使用已发布配置重新检查或覆盖部署。</p>
        </div>
        <div className="diagnostics-actions">
          <button
            className="button button--secondary"
            type="button"
            onClick={onCheck}
            disabled={!canCheck || checking || deploying}
          >
            {checking ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
            {checking ? '正在检查' : '重新检查'}
          </button>
          <button
            className="button button--primary"
            type="button"
            onClick={onRedeploy}
            disabled={!canCheck || checking || deploying}
            title="使用当前已发布配置覆盖现有受管 Worker"
          >
            {deploying ? <LoaderCircle className="spin" size={16} /> : <Rocket size={16} />}
            {deploying ? '正在覆盖' : '覆盖部署'}
          </button>
        </div>
      </div>

      {focusedHostname && (
        <div className="diagnostics-focus" role="status">
          <Cloud size={16} />
          <span>正在优先显示 <strong>{focusedHostname}</strong> 的故障信息</span>
          <button type="button" onClick={onClearFocus}>查看全部</button>
        </div>
      )}

      {isOverwriteJob && (
        <div className={`diagnostics-deployment${overwriteFailed ? ' is-error' : overwriteComplete ? ' is-success' : ''}`}>
          {overwriteFailed
            ? <AlertCircle size={19} />
            : overwriteComplete
              ? <CheckCircle2 size={19} />
              : <LoaderCircle className="spin" size={19} />}
          <div>
            <strong>{overwriteFailed ? '覆盖部署失败' : overwriteComplete ? '覆盖部署完成' : '覆盖部署进行中'}</strong>
            <p>{job.message}</p>
          </div>
          <span>{formatDateTime(job.updatedAt)}</span>
        </div>
      )}

      <section className="panel diagnostics-current" aria-labelledby="current-diagnostics-title">
        <div className="panel__heading panel__heading--row">
          <div>
            <p className="eyebrow">当前状态</p>
            <h2 id="current-diagnostics-title">服务检查结果</h2>
            <p>检查 Worker 服务入口是否可访问，以及域名是否已经绑定到当前服务。</p>
          </div>
          {health?.checkedAt && <span className="diagnostics-checked">检查于 {formatDateTime(health.checkedAt)}</span>}
        </div>

        {healthError && (
          <div className="diagnostics-request-error" role="alert">
            <AlertCircle size={18} />
            <div><strong>检查请求失败</strong><p>{healthError}</p></div>
          </div>
        )}

        {checking ? (
          <div className="diagnostics-empty"><LoaderCircle className="spin" size={24} /><strong>正在检查服务入口与 NAS 后端</strong><p>检查结果会在完成后自动更新。</p></div>
        ) : failures.length > 0 ? (
          <div className="diagnostics-failure-list">
            {failures.map((failure) => (
              <article
                className={`diagnostics-failure${failure.hostname.toLowerCase() === focusedHostname?.toLowerCase() ? ' is-focused' : ''}`}
                key={failure.hostname}
              >
                <span className="diagnostics-failure__icon"><AlertCircle size={18} /></span>
                <div className="diagnostics-failure__body">
                  <div className="diagnostics-failure__title">
                    <strong>{failure.serviceName || failure.hostname}</strong>
                    <span>{stageLabel(failure.stage)}</span>
                  </div>
                  <p>{failure.detail}</p>
                  <div className="diagnostics-meta">
                    <code>{failure.code || 'health_check_failed'}</code>
                    {failure.httpStatus !== undefined && <span>HTTP {failure.httpStatus}</span>}
                    <span>{failure.hostname}</span>
                    {failure.port !== undefined && <span>NAS :{failure.port}</span>}
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : health && !healthError ? (
          <div className="diagnostics-empty diagnostics-empty--success"><CheckCircle2 size={26} /><strong>Worker 入口配置正常</strong><p>最近一次检查确认域名已绑定到当前 Worker。</p></div>
        ) : (
          <div className="diagnostics-empty"><ServerCog size={26} /><strong>等待服务检查</strong><p>点击“重新检查”获取当前运行状态。</p></div>
        )}
      </section>

      <section className="panel diagnostics-history" aria-labelledby="diagnostic-history-title">
        <div className="panel__heading panel__heading--row">
          <div>
            <p className="eyebrow">错误日志</p>
            <h2 id="diagnostic-history-title">诊断记录</h2>
            <p>仅记录错误阶段与响应结果，不记录 API Token、密码或代理 Cookie。</p>
          </div>
          <span className="diagnostics-count">{entries.length} 条</span>
        </div>

        {loading ? (
          <div className="diagnostics-empty"><LoaderCircle className="spin" size={24} /><strong>正在读取诊断记录</strong></div>
        ) : orderedEntries.length === 0 ? (
          <div className="diagnostics-empty"><CheckCircle2 size={26} /><strong>暂无错误记录</strong><p>新的检查或部署错误会显示在这里。</p></div>
        ) : (
          <div className="diagnostics-log-list">
            {orderedEntries.map((entry) => (
              <article
                className={`diagnostics-log${matchesHostname(entry, focusedHostname) ? ' is-focused' : ''}`}
                key={entry.id}
              >
                <span className={`diagnostics-log__marker diagnostics-log__marker--${entry.severity}`}>
                  {entry.severity === 'warning' ? <TriangleAlert size={17} /> : <AlertCircle size={17} />}
                </span>
                <div className="diagnostics-log__body">
                  <div className="diagnostics-log__title">
                    <strong>{entry.summary}</strong>
                    <time>{formatDateTime(entry.lastObservedAt)}</time>
                  </div>
                  {entry.detail && <p>{entry.detail}</p>}
                  <div className="diagnostics-meta">
                    <span>{entry.source === 'deployment' ? '部署' : '健康检查'}</span>
                    <span>{stageLabel(entry.stage)}</span>
                    <code>{entry.code}</code>
                    {entry.httpStatus !== undefined && <span>HTTP {entry.httpStatus}</span>}
                    {entry.service && <span>{entry.service.hostname}{entry.service.port ? ` · NAS :${entry.service.port}` : ''}</span>}
                    {entry.deployment?.mode === 'overwrite' && <span>覆盖部署</span>}
                    {entry.occurrences > 1 && <span>重复 {entry.occurrences} 次</span>}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="diagnostics-note">
        <Circle size={9} fill="currentColor" />
        <span>覆盖部署会替换当前项目管理的同名 Worker；其他来源的同名 Worker 仍会被保护，不会被覆盖。</span>
      </div>
    </div>
  );
}
