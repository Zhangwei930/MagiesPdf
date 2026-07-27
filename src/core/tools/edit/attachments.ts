import { ToolError } from '../../errors.ts';
import { openDocument, saveDocument, withDocumentSync } from '../../pdf/document.ts';
import { sanitizeFileName, suffixedName } from '../../naming.ts';
import type { ToolDescriptor, ToolOutputFile } from '../../types.ts';
import {
  PDF_ONE,
  passwordParam,
  pdfOutput,
  soleFile,
  stringParam,
} from '../shared.ts';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function mimeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 && MIME_BY_EXTENSION[name.slice(dot).toLowerCase()]) || 'application/octet-stream';
}

export const extractAttachmentsTool: ToolDescriptor = {
  id: 'edit.extract-attachments',
  category: 'edit',
  name: { zh: '提取附件', en: 'Extract Attachments' },
  description: {
    zh: '把 PDF 里内嵌的附件文件全部取出来。',
    en: 'Pull every embedded attachment out of a PDF.',
  },
  icon: 'Paperclip',
  keywords: ['attachment', 'embedded', 'files', 'extract', '附件', '内嵌文件', '提取'],
  input: PDF_ONE,
  output: 'multiple',
  params: [passwordParam()],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);

    return withDocumentSync(file.bytes, stringParam(ctx, 'password'), (doc) => {
      const embedded = doc.getEmbeddedFiles();
      const entries = Object.entries(embedded);

      if (entries.length === 0) {
        throw new ToolError('EMPTY_RESULT', 'Document has no embedded files', {
          zh: '这个文档里没有内嵌附件。',
          en: 'This document carries no embedded attachments.',
        });
      }

      const files: ToolOutputFile[] = entries.map(([name, filespec]) => {
        const params = doc.getFilespecParams(filespec);
        const buffer = doc.getEmbeddedFileContents(filespec);
        const bytes = buffer ? new Uint8Array(buffer.asUint8Array()) : new Uint8Array(0);
        const outName = sanitizeFileName(params?.filename || name);
        return { name: outName, bytes, mime: params?.mimetype || mimeFor(outName) };
      });

      ctx.report(1);
      return {
        files,
        summary: {
          zh: `已提取 ${files.length} 个附件`,
          en: `Extracted ${files.length} attachments`,
        },
      };
    });
  },
};

export const addAttachmentsTool: ToolDescriptor = {
  id: 'edit.add-attachments',
  category: 'edit',
  name: { zh: '添加附件', en: 'Add Attachments' },
  description: {
    zh: '把任意文件内嵌进 PDF 随文档一起分发。第一个文件是 PDF，其余作为附件。',
    en: 'Embed files into a PDF so they travel with it. First file is the PDF; the rest become attachments.',
  },
  icon: 'Paperclip',
  keywords: ['attach', 'embed', 'files', 'bundle', '附件', '内嵌', '打包'],
  input: {
    accept: ['.pdf', '.txt', '.md', '.csv', '.json', '.xml', '.png', '.jpg', '.jpeg', '.zip', '.docx', '.xlsx', '.pptx'],
    min: 2,
    max: null,
    ordered: true,
  },
  output: 'single',
  params: [passwordParam()],
  runtime: 'worker',

  async run(ctx) {
    const [host, ...attachments] = ctx.files;
    if (!host || !host.name.toLowerCase().endsWith('.pdf')) {
      throw new ToolError('INVALID_INPUT', 'First input must be the host PDF', {
        zh: '第一个文件必须是 PDF（作为宿主文档），后面的文件才是要内嵌的附件。',
        en: 'The first file must be the host PDF; the files after it become the attachments.',
      });
    }
    if (attachments.length === 0) {
      throw new ToolError('INVALID_INPUT', 'No attachments supplied', {
        zh: '请在 PDF 之后再添加至少一个要内嵌的文件。',
        en: 'Add at least one file after the PDF to embed.',
      });
    }

    const doc = openDocument(host.bytes, stringParam(ctx, 'password'));
    try {
      const now = new Date();
      for (const attachment of attachments) {
        const filespec = doc.addEmbeddedFile(
          attachment.name,
          attachment.mime || mimeFor(attachment.name),
          attachment.bytes,
          now,
          now,
        );
        doc.insertEmbeddedFile(attachment.name, filespec);
      }

      const bytes = saveDocument(doc, { garbage: 'compact' });
      ctx.report(1);

      return {
        files: [pdfOutput(suffixedName(host.name, '_bundled', '.pdf'), bytes)],
        summary: {
          zh: `已内嵌 ${attachments.length} 个附件`,
          en: `Embedded ${attachments.length} attachments`,
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
