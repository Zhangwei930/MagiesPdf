'use strict';

/**
 * Markdown → the structures the composing tools already take.
 *
 * A model is far better at writing a whole document in one pass than at
 * emitting a dozen styling calls in the right order: the long call chain is
 * where a smaller model loses the plan and stops half-styled. Letting it write
 * Markdown plays to what it does best and leaves every design decision on this
 * side, which is the same split the big assistant apps use — outline from the
 * model, layout from a renderer.
 *
 * The grammar is deliberately small. Anything it does not recognise becomes
 * body text rather than an error: a deck with a stray line in it beats a tool
 * call that failed.
 */

const FENCE = /^```(\w+)?\s*$/;

function lines(markdown) {
  return String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
}

/** Tabs count as four columns, the width every editor renders them at. */
function indentWidth(prefix) {
  return [...prefix].reduce((width, character) => width + (character === '\t' ? 4 : 1), 0);
}

/** `- item` / `1. item` → its text, whether it is ordered, and how far it is in. */
function listItem(line) {
  const unordered = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (unordered) {
    return { text: unordered[2].trim(), ordered: false, indent: indentWidth(unordered[1]) };
  }
  const ordered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
  if (ordered) {
    return { text: ordered[2].trim(), ordered: true, indent: indentWidth(ordered[1]) };
  }
  return null;
}

/** How deep a list item sits, per `MAX_LIST_LEVEL`. */
const MAX_LIST_LEVEL = 4;

/**
 * Turns the indentation seen so far into a level.
 *
 * Counting spaces would have to pick a width, and two and four are both
 * ordinary Markdown — a model will use either, sometimes in the same document.
 * Keeping the widths that have actually been opened means the shape of the
 * indentation decides, so coming back out lands on the level it left.
 */
function listLevel(openIndents, indent) {
  while (openIndents.length > 0 && indent < openIndents[openIndents.length - 1]) {
    openIndents.pop();
  }
  if (openIndents.length === 0 || indent > openIndents[openIndents.length - 1]) {
    openIndents.push(indent);
  }
  return Math.min(openIndents.length - 1, MAX_LIST_LEVEL);
}

/** Strips the inline marks that would otherwise be read aloud as characters. */
function plainText(value) {
  return String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)\*([^*]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function heading(line) {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, text: plainText(match[2]) };
}

function image(line) {
  const match = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
  if (!match) return null;
  return { alt: plainText(match[1]), path: match[2].trim() };
}

/** ```chart fences carry the numbers a chart slide needs, as JSON. */
function chartSpec(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const series = Array.isArray(parsed.series) ? parsed.series : [];
  if (!Array.isArray(parsed.categories) || series.length === 0) return null;
  return {
    chart_type: typeof parsed.type === 'string' ? parsed.type : 'column',
    categories: parsed.categories,
    series,
  };
}

/** ```kpi fences hold one `value | label` per line. */
function kpiSpec(body) {
  const entries = body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, ...rest] = line.split('|');
      return { value: plainText(value), label: plainText(rest.join('|')) };
    })
    .filter((entry) => entry.value !== '');
  return entries.length > 0 ? entries : null;
}

/**
 * Markdown → slides for office_presentation_compose.
 *
 * - the first `#` is the cover, later ones are section dividers
 * - `##` starts a content slide
 * - `-` bullets fill it; a numbered list becomes the steps layout instead
 * - `>` becomes a quote slide, `![](path)` an image slide
 * - ```chart and ```kpi fences become those layouts
 * - `---` forces a new slide
 */
