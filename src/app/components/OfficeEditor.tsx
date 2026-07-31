import { useEffect, useId, useRef, useState } from 'react';
import type { OnlineOfficeSession } from '../bridge.ts';
import { t } from '../i18n.ts';
import { FileOutput, Loader2, X } from '../icons.ts';
import { useApp } from '../store.ts';

interface OfficeEditorProps {
  path: string;
  session: OnlineOfficeSession;
  onClose(): void;
  onOpenLocal(path: string): Promise<void>;
}

export function OfficeEditor({ path, session, onClose, onOpenLocal }: OfficeEditorProps) {
  const locale = useApp((state) => state.locale);
  const frameName = `office-editor-${useId().replaceAll(':', '')}`;
  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);
  const [loading, setLoading] = useState(true);
  const [openingLocal, setOpeningLocal] = useState(false);
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    submitted.current = true;
    formRef.current?.submit();
  }, [session]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--surface-app)]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{session.name}</span>
        <span className="rounded-md bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">
          {t('officeOnline', locale)}
        </span>
        <button
          type="button"
          disabled={openingLocal}
          onClick={() => {
            setOpeningLocal(true);
            setLocalError('');
            void onOpenLocal(path)
              .catch((cause) => setLocalError(cause instanceof Error ? cause.message : String(cause)))
              .finally(() => setOpeningLocal(false));
          }}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
        >
          {openingLocal ? <Loader2 size={12} className="animate-spin" /> : <FileOutput size={12} />}
          {t('openLocalEditor', locale)}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('closeOfficeEditor', locale)}
          className="rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)]"
        >
          <X size={14} />
        </button>
      </div>

      {localError && (
        <p className="shrink-0 border-b border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-1.5 text-[11px] text-[var(--danger)]">
          {localError}
        </p>
      )}

      <form ref={formRef} action={session.editorUrl} method="post" target={frameName} className="hidden">
        <input type="hidden" name="access_token" value={session.accessToken} />
        <input type="hidden" name="access_token_ttl" value={String(session.accessTokenTtl)} />
      </form>

      <div className="relative min-h-0 flex-1">
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[var(--surface-app)]">
            <Loader2 size={20} className="animate-spin text-[var(--accent)]" />
            <p className="text-xs text-[var(--text-muted)]">{t('loadingOfficeEditor', locale)}</p>
          </div>
        )}
        <iframe
          name={frameName}
          title={session.name}
          className="h-full w-full border-0 bg-white"
          allow="clipboard-read; clipboard-write"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals allow-pointer-lock"
          onLoad={() => {
            if (submitted.current) setLoading(false);
          }}
        />
      </div>
    </div>
  );
}
