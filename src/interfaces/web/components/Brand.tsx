import { Network } from 'lucide-react';

interface BrandProps {
  compact?: boolean;
}

export function Brand({ compact = false }: BrandProps) {
  return (
    <div className={`brand${compact ? ' brand--compact' : ''}`} aria-label="UGLINK Control">
      <span className="brand__mark" aria-hidden="true">
        <Network size={compact ? 18 : 21} strokeWidth={2.2} />
      </span>
      <span className="brand__copy">
        <strong>UGLINK</strong>
        <span>CONTROL</span>
      </span>
    </div>
  );
}
