import { ArchiveRestore, DatabaseBackup, LoaderCircle, LockKeyhole, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type {
  BackupRestoreRequest,
  BootstrapResponse,
  EncryptedControlBackup
} from '../../../application/console/contracts';
import { apiPost, ConsoleApiError } from '../lib/api';
import { downloadJson, readJsonFile } from '../lib/files';

type BackupMode = 'export' | 'restore';

interface BackupDialogProps {
  csrfToken: string;
  mode?: BackupMode;
  onClose: () => void;
  onBeforeExport?: () => Promise<void>;
  onRestored: (bootstrap: BootstrapResponse) => void;
}

function message(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    return error.detail ? `${error.message}（${error.detail}）` : error.message;
  }
  return error instanceof Error ? error.message : '备份操作失败。';
}

export function BackupDialog({
  csrfToken,
  mode,
  onClose,
  onBeforeExport,
  onRestored
}: BackupDialogProps) {
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setPassphrase('');
    setConfirmation('');
    setFile(undefined);
    setError(undefined);
  }, [mode]);

  if (!mode) return null;
  const exporting = mode === 'export';
  const valid = passphrase.length >= 12
    && passphrase.length <= 256
    && (exporting ? passphrase === confirmation : Boolean(file));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (exporting) {
        await onBeforeExport?.();
        const backup = await apiPost<EncryptedControlBackup>(
          '/api/backups/export',
          csrfToken,
          { passphrase }
        );
        downloadJson(`uglink-backup-${backup.createdAt.slice(0, 10)}.json`, backup);
        onClose();
      } else {
        const backup = await readJsonFile<EncryptedControlBackup>(file!);
        const restored = await apiPost<BootstrapResponse>(
          '/api/backups/restore',
          csrfToken,
          { backup, passphrase } satisfies BackupRestoreRequest
        );
        onRestored(restored);
      }
    } catch (reason) {
      setError(message(reason));
      setBusy(false);
    }
  };

  const Icon = exporting ? DatabaseBackup : ArchiveRestore;
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="backup-dialog-title">
        <div className="dialog__heading">
          <span className="security-card__icon"><Icon size={21} /></span>
          <div>
            <h2 id="backup-dialog-title">{exporting ? '导出加密备份' : '恢复加密备份'}</h2>
            <p>{exporting
              ? '备份包含 Cloudflare 连接信息、服务配置和诊断记录。'
              : '恢复前会验证备份密码和 Cloudflare API Token。'}</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose} disabled={busy}>
            <X size={17} />
          </button>
        </div>
        <form className="dialog__form" onSubmit={submit}>
          {!exporting && (
            <label className="field">
              <span>备份文件</span>
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => setFile(event.target.files?.[0])}
              />
              <small>请选择由本控制台导出的加密备份文件。</small>
            </label>
          )}
          <label className="field">
            <span><LockKeyhole size={14} /> 备份密码</span>
            <input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="new-password"
              minLength={12}
              maxLength={256}
              placeholder="至少 12 个字符"
            />
          </label>
          {exporting && (
            <label className="field">
              <span>确认备份密码</span>
              <input
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="new-password"
                minLength={12}
                maxLength={256}
                placeholder="再次输入备份密码"
              />
            </label>
          )}
          {exporting && confirmation && confirmation !== passphrase && (
            <p className="form-error">两次输入的备份密码不一致。</p>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="dialog__actions">
            <button className="button button--secondary" type="button" onClick={onClose} disabled={busy}>取消</button>
            <button className="button button--primary" type="submit" disabled={!valid || busy}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Icon size={16} />}
              {exporting ? '导出备份' : '验证并恢复'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
