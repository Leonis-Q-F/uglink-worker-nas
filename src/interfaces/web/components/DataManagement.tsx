import { ArchiveRestore, DatabaseBackup } from 'lucide-react';
import { useState } from 'react';
import type {
  BootstrapResponse,
  PersistedConfigurationState
} from '../../../application/console/contracts';
import type { UglinkConfig } from '../../../domain/configuration/model';
import { apiPost } from '../lib/api';
import { BackupDialog } from './BackupDialog';

interface DataManagementProps {
  csrfToken: string;
  config: UglinkConfig;
  onRestored: (bootstrap: BootstrapResponse) => void;
}

export function DataManagement({
  csrfToken,
  config,
  onRestored
}: DataManagementProps) {
  const [backupMode, setBackupMode] = useState<'export' | 'restore'>();

  const persistCurrent = async () => {
    await apiPost<PersistedConfigurationState>('/api/configuration/draft', csrfToken, { config });
  };

  return (
    <>
      <section className="panel security-card">
        <span className="security-card__icon security-card__icon--orange"><DatabaseBackup size={21} /></span>
        <div>
          <h2>加密备份与恢复</h2>
          <p>备份 Cloudflare 连接、UGREENlink ID、NAS 登录用户名、服务配置和诊断记录。NAS 密码仍只保存在 Cloudflare Secret 中。</p>
        </div>
        <div className="security-card__actions security-card__actions--row">
          <button className="button button--secondary" type="button" onClick={() => setBackupMode('export')}>
            <DatabaseBackup size={15} /> 导出备份
          </button>
          <button className="button button--secondary" type="button" onClick={() => setBackupMode('restore')}>
            <ArchiveRestore size={15} /> 恢复备份
          </button>
        </div>
      </section>
      <BackupDialog
        csrfToken={csrfToken}
        mode={backupMode}
        onClose={() => setBackupMode(undefined)}
        onBeforeExport={persistCurrent}
        onRestored={onRestored}
      />
    </>
  );
}
