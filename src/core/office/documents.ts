import * as XLSX from 'xlsx';
import type { ToolOutputFile } from '../types.ts';
import { paragraphsToDocx } from '../ooxml/docx.ts';
import { slidesToPptx } from '../ooxml/pptx.ts';

export type OfficeDocumentKind = 'word' | 'sheet' | 'slide' | 'pdf';

const EXTENSION_KIND = new Map<string, OfficeDocumentKind>([
  ['.doc', 'word'],
  ['.docx', 'word'],
  ['.odt', 'word'],
  ['.rtf', 'word'],
  ['.xls', 'sheet'],
  ['.xlsx', 'sheet'],
  ['.ods', 'sheet'],
  ['.ppt', 'slide'],
  ['.pptx', 'slide'],
  ['.odp', 'slide'],
  ['.pdf', 'pdf'],
]);

export function documentKindFromName(name: string): OfficeDocumentKind | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSION_KIND.get(name.slice(dot).toLowerCase()) ?? null;
}

/** Creates the OOXML file that a New Word/Sheet/Presentation action starts from. */
export function createBlankOfficeDocument(kind: OfficeDocumentKind): ToolOutputFile {
  switch (kind) {
    case 'word':
      return {
        name: 'Untitled.docx',
        bytes: paragraphsToDocx(['']),
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
    case 'sheet': {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['']]), 'Sheet1');
      return {
        name: 'Untitled.xlsx',
        bytes: new Uint8Array(
          XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer,
        ),
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    }
    case 'slide':
      return {
        name: 'Untitled.pptx',
        bytes: slidesToPptx([{ title: '', body: [''] }]),
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      };
    default:
      throw new Error(`Unsupported Office document kind: ${kind}`);
  }
}
