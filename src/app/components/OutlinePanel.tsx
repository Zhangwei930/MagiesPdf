import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { t, type Locale } from '../i18n.ts';
import { ChevronDown, ChevronRight, ListTree } from '../icons.ts';
import type { PdfDocumentHandle } from '../pdf/renderer.ts';

export interface OutlineNode {
  title: string;
  bold?: boolean;
  italic?: boolean;
  dest?: unknown;
  url?: string;
  items?: OutlineNode[];
}

interface OutlinePanelProps {
  doc: PdfDocumentHandle | null;
  locale: Locale;
  onGoToPage(page: number): void;
}

export function OutlinePanel({ doc, locale, onGoToPage }: OutlinePanelProps) {
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  const [loadedDoc, setLoadedDoc] = useState<PdfDocumentHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!doc) return;

    void doc.getOutline().then((result) => {
      if (!cancelled) {
        setOutline((result as OutlineNode[]) || null);
        setLoadedDoc(doc);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  if (!doc) return null;

  const loading = loadedDoc !== doc;
  if (loading) {
    return <div className="p-2 text-xs text-[var(--text-muted)]">...</div>;
  }

  if (!outline || outline.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-4 text-center">
        <ListTree size={24} className="mb-2 text-[var(--text-muted)] opacity-50" />
        <span className="text-xs text-[var(--text-muted)]">{t('pdfNoOutline', locale)}</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-1 py-2">
      {outline.map((item, index) => (
        <OutlineItem key={index} item={item} doc={doc} onGoToPage={onGoToPage} depth={0} />
      ))}
    </div>
  );
}

function OutlineItem({
  item,
  doc,
  onGoToPage,
  depth,
}: {
  item: OutlineNode;
  doc: PdfDocumentHandle;
  onGoToPage: (page: number) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasItems = Array.isArray(item.items) && item.items.length > 0;

  const handleClick = async () => {
    if (item.dest) {
      let dest = item.dest;
      if (typeof dest === 'string') {
        const resolved = await doc.getDestination(dest);
        if (resolved) dest = resolved;
      }
      if (Array.isArray(dest)) {
        const pageIndex = await doc.getPageIndex(dest[0]);
        if (pageIndex >= 0) {
          onGoToPage(pageIndex + 1);
        }
      }
    } else if (hasItems) {
      setExpanded((e) => !e);
    }
  };

  return (
    <div className="flex flex-col">
      <div
        className="flex cursor-pointer items-center rounded py-1 pl-1 pr-2 hover:bg-[var(--surface-hover)]"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        <div
          className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--text-muted)]"
          onClick={(e) => {
            if (hasItems) {
              e.stopPropagation();
              setExpanded((ex) => !ex);
            }
          }}
        >
          {hasItems ? (
            expanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : (
            <span className="w-3" />
          )}
        </div>
        <span
          className={clsx(
            'truncate text-[12px] text-[var(--text-primary)]',
            item.bold && 'font-bold',
            item.italic && 'italic',
          )}
          onClick={() => void handleClick()}
        >
          {item.title}
        </span>
      </div>
      {expanded && hasItems && item.items && (
        <div className="flex flex-col">
          {item.items.map((child, index) => (
            <OutlineItem
              key={index}
              item={child}
              doc={doc}
              onGoToPage={onGoToPage}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
