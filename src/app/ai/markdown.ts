import { Marked, type RendererObject, type Tokens } from 'marked';

/**
 * Markdown → HTML for what a model says, on the assumption that it is hostile.
 *
 * The text on this path is not the user's. A turn can read a document the user
 * opened, and a document can carry instructions written by whoever produced it,
 * so an answer is reachable by someone who is not in the room. It then lands in
 * `dangerouslySetInnerHTML`, in a renderer holding a bridge that reads and
 * writes files.
 *
 * marked emits raw HTML unchanged — it dropped `sanitize` in v5 and says to
 * sanitise downstream — so this is that downstream. The page's CSP stops a
 * `<script>` and an `onerror` from running, but a CSP is the second line: it
 * still allows inline *styles*, which is enough to repaint the pane as a form
 * asking for the API key the app really does ask for, and it allows a loopback
 * frame, which is where this app's own editor host and REST API listen.
 *
 * So: raw HTML is escaped into visible text rather than adopted — an answer
 * explaining some markup should show it, not become it — and links and images
 * are held to the schemes that can do no more than a browser would.
 *
 * Pure, so it is tested without a DOM.
 */

/** Schemes a link may keep. Matches `isExternalUrlAllowed` in the main process,
 *  which is what decides whether the click is actually handed to the desktop. */
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Schemes an image may load. This is `img-src 'self' data: blob:` from the
 * page's CSP, and nothing wider.
 *
 * `http:` and `https:` were listed here and the CSP never allowed them, so a
 * remote image was rendered as an `<img>` the page then refused to load — a
 * broken picture with no explanation. Widening the CSP instead would let a
 * document decide what this window fetches, which is the thing that policy
 * exists to prevent; the alt text is what the model was describing anyway.
 */
const IMAGE_SCHEMES = new Set(['data:', 'blob:']);

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * The url as an attribute, or null to render the element as plain text.
 *
 * Parsing rather than pattern-matching, because `java\nscript:` and friends are
 * a url parser's problem to normalise, not a regex's. The result is re-escaped:
 * a parsed url can still carry a quote through its query or fragment.
 */
function safeUrl(href: string, schemes: Set<string>): string | null {
  if (typeof href !== 'string' || href === '') return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!schemes.has(url.protocol)) return null;
  // A `data:` image is allowed; `data:text/html` is a document, and is not.
  if (url.protocol === 'data:' && !url.pathname.startsWith('image/')) return null;
  return escapeHtml(url.href);
}

const renderer: RendererObject = {
  /** Raw HTML, block or inline, shown as the text it is. */
  html({ text }: Tokens.HTML | Tokens.Tag): string {
    return escapeHtml(text);
  },

  link({ href, title, tokens }: Tokens.Link): string {
    const text = this.parser.parseInline(tokens);
    const url = safeUrl(href, LINK_SCHEMES);
    if (url === null) return text;
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    // Nothing in this window may navigate, so a link that is not marked to open
    // outside it is a link that silently does nothing when clicked. The main
    // process re-checks the scheme before the desktop is handed anything.
    return `<a href="${url}"${titleAttribute} target="_blank" rel="noopener noreferrer">${text}</a>`;
  },

  image({ href, title, text }: Tokens.Image): string {
    const url = safeUrl(href, IMAGE_SCHEMES);
    if (url === null) return escapeHtml(text);
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${url}" alt="${escapeHtml(text)}"${titleAttribute}>`;
  },
};

const parser = new Marked({ gfm: true, breaks: false }).use({ renderer });

export function renderAssistantMarkdown(text: string): string {
  if (!text) return '';
  return parser.parse(text, { async: false }) as string;
}
