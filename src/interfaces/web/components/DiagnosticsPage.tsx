import {
  Check, ChevronRight, Copy, Download, LoaderCircle, Pause, Play, RefreshCw, Rocket, Search, X
} from 'lucide-react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { DeploymentJob, DiagnosticEntry, ServiceHealthResponse } from '../../../domain/deployment/model';
import { useRuntimeLogs } from '../hooks/use-runtime-logs';
import type { LogSource } from '../hooks/use-runtime-logs';
import {
  consoleLogEntries, filterLogEntries, formatLogExport, formatLogTextExport, LOG_BUFFER_LIMIT, mergeLogEntries
} from '../lib/log-viewer';
import type { LogFilters, ViewerLogEntry } from '../lib/log-viewer';

interface DiagnosticsPageProps {
  entries: DiagnosticEntry[];
  health?: ServiceHealthResponse;
  healthError?: string;
  diagnosticsError?: string;
  focusedHostname?: string;
  csrfToken?: string;
  loading: boolean;
  checking: boolean;
  deploying: boolean;
  canCheck: boolean;
  job?: DeploymentJob;
  onClearFocus: () => void;
  onCheck: () => void;
  onRedeploy: () => void;
  onRefresh?: () => void | Promise<void>;
}

const LEVEL_NAMES = { debug: 'DEBUG', info: 'INFO', warning: 'WARN', error: 'ERROR' };
const CONNECTION_NAMES = {
  connecting: '正在连接', connected: '实时连接', paused: '已暂停', error: '等待重连', unavailable: '不可用'
};
const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false
});

const LogRow = memo(function LogRow({ entry }: { entry: ViewerLogEntry }) {
  const date = new Date(entry.timestamp);
  const validDate = Number.isFinite(date.getTime());
  const time = <time dateTime={validDate ? date.toISOString() : undefined} title={validDate ? date.toLocaleString('zh-CN') : '时间不可用'}>
    {validDate ? TIME_FORMAT.format(date) : '—'}
  </time>;

  if (entry.source === 'container') {
    return (
      <div className="runtime-log-row runtime-log-row--container" data-testid="log-row" data-source="container" data-stream={entry.stream}>
        <span className="runtime-log-meta">{time}<span className="runtime-log-channel">{entry.stream || 'process'}</span></span>
        <pre className="runtime-log-message">{entry.message}</pre>
      </div>
    );
  }

  return (
    <details className="runtime-log-row" data-testid="log-row" data-level={entry.level} data-source={entry.source}>
      <summary className="runtime-log-line">
        <span className="runtime-log-meta">{time}<span className={`runtime-log-level runtime-log-level--${entry.level}`}>{LEVEL_NAMES[entry.level]}</span></span>
        <span className="runtime-log-message">{entry.message}{entry.occurrences && entry.occurrences > 1
          ? <span className="runtime-log-occurrences" title="此旧记录在历史存储中已合并，无法还原每次事件的时间">〔历史合并 {entry.occurrences} 次〕</span> : null}</span>
        <ChevronRight className="runtime-log-row__chevron" size={14} aria-hidden="true" />
      </summary>
      <div className="runtime-log-detail"><pre>{JSON.stringify(entry.data ?? entry, null, 2)}</pre></div>
    </details>
  );
});

