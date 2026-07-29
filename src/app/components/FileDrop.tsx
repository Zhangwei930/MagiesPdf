import { useCallback, useRef, useState } from 'react';
import { clsx } from 'clsx';
import type { ToolInputSpec } from '@core/types.ts';
import { bridge } from '../bridge.ts';
import type { PickedFile } from '../bridge.ts';
import { formatBytes, t, type Locale } from '../i18n.ts';
import { ChevronDown, ChevronRight, Eye, FileText, Plus, Trash2, X } from '../icons.ts';
import { Button } from './ui.tsx';

interface FileDropProps {
  spec: ToolInputSpec;
  files: PickedFile[];
  locale: Locale;
  onChange(files: PickedFile[]): void;
  onPreview?(file: PickedFile): void;
}

export function FileDrop({ spec, files, locale, onChange, onPreview }: FileDropProps) {
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
    <div className="space-y-3">
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
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-card)]',
          'border-2 border-dashed px-6 py-9 text-center transition-colors duration-150',
          dragging
            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
            : 'border-[var(--border-strong)] bg-[var(--surface-sunken)] hover:border-[var(--accent)] hover:bg-[var(--surface-hover)]',
        )}
      >
        <Plus size={20} className="text-[var(--text-muted)]" />
        <p className="text-sm font-medium text-[var(--text-secondary)]">
          {t(dragging ? 'dropHereNow' : 'dropHere', locale)}
        </p>
        <p className="font-mono text-[11px] text-[var(--text-muted)]">
          {t('accepts', locale)} {spec.accept.join('  ')}
        </p>
      </div>

      {error && (
        <p className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}

      {files.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between px-0.5">
            <span className="text-xs text-[var(--text-muted)]">
              {files.length} {t('fileCount', locale)}
              {missing > 0 && (
                <span className="ml-2 text-[var(--danger)]">
                  {t('needMoreFiles', locale)} {missing} {t('more', locale)}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => onChange([])}
              className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--danger)]"
            >
              <Trash2 size={12} />
              {t('clearFiles', locale)}
            </button>
          </div>

          <ul className="space-y-1">
            {files.map((file, index) => (
              <li
                key={`${file.path}-${index}`}
                className="group flex items-center gap-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2"
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
                      <ChevronRight size={13} className="-rotate-90" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('moveDown', locale)}
                      disabled={index === files.length - 1}
                      onClick={() => move(index, index + 1)}
                      className="text-[var(--text-muted)] transition-colors hover:text-[var(--accent)] disabled:opacity-25"
                    >
                      <ChevronDown size={13} />
                    </button>
                  </div>
                )}

                <FileText size={15} className="shrink-0 text-[var(--accent)]" />
                <span className="min-w-0 flex-1 truncate text-[13px]" title={file.path}>
                  {file.name}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
                  {formatBytes(file.size, locale)}
                </span>
                {onPreview && file.name.toLowerCase().endsWith('.pdf') && (
                  <button
                    type="button"
                    aria-label={t('previewPdf', locale)}
                    onClick={() => onPreview(file)}
                    className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition-all group-hover:opacity-100 hover:text-[var(--accent)]"
                  >
                    <Eye size={13} />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t('removeFile', locale)}
                  onClick={() => onChange(files.filter((_, i) => i !== index))}
                  className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition-all group-hover:opacity-100 hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {files.length === 0 && (
        <Button size="sm" variant="ghost" onClick={openPicker} className="w-full">
          {t(multiple ? 'chooseFiles' : 'chooseFile', locale)}
        </Button>
      )}
    </div>
  );
}
