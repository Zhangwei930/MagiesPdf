import { ToolError } from './errors.ts';
import type { CategoryDescriptor, CategoryId, ToolDescriptor, ToolMeta } from './types.ts';

export const CATEGORIES: readonly CategoryDescriptor[] = [
  {
    id: 'organize',
    name: { zh: '组织', en: 'Organize' },
    description: { zh: '合并、拆分、排序、旋转页面', en: 'Merge, split, reorder and rotate pages' },
    icon: 'LayoutGrid',
  },
  {
    id: 'convert',
    name: { zh: '转换', en: 'Convert' },
    description: { zh: '在 PDF 与图片、文档、网页之间转换', en: 'Convert between PDF, images, documents and web pages' },
    icon: 'ArrowLeftRight',
  },
  {
    id: 'security',
    name: { zh: '安全', en: 'Security' },
    description: { zh: '密码、权限、水印、涂黑与签名', en: 'Passwords, permissions, watermarks, redaction and signing' },
    icon: 'ShieldCheck',
  },
  {
    id: 'edit',
    name: { zh: '编辑', en: 'Edit' },
    description: { zh: '压缩、修复、OCR、页码与附件', en: 'Compress, repair, OCR, page numbers and attachments' },
    icon: 'PenLine',
  },
  {
    id: 'advanced',
    name: { zh: '高级', en: 'Advanced' },
    description: { zh: '批量处理、流水线与自动化', en: 'Batch processing, pipelines and automation' },
    icon: 'Workflow',
  },
];

export type Locale = 'zh' | 'en';

/** Higher scores sort first. Gaps leave room for future tiers. */
const SCORE_ID_EXACT = 1000;
const SCORE_NAME_EXACT = 900;
const SCORE_NAME_PREFIX = 700;
const SCORE_NAME_SUBSTRING = 500;
const SCORE_KEYWORD = 300;
const SCORE_ID_SUBSTRING = 200;
const SCORE_DESCRIPTION = 100;

/**
 * Catalogue of tools, keyed by id.
 *
 * Generic over the entry type so the same lookup, grouping and search logic
 * serves both sides of the process boundary: the worker registers full
 * `ToolDescriptor`s, while the renderer registers `ToolMeta` it received as data.
 */
export class ToolRegistry<T extends ToolMeta = ToolDescriptor> {
  readonly #tools = new Map<string, T>();

  register(tool: T): void {
    if (this.#tools.has(tool.id)) {
      throw new Error(`Tool "${tool.id}" is already registered.`);
    }
    const [prefix, ...rest] = tool.id.split('.');
    if (rest.length !== 1 || !prefix || !rest[0]) {
      throw new Error(`Tool id "${tool.id}" must be dotted "category.name" form.`);
    }
    if (prefix !== tool.category) {
      throw new Error(
        `Tool id "${tool.id}" disagrees with its category "${tool.category}"; the prefix must match.`,
      );
    }
    this.#tools.set(tool.id, tool);
  }

  tryGet(id: string): T | undefined {
    return this.#tools.get(id);
  }

  get(id: string): T {
    const tool = this.#tools.get(id);
    if (!tool) {
      throw new ToolError('INVALID_INPUT', `Unknown tool "${id}"`, {
        zh: `找不到工具「${id}」，它可能已被重命名或移除。`,
        en: `No such tool "${id}". It may have been renamed or removed.`,
      });
    }
    return tool;
  }

  has(id: string): boolean {
    return this.#tools.has(id);
  }

  list(): T[] {
    return [...this.#tools.values()];
  }

  byCategory(category: CategoryId): T[] {
    return this.list().filter((t) => t.category === category);
  }

  /** Tools that can be used as pipeline nodes: they must produce files to chain. */
  pipelineTools(): T[] {
    return this.list().filter((t) => t.pipelineable !== false && t.output !== 'report');
  }

  /**
   * Ranked fuzzy-ish search for the ⌘K palette. Both languages are always searched
   * so a bilingual user can type either — `locale` only breaks ties.
   */
  search(query: string, locale: Locale = 'zh', limit = 50): T[] {
    const needle = query.trim().toLowerCase();
    if (needle === '') return this.list().slice(0, limit);

    const scored: Array<{ tool: T; score: number }> = [];

    for (const tool of this.#tools.values()) {
      const score = scoreTool(tool, needle, locale);
      if (score > 0) scored.push({ tool, score });
    }

    scored.sort((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id));
    return scored.slice(0, limit).map((s) => s.tool);
  }
}

function scoreTool(tool: ToolMeta, needle: string, locale: Locale): number {
  const id = tool.id.toLowerCase();
  if (id === needle) return SCORE_ID_EXACT;

  const names = [tool.name.zh, tool.name.en].map((n) => n.toLowerCase());
  let best = 0;

  for (const name of names) {
    if (name === needle) best = Math.max(best, SCORE_NAME_EXACT);
    else if (name.startsWith(needle)) best = Math.max(best, SCORE_NAME_PREFIX);
    else if (name.includes(needle)) best = Math.max(best, SCORE_NAME_SUBSTRING);
  }

  if (best === 0) {
    if (tool.keywords.some((k) => k.toLowerCase().includes(needle))) best = SCORE_KEYWORD;
    else if (id.includes(needle)) best = SCORE_ID_SUBSTRING;
    else if (
      [tool.description.zh, tool.description.en].some((d) => d.toLowerCase().includes(needle))
    ) {
      best = SCORE_DESCRIPTION;
    }
  }

  // Nudge matches in the reading language ahead of equally-scored ones.
  if (best > 0 && tool.name[locale].toLowerCase().includes(needle)) best += 10;
  return best;
}

/** The application-wide catalogue. Populated by `src/core/tools/index.ts`. */
export const registry = new ToolRegistry<ToolDescriptor>();
