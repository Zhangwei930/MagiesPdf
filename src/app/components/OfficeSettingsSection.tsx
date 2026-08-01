import { useEffect, useState } from 'react';
import { bridge, hasBridge, type OfficeStatus } from '../bridge.ts';
import { t } from '../i18n.ts';
import { AlertCircle, Check, RefreshCw } from '../icons.ts';
import { useApp } from '../store.ts';
import { Button } from './ui.tsx';

export function OfficeSettingsSection() {
  const locale = useApp((state) => state.locale);
  const [status, setStatus] = useState<OfficeStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const refreshStatus = async () => {
    if (!hasBridge()) return;
    setRefreshing(true);
    setError('');
    try {
      setStatus(await bridge().getOfficeStatus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!hasBridge()) return;
    let cancelled = false;
    void bridge().getOfficeStatus().then(
      (result) => {
        if (!cancelled) setStatus(result);
      },
      (cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="surface-panel space-y-5 p-4">
      <div>
        <h2 className="text-[13px] font-semibold">{t('officeIntegration', locale)}</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">{t('officeIntegrationHelp', locale)}</p>
      </div>

      <div className={`rounded-xl border p-3 ${status?.libreOffice.available ? 'border-[var(--success)]/30 bg-[var(--success-soft)]' : 'border-[var(--danger)]/30 bg-[var(--danger-soft)]'}`}>
        <div className="flex items-start gap-2">
          {status?.libreOffice.available ? <Check size={15} className="mt-0.5 shrink-0 text-[var(--success)]" /> : <AlertCircle size={15} className="mt-0.5 shrink-0 text-[var(--danger)]" />}
          <div>
            <p className="text-[12px] font-medium">{status?.libreOffice.available ? t('libreOfficeReady', locale) : t('libreOfficeMissing', locale)}</p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--text-muted)]">{status?.libreOffice.available ? t('localOfficeReadyHint', locale) : t('localOfficeMissingHint', locale)}</p>
          </div>
        </div>
      </div>

      {error && <p className="flex items-start gap-1.5 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[11px] text-[var(--danger)]"><AlertCircle size={13} className="mt-0.5 shrink-0" /><span>{error}</span></p>}

      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => void refreshStatus()} loading={refreshing}><RefreshCw size={14} />{t('detectAgain', locale)}</Button>
      </div>
    </section>
  );
}
