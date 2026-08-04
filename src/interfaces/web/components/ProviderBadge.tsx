import { Check, Cloud } from 'lucide-react';
import type { ProviderStatus } from '../../../application/console/contracts';

interface ProviderBadgeProps {
  status: ProviderStatus;
  full?: boolean;
}

export function ProviderBadge({ status, full = false }: ProviderBadgeProps) {
  const connected = status.state === 'connected';
  return (
    <div className={`provider-badge${full ? ' provider-badge--full' : ''}`}>
      <span className="provider-badge__icon provider-badge__icon--cloudflare" aria-hidden="true">
        <Cloud size={17} strokeWidth={2} />
      </span>
      <span className="provider-badge__text">
        <strong>{full ? (status.label || 'Cloudflare') : 'Cloudflare'}</strong>
        {full && <small>{status.detail || (connected ? '已连接' : '未连接')}</small>}
      </span>
      <span className={`provider-badge__state provider-badge__state--${connected ? 'ok' : 'idle'}`}>
        {connected && <Check size={12} strokeWidth={3} />}
        {connected ? '已连接' : '未连接'}
      </span>
    </div>
  );
}
