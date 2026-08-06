/**
 * Checks what the user pasted into the external-MCP box before it is sent.
 *
 * The main process already refuses anything that is not valid JSON, but by then
 * the only thing it can say is that the text was not valid JSON. Doing it here
 * as well means the pane can point at the line — and can name the two things
 * that actually go wrong in practice: a snippet copied out of documentation
 * still carrying a `…`, or curly quotes from a rich-text editor.
 *
 * Pure, so it is tested without a DOM.
 */

export type McpConfigCheck =
  | { state: 'empty' }
  | { state: 'valid'; serverCount: number }
  | { state: 'invalid'; message: { zh: string; en: string } };

const SMART_QUOTES = /[‘’“”]/;
const ELLIPSIS = /[…]/;

/**
 * The line the parser tripped on, or 0 when it did not say.
 *
 * V8 words this two ways: "... at position 16 (line 2 column 7)" for most
 * syntax errors, and a truncated "Unexpected token '}', ...\"…\" is not valid
 * JSON" for others. Read the line it gives, fall back to computing one from the
 * offset, and say nothing when neither is there.
 */
function lineOf(text: string, error: unknown): number {
  const message = error instanceof Error ? error.message : '';

  const reported = Number(/line (\d+)/.exec(message)?.[1] ?? NaN);
  if (Number.isFinite(reported)) return reported;

  const position = Number(/position (\d+)/.exec(message)?.[1] ?? NaN);
  if (!Number.isFinite(position)) return 0;
  return text.slice(0, position).split('\n').length;
}

export function validateMcpConfigText(text: string): McpConfigCheck {
  const trimmed = text.trim();
  if (!trimmed) return { state: 'empty' };

  if (ELLIPSIS.test(trimmed)) {
    return {
      state: 'invalid',
      message: {
        zh: '配置里有省略号「…」，那是文档里的占位符，需要替换成真实的值。',
        en: 'The configuration still contains an ellipsis (…) — a documentation placeholder that must be replaced with a real value.',
      },
    };
  }

  if (SMART_QUOTES.test(trimmed)) {
    return {
      state: 'invalid',
      message: {
        zh: '配置里有中文/弯引号，JSON 只接受直引号 " 。',
        en: 'The configuration contains curly quotes; JSON only accepts straight quotes (").',
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    const line = lineOf(trimmed, cause);
    return {
      state: 'invalid',
      message: {
        zh: line ? `JSON 语法有误，大约在第 ${line} 行。` : 'JSON 语法有误。',
        en: line ? `Invalid JSON, around line ${line}.` : 'Invalid JSON.',
      },
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      state: 'invalid',
      message: {
        zh: '最外层需要是一个对象 { }。',
        en: 'The top level has to be an object ({ }).',
      },
    };
  }

  const root = parsed as Record<string, unknown>;
  // Both shapes are accepted: the documented wrapper, and the bare server map
  // people paste when they copy only the inner part.
  const servers = (root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers))
    ? root.mcpServers as Record<string, unknown>
    : root;

  const serverCount = Object.keys(servers).length;
  if (serverCount === 0) {
    return {
      state: 'invalid',
      message: {
        zh: '配置里没有任何 MCP Server。',
        en: 'The configuration contains no server.',
      },
    };
  }

  return { state: 'valid', serverCount };
}
