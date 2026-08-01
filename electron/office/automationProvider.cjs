'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createOfficeWorkspace } = require('./workspace.cjs');

const WORD_EXTENSIONS = new Set(['.doc', '.docx', '.odt', '.rtf']);
const EXCEL_EXTENSIONS = new Set(['.xls', '.xlsx', '.ods']);
const PRESENTATION_EXTENSIONS = new Set(['.ppt', '.pptx', '.odp']);
const CONVERTIBLE_EXTENSIONS = new Set([...WORD_EXTENSIONS, ...EXCEL_EXTENSIONS, ...PRESENTATION_EXTENSIONS]);
const CELL_REFERENCE = /^[A-Za-z]{1,3}[1-9]\d*$/;
const RANGE_REFERENCE = /^[A-Za-z]{1,3}[1-9]\d*(?::[A-Za-z]{1,3}[1-9]\d*)?$/;
const DEFAULT_OUTPUT_DIRECTORY = 'Magies Office Output';

function schema(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, required };
}

function tool(functionName, name, description, parameters) {
  return {
    functionName,
    toolId: `office:${functionName.replace(/^office_/, '').replaceAll('_', ':')}`,
    name,
    requiresApproval: true,
    providerTool: {
      type: 'function',
      function: { name: functionName, description, parameters },
    },
  };
}

const PATH_PROPERTY = {
  type: 'string',
  description: 'Document path relative to the user-granted workspace. Never use an absolute path.',
};

const OUTPUT_DIRECTORY_PROPERTY = {
  type: 'string',
  description: `Output directory relative to the workspace. Defaults to "${DEFAULT_OUTPUT_DIRECTORY}".`,
};

const OFFICE_AUTOMATION_TOOLS = Object.freeze([
  tool(
    'office_workspace_list',
    { zh: '扫描办公目录', en: 'Scan office workspace' },
    'List supported Office and PDF documents inside the user-granted workspace. Returns relative paths and metadata only.',
    schema({
      query: { type: 'string', description: 'Optional case-insensitive text contained in the relative path.' },
      recursive: { type: 'boolean', description: 'Scan nested folders. Defaults to true.' },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 20,
        description: 'Optional extensions such as .docx, .xlsx, .pptx, or .pdf.',
      },
    }),
  ),
  tool(
    'office_word_read',
    { zh: '读取 Word 内容', en: 'Read Word content' },
    'Read text from a Word document in the granted workspace. The returned text is sent to the AI model after user approval.',
    schema({ path: PATH_PROPERTY }, ['path']),
  ),
  tool(
    'office_word_replace',
    { zh: '替换 Word 文本', en: 'Replace Word text' },
    'Replace text in a Word document using LibreOffice and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      find: { type: 'string', minLength: 1, maxLength: 2000 },
      replace: { type: 'string', maxLength: 20000 },
      match_case: { type: 'boolean', description: 'Use case-sensitive matching. Defaults to true.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'find', 'replace']),
  ),
  tool(
    'office_excel_read',
    { zh: '读取 Excel 区域', en: 'Read Excel range' },
    'Read cell values and formulas from an Excel workbook. The returned cells are sent to the AI model after user approval.',
    schema({
      path: PATH_PROPERTY,
      sheet: { type: 'string', maxLength: 128, description: 'Worksheet name. Defaults to the first sheet.' },
      range: { type: 'string', description: 'Optional A1 range such as A1:F40. The used area is read when omitted.' },
    }, ['path']),
  ),
  tool(
    'office_excel_write',
    { zh: '写入 Excel 区域', en: 'Write Excel range' },
    'Write a rectangular array of values or formulas to an Excel workbook and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      sheet: { type: 'string', maxLength: 128, description: 'Worksheet name. Defaults to the first sheet.' },
      start_cell: { type: 'string', description: 'Top-left A1 cell, for example B2.' },
      values: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: { type: 'array', minItems: 1, maxItems: 50, items: { type: ['string', 'number', 'boolean', 'null'] } },
      },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'start_cell', 'values']),
  ),
  tool(
    'office_presentation_read',
    { zh: '读取 PPT 内容', en: 'Read presentation content' },
    'Read text grouped by slide from a PowerPoint presentation. The returned text is sent to the AI model after user approval.',
    schema({ path: PATH_PROPERTY }, ['path']),
  ),
  tool(
    'office_presentation_replace',
    { zh: '替换 PPT 文本', en: 'Replace presentation text' },
    'Replace text across PowerPoint slides using LibreOffice and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      find: { type: 'string', minLength: 1, maxLength: 2000 },
      replace: { type: 'string', maxLength: 20000 },
      match_case: { type: 'boolean', description: 'Use case-sensitive matching. Defaults to true.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'find', 'replace']),
  ),
  tool(
    'office_batch_convert_pdf',
    { zh: '批量转为 PDF', en: 'Batch convert to PDF' },
    'Convert Word, Excel, or PowerPoint documents to PDF with LibreOffice. Outputs never overwrite existing files.',
    schema({
      paths: { type: 'array', minItems: 1, maxItems: 50, items: PATH_PROPERTY },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['paths']),
  ),
  tool(
    'office_workspace_archive',
    { zh: '归档办公文件', en: 'Archive office files' },
    'Copy or move documents into a folder inside the granted workspace. Existing files are never overwritten.',
    schema({
      paths: { type: 'array', minItems: 1, maxItems: 50, items: PATH_PROPERTY },
      destination: { type: 'string', description: 'Archive directory relative to the workspace.' },
      mode: { type: 'string', enum: ['copy', 'move'], description: 'Defaults to copy so source files are preserved.' },
    }, ['paths', 'destination']),
  ),
]);

