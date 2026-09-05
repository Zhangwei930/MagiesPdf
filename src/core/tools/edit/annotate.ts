import { ToolError } from '../../errors.ts';
import { writeAnnotations, type DocumentAnnotations } from '../../pdf/annotations.ts';
import { PDF_ONE, passwordParam, soleFile, stringParam } from '../shared.ts';
import type { ToolDescriptor } from '../../types.ts';

/**
 * Writes the marks the viewer drew into the document.
 *
 * Hidden, because there is nothing here a person could type: the parameters are
 * the geometry of a text selection or a pen stroke. It is a tool all the same,
 * and that is the point — an edit only reaches the worker, the undo history and
 * the dirty flag by being one. Rotating a page works exactly this way.
 *
 * The marks go in as `/Highlight` and `/Ink` annotations, so the text under a
 * highlight is still text and another reader can see, move or remove them.
 */

/** What the shell sends. Rejected loudly rather than silently half-applied. */
function parseAnnotations(raw: string): DocumentAnnotations {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError('INVALID_PARAM', 'annotations must be JSON', {
      zh: '批注数据不是有效的 JSON。',
      en: 'The annotation data is not valid JSON.',
    });
  }

  const value = parsed as Partial<DocumentAnnotations> | null;
  const highlights = Array.isArray(value?.highlights) ? value.highlights : [];
  const ink = Array.isArray(value?.ink) ? value.ink : [];
  if (highlights.length === 0 && ink.length === 0) {
    throw new ToolError('INVALID_PARAM', 'annotations contained nothing to write', {
      zh: '没有要写入的批注。',
      en: 'There are no annotations to write.',
    });
  }
  return { highlights, ink };
}

export const annotateTool: ToolDescriptor = {
  id: 'edit.annotate',
  category: 'edit',
  name: { zh: '写入批注', en: 'Write annotations' },
  description: {
    zh: '把高亮和墨迹写入 PDF，成为标准批注对象。',
    en: 'Writes highlights and ink into the PDF as standard annotation objects.',
  },
  icon: 'PenLine',
  keywords: [],
  hidden: true,
  pipelineable: false,
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'annotations',
      type: 'text',
      label: { zh: '批注数据', en: 'Annotation data' },
      help: {
        zh: '由查看器生成的 JSON，包含高亮矩形和墨迹点。',
        en: 'JSON produced by the viewer: highlight rectangles and ink points.',
      },
      default: '',
    },
    passwordParam(),
  ],
  runtime: 'worker',
  async run(ctx) {
    const file = soleFile(ctx);
    const annotations = parseAnnotations(stringParam(ctx, 'annotations'));
    const bytes = writeAnnotations(file.bytes, annotations, stringParam(ctx, 'password'));
    return { files: [{ name: file.name, mime: 'application/pdf', bytes }] };
  },
};
