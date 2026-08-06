import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Cloud,
  Code2,
  Eye,
  EyeOff,
  ExternalLink,
  FileCheck2,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  Rocket,
  ServerCog,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost, ConsoleApiError } from '../lib/api';
import type {
  BootstrapResponse,
  PersistedConfigurationState
} from '../../../application/console/contracts';
import { defaultConfig } from '../../../domain/configuration/defaults';
import type { UglinkConfig } from '../../../domain/configuration/model';
import {
  configsEqual,
  normalizeHostname,
  prettyConfig,
  validateUglinkConfig,
  type ValidationCheck,
  type ValidationResponse
} from '../../../domain/configuration/validation';
import type {
  DeploymentJob,
  DeploymentMode,
  DiagnosticLogResponse,
  ServiceHealthResponse
} from '../../../domain/deployment/model';
import { Brand } from './Brand';
import { DiagnosticsPage } from './DiagnosticsPage';
import { DataManagement } from './DataManagement';
import { ProviderBadge } from './ProviderBadge';
import { Toggle } from './Toggle';

type Section = 'services' | 'diagnostics' | 'security';

interface DashboardProps {
  bootstrap: BootstrapResponse;
  onConnectionReset: () => void;
}

interface CloudConfigurationDialogProps {
  workerName: string;
  serviceCount: number;
  busy?: 'import' | 'dismiss';
  error?: string;
  onImport: () => void;
  onDismiss: () => void;
}

const SECTION_COPY: Record<Section, { label: string; description: string }> = {
  services: { label: '服务配置', description: '管理 NAS 连接与访问域名' },
  diagnostics: { label: '故障诊断', description: '查看服务检查与部署错误' },
  security: { label: '权限与安全', description: '管理 API Token 与数据安全' }
};

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    return error.detail ? `${error.message}（${error.detail}）` : error.message;
  }
  return error instanceof Error ? error.message : '发生了未知错误。';
}

function CloudConfigurationDialog({
  workerName,
  serviceCount,
  busy,
  error,
  onImport,
  onDismiss
}: CloudConfigurationDialogProps) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-config-dialog-title">
        <div className="dialog__heading dialog__heading--decision">
          <span className="security-card__icon security-card__icon--orange"><Cloud size={21} /></span>
          <div>
            <h2 id="cloud-config-dialog-title">检测到已有配置</h2>
            <p>Cloudflare 中的 {workerName} 保存了已发布配置，是否导入当前控制台？</p>
          </div>
        </div>
        <div className="dialog__form">
          <div className="cloud-config-summary">
            <Cloud size={19} />
            <div><strong>{serviceCount} 个已发布服务</strong><p>导入后将替换当前已发布配置和本地草稿。</p></div>
          </div>
          <p className="dialog__note">API Token 和 NAS 密码不会从云端配置读取。</p>
          {error && <p className="form-error">{error}</p>}
          <div className="dialog__actions">
            <button className="button button--secondary" type="button" onClick={onDismiss} disabled={Boolean(busy)}>
              {busy === 'dismiss' && <LoaderCircle className="spin" size={16} />} 暂不导入
            </button>
            <button className="button button--primary" type="button" onClick={onImport} disabled={Boolean(busy)}>
              {busy === 'import' ? <LoaderCircle className="spin" size={16} /> : <Cloud size={16} />} 导入配置
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function CheckIcon({ check }: { check: ValidationCheck }) {
  if (check.level === 'pass') return <CheckCircle2 className="check-icon check-icon--pass" size={18} />;
  if (check.level === 'warning') return <TriangleAlert className="check-icon check-icon--warning" size={18} />;
  if (check.level === 'error') return <AlertCircle className="check-icon check-icon--error" size={18} />;
  return <Circle className="check-icon" size={18} />;
}

interface ConfigEditorProps {
  config: UglinkConfig;
  deployedConfig: UglinkConfig;
  deploymentConfig?: UglinkConfig;
  job?: DeploymentJob;
  publishedHealth?: ServiceHealthResponse;
  deploying: boolean;
  checkingHealth: boolean;
  healthCheckError?: string;
  password: string;
  setPassword: (password: string) => void;
  onChange: (config: UglinkConfig) => void;
  onInspectService: (hostname: string) => void;
}

type ServiceStatusTone = 'success' | 'progress' | 'pending' | 'error' | 'neutral';

interface ServiceStatusValue {
  label: string;
  detail: string;
  tone: ServiceStatusTone;
}