function slidesFromMarkdown(markdown) {
  const slides = [];
  let current = null;
  let seenCover = false;
  let fence = null;
  let fenceBody = [];

  const flush = () => {
    if (current && (current.title || (current.body && current.body.length > 0)
      || current.kpis || current.categories || current.image_path || current.subtitle)) {
      slides.push(current);
    }
    current = null;
  };

  for (const line of lines(markdown)) {
    const fenceMatch = FENCE.exec(line.trim());
    if (fenceMatch) {
      if (fence === null) {
        fence = (fenceMatch[1] || '').toLowerCase();
        fenceBody = [];
      } else {
        const body = fenceBody.join('\n');
        if (fence === 'chart') {
          const spec = chartSpec(body);
          if (spec) {
            const title = current?.title || '';
            flush();
            slides.push({ layout: 'chart', title, ...spec });
          }
        } else if (fence === 'kpi') {
          const entries = kpiSpec(body);
          if (entries) {
            const title = current?.title || '';
            flush();
            slides.push({ layout: 'kpi', title, kpis: entries });
          }
        }
        fence = null;
        fenceBody = [];
      }
      continue;
    }
    if (fence !== null) {
      fenceBody.push(line);
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      flush();
      continue;
    }

    const head = heading(line);
    if (head) {
      flush();
      if (head.level === 1 && !seenCover) {
        seenCover = true;
        current = { layout: 'title', title: head.text, body: [] };
      } else if (head.level === 1) {
        current = { layout: 'section', title: head.text, body: [] };
      } else {
        current = { layout: 'bullets', title: head.text, body: [] };
      }
      continue;
    }

    const picture = image(line);
    if (picture) {
      const title = current?.title || plainText(picture.alt);
      const body = current?.body ?? [];
      flush();
      slides.push({ layout: 'image', title, image_path: picture.path, body });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const text = plainText(quote[1]);
      if (!text) continue;
      if (current && current.layout === 'quote') {
        current.body.push(text);
      } else {
        flush();
        current = { layout: 'quote', title: text, body: [] };
      }
      continue;
    }

    const item = listItem(line);
    if (item && item.text) {
      if (!current) current = { layout: 'bullets', title: '', body: [] };
      // A numbered list is a process, and reads far better as one.
      if (item.ordered && current.layout === 'bullets' && current.body.length === 0) {
        current.layout = 'steps';
      }
      current.body.push(plainText(item.text));
      continue;
    }

    const text = plainText(line);
    if (!text) continue;
    if (!current) {
      current = { layout: 'bullets', title: '', body: [] };
    }
    if (current.layout === 'title' && !current.subtitle) {
      current.subtitle = text;
      continue;
    }
    current.body.push(text);
  }
  flush();
  return slides;
}

/**
 * Markdown → blocks for office_word_append.
 *
 * The first `#` is the document title; `#`/`##`/`###` map onto the real
 * heading styles, so the navigator and the table of contents work.
 */
function blocksFromMarkdown(markdown) {
  const blocks = [];
  let seenTitle = false;
  let fence = null;
  /** Indent widths currently open, innermost last. A heading closes them all. */
  const openIndents = [];

  for (const line of lines(markdown)) {
    if (FENCE.test(line.trim())) {
      fence = fence === null ? '' : null;
      continue;
    }
    if (fence !== null) {
      const code = line.trimEnd();
      if (code) blocks.push({ style: 'body', text: code });
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) continue;

    const head = heading(line);
    if (head) {
      // A heading ends whatever list was open, so the next one starts over.
      openIndents.length = 0;
      if (head.level === 1 && !seenTitle) {
        seenTitle = true;
        blocks.push({ style: 'title', text: head.text });
      } else {
        const style = head.level <= 2 ? `heading${Math.max(1, head.level)}` : 'heading3';
        blocks.push({ style, text: head.text });
      }
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const text = plainText(quote[1]);
      if (text) blocks.push({ style: 'quote', text });
      continue;
    }

    const item = listItem(line);
    if (item && item.text) {
      blocks.push({
        style: item.ordered ? 'number' : 'bullet',
        text: plainText(item.text),
        level: listLevel(openIndents, item.indent),
      });
      continue;
    }

    const text = plainText(line);
    if (text) {
      openIndents.length = 0;
      blocks.push({ style: 'body', text });
    }
  }
  return blocks;
}

module.exports = { blocksFromMarkdown, slidesFromMarkdown };
