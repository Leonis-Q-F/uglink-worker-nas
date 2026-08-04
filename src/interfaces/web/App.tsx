import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiGet } from './lib/api';
import type { BootstrapResponse } from '../../application/console/contracts';
import { Brand } from './components/Brand';
import { ConnectScreen } from './components/ConnectScreen';
import { Dashboard } from './components/Dashboard';

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`);
    }
    let active = true;
    void apiGet<BootstrapResponse>('/api/bootstrap')
      .then((response) => active && setBootstrap(response))
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : '控制台初始化失败。');
      });
    return () => { active = false; };
  }, []);

  if (error) {
    return (
      <div className="boot-screen">
        <Brand />
        <div className="boot-error"><AlertCircle size={22} /><h1>控制台没有启动</h1><p>{error}</p><button className="button button--primary" type="button" onClick={() => window.location.reload()}><RefreshCw size={16} /> 重试</button></div>
      </div>
    );
  }

  if (!bootstrap) {
    return <div className="boot-screen"><Brand /><div className="boot-loading"><LoaderCircle className="spin" size={22} /> 正在建立安全会话…</div></div>;
  }

  if (!bootstrap.authenticated) {
    return <ConnectScreen bootstrap={bootstrap} />;
  }

  return <Dashboard bootstrap={bootstrap} onConnectionReset={() => window.location.reload()} />;
}
