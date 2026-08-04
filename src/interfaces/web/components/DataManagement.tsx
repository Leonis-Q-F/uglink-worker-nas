import { ArchiveRestore, DatabaseBackup, Download, Upload } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import type {
  BootstrapResponse,
  PersistedConfigurationState
} from '../../../application/console/contracts';
import type { UglinkConfig } from '../../../domain/configuration/model';
import { apiGet, apiPost, ConsoleApiError } from '../lib/api';
import { downloadJson, readJsonFile } from '../lib/files';
import { BackupDialog } from './BackupDialog';

interface DataManagementProps {
  csrfToken: string;
  config: UglinkConfig;
  onConfigurationImported: (snapshot: PersistedConfigurationState) => void;
  onRestored: (bootstrap: BootstrapResponse) => void;
  onNotice: (type: 'success' | 'error', message: string) => void;
}

function message(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    return error.detail ? `${error.message}（${error.detail}）` : error.message;
  }
  return error instanceof Error ? error.message : '数据操作失败。';
}

export function DataManagement({
  csrfToken,
  config,
  onConfigurationImported,
  onRestored,
  onNotice
}: DataManagementProps) {
  const input = useRef<HTMLInputElement>(null);
  const [backupMode, setBackupMode] = useState<'export' | 'restore'>();
  const [busy, setBusy] = useState(false);

  const persistCurrent = async () => {
    await apiPost<PersistedConfigurationState>('/api/configuration/draft', csrfToken, { config });
  };

  const exportConfiguration = async () => {
    setBusy(true);
    try {
      await persistCurrent();
      const exported = await apiGet<UglinkConfig>('/api/configuration/export');
      downloadJson('uglink.config.json', exported);
      onNotice('success', '配置文件已导出。');
    } catch (error) {
      onNotice('error', message(error));
    } finally {
      setBusy(false);
    }
  };

  const importConfiguration = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const imported = await readJsonFile<UglinkConfig>(file);
      const snapshot = await apiPost<PersistedConfigurationState>(
        '/api/configuration/import',
        csrfToken,
        { config: imported }
      );
      onConfigurationImported(snapshot);
      onNotice('success', '配置已导入并保存为待发布草稿。');
    } catch (error) {
      onNotice('error', message(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="panel security-card security-card--wide">
        <span className="security-card__icon"><Download size={21} /></span>
        <div>
          <h2>配置导入与导出</h2>
          <p>导出当前服务配置，或从配置文件导入为待发布草稿；文件不包含任何密码或 API Token。</p>
        </div>
        <div className="security-card__actions security-card__actions--row">
          <button className="button button--secondary" type="button" onClick={() => void exportConfiguration()} disabled={busy}>
            <Download size={15} /> 导出配置
          </button>
          <button className="button button--secondary" type="button" onClick={() => input.current?.click()} disabled={busy}>
            <Upload size={15} /> 导入配置
          </button>
          <input
            ref={input}
            className="visually-hidden"
            type="file"
            accept="application/json,.json"
            onChange={(event) => void importConfiguration(event)}
          />
        </div>
      </section>
      <section className="panel security-card security-card--wide">
        <span className="security-card__icon security-card__icon--orange"><DatabaseBackup size={21} /></span>
        <div>
          <h2>加密备份与恢复</h2>
          <p>备份 Cloudflare 连接、服务配置和诊断记录。备份使用独立密码加密，NAS 密码仍保存在 Cloudflare Secret 中。</p>
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
