import { useEffect, useState, useRef } from 'react';
import { clsx } from 'clsx';
import { Bot, Sparkles, Languages, PenLine } from '../icons.ts';
import type { Locale } from '../i18n.ts';
import { selectionMenuPosition } from '../pdf/selectionMenu.ts';

export interface TextSelectionMenuProps {
  locale: Locale;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onAiAction(action: 'summarize' | 'translate' | 'polish', selectedText: string): void;
  onHighlightText?(selectedText: string): void;
}

export function TextSelectionMenu({
  locale,
  containerRef,
  onAiAction,
  onHighlightText,
}: TextSelectionMenuProps) {
  const [selectedText, setSelectedText] = useState('');
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        setSelectedText('');
        setPosition(null);
        return;
      }

      const text = selection.toString().trim();
      if (!text || text.length < 2) {
        setSelectedText('');
        setPosition(null);
        return;
      }

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const container = containerRef.current;
      const containerRect = container?.getBoundingClientRect() ?? null;

      // The menu is absolutely positioned inside the scrolled content, so its
      // coordinate includes the scroll offset. `selectionMenuPosition` owns
      // that conversion; keep it there, where it can be tested without a DOM.
      setPosition(
        selectionMenuPosition({
          selection: rect,
          container: containerRect && {
            left: containerRect.left,
            top: containerRect.top,
            width: containerRect.width,
            height: containerRect.height,
          },
          scroll: {
            left: container?.scrollLeft ?? 0,
            top: container?.scrollTop ?? 0,
          },
        }),
      );

      setSelectedText(text);
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [containerRef]);

  if (!position || !selectedText) return null;

  return (
    <div
      ref={menuRef}
      className={clsx(
        'absolute z-40 flex items-center gap-1 rounded-full p-1.5 shadow-2xl transition-all animate-in fade-in zoom-in-95 duration-150',
        'border border-[var(--border-strong)] bg-[var(--surface-panel)]/95 backdrop-blur-md text-xs'
      )}
      style={{
        left: position.x,
        top: position.y,
        transform: 'translateX(-50%)',
      }}
      onMouseDown={(e) => e.preventDefault()} // Keep text selection intact on click
    >
      <button
        type="button"
        title={locale === 'zh' ? 'AI 总结核心内容' : 'AI Summarize'}
        onClick={() => onAiAction('summarize', selectedText)}
        className="flex items-center gap-1 rounded-full px-2.5 py-1 font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)] transition-colors"
      >
        <Bot size={13} />
        <span>{locale === 'zh' ? 'AI 总结' : 'Summarize'}</span>
      </button>

      <span className="h-3.5 w-px bg-[var(--border-subtle)]" />

      <button
        type="button"
        title={locale === 'zh' ? 'AI 划词翻译' : 'AI Translate'}
        onClick={() => onAiAction('translate', selectedText)}
        className="flex items-center gap-1 rounded-full px-2 py-1 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
      >
        <Languages size={13} />
        <span>{locale === 'zh' ? '翻译' : 'Translate'}</span>
      </button>

      <button
        type="button"
        title={locale === 'zh' ? 'AI 提炼与润色' : 'AI Polish'}
        onClick={() => onAiAction('polish', selectedText)}
        className="flex items-center gap-1 rounded-full px-2 py-1 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
      >
        <Sparkles size={13} />
        <span>{locale === 'zh' ? '润色' : 'Polish'}</span>
      </button>

      {onHighlightText && (
        <>
          <span className="h-3.5 w-px bg-[var(--border-subtle)]" />
          <button
            type="button"
            title={locale === 'zh' ? '添加高亮' : 'Highlight'}
            onClick={() => onHighlightText(selectedText)}
            className="flex items-center gap-1 rounded-full px-2 py-1 text-[var(--warning)] hover:bg-[var(--surface-hover)] transition-colors"
          >
            <PenLine size={13} />
            <span>{locale === 'zh' ? '高亮' : 'Highlight'}</span>
          </button>
        </>
      )}
    </div>
  );
}
