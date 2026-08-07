const path = require('node:path');

const OFFICE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.odt',
  '.rtf',
  '.xls',
  '.xlsx',
  '.ods',
  '.ppt',
  '.pptx',
  '.odp',
]);

const DOCUMENT_EXTENSIONS = new Set(['.pdf', ...OFFICE_EXTENSIONS]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp']);

function isOfficeDocumentPath(candidate) {
  return typeof candidate === 'string' && OFFICE_EXTENSIONS.has(path.extname(candidate).toLowerCase());
}

/**
 * Filters for the OS Save As dialog — path + type in one step, like WPS.
 *
 * Labels mirror the wording users see in WPS / Word ("Microsoft Word 文件
 * (*.docx)"), so the system panel's type dropdown reads the same way. The
 * extension the user picks still decides how we convert.
 */
function officeSaveAsFilters(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.pdf') {
    return [{ name: 'PDF 文件 (*.pdf)', extensions: ['pdf'] }];
  }
  if (ext === '.xlsx' || ext === '.xls' || ext === '.ods') {
    return [
      { name: 'Microsoft Excel 文件 (*.xlsx)', extensions: ['xlsx'] },
      { name: 'PDF 文件 (*.pdf)', extensions: ['pdf'] },
      { name: 'OpenDocument 表格 (*.ods)', extensions: ['ods'] },
    ];
  }
  if (ext === '.pptx' || ext === '.ppt' || ext === '.odp') {
    return [
      { name: 'Microsoft PowerPoint 演示文稿 (*.pptx)', extensions: ['pptx'] },
      { name: 'PDF 文件 (*.pdf)', extensions: ['pdf'] },
      { name: 'OpenDocument 演示文稿 (*.odp)', extensions: ['odp'] },
    ];
  }
  // Word is the default for unknown / .docx / .doc / .odt / .rtf.
  return [
    { name: 'Microsoft Word 文件 (*.docx)', extensions: ['docx'] },
    { name: 'PDF 文件 (*.pdf)', extensions: ['pdf'] },
    { name: 'OpenDocument 文本 (*.odt)', extensions: ['odt'] },
    { name: 'RTF 文件 (*.rtf)', extensions: ['rtf'] },
  ];
}

/**
 * Options for the system Save As panel — same shape as WPS: name field,
 * type dropdown, Save / Cancel. macOS labels the name field in Chinese.
 */
function officeSaveAsDialogOptions(name) {
  const suggested = String(name || 'document.docx');
  return {
    title: '另存为',
    defaultPath: suggested,
    buttonLabel: '保存',
    filters: officeSaveAsFilters(suggested),
    // macOS only — matches WPS's "文件名称" row above the type dropdown.
    nameFieldLabel: '文件名称',
    showsTagField: false,
  };
}

/** `报告.docx` → `报告.pdf` for the dedicated “输出为 PDF” action. */
function pdfExportName(name) {
  const base = String(name || 'document');
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem || 'document'}.pdf`;
}

module.exports = {
  DOCUMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  OFFICE_EXTENSIONS,
  isOfficeDocumentPath,
  officeSaveAsFilters,
  officeSaveAsDialogOptions,
  pdfExportName,
};