function servicesEqual(
  left: UglinkConfig['services'][number] | undefined,
  right: UglinkConfig['services'][number] | undefined
): boolean {
  return Boolean(left && right
    && left.name === right.name
    && left.hostname === right.hostname
    && left.port === right.port
    && (left.enabled !== false) === (right.enabled !== false));
}

function resolveServiceStatus(
  service: UglinkConfig['services'][number],
  index: number,
  deployedConfig: UglinkConfig,
  deploymentConfig: UglinkConfig | undefined,
  deploymentByHostname: Map<string, DeploymentJob['services'][number]>,
  publishedByHostname: Map<string, ServiceHealthResponse['services'][number]>,
  job: DeploymentJob | undefined,
  deploying: boolean,
  checkingHealth: boolean,
  healthCheckError: string | undefined
): ServiceStatusValue {
  const matchesDeployed = servicesEqual(service, deployedConfig.services[index]);
  const matchesDeployment = servicesEqual(service, deploymentConfig?.services[index]);

  if (deploying && matchesDeployment) {
    return { label: '发布中', detail: '正在发布这项服务。', tone: 'progress' };
  }

  if (service.enabled === false && matchesDeployed) {
    return { label: '已停用', detail: '这项服务未启用。', tone: 'neutral' };
  }

  if (checkingHealth && matchesDeployed) {
    return { label: '检查中', detail: '正在重新检查服务入口。', tone: 'progress' };
  }

  if (healthCheckError && matchesDeployed) {
    return { label: '检查失败', detail: healthCheckError, tone: 'error' };
  }

  if (job && matchesDeployment) {
    if (service.enabled === false) {
      return { label: '已停用', detail: '这项服务未启用。', tone: 'neutral' };
    }
    const result = deploymentByHostname.get(service.hostname.trim().toLowerCase());
    if (result?.healthy) {
      return { label: '运行正常', detail: result.detail, tone: 'success' };
    }
    if (job.phase === 'failed' || job.phase === 'healthy') {
      return {
        label: result ? compactFailureLabel(result) : '发布失败',
        detail: result?.detail || job.message,
        tone: 'error'
      };
    }
    if (job.phase === 'checking') {
      return { label: '生效中', detail: result?.detail || job.message, tone: 'progress' };
    }
    return { label: '发布中', detail: result?.detail || job.message, tone: 'progress' };
  }

  if (!matchesDeployed) {
    return { label: '待发布', detail: '当前修改尚未发布。', tone: 'pending' };
  }
  if (service.enabled === false) {
    return { label: '已停用', detail: '这项服务未启用。', tone: 'neutral' };
  }
  const publishedResult = publishedByHostname.get(service.hostname.trim().toLowerCase());
  if (publishedResult?.healthy) {
    return { label: '运行正常', detail: publishedResult.detail, tone: 'success' };
  }
  return {
    label: publishedResult ? compactFailureLabel(publishedResult) : '检查失败',
    detail: publishedResult?.detail || '服务端没有返回这项服务的检查结果。',
    tone: 'error'
  };
}

function compactFailureLabel(result: ServiceHealthResponse['services'][number]): string {
  const labels: Record<string, string> = {
    invalid_credentials: '密码错误',
    account_locked: '账号锁定',
    login_source_blocked: '登录受限',
    account_blocked: '账号停用',
    password_expired: '密码过期',
    authentication_failed: '认证失败',
    proxy_session_expired: '会话失效',
    proxy_session_unavailable: '会话异常',
    service_entry_timeout: '入口超时',
    service_entry_unreachable: '入口断开',
    worker_health_invalid_response: '响应异常',
    worker_hostname_unconfigured: '域名未配置'
  };
  if (result.code && labels[result.code]) return labels[result.code]!;
  if (result.httpStatus !== undefined) return `HTTP ${result.httpStatus}`;
  return '异常';
}

function serviceAccessAddress(hostname: string): string | undefined {
  try {
    return `https://${normalizeHostname(hostname)}`;
  } catch {
    return undefined;
  }
}

function ServiceStatus({ value, onInspect }: { value: ServiceStatusValue; onInspect?: () => void }) {
  const Icon = value.tone === 'success'
    ? CheckCircle2
    : value.tone === 'error'
      ? AlertCircle
      : value.tone === 'progress'
        ? LoaderCircle
        : Circle;
  const content = (
    <>
      <Icon className={value.tone === 'progress' ? 'spin' : undefined} size={14} />
      {value.label}
    </>
  );
  if (value.tone === 'error' && onInspect) {
    return (
      <button
        className={`service-status service-status--${value.tone} service-status--interactive`}
        type="button"
        title={`${value.detail}；点击查看故障详情`}
        aria-label={`${value.label}：${value.detail}。查看故障详情`}
        onClick={onInspect}
      >
        {content}
      </button>
    );
  }
  return (
    <span
      className={`service-status service-status--${value.tone}`}
      title={value.detail}
      aria-label={`${value.label}：${value.detail}`}
    >
      {content}
    </span>
  );
}