export function DiagnosticsPage({
  entries, healthError, diagnosticsError, focusedHostname, csrfToken, loading, checking,
  deploying, canCheck, job, onClearFocus, onCheck, onRedeploy, onRefresh
}: DiagnosticsPageProps) {
  const [source, setSource] = useState<LogSource>('container');
  const [pausedEntries, setPausedEntries] = useState<ViewerLogEntry[] | null>(null);
  const paused = pausedEntries !== null;
  const { entries: runtimeEntries, connection } = useRuntimeLogs(csrfToken, paused, source);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [level, setLevel] = useState<LogFilters['level']>('');
  const [hostname, setHostname] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copyState, setCopyState] = useState('');
  const [requestErrors, setRequestErrors] = useState<ViewerLogEntry[]>([]);
  const [gapNotices, setGapNotices] = useState<ViewerLogEntry[]>([]);
  const lastErrors = useRef({ health: '', diagnostics: '' });
  const viewport = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const activeHostname = source === 'container' ? '' : focusedHostname || hostname;

  const refreshConsole = useCallback(async () => {
    if (!onRefresh) return;
    if (refreshInFlight.current) { await refreshInFlight.current; return; }
    const operation = Promise.resolve().then(onRefresh).catch(() => {
      // The caller exposes load errors through diagnosticsError.
    });
    refreshInFlight.current = operation;
    try { await operation; } finally {
      if (refreshInFlight.current === operation) refreshInFlight.current = null;
    }
  }, [onRefresh]);

  useEffect(() => {
    const receivedAt = Date.now();
    const additions: ViewerLogEntry[] = [];
    for (const [operation, message] of [['health', healthError], ['diagnostics', diagnosticsError]] as const) {
      if (message && message !== lastErrors.current[operation]) additions.push({
        id: `request:${operation}:${receivedAt}`, timestamp: receivedAt, level: 'error', source: 'console',
        message, data: { operation: operation === 'health' ? 'health_check_request' : 'diagnostics_load', receivedAt }
      });
      lastErrors.current[operation] = message || '';
    }
    if (additions.length) setRequestErrors((current) => mergeLogEntries([...current, ...additions], 100));
  }, [diagnosticsError, healthError]);

  useEffect(() => {
    if (source !== 'console' || paused || !onRefresh) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      await refreshConsole();
      if (!cancelled) timer = setTimeout(() => { void refresh(); }, 4_000);
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [onRefresh, paused, refreshConsole, source]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const consoleEntries = useMemo(() => consoleLogEntries(entries, job), [entries, job]);
  const liveEntries = useMemo(() => source === 'console'
    ? mergeLogEntries([...consoleEntries, ...requestErrors])
    : source === 'worker' ? mergeLogEntries([...runtimeEntries, ...gapNotices]) : runtimeEntries,
  [consoleEntries, gapNotices, requestErrors, runtimeEntries, source]);
  const displayedEntries = pausedEntries ?? liveEntries;
  const filteredEntries = useMemo(() => filterLogEntries(displayedEntries, {
    search: deferredSearch, level: source === 'container' ? '' : level, hostname: activeHostname
  }), [activeHostname, deferredSearch, displayedEntries, level, source]);
  const hostnames = useMemo(() => [...new Set([
    ...displayedEntries.flatMap((entry) => entry.hostname ? [entry.hostname.toLowerCase()] : []),
    ...(activeHostname ? [activeHostname.toLowerCase()] : [])
  ])].sort(), [activeHostname, displayedEntries]);
  const hasFilters = Boolean(search || (source !== 'container' && (level || activeHostname)));
  const isLoading = source === 'console' ? loading : connection.state === 'connecting' && !displayedEntries.length;
  const exportDescription = source === 'container' ? '纯文本 .log' : 'JSON Lines .jsonl';

  useEffect(() => {
    if (autoScroll && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [autoScroll, filteredEntries]);

  function togglePaused() {
    if (!paused) {
      setPausedEntries(liveEntries);
      return;
    }
    if (source === 'worker') {
      const timestamp = Date.now();
      setGapNotices((current) => mergeLogEntries([...current, {
        id: `resume:${timestamp}`, timestamp, level: 'info', source: 'console',
        message: '已恢复 Worker 网络日志；暂停期间的输出不会补收。',
        data: { operation: 'runtime_log_resume', gapsPossible: true }
      }], 100));
    }
    setPausedEntries(null);
  }

  function clearFilters() {
    setSearch(''); setLevel(''); setHostname(''); onClearFocus();
  }

  function changeSource(nextSource: LogSource) {
    setPausedEntries(null);
    setCopyState('');
    clearFilters();
    setSource(nextSource);
  }

  function logExport() {
    return source === 'container' ? formatLogTextExport(filteredEntries) : formatLogExport(filteredEntries);
  }

  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(logExport());
      setCopyState('已复制');
    } catch { setCopyState('复制失败，请下载日志'); }
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyState(''), 3_000);
  }

  function downloadLogs() {
    const isContainer = source === 'container';
    const url = URL.createObjectURL(new Blob([logExport()], {
      type: isContainer ? 'text/plain;charset=utf-8' : 'application/x-ndjson;charset=utf-8'
    }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `uglink-${source}-${new Date().toISOString().replace(/[:.]/g, '-')}.${isContainer ? 'log' : 'jsonl'}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  let notice: string;
  if (paused) notice = source === 'container' ? '已暂停接收 · 恢复后回放最近保存的输出'
    : source === 'worker' ? '已暂停接收 · 暂停期间的 Worker 输出不会补收' : '已暂停记录刷新';
  else if (connection.state === 'error' || connection.state === 'unavailable') notice = connection.message;
  else notice = source === 'container' ? '回放最近保存的输出，并持续接收 stdout / stderr'
    : source === 'worker' ? '从连接后开始接收 · 断线或暂停期间的 Worker 输出不会补收'
      : '服务检查与部署历史 · 每 4 秒刷新';

  return (
    <div className="section-page diagnostics-page" data-testid="diagnostics-page">
      <div className="page-heading diagnostics-heading">
        <div><h1>故障诊断</h1><p>查看 UGLINK 控制台的容器运行输出与历史记录</p></div>
        <div className="diagnostics-actions">
          <button className="button button--secondary" type="button" onClick={() => { changeSource('console'); onCheck(); }} disabled={!canCheck || checking || deploying}>
            {checking ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{checking ? '正在检查' : '重新检查'}
          </button>
          <button className="button button--secondary" type="button" onClick={() => { changeSource('console'); onRedeploy(); }} disabled={!canCheck || checking || deploying}
            title="使用当前已发布配置覆盖现有受管 Worker">
            {deploying ? <LoaderCircle className="spin" size={15} /> : <Rocket size={15} />}{deploying ? '正在覆盖' : '覆盖部署'}
          </button>
        </div>
      </div>

      <section className="runtime-log-console" data-testid="log-viewer" data-source={source} aria-labelledby="runtime-log-title">
        <div className="runtime-log-toolbar">
          <div className="runtime-log-title"><h2 id="runtime-log-title">日志查看器</h2>
            <span className={`runtime-log-connection runtime-log-connection--${connection.state}`} title={connection.message}>
              <span aria-hidden="true" />{source === 'console' && connection.state === 'connected' ? '自动刷新' : CONNECTION_NAMES[connection.state]}
            </span>
          </div>
          <div className="runtime-log-tools">
            <button type="button" onClick={togglePaused} aria-pressed={paused}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? '恢复' : '暂停'}</button>
            <button type="button" onClick={() => { void copyLogs(); }} disabled={!filteredEntries.length} title={`复制当前筛选结果（${exportDescription}）`}>
              {copyState === '已复制' ? <Check size={14} /> : <Copy size={14} />}复制
            </button>
            <button type="button" onClick={downloadLogs} disabled={!filteredEntries.length} title={`下载当前筛选结果（${exportDescription}）`}><Download size={14} />下载</button>
          </div>
        </div>

        <div className={`runtime-log-filters${source === 'container' ? ' runtime-log-filters--container' : ''}`}>
          <select aria-label="日志来源" value={source} onChange={(event) => changeSource(event.target.value as LogSource)}>
            <option value="container">容器运行日志</option><option value="worker">Worker 网络日志</option><option value="console">检查与部署记录</option>
          </select>
          <label className="runtime-log-search"><Search size={17} aria-hidden="true" />
            <input aria-label="搜索日志" type="search" placeholder={source === 'container' ? '搜索运行输出…' : '搜索日志内容、域名或 JSON…'} value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          {source !== 'container' ? <>
            <select aria-label="日志级别" value={level} onChange={(event) => setLevel(event.target.value as LogFilters['level'])}>
              <option value="">全部级别</option><option value="debug">DEBUG</option><option value="info">INFO</option><option value="warning">WARN</option><option value="error">ERROR</option>
            </select>
            <select aria-label="日志域名" value={activeHostname.toLowerCase()} onChange={(event) => { onClearFocus(); setHostname(event.target.value); }}>
              <option value="">全部域名</option>{hostnames.map((host) => <option key={host} value={host}>{host}</option>)}
            </select>
          </> : null}
          <button className="runtime-log-clear" type="button" onClick={clearFilters} disabled={!hasFilters}><X size={13} />清除筛选</button>
        </div>

        <div className="runtime-log-notice" role="status">
          <span>{notice} · 最多显示 {LOG_BUFFER_LIMIT.toLocaleString()} 条</span>
          {copyState ? <span className="runtime-log-feedback">{copyState}</span> : null}
        </div>

        <div className="runtime-log-viewport" ref={viewport} tabIndex={0} role="region" aria-label="日志内容" aria-busy={isLoading || undefined}>
          {filteredEntries.length ? filteredEntries.map((entry) => <LogRow key={`${entry.source}:${entry.id}`} entry={entry} />) : (
            <div className="runtime-log-empty">
              {isLoading ? <LoaderCircle className="spin" size={21} /> : <span className="runtime-log-empty__prompt" aria-hidden="true">&gt;_</span>}
              <strong>{isLoading ? '正在读取日志' : hasFilters ? '没有匹配的日志' : connection.state === 'unavailable' ? '当前运行环境无法提供此日志源' : '等待日志输出'}</strong>
              <p>{hasFilters ? '调整搜索词或清除筛选后查看其他记录。' : connection.state === 'unavailable' ? connection.message
                : source === 'container' ? '容器启动信息、标准输出和标准错误会连续显示在这里。'
                  : source === 'worker' ? '建立连接后，Worker 请求与运行输出会显示在这里。' : '服务检查和部署记录会按时间显示在这里。'}</p>
              {hasFilters ? <button type="button" onClick={clearFilters}>清除筛选</button> : null}
            </div>
          )}
        </div>
        <div className="runtime-log-footer"><span>显示 {filteredEntries.length.toLocaleString()} / {displayedEntries.length.toLocaleString()} 条</span>
          <label><span>按时间正序 · 自动滚动</span><input type="checkbox" role="switch" aria-label="自动滚动" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} /></label>
        </div>
      </section>
    </div>
  );
}
