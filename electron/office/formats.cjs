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

function isOfficeDocumentPath(candidate) {
  return typeof candidate === 'string' && OFFICE_EXTENSIONS.has(path.extname(candidate).toLowerCase());
}

module.exports = { DOCUMENT_EXTENSIONS, OFFICE_EXTENSIONS, isOfficeDocumentPath };
