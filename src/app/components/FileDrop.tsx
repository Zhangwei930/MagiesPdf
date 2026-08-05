import { useCallback, useRef, useState } from 'react';
import { clsx } from 'clsx';
import type { ToolInputSpec } from '@core/types.ts';
import { bridge } from '../bridge.ts';
import type { PickedFile } from '../bridge.ts';
import { formatBytes, t, type Locale } from '../i18n.ts';
import { ChevronDown, ChevronRight, Eye, FileText, Plus, Trash2, X } from '../icons.ts';

interface FileDropProps {
  spec: ToolInputSpec;
  files: PickedFile[];
  locale: Locale;
  /** Compact layout for WPS-style dialogs / task panes. */
  density?: 'default' | 'compact';
  onChange(files: PickedFile[]): void;
  onPreview?(file: PickedFile): void;
}

export function FileDrop({
  spec,
  files,
  locale,
  density = 'default',
  onChange,
  onPreview,
}: FileDropProps) {
  const compact = density === 'compact';
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  // Nested dragenter/dragleave pairs fire per child element; counting them is the
  // only reliable way to know when the pointer has truly left the drop zone.
  const dragDepth = useRef(0);

  const multiple = spec.max === null || spec.max > 1;

  const accept = useCallback(
    (incoming: PickedFile[]) => {
      const allowed = incoming.filter((file) =>
        spec.accept.some((extension) => file.name.toLowerCase().endsWith(extension)),
      );
      const rejected = incoming.length - allowed.length;

      setError(
        rejected > 0
          ? locale === 'zh'
            ? `已忽略 ${rejected} 个不支持的文件，仅接受 ${spec.accept.join('、')}`
            : `Ignored ${rejected} unsupported file(s); only ${spec.accept.join(', ')} are accepted`
          : '',
      );

      const combined = multiple ? [...files, ...allowed] : allowed.slice(0, 1);
      onChange(spec.max === null ? combined : combined.slice(0, spec.max));
    },
    [files, locale, multiple, onChange, spec.accept, spec.max],
  );

  const openPicker = useCallback(async () => {
    try {
      accept(await bridge().pickFiles(spec.accept, multiple));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [accept, multiple, spec.accept]);

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      // The shell also accepts drops, anywhere in the window. A drop that landed
      // squarely on this zone was meant for this tool, not for the viewer.
      event.stopPropagation();
      dragDepth.current = 0;
      setDragging(false);

      // The renderer only ever sees paths; the main process does the reading.
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => bridge().pathForFile(file))
        .filter(Boolean);

      if (paths.length === 0) return;
      try {
        accept(await bridge().readFiles(paths));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [accept],
  );

  const move = (from: number, to: number) => {
    if (to < 0 || to >= files.length) return;
    const next = [...files];
    const [moved] = next.splice(from, 1);
    if (moved) next.splice(to, 0, moved);
    onChange(next);
  };

  const missing = Math.max(0, spec.min - files.length);

  return (
    <div className={clsx(compact ? 'space-y-2' : 'space-y-3')}>
      {files.length === 0 && (
        <div
          onDragEnter={(e) => {
            e.preventDefault();
            // Keeps the shell's whole-window drop overlay from covering this zone
            // the moment the pointer reaches it.
            e.stopPropagation();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            dragDepth.current -= 1;
            if (dragDepth.current <= 0) setDragging(false);
          }}
          onDrop={onDrop}
          onClick={openPicker}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void openPicker();
            }
          }}
          role="button"
          tabIndex={0}
          className={clsx(
            'flex cursor-pointer flex-col items-center justify-center text-center transition-colors duration-150',
            'border-2 border-dashed rounded-lg',
            compact ? 'gap-1 px-3 py-4' : 'gap-2 rounded-[var(--radius-card)] px-6 py-9',
            dragging
              ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
              : 'border-[var(--border-strong)] bg-[var(--surface-sunken)] hover:border-[var(--accent)] hover:bg-[var(--surface-hover)]',
          )}
        >
          <Plus size={compact ? 16 : 20} className="text-[var(--text-muted)]" />
          <p
            className={clsx(
              'font-medium text-[var(--text-secondary)]',
              compact ? 'text-[12px]' : 'text-sm',
            )}
          >
            {t(dragging ? 'dropHereNow' : 'dropHere', locale)}
          </p>
          <p className="font-mono text-[10px] text-[var(--text-muted)]">
            {t('accepts', locale)} {spec.accept.join('  ')}
          </p>
        </div>
      )}

      {error && (
        <p
          className={clsx(
            'rounded-lg bg-[var(--danger-soft)] text-[var(--danger)]',
            compact ? 'px-2 py-1.5 text-[11px]' : 'px-3 py-2 text-xs',
          )}
        >
          {error}
        </p>
      )}

      {files.length > 0 && (
        <div className={clsx(compact ? 'space-y-1' : 'space-y-1.5')}>
          <div className="flex items-center justify-between px-0.5">
            <span className={clsx(compact ? 'text-[11px]' : 'text-xs', 'text-[var(--text-muted)]')}>
              {files.length} {t('fileCount', locale)}
              {missing > 0 && (
                <span className="ml-2 text-[var(--danger)]">
                  {t('needMoreFiles', locale)} {missing} {t('more', locale)}
                </span>
              )}
            </span>
            <div className="flex items-center gap-2">
              {(multiple || files.length === 0) && (
                <button
                  type="button"
                  onClick={() => void openPicker()}
                  className="inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
                >
                  <Plus size={11} />
                  {t(multiple ? 'chooseFiles' : 'chooseFile', locale)}
                </button>
              )}
              <button
                type="button"
                onClick={() => onChange([])}
                className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--danger)]"
              >
                <Trash2 size={11} />
                {t('clearFiles', locale)}
              </button>
            </div>
          </div>

          <ul
            className={clsx(compact ? 'space-y-0.5' : 'space-y-1')}
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              dragDepth.current += 1;
              setDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              dragDepth.current -= 1;
              if (dragDepth.current <= 0) setDragging(false);
            }}
            onDrop={onDrop}
          >
            {files.map((file, index) => (
              <li
                key={`${file.path}-${index}`}
                className={clsx(
                  'group flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)]',
                  compact ? 'px-2 py-1.5' : 'gap-2.5 rounded-lg bg-[var(--surface-panel)] px-3 py-2',
                )}
              >
                {spec.ordered && files.length > 1 && (
                  <div className="flex flex-col -my-1">
                    <button
                      type="button"
                      aria-label={t('moveUp', locale)}
                      disabled={index === 0}
                      onClick={() => move(index, index - 1)}
                      className="text-[var(--text-muted)] transition-colors hover:text-[var(--accent)] disabled:opacity-25"
                    >
                      <ChevronRight size={12} className="-rotate-90" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('moveDown', locale)}
                      disabled={index === files.length - 1}
                      onClick={() => move(index, index + 1)}
                      className="text-[var(--text-muted)] transition-colors hover:text-[var(--accent)] disabled:opacity-25"
                    >
                      <ChevronDown size={12} />
                    </button>
                  </div>
                )}

                <FileText size={compact ? 12 : 15} className="shrink-0 text-[var(--accent)]" />
                <span
                  className={clsx('min-w-0 flex-1 truncate', compact ? 'text-[12px]' : 'text-[13px]')}
                  title={file.path}
                >
                  {file.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">
                  {formatBytes(file.size, locale)}
                </span>
                {onPreview && file.name.toLowerCase().endsWith('.pdf') && (
                  <button
                    type="button"
                    aria-label={t('previewPdf', locale)}
                    onClick={() => onPreview(file)}
                    className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition-all group-hover:opacity-100 hover:text-[var(--accent)]"
                  >
                    <Eye size={12} />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t('removeFile', locale)}
                  onClick={() => onChange(files.filter((_, i) => i !== index))}
                  className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition-all group-hover:opacity-100 hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
