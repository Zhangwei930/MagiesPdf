import { t, type Locale } from '../i18n.ts';
import { FileSpreadsheet, FileText, Presentation } from '../icons.ts';

export interface PdfQuickConvertProps {
  locale: Locale;
  disabled?: boolean;
  onConvert(toolId: string): void;
}

const ACTIONS = [
  { toolId: 'convert.pdf-to-docx', icon: FileText, labelKey: 'pdfToWord' as const },
  { toolId: 'convert.pdf-to-xlsx', icon: FileSpreadsheet, labelKey: 'pdfToExcel' as const },
  { toolId: 'convert.pdf-to-pptx', icon: Presentation, labelKey: 'pdfToPpt' as const },
];

/**
 * WPS-style floating shortcuts for the three most common PDF exports.
 * Sits over the canvas; does not steal layout from the page.
 */
export function PdfQuickConvert({ locale, disabled, onConvert }: PdfQuickConvertProps) {
  return (
    <div className="pointer-events-none absolute right-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1.5">
      <div className="pointer-events-auto flex flex-col gap-0.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)]/95 p-1.5 shadow-lg backdrop-blur-sm">
        {ACTIONS.map(({ toolId, icon: Icon, labelKey }) => (
          <button
            key={toolId}
            type="button"
            disabled={disabled}
            onClick={() => onConvert(toolId)}
            className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
          >
            <Icon size={15} className="shrink-0 text-[var(--accent)]" />
            <span className="whitespace-nowrap">{t(labelKey, locale)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
