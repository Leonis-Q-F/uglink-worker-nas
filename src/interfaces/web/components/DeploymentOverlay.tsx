import { AlertCircle, CheckCircle2, LoaderCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { DeploymentJob } from '../../../domain/deployment/model';

interface DeploymentOverlayProps {
  job?: DeploymentJob;
  error?: string;
  onClose: () => void;
}

export function DeploymentOverlay({ job, error, onClose }: DeploymentOverlayProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const failure = error || (job?.phase === 'failed' ? job.message : undefined);
  const complete = !failure && job?.phase === 'healthy';
  const title = failure ? '部署遇到问题' : complete ? '覆盖部署完成' : '正在覆盖部署';

  useEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (!complete) return;
    const timer = window.setTimeout(onClose, 1_200);
    return () => window.clearTimeout(timer);
  }, [complete, onClose]);

  return (
    <dialog
      ref={dialog}
      className="deployment-overlay"
      aria-labelledby="deployment-overlay-title"
      aria-describedby="deployment-overlay-message"
      onCancel={(event) => {
        event.preventDefault();
        if (failure) onClose();
      }}
    >
      <div className={`deployment-overlay__content${failure ? ' is-error' : complete ? ' is-success' : ''}`} role="status" aria-live="polite">
        <div className="deployment-overlay__icon" aria-hidden="true">
          {failure ? <AlertCircle size={44} /> : complete ? <CheckCircle2 size={44} /> : <LoaderCircle className="spin" size={44} />}
        </div>
        <h2 id="deployment-overlay-title">{title}</h2>
        <p id="deployment-overlay-message">{failure || (complete ? '服务已发布，窗口即将自动关闭。' : job?.message || '正在检查配置并提交部署，请稍候。')}</p>
        {failure
          ? <button className="button button--secondary" type="button" onClick={onClose}>关闭并查看诊断</button>
          : !complete && <small>完成前请勿刷新或关闭页面</small>}
      </div>
    </dialog>
  );
}