function requireExtension(inputPath, allowed, label) {
  if (!allowed.has(path.extname(inputPath).toLowerCase())) {
    throw new Error(`${label} requires a supported ${label} document`);
  }
}

function stringValue(value, label, { required = false, maxLength = 20000 } = {}) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && value === '') || value.length > maxLength) {
    throw new Error(`${label} must be ${required ? 'a non-empty ' : 'a '}string no longer than ${maxLength} characters`);
  }
  return value;
}

function pathList(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50 || value.some((item) => typeof item !== 'string')) {
    throw new Error('paths must contain between 1 and 50 relative document paths');
  }
  return value;
}

function excelValues(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new Error('values must contain between 1 and 200 rows');
  }
  let width = -1;
  let cells = 0;
  for (const row of value) {
    if (!Array.isArray(row) || row.length === 0 || row.length > 50) {
      throw new Error('Each values row must contain between 1 and 50 cells');
    }
    if (width === -1) width = row.length;
    if (row.length !== width) throw new Error('values must be a rectangular array');
    for (const cell of row) {
      if (cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)) {
        throw new Error('Excel cells may only contain strings, numbers, booleans, or null');
      }
    }
    cells += row.length;
  }
  if (cells > 5000) throw new Error('At most 5000 Excel cells may be written at once');
  return value;
}

