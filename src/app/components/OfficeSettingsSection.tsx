import { useCallback, useEffect, useState } from 'react';
import { bridge, hasBridge, type OfficeStatus } from '../bridge.ts';
import { t } from '../i18n.ts';
import { AlertCircle, Check, RefreshCw } from '../icons.ts';
import { useApp } from '../store.ts';
import { Button, Field } from './ui.tsx';

export function OfficeSettingsSection() {
  const locale = useApp((state) => state.locale);
  const office = useApp((state) => state.settings.office);
  const update = useApp((state) => state.updateSettings);
  const [executable, setExecutable] = useState(office.libreOfficeExecutable);
  const [status, setStatus] = useState<OfficeStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const refreshStatus = useCallback(async () => {
    if (!hasBridge()) return;
    setStatus(await bridge().getOfficeStatus());
  }, []);

  useEffect(() => {
    if (!hasBridge()) return;
    let cancelled = false;
    void bridge().getOfficeStatus().then(
      (result) => {
        if (!cancelled) setStatus(result);
      },
      () => {
        if (!cancelled) setStatus(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await update({ office: { libreOfficeExecutable: executable.trim() } });
      await refreshStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const locate = async () => {
    setError('');
    try {
      const result = await bridge().pickLibreOfficeExecutable();
      setStatus(result.status);
      if (!result.canceled && result.status.libreOffice.executable) {
        setExecutable(result.status.libreOffice.executable);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const download = async () => {
    setError('');
    try {
      await bridge().openLibreOfficeDownload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

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
            {status?.libreOffice.executable && <p className="mt-1 break-all font-mono text-[9px] text-[var(--text-muted)]">{status.libreOffice.executable}</p>}
          </div>
        </div>
      </div>

      <Field label={t('libreOfficeExecutable', locale)} help={t('libreOfficeExecutableHelp', locale)}>
        <input
          className="field-input font-mono text-xs"
          value={executable}
          placeholder={t('libreOfficeAutoDetect', locale)}
          onChange={(event) => setExecutable(event.target.value)}
        />
      </Field>

      {error && <p className="flex items-start gap-1.5 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[11px] text-[var(--danger)]"><AlertCircle size={13} className="mt-0.5 shrink-0" /><span>{error}</span></p>}

      <div className="flex justify-end gap-2">
        {!status?.libreOffice.available && (
          <Button size="sm" variant="primary" onClick={() => void download()}>{t('downloadLibreOffice', locale)}</Button>
        )}
        <Button size="sm" onClick={() => void locate()}>{t('locateInstalled', locale)}</Button>
        <Button size="sm" onClick={() => void refreshStatus()}><RefreshCw size={14} />{t('detectAgain', locale)}</Button>
        <Button size="sm" variant="primary" onClick={() => void save()} loading={saving}>{t('saveSettings', locale)}</Button>
      </div>
    </section>
  );
}