function ConfigEditor({
  config,
  deployedConfig,
  deploymentConfig,
  job,
  publishedHealth,
  deploying,
  checkingHealth,
  healthCheckError,
  password,
  setPassword,
  onChange,
  onInspectService
}: ConfigEditorProps) {
  const [pendingRemoval, setPendingRemoval] = useState<number>();
  const [passwordVisible, setPasswordVisible] = useState(false);
  const deploymentByHostname = useMemo(() => new Map(
    (job?.services || []).map((service) => [service.hostname.toLowerCase(), service])
  ), [job]);
  const publishedByHostname = useMemo(() => new Map(
    (publishedHealth?.services || []).map((service) => [service.hostname.toLowerCase(), service])
  ), [publishedHealth]);

  const updateService = (index: number, patch: Partial<UglinkConfig['services'][number]>) => {
    onChange({
      ...config,
      services: config.services.map((service, serviceIndex) => (
        serviceIndex === index ? { ...service, ...patch } : service
      ))
    });
  };

  const addService = () => {
    const nextNumber = config.services.length + 1;
    onChange({
      ...config,
      services: [...config.services, {
        name: `service-${nextNumber}`,
        hostname: '',
        port: 80,
        enabled: true
      }]
    });
  };

  const removeService = (index: number) => {
    if (pendingRemoval !== index) {
      setPendingRemoval(index);
      return;
    }
    onChange({ ...config, services: config.services.filter((_, serviceIndex) => serviceIndex !== index) });
    setPendingRemoval(undefined);
  };

  return (
    <div className="editor-stack">
      <section className="panel config-panel">
        <div className="panel__heading">
          <div>
            <p className="eyebrow">NAS 连接</p>
            <h2>NAS 连接信息</h2>
            <p>用于连接绿联云中的 NAS 服务。</p>
          </div>
            <span className="panel__meta"><LockKeyhole size={15} /> 密码不会保存在本机</span>
        </div>
        <div className="form-grid">
          <label className="field field--wide">
            <span>UGREENlink ID <em>UGLINK_ID</em></span>
            <input
              value={config.uglink.id}
              onChange={(event) => onChange({
                ...config,
                uglink: { ...config.uglink, id: event.target.value }
              })}
              placeholder="例如 northedge"
              autoComplete="off"
            />
            <small>即 https://ug.link/ 后的设备 ID；运行时会自动发现当前中继地址。</small>
          </label>
          <label className="field">
            <span>登录用户名 <em>USERNAME</em></span>
            <input
              value={config.uglink.username}
              onChange={(event) => onChange({
                ...config,
                uglink: { ...config.uglink, username: event.target.value }
              })}
              placeholder="NAS 登录用户名"
              autoComplete="username"
            />
          </label>
          <label className="field">
            <span>登录密码 <em>PASSWORD</em></span>
            <div className="password-field">
              <input
                id="nas-password"
                type={passwordVisible ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="首次发布时填写"
                autoComplete="new-password"
              />
              <button
                className="password-field__toggle"
                type="button"
                aria-label={passwordVisible ? '隐藏密码' : '显示密码'}
                aria-pressed={passwordVisible}
                aria-controls="nas-password"
                title={passwordVisible ? '隐藏密码' : '显示密码'}
                onClick={(event) => {
                  event.preventDefault();
                  setPasswordVisible((visible) => !visible);
                }}
              >
                {passwordVisible
                  ? <EyeOff size={17} aria-hidden="true" />
                  : <Eye size={17} aria-hidden="true" />}
              </button>
            </div>
            <small>首次发布时必填；以后留空则保留当前密码。</small>
          </label>
        </div>
      </section>

      <section className="panel services-panel">
        <div className="panel__heading panel__heading--row">
          <div>
            <p className="eyebrow">访问映射</p>
            <h2>反向代理服务</h2>
            <p>一项服务对应一个访问域名和一个 NAS 端口，可同时配置多项服务。</p>
          </div>
          <button className="button button--secondary" type="button" onClick={addService}>
            <Plus size={16} /> 添加服务
          </button>
        </div>

        <div className="service-table" role="table" aria-label="反向代理服务列表">
          <div className="service-table__head" role="row">
            <span>服务名</span><span>完整域名</span><span>访问地址</span><span>NAS 端口</span><span>状态</span><span>启用</span><span>操作</span>
          </div>
          {config.services.length === 0 && (
            <div className="empty-row"><ServerCog size={20} /><span>还没有服务。添加一行后即可配置域名和端口。</span></div>
          )}
          {config.services.map((service, index) => (
            <div className="service-table__row" role="row" key={index}>
              <label data-label="服务名">
                <input
                  value={service.name}
                  onChange={(event) => updateService(index, { name: event.target.value })}
                  aria-label={`第 ${index + 1} 个服务名`}
                />
              </label>
              <label data-label="完整域名">
                <div className="domain-input">
                  <Cloud size={15} />
                  <input
                    value={service.hostname}
                    onChange={(event) => updateService(index, { hostname: event.target.value.toLowerCase() })}
                    aria-label={`第 ${index + 1} 个服务域名`}
                    placeholder="sub.example.com"
                  />
                </div>
              </label>
              <div data-label="访问地址" className="service-table__address">
                {serviceAccessAddress(service.hostname) ? (
                  <a
                    href={serviceAccessAddress(service.hostname)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={serviceAccessAddress(service.hostname)}
                  >
                    <ExternalLink size={13} aria-hidden="true" />
                    <span>{serviceAccessAddress(service.hostname)}</span>
                  </a>
                ) : <span>未配置</span>}
              </div>
              <label data-label="NAS 端口">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={service.port}
                  onChange={(event) => updateService(index, { port: Number(event.target.value) })}
                  aria-label={`第 ${index + 1} 个 NAS 端口`}
                />
              </label>
              <div data-label="状态" className="service-table__status">
                <ServiceStatus
                  value={resolveServiceStatus(
                    service,
                    index,
                    deployedConfig,
                    deploymentConfig,
                    deploymentByHostname,
                    publishedByHostname,
                    job,
                    deploying,
                    checkingHealth,
                    healthCheckError
                  )}
                  onInspect={() => onInspectService(service.hostname)}
                />
              </div>
              <div data-label="启用" className="service-table__toggle">
                <Toggle
                  checked={service.enabled !== false}
                  onChange={(enabled) => updateService(index, { enabled })}
                  label={`${service.name || `服务 ${index + 1}`}启用状态`}
                />
              </div>
              <div data-label="操作" className="service-table__actions">
                <button
                  className={`icon-button${pendingRemoval === index ? ' icon-button--confirm' : ''}`}
                  type="button"
                  title={pendingRemoval === index ? '再次点击确认删除' : '删除服务'}
                  aria-label={pendingRemoval === index ? '再次点击确认删除服务' : '删除服务'}
                  onClick={() => removeService(index)}
                  onBlur={() => setPendingRemoval(undefined)}
                >
                  {pendingRemoval === index ? <X size={16} /> : <Trash2 size={16} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
}

interface InspectorProps {
  validation: ValidationResponse;
  config: UglinkConfig;
  job?: DeploymentJob;
}

function Inspector({ validation, config, job }: InspectorProps) {
  return (
    <aside className="inspector">
      <section className="inspector__section">
        <div className="inspector__heading">
          <div><p className="eyebrow">配置检查</p><h3>检查结果</h3></div>
          <span className={`score-badge${validation.valid ? ' score-badge--ok' : ''}`}>
            {validation.checks.filter((check) => check.level === 'pass').length}/{validation.checks.length}
          </span>
        </div>
        <div className="check-list">
          {validation.checks.map((check) => (
            <div className="check-row" key={check.id}>
              <CheckIcon check={check} />
              <div><strong>{check.label}</strong><p>{check.detail}</p></div>
            </div>
          ))}
        </div>
      </section>

      <section className="inspector__section">
        <details className="config-preview">
          <summary><span><Code2 size={16} /> 待发布配置</span><ChevronRight size={16} /></summary>
          <pre>{prettyConfig(config)}</pre>
        </details>
      </section>

      <section className="inspector__section inspector__section--timeline">
        <div className="inspector__heading">
          <div><p className="eyebrow">发布流程</p><h3>发布进度</h3></div>
          {job && <span className={`phase-pill phase-pill--${job.phase}`}>{job.phase}</span>}
        </div>
        {job ? (
          <ol className="timeline">
            {job.timeline.map((entry, index) => (
              <li key={`${entry.phase}-${index}`} className={index === job.timeline.length - 1 ? 'is-current' : 'is-complete'}>
                <span className="timeline__dot">{index < job.timeline.length - 1 ? <Check size={11} /> : <Circle size={9} fill="currentColor" />}</span>
                <div><strong>{entry.label}</strong><p>{entry.detail}</p><time>{formatTime(entry.at)}</time></div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="timeline-empty">
            <Rocket size={22} />
            <p><strong>尚未发布</strong><br />发布后，这里会显示各阶段的处理状态。</p>
          </div>
        )}
      </section>
    </aside>
  );
}

interface SecurityPageProps {
  bootstrap: BootstrapResponse;
  config: UglinkConfig;
  resetting: boolean;
  onReset: () => void;
  onRestored: (bootstrap: BootstrapResponse) => void;
}

function SecurityPage({
  bootstrap,
  config,
  resetting,
  onReset,
  onRestored
}: SecurityPageProps) {
  return (
    <div className="section-page">
      <div className="page-heading">
        <div><p className="eyebrow">凭据管理</p><h1>权限与安全</h1><p>查看 Cloudflare 发布目标与 API Token 的本地保护状态。</p></div>
      </div>
      <div className="security-grid">
        <section className="panel security-card">
          <span className="security-card__icon security-card__icon--orange"><Cloud size={21} /></span>
          <div><h2>Cloudflare 连接</h2><p>当前 Account ID 尾号 <strong>···{bootstrap.target?.accountIdSuffix}</strong>，用于发布服务并管理访问域名。</p></div>
          <ProviderBadge status={bootstrap.providers.cloudflare} full />
          <div className="security-card__actions">
            <button className="button button--secondary" type="button" disabled={resetting} onClick={onReset}>
              {resetting ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} 重新配置 API Token
            </button>
          </div>
        </section>
        <section className="panel security-card">
          <span className="security-card__icon"><HardDrive size={21} /></span>
          <div><h2>持久化配置</h2><p>UGREENlink ID、NAS 登录用户名与服务映射保存在服务器数据目录，不再依赖当前浏览器。</p></div>
          <span className="status-chip status-chip--success"><Check size={12} /> 已安全保存</span>
        </section>
        <section className="panel security-card security-card--wide">
          <span className="security-card__icon"><ShieldCheck size={21} /></span>
          <div>
            <h2>API Token 保护</h2>
            <p>API Token 由服务端加密保存，浏览器仅持有 HttpOnly 会话标识；重新配置会清除当前服务端凭据。</p>
          </div>
          <span className="status-chip status-chip--success"><Check size={12} /> 已启用</span>
        </section>
        <DataManagement
          csrfToken={bootstrap.csrfToken}
          config={config}
          onRestored={onRestored}
        />
      </div>
    </div>
  );
}

export function Dashboard({ bootstrap, onConnectionReset }: DashboardProps) {
  const target = bootstrap.target!;
  const initialConfiguration = useMemo(() => {
    const deployed = bootstrap.configuration?.deployed || defaultConfig();
    return {
      deployed,
      config: bootstrap.configuration?.draft || deployed
    };
  }, [bootstrap.configuration]);
  const initialHasPublishedServices = initialConfiguration.deployed.services.some((service) => service.enabled !== false);
  const [section, setSection] = useState<Section>('services');
  const [config, setConfig] = useState<UglinkConfig>(() => initialConfiguration.config);
  const [savedConfig, setSavedConfig] = useState<UglinkConfig>(() => initialConfiguration.deployed);
  const [password, setPassword] = useState('');
  const [validation, setValidation] = useState<ValidationResponse>(() => validateUglinkConfig(initialConfiguration.config));
  const [job, setJob] = useState<DeploymentJob>();
  const [deploymentConfig, setDeploymentConfig] = useState<UglinkConfig>();
  const [publishedHealth, setPublishedHealth] = useState<ServiceHealthResponse>();
  const [checkingHealth, setCheckingHealth] = useState(initialHasPublishedServices);
  const [healthCheckError, setHealthCheckError] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<DiagnosticLogResponse>({ entries: [] });
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string>();
  const [focusedHostname, setFocusedHostname] = useState<string>();
  const [busy, setBusy] = useState<'validate' | 'deploy'>();
  const [resettingConnection, setResettingConnection] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string }>();
  const [cloudConfiguration, setCloudConfiguration] = useState(bootstrap.cloudConfiguration);
  const [cloudConfigurationBusy, setCloudConfigurationBusy] = useState<'import' | 'dismiss'>();
  const [cloudConfigurationError, setCloudConfigurationError] = useState<string>();
  const healthRequestVersion = useRef(0);
  const autosaveReady = useRef(false);
  const autosaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const hasPublishedServices = savedConfig.services.some((service) => service.enabled !== false);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [section]);

  useEffect(() => {
    if (!autosaveReady.current) {
      autosaveReady.current = true;
      return undefined;
    }
    const timer = window.setTimeout(() => {
      autosaveQueue.current = autosaveQueue.current
        .catch(() => undefined)
        .then(() => apiPost<PersistedConfigurationState>(
          '/api/configuration/draft',
          bootstrap.csrfToken,
          { config }
        ))
        .catch((error) => setNotice({
          type: 'error',
          message: `配置自动保存失败：${errorMessage(error)}`
        }));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [bootstrap.csrfToken, config]);

  const loadDiagnostics = useCallback(async (showLoading = true) => {
    if (showLoading) setDiagnosticsLoading(true);
    setDiagnosticsError(undefined);
    try {
      setDiagnostics(await apiGet<DiagnosticLogResponse>('/api/diagnostics'));
    } catch (error) {
      setDiagnosticsError(errorMessage(error));
    } finally {
      if (showLoading) setDiagnosticsLoading(false);
    }
  }, []);

  const checkServices = useCallback(async (publishedConfig: UglinkConfig) => {
    const requestVersion = ++healthRequestVersion.current;
    setCheckingHealth(true);
    setHealthCheckError(undefined);
    try {
      const health = await apiPost<ServiceHealthResponse>('/api/services/health', bootstrap.csrfToken, {
        config: publishedConfig
      });
      if (healthRequestVersion.current === requestVersion) setPublishedHealth(health);
      return health;
    } catch (error) {
      if (healthRequestVersion.current === requestVersion) setHealthCheckError(errorMessage(error));
      return undefined;
    } finally {
      if (healthRequestVersion.current === requestVersion) setCheckingHealth(false);
      void loadDiagnostics(false);
    }
  }, [bootstrap.csrfToken, loadDiagnostics]);

  useEffect(() => {
    if (!hasPublishedServices) {
      setCheckingHealth(false);
      return;
    }
    void checkServices(savedConfig);
  }, [checkServices, hasPublishedServices, savedConfig]);

  useEffect(() => {
    if (section === 'diagnostics') void loadDiagnostics();
  }, [loadDiagnostics, section]);

  useEffect(() => {
    if (!job || job.phase === 'healthy' || job.phase === 'failed') return undefined;
    let active = true;
    const timer = window.setTimeout(() => {
      void apiGet<DeploymentJob>(`/api/deployments/${job.id}`)
        .then((nextJob) => active && setJob(nextJob))
        .catch((error) => active && setNotice({ type: 'error', message: errorMessage(error) }));
    }, 2_500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [job]);

  useEffect(() => {
    if (!job) return;
    setPublishedHealth({ checkedAt: job.updatedAt, services: job.services });
    if (job.phase === 'healthy' || job.phase === 'failed') void loadDiagnostics(false);
  }, [job, loadDiagnostics]);

  const localValidation = useMemo(
    () => validateUglinkConfig(config),
    [config]
  );
  const visibleValidation = validation || localValidation;
  const hasConfigChanges = !configsEqual(config, savedConfig);
  const hasChanges = hasConfigChanges || password.length > 0;

  const changeConfig = (nextConfig: UglinkConfig) => {
    setConfig(nextConfig);
    setValidation(validateUglinkConfig(nextConfig));
  };

  const validate = async (): Promise<ValidationResponse | undefined> => {
    setBusy('validate');
    setNotice(undefined);
    try {
      const result = await apiPost<ValidationResponse>('/api/validate', bootstrap.csrfToken, { config });
      setValidation(result);
      setNotice({
        type: result.valid ? 'success' : 'error',
        message: result.valid ? '配置已通过服务器校验。' : '配置仍有需要修正的项目。'
      });
      return result;
    } catch (error) {
      setNotice({ type: 'error', message: errorMessage(error) });
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  const deployConfiguration = async (nextConfig: UglinkConfig, mode: DeploymentMode) => {
    if (mode === 'publish' && !hasChanges) return;
    healthRequestVersion.current += 1;
    setCheckingHealth(false);
    setHealthCheckError(undefined);
    setBusy('deploy');
    setJob(undefined);
    setDeploymentConfig(nextConfig);
    setNotice(undefined);
    try {
      const checked = await apiPost<ValidationResponse>('/api/validate', bootstrap.csrfToken, { config: nextConfig });
      setValidation(checked);
      if (!checked.valid) {
        setNotice({ type: 'error', message: '配置检查未通过，尚未发布任何修改。' });
        return;
      }
      const created = await apiPost<DeploymentJob>('/api/deploy', bootstrap.csrfToken, {
        config: nextConfig,
        mode,
        ...(mode === 'publish' && password ? { password } : {})
      });
      setJob(created);
      void loadDiagnostics(false);
      if (created.phase === 'failed') {
        setNotice({ type: 'error', message: created.message });
      } else {
        if (mode === 'publish') {
          setSavedConfig(nextConfig);
          setPassword('');
        }
        setNotice({ type: 'success', message: mode === 'overwrite' ? '覆盖部署已开始。' : '发布已开始。' });
      }
    } catch (error) {
      setNotice({ type: 'error', message: errorMessage(error) });
    } finally {
      setBusy(undefined);
    }
  };

  const inspectService = (hostname: string) => {
    setFocusedHostname(hostname);
    setSection('diagnostics');
  };

  const redeploy = () => {
    const confirmed = window.confirm('将使用当前已发布配置覆盖现有受管 Worker。是否继续？');
    if (confirmed) void deployConfiguration(savedConfig, 'overwrite');
  };

  const reset = () => {
    setConfig(savedConfig);
    setPassword('');
    setValidation(validateUglinkConfig(savedConfig));
    setNotice({ type: 'success', message: '未发布的本地修改已撤销。' });
  };

  const resetConnection = async () => {
    setResettingConnection(true);
    setNotice(undefined);
    try {
      await apiPost<{ ok: true }>('/api/connections/cloudflare/reset', bootstrap.csrfToken);
      onConnectionReset();
    } catch (error) {
      setNotice({ type: 'error', message: errorMessage(error) });
      setResettingConnection(false);
    }
  };

  const importCloudConfiguration = async () => {
    setCloudConfigurationBusy('import');
    setCloudConfigurationError(undefined);
    try {
      const imported = await apiPost<BootstrapResponse>(
        '/api/configuration/cloud/import',
        bootstrap.csrfToken
      );
      const snapshot = imported.configuration;
      if (!snapshot) throw new Error('Cloudflare 配置导入后没有返回配置。');
      setSavedConfig(snapshot.deployed);
      setConfig(snapshot.draft || snapshot.deployed);
      setValidation(validateUglinkConfig(snapshot.draft || snapshot.deployed));
      setCloudConfiguration(undefined);
      setNotice({ type: 'success', message: 'Cloudflare 已发布配置已导入。' });
    } catch (error) {
      setCloudConfigurationError(errorMessage(error));
    } finally {
      setCloudConfigurationBusy(undefined);
    }
  };

  const dismissCloudConfiguration = async () => {
    setCloudConfigurationBusy('dismiss');
    setCloudConfigurationError(undefined);
    try {
      await apiPost<{ ok: true }>('/api/configuration/cloud/dismiss', bootstrap.csrfToken);
      setCloudConfiguration(undefined);
      setNotice({ type: 'success', message: '已保留当前控制台配置。' });
    } catch (error) {
      setCloudConfigurationError(errorMessage(error));
    } finally {
      setCloudConfigurationBusy(undefined);
    }
  };

  const navItems: Array<{ id: Section; icon: typeof ServerCog }> = [
    { id: 'services', icon: ServerCog },
    { id: 'diagnostics', icon: TriangleAlert },
    { id: 'security', icon: ShieldCheck }
  ];
  const currentErrorCount = (publishedHealth?.services.filter((service) => !service.healthy).length || 0)
    + (healthCheckError ? 1 : 0);

  return (
    <div className="app-shell">
      <header className="app-header">
        <Brand compact />
        <div className="app-header__context">
          <span>{target.accountName}</span><ChevronRight size={14} /><strong>{target.workerName}</strong>
        </div>
        <div className="app-header__providers">
          <ProviderBadge status={bootstrap.providers.cloudflare} />
        </div>
      </header>

      <nav className="mobile-section-nav" aria-label="控制台分区">
        {navItems.map(({ id }) => (
          <button key={id} type="button" className={section === id ? 'is-active' : ''} onClick={() => setSection(id)}>
            {SECTION_COPY[id].label}
            {id === 'diagnostics' && currentErrorCount > 0 && <em className="nav-alert-count">{currentErrorCount}</em>}
          </button>
        ))}
      </nav>

      <div className="app-layout">
        <aside className="app-sidebar">
          <nav aria-label="控制台导航">
            {navItems.map(({ id, icon: Icon }) => (
              <button key={id} type="button" className={section === id ? 'is-active' : ''} onClick={() => setSection(id)}>
                <Icon size={18} />
                <span>{SECTION_COPY[id].label}{id === 'diagnostics' && currentErrorCount > 0 && <em className="nav-alert-count">{currentErrorCount}</em>}</span>
                {section === id && <ChevronRight size={15} />}
              </button>
            ))}
          </nav>
          <div className="sidebar-target">
            <p className="eyebrow">发布目标</p>
            <div><span className="health-dot health-dot--ok" /><strong>{target.workerName}</strong></div>
            <small>Account ID ···{target.accountIdSuffix}</small>
          </div>
        </aside>

        <main className={`app-main${section === 'services' ? ' app-main--editor' : ''}`}>
          {section === 'services' ? (
            <>
              <div className="editor-main">
                <div className="page-heading page-heading--compact">
                  <div>
                    <p className="eyebrow">本地配置</p>
                    <h1>服务配置</h1>
                    <p>在一处管理多个访问域名与 NAS 端口的映射。</p>
                  </div>
                  <span className={`dirty-state${hasChanges ? ' dirty-state--changed' : ''}`}>
                    <span />{hasChanges ? '有未发布修改' : '当前无修改'}
                  </span>
                </div>
                <ConfigEditor
                  config={config}
                  deployedConfig={savedConfig}
                  deploymentConfig={deploymentConfig}
                  job={job}
                  publishedHealth={publishedHealth}
                  deploying={busy === 'deploy'}
                  checkingHealth={checkingHealth}
                  healthCheckError={healthCheckError}
                  password={password}
                  setPassword={setPassword}
                  onChange={changeConfig}
                  onInspectService={inspectService}
                />
              </div>
              <Inspector validation={visibleValidation} config={config} job={job} />
            </>
          ) : section === 'diagnostics' ? (
            <DiagnosticsPage
              entries={diagnostics.entries}
              health={publishedHealth}
              healthError={healthCheckError || diagnosticsError}
              focusedHostname={focusedHostname}
              loading={diagnosticsLoading}
              checking={checkingHealth}
              deploying={busy === 'deploy'}
              canCheck={hasPublishedServices}
              job={job}
              onClearFocus={() => setFocusedHostname(undefined)}
              onCheck={() => void checkServices(savedConfig)}
              onRedeploy={redeploy}
            />
          ) : section === 'security' ? (
            <SecurityPage
              bootstrap={bootstrap}
              config={config}
              resetting={resettingConnection}
              onReset={() => void resetConnection()}
              onRestored={() => window.location.reload()}
            />
          ) : null}
        </main>
      </div>

      {section === 'services' && (
        <footer className="action-bar">
          <div className="action-bar__status">
            {visibleValidation.valid ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
            <span><strong>{visibleValidation.valid ? '配置可以发布' : '配置需要修正'}</strong><small>{hasChanges ? '修改将在发布后生效' : '当前没有待发布修改'}</small></span>
          </div>
          <div className="action-bar__buttons">
            <button className="button button--ghost" type="button" onClick={reset} disabled={!hasChanges || Boolean(busy)}><RefreshCw size={15} /> 撤销</button>
            <button className="button button--secondary" type="button" onClick={() => void validate()} disabled={Boolean(busy)}>
              {busy === 'validate' ? <LoaderCircle className="spin" size={16} /> : <FileCheck2 size={16} />} 检查配置
            </button>
            <button className="button button--primary" type="button" onClick={() => void deployConfiguration(config, 'publish')} disabled={!hasChanges || !localValidation.valid || Boolean(busy)}>
              {busy === 'deploy' ? <LoaderCircle className="spin" size={16} /> : <Rocket size={16} />} 发布更改
            </button>
          </div>
        </footer>
      )}

      {cloudConfiguration && (
        <CloudConfigurationDialog
          workerName={target.workerName}
          serviceCount={cloudConfiguration.serviceCount}
          busy={cloudConfigurationBusy}
          error={cloudConfigurationError}
          onImport={() => void importCloudConfiguration()}
          onDismiss={() => void dismissCloudConfiguration()}
        />
      )}

      {notice && (
        <div
          className={`toast toast--${notice.type}`}
          role="status"
        >
          {notice.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span>{notice.message}</span>
          <button type="button" onClick={() => setNotice(undefined)} aria-label="关闭提示"><X size={15} /></button>
        </div>
      )}
    </div>
  );
}