function createOfficeAutomationProvider({
  workspace = createOfficeWorkspace(),
  getLibreOfficeExecutable,
  runUno,
  fileSystem = fs,
} = {}) {
  if (typeof getLibreOfficeExecutable !== 'function') {
    throw new TypeError('getLibreOfficeExecutable is required');
  }
  if (typeof runUno !== 'function') throw new TypeError('runUno is required');

  const requireLibreOffice = () => {
    const executable = getLibreOfficeExecutable();
    if (!executable) throw new Error('LibreOffice is unavailable; reinstall or configure Magies Office');
    return executable;
  };

  const callUno = (request, options) => runUno({
    ...request,
    executable: requireLibreOffice(),
    signal: options?.signal,
  });

  const callTool = async (functionName, rawArgs = {}, options = {}) => {
    const definition = OFFICE_AUTOMATION_TOOLS.find((candidate) => candidate.functionName === functionName);
    if (!definition) throw new Error(`Unknown Office Agent tool: ${functionName}`);
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};

    if (functionName === 'office_workspace_list') {
      return workspace.listDocuments({
        recursive: args.recursive !== false,
        query: stringValue(args.query, 'query', { maxLength: 500 }),
        extensions: args.extensions,
      });
    }

    if (functionName === 'office_word_read') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, WORD_EXTENSIONS, 'Word');
      const result = await callUno({ operation: 'word_read', inputPath }, options);
      return { path: relativePath, ...result };
    }

    if (functionName === 'office_word_replace') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const find = stringValue(args.find, 'find', { required: true, maxLength: 2000 });
      const replace = stringValue(args.replace, 'replace', { maxLength: 20000 });
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, WORD_EXTENSIONS, 'Word');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'word_replace',
        inputPath,
        outputPath: output.absolutePath,
        find,
        replace,
        matchCase: args.match_case !== false,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        replacementCount: Number(result.replacementCount) || 0,
      };
    }

    if (functionName === 'office_excel_read') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const range = stringValue(args.range, 'range', { maxLength: 50 });
      if (range && !RANGE_REFERENCE.test(range)) throw new Error('range must use A1 notation such as A1:F40');
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, EXCEL_EXTENSIONS, 'Excel');
      const result = await callUno({
        operation: 'excel_read',
        inputPath,
        sheet: stringValue(args.sheet, 'sheet', { maxLength: 128 }),
        range: range.toUpperCase(),
      }, options);
      return { path: relativePath, ...result };
    }

    if (functionName === 'office_excel_write') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const startCell = stringValue(args.start_cell, 'start_cell', { required: true, maxLength: 20 }).toUpperCase();
      if (!CELL_REFERENCE.test(startCell)) throw new Error('start_cell must use A1 notation such as B2');
      const values = excelValues(args.values);
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, EXCEL_EXTENSIONS, 'Excel');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'excel_write',
        inputPath,
        outputPath: output.absolutePath,
        sheet: stringValue(args.sheet, 'sheet', { maxLength: 128 }),
        startCell,
        values,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        cellsWritten: Number(result.cellsWritten) || 0,
      };
    }

    if (functionName === 'office_presentation_read') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, PRESENTATION_EXTENSIONS, 'PowerPoint');
      const result = await callUno({ operation: 'presentation_read', inputPath }, options);
      return { path: relativePath, ...result };
    }

    if (functionName === 'office_presentation_replace') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const find = stringValue(args.find, 'find', { required: true, maxLength: 2000 });
      const replace = stringValue(args.replace, 'replace', { maxLength: 20000 });
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, PRESENTATION_EXTENSIONS, 'PowerPoint');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'presentation_replace',
        inputPath,
        outputPath: output.absolutePath,
        find,
        replace,
        matchCase: args.match_case !== false,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        replacementCount: Number(result.replacementCount) || 0,
      };
    }

    if (functionName === 'office_batch_convert_pdf') {
      const paths = pathList(args.paths);
      const outputDirectory = stringValue(args.output_directory, 'output_directory', { maxLength: 1000 })
        || DEFAULT_OUTPUT_DIRECTORY;
      const written = [];
      for (let index = 0; index < paths.length; index += 1) {
        const inputPath = await workspace.resolveInput(paths[index]);
        requireExtension(inputPath, CONVERTIBLE_EXTENSIONS, 'Office');
        const output = await workspace.uniqueOutputPath(
          outputDirectory,
          `${path.basename(inputPath, path.extname(inputPath))}.pdf`,
        );
        await callUno({ operation: 'convert_pdf', inputPath, outputPath: output.absolutePath }, options);
        written.push(output.relativePath);
        options.onProgress?.((index + 1) / paths.length);
      }
      return { converted: written.length, written };
    }

    const paths = pathList(args.paths);
    const destination = stringValue(args.destination, 'destination', { required: true, maxLength: 1000 });
    const mode = args.mode === undefined ? 'copy' : args.mode;
    if (mode !== 'copy' && mode !== 'move') throw new Error('mode must be copy or move');
    const written = [];
    for (let index = 0; index < paths.length; index += 1) {
      const inputPath = await workspace.resolveInput(paths[index]);
      const output = await workspace.uniqueOutputPath(destination, path.basename(inputPath));
      await fileSystem.copyFile(inputPath, output.absolutePath, constants.COPYFILE_EXCL);
      if (mode === 'move') await fileSystem.unlink(inputPath);
      written.push(output.relativePath);
      options.onProgress?.((index + 1) / paths.length);
    }
    return { mode, archived: written.length, written };
  };

  const listTools = async () => workspace.getStatus().configured
    ? OFFICE_AUTOMATION_TOOLS.map((definition) => ({ ...definition }))
    : [];

  return {
    callTool,
    clearWorkspace: workspace.clear,
    getWorkspaceStatus: workspace.getStatus,
    listTools,
    setWorkspaceRoot: workspace.setRoot,
  };
}

module.exports = {
  DEFAULT_OUTPUT_DIRECTORY,
  OFFICE_AUTOMATION_TOOLS,
  createOfficeAutomationProvider,
  excelValues,
};
