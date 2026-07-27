import { ToolError } from './errors.ts';

/**
 * Page-selection mini-language shared by every tool that takes a page range.
 *
 *   `1,3,5`      individual pages, in the order written
 *   `2-5`        an ascending span
 *   `5-2`        a descending span (useful for reordering)
 *   `8-`  `-3`   open-ended spans
 *   `N`          the last page, also usable inside a span (`8-N`)
 *   `1-10/3`     every 3rd page of the span
 *   `all` `first` `last` `odd` `even`
 *
 * Order and duplicates are preserved on purpose: `3,1` means "page 3 then page 1",
 * which is what extract/reorder need. Callers that want a set should dedupe.
 */

const KEYWORDS = new Set(['all', 'first', 'last', 'odd', 'even']);

function invalid(expression: string, reason: string): ToolError {
  return new ToolError('INVALID_PARAM', `Invalid page range "${expression}": ${reason}`, {
    zh: `页码范围「${expression}」无法识别。可用写法：1,3,5 · 2-5 · 8- · 1-10/3 · all/odd/even/first/last/N`,
    en: `Cannot parse the page range "${expression}". Try: 1,3,5 · 2-5 · 8- · 1-10/3 · all/odd/even/first/last/N`,
  });
}

function outOfRange(page: number, pageCount: number): ToolError {
  return new ToolError(
    'PAGE_OUT_OF_RANGE',
    `Page ${page} is outside the document (1-${pageCount})`,
    {
      zh: `第 ${page} 页超出文档范围（共 ${pageCount} 页）。`,
      en: `Page ${page} is outside this document, which has ${pageCount} pages.`,
    },
    { page, pageCount },
  );
}

/** Resolves one endpoint of a span. `N` and `last` both mean the final page. */
function endpoint(raw: string, pageCount: number, expression: string): number {
  const token = raw.trim().toLowerCase();
  if (token === 'n' || token === 'last') return pageCount;
  if (token === 'first') return 1;
  if (!/^\d+$/.test(token)) throw invalid(expression, `"${raw}" is not a page number`);
  return Number(token);
}

function assertInRange(page: number, pageCount: number): number {
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    throw outOfRange(page, pageCount);
  }
  return page;
}

/** Returns 1-based page numbers, in the order the expression names them. */
export function parsePageRange(expression: string, pageCount: number): number[] {
  if (pageCount < 1) {
    throw new ToolError('INVALID_INPUT', `Page count must be >= 1, got ${pageCount}`, {
      zh: '文档没有任何页面。',
      en: 'The document has no pages.',
    });
  }

  const trimmed = expression.trim();
  if (trimmed === '') throw invalid(expression, 'expression is empty');

  const pages: number[] = [];

  for (const rawSegment of trimmed.split(',')) {
    const segment = rawSegment.trim().toLowerCase();
    if (segment === '') throw invalid(expression, 'empty segment between commas');

    // An optional `/step` suffix applies to whatever the segment resolves to.
    const [body, stepText, ...extra] = segment.split('/');
    if (extra.length > 0 || body === undefined) throw invalid(expression, 'too many "/" separators');

    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText.trim())) throw invalid(expression, `"${stepText}" is not a step`);
      step = Number(stepText.trim());
      if (step < 1) throw invalid(expression, 'step must be at least 1');
    }

    const selected = expandSegment(body.trim(), pageCount, expression);
    for (let i = 0; i < selected.length; i += step) {
      pages.push(selected[i] as number);
    }
  }

  return pages;
}

function expandSegment(body: string, pageCount: number, expression: string): number[] {
  if (body === '') throw invalid(expression, 'empty segment');

  if (KEYWORDS.has(body)) {
    switch (body) {
      case 'all':
        return Array.from({ length: pageCount }, (_, i) => i + 1);
      case 'first':
        return [1];
      case 'last':
        return [pageCount];
      case 'odd':
        return Array.from({ length: pageCount }, (_, i) => i + 1).filter((p) => p % 2 === 1);
      case 'even':
        return Array.from({ length: pageCount }, (_, i) => i + 1).filter((p) => p % 2 === 0);
    }
  }

  // A leading "-" is an open start (`-3`), not a negative number.
  const dashIndex = body.indexOf('-', body.startsWith('-') ? 0 : 1);
  const isSpan = body.startsWith('-') || dashIndex > 0;

  if (!isSpan) {
    return [assertInRange(endpoint(body, pageCount, expression), pageCount)];
  }

  const splitAt = body.startsWith('-') ? 0 : dashIndex;
  const startText = body.slice(0, splitAt).trim();
  const endText = body.slice(splitAt + 1).trim();

  const start = startText === '' ? 1 : assertInRange(endpoint(startText, pageCount, expression), pageCount);
  const end = endText === '' ? pageCount : assertInRange(endpoint(endText, pageCount, expression), pageCount);

  const stepDirection = start <= end ? 1 : -1;
  const run: number[] = [];
  for (let p = start; stepDirection > 0 ? p <= end : p >= end; p += stepDirection) {
    run.push(p);
  }
  return run;
}

/** True when the expression is well-formed — used for live validation in the form. */
export function isValidPageRange(expression: string, pageCount: number): boolean {
  try {
    parsePageRange(expression, pageCount);
    return true;
  } catch {
    return false;
  }
}

/** Renders a page list back into the compact `1-3, 5, 7-8` notation for display. */
export function formatPageRange(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (sorted.length === 0) return '—';

  const parts: string[] = [];
  let runStart = sorted[0] as number;
  let runEnd = runStart;

  for (const page of sorted.slice(1)) {
    if (page === runEnd + 1) {
      runEnd = page;
      continue;
    }
    parts.push(runStart === runEnd ? `${runStart}` : `${runStart}-${runEnd}`);
    runStart = page;
    runEnd = page;
  }
  parts.push(runStart === runEnd ? `${runStart}` : `${runStart}-${runEnd}`);

  return parts.join(', ');
}
