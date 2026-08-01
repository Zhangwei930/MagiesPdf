import { stemOf } from '../../naming.ts';
import type { ToolContext, ToolInputFile, ToolResult } from '../../types.ts';

const OFFICE_MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export async function externalOfficeExport(
  ctx: ToolContext,
  file: ToolInputFile,
  extension: 'docx' | 'xlsx' | 'pptx',
): Promise<ToolResult | null> {
  if (!ctx.host?.hasExternalConverter(extension)) return null;
  const output = await ctx.host.externalConvert(file, extension, ctx.signal);
  ctx.report(1);
  return {
    files: [
      {
        name: `${stemOf(file.name)}.${extension}`,
        bytes: output.bytes,
        mime: OFFICE_MIME[extension] as string,
      },
    ],
    summary: {
      zh: `已通过外部转换器导出为 ${extension.toUpperCase()}`,
      en: `Exported as ${extension.toUpperCase()} via the external converter`,
    },
  };
}
