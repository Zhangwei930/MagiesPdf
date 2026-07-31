import { useCallback, useEffect, useState } from 'react';
import {
  bridge,
  hasBridge,
  type CollaboraStatus,
  type OfficeStatus,
} from '../bridge.ts';
import { t } from '../i18n.ts';
import { AlertCircle, Check, Loader2, RefreshCw } from '../icons.ts';
import { useApp } from '../store.ts';
import { Button, Field } from './ui.tsx';

export function OfficeSettingsSection() {
  const locale = useApp((state) => state.locale);
  const office = useApp((state) => state.settings.office);
  const update = useApp((state) => state.updateSettings);
  const [draft, setDraft] = useState(office);
  const [status, setStatus] = useState<OfficeStatus | null>(null);
  const [collabora, setCollabora] = useState<CollaboraStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  const refreshStatus = useCallback(async () => {
    if (!hasBridge()) return;
    setStatus(await bridge().getOfficeStatus());
  }, []);

  useEffect(() => {
    if (!hasBridge()) return;
    let cancelled = false;
    void bridge()
      .getOfficeStatus()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await update({ office: draft });
      await refreshStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const check = async () => {
    setChecking(true);
    setError('');
    setCollabora(null);
    try {
      await update({ office: draft });
      const result = await bridge().checkCollabora();
      setCollabora(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="surface-panel space-y-5 p-4">
      <div>
        <h2 className="text-[13px] font-semibold">{t('officeIntegration', locale)}</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
          {t('officeIntegrationHelp', locale)}
        </p>
      </div>

      <Field label={t('libreOfficeExecutable', locale)} help={t('libreOfficeExecutableHelp', locale)}>
        <input
          className="field-input font-mono text-xs"
          value={draft.libreOfficeExecutable}
          placeholder={t('libreOfficeAutoDetect', locale)}
          onChange={(event) =>
            setDraft((current) => ({ ...current, libreOfficeExecutable: event.target.value }))
          }
        />
        <StatusLine
          ready={status?.libreOffice.available === true}
          readyText={t('libreOfficeReady', locale)}
          missingText={t('libreOfficeMissing', locale)}
          detail={status?.libreOffice.executable}
        />
      </Field>

      <div className="border-t border-[var(--border-subtle)] pt-4">
        <Field label={t('collaboraUrl', locale)} help={t('collaboraUrlHelp', locale)}>
          <input
            className="field-input font-mono text-xs"
            value={draft.collaboraUrl}
            placeholder="https://office.example.com"
            onChange={(event) =>
              setDraft((current) => ({ ...current, collaboraUrl: event.target.value }))
            }
          />
        </Field>

        <div className="mt-4">
          <Field label={t('wopiPublicUrl', locale)} help={t('wopiPublicUrlHelp', locale)}>
            <input
              className="field-input font-mono text-xs"
              value={draft.wopiPublicUrl}
              placeholder="https://files.example.com"
              onChange={(event) =>
                setDraft((current) => ({ ...current, wopiPublicUrl: event.target.value }))
              }
            />
          </Field>
        </div>

        {collabora && (
          <StatusLine
            ready={collabora.reachable}
            readyText={t('collaboraReachable', locale)}
            missingText={collabora.error || t('collaboraUnreachable', locale)}
          />
        )}
      </div>

      {error && (
        <p className="flex items-start gap-1.5 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[11px] text-[var(--danger)]">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => void check()} disabled={checking || saving || !draft.collaboraUrl}>
          {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {t('testConnection', locale)}
        </Button>
        <Button size="sm" variant="primary" onClick={() => void save()} loading={saving} disabled={checking}>
          {t('saveSettings', locale)}
        </Button>
      </div>
    </section>
  );
}

function StatusLine({
  ready,
  readyText,
  missingText,
  detail,
}: {
  ready: boolean;
  readyText: string;
  missingText: string;
  detail?: string;
}) {
  return (
    <div className="mt-2 flex items-start gap-1.5 text-[10.5px]">
      {ready ? (
        <Check size={12} className="mt-0.5 shrink-0 text-[var(--success)]" />
      ) : (
        <AlertCircle size={12} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
      )}
      <span className={ready ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}>
        {ready ? readyText : missingText}
        {detail ? <span className="mt-0.5 block break-all font-mono text-[9px] text-[var(--text-muted)]">{detail}</span> : null}
      </span>
    </div>
  );
}
