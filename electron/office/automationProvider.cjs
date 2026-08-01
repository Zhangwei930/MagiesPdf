'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createOfficeWorkspace } = require('./workspace.cjs');
const { IMAGE_EXTENSIONS } = require('./formats.cjs');

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
    'List supported Office, PDF, and image files inside the user-granted workspace. Returns relative paths and metadata only.',
    schema({
      query: { type: 'string', description: 'Optional case-insensitive text contained in the relative path.' },
      recursive: { type: 'boolean', description: 'Scan nested folders. Defaults to true.' },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 20,
        description: 'Optional extensions such as .docx, .xlsx, .pptx, .pdf, or .png.',
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
    'office_word_read_changes',
    { zh: '读取 Word 修订', en: 'Read Word tracked changes' },
    'Read bounded tracked-change metadata and text from a Word document after user approval.',
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
    'office_word_replace_tracked',
    { zh: '修订模式替换 Word 文本', en: 'Replace Word text with tracking' },
    'Replace Word text while recording the edits as tracked changes, then save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      find: { type: 'string', minLength: 1, maxLength: 2000 },
      replace: { type: 'string', maxLength: 20000 },
      match_case: { type: 'boolean', description: 'Use case-sensitive matching. Defaults to true.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'find', 'replace']),
  ),
  tool(
    'office_word_insert_table',
    { zh: '插入 Word 表格', en: 'Insert Word table' },
    'Append a table to a Word document and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      values: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: { type: ['string', 'number', 'boolean', 'null'] },
        },
      },
      has_header: { type: 'boolean', description: 'Bold and shade the first row. Defaults to false.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'values']),
  ),
  tool(
    'office_word_insert_image',
    { zh: '插入 Word 图片', en: 'Insert Word image' },
    'Append an image from the granted workspace to a Word document and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      image_path: { ...PATH_PROPERTY, description: 'Image path relative to the user-granted workspace.' },
      width_mm: { type: 'number', minimum: 1, maximum: 300 },
      height_mm: { type: 'number', minimum: 1, maximum: 300 },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'image_path']),
  ),
  tool(
    'office_word_set_header_footer',
    { zh: '设置 Word 页眉页脚', en: 'Set Word header and footer' },
    'Set or clear the active Word page style header and footer, then save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      header: { type: 'string', maxLength: 20000, description: 'Header text. Use an empty string to disable it.' },
      footer: { type: 'string', maxLength: 20000, description: 'Footer text. Use an empty string to disable it.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path']),
  ),
  tool(
    'office_word_add_comment',
    { zh: '添加 Word 批注', en: 'Add Word comment' },
    'Add a comment to one matching text occurrence in a Word document and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      find: { type: 'string', minLength: 1, maxLength: 2000 },
      comment: { type: 'string', minLength: 1, maxLength: 20000 },
      author: { type: 'string', maxLength: 200, description: 'Defaults to Magies Office AI.' },
      initials: { type: 'string', maxLength: 20, description: 'Defaults to AI.' },
      occurrence: { type: 'integer', minimum: 1, description: '1-based matching occurrence. Defaults to 1.' },
      match_case: { type: 'boolean', description: 'Use case-sensitive matching. Defaults to true.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'find', 'comment']),
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
    'office_excel_sort_range',
    { zh: '排序 Excel 区域', en: 'Sort Excel range' },
    'Sort rows in a bounded Excel range by one relative column and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      sheet: { type: 'string', maxLength: 128, description: 'Worksheet name. Defaults to the first sheet.' },
      range: { type: 'string', description: 'A1 range such as A1:F40.' },
      key_column: { type: 'integer', minimum: 1, maximum: 50, description: '1-based column within the selected range.' },
      ascending: { type: 'boolean', description: 'Sort ascending. Defaults to true.' },
      has_header: { type: 'boolean', description: 'Keep the first row as a header. Defaults to true.' },
      match_case: { type: 'boolean', description: 'Use case-sensitive text sorting. Defaults to false.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'range', 'key_column']),
  ),
  tool(
    'office_excel_apply_autofilter',
    { zh: '应用 Excel 自动筛选', en: 'Apply Excel auto filter' },
    'Enable an auto filter on a bounded Excel range with a header row and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      sheet: { type: 'string', maxLength: 128, description: 'Worksheet name. Defaults to the first sheet.' },
      range: { type: 'string', description: 'A1 range with a header row, such as A1:F40.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'range']),
  ),
  tool(
    'office_excel_format_range',
    { zh: '设置 Excel 格式', en: 'Format Excel range' },
    'Format an Excel range and save a new non-overwriting copy. At least one format option is required.',
    schema({
      path: PATH_PROPERTY,
      sheet: { type: 'string', maxLength: 128, description: 'Worksheet name. Defaults to the first sheet.' },
      range: { type: 'string', description: 'A1 range such as A1:F40.' },
      bold: { type: 'boolean' },
      background_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      text_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      horizontal_alignment: { type: 'string', enum: ['left', 'center', 'right'] },
      optimal_width: { type: 'boolean', description: 'Automatically fit the selected columns.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'range']),
  ),
  tool(
    'office_excel_add_conditional_format',
    { zh: '添加 Excel 条件格式', en: 'Add Excel conditional formatting' },
    'Add one bounded conditional-format rule backed by a dedicated cell style and save a new copy.',
    schema({
      path: PATH_PROPERTY,
      sheet: { type: 'string', maxLength: 128, description: 'Worksheet name. Defaults to the first sheet.' },
      range: { type: 'string', description: 'A1 range such as B2:B200.' },
      operator: {
        type: 'string',
        enum: ['equal', 'not_equal', 'greater', 'greater_equal', 'less', 'less_equal', 'between', 'not_between', 'formula'],
      },
      formula1: { type: 'string', minLength: 1, maxLength: 2000 },
      formula2: { type: 'string', maxLength: 2000, description: 'Required for between and not_between.' },
      background_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      text_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      bold: { type: 'boolean' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'range', 'operator', 'formula1']),
  ),
  tool(
    'office_excel_create_chart',
    { zh: '创建 Excel 图表', en: 'Create Excel chart' },
    'Create a chart from an Excel data range and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      sheet: { type: 'string', maxLength: 128, description: 'Worksheet name. Defaults to the first sheet.' },
      data_range: { type: 'string', description: 'A1 range containing chart data, such as A1:B12.' },
      chart_type: { type: 'string', enum: ['column', 'bar', 'line', 'pie', 'area'] },
      title: { type: 'string', maxLength: 200 },
      chart_name: { type: 'string', maxLength: 128 },
      first_row_labels: { type: 'boolean', description: 'Use the first row as labels. Defaults to true.' },
      first_column_labels: { type: 'boolean', description: 'Use the first column as labels. Defaults to true.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'data_range', 'chart_type']),
  ),
  tool(
    'office_excel_create_pivot',
    { zh: '创建 Excel 数据透视表', en: 'Create Excel pivot table' },
    'Create a pivot table from named Excel header fields and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      source_sheet: { type: 'string', maxLength: 128, description: 'Source worksheet. Defaults to the first sheet.' },
      source_range: { type: 'string', description: 'Bounded source range with a header row, such as A1:D200.' },
      row_field: { type: 'string', minLength: 1, maxLength: 128, description: 'Header name used for pivot rows.' },
      column_field: { type: 'string', minLength: 1, maxLength: 128, description: 'Optional header name used for pivot columns.' },
      data_field: { type: 'string', minLength: 1, maxLength: 128, description: 'Header name containing values to aggregate.' },
      function: { type: 'string', enum: ['sum', 'count', 'average', 'min', 'max'], description: 'Aggregation. Defaults to sum.' },
      destination_sheet: { type: 'string', maxLength: 128, description: 'Existing or new output worksheet. Defaults to Pivot.' },
      destination_cell: { type: 'string', description: 'Top-left output cell. Defaults to A1.' },
      name: { type: 'string', maxLength: 128, description: 'Pivot table name. Defaults to MagiesPivot.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'source_range', 'row_field', 'data_field']),
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
    'office_presentation_add_slide',
    { zh: '新增 PPT 幻灯片', en: 'Add presentation slide' },
    'Add a title-and-body slide to a PowerPoint presentation and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      after_slide: { type: 'integer', minimum: 0, description: 'Insert after this 1-based slide number. Use 0 for the beginning; omit for the end.' },
      title: { type: 'string', maxLength: 1000 },
      body: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 2000 } },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path']),
  ),
  tool(
    'office_presentation_duplicate_slide',
    { zh: '复制 PPT 幻灯片', en: 'Duplicate presentation slide' },
    'Duplicate one PowerPoint slide, including its shapes, immediately after the source slide and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      slide_number: { type: 'integer', minimum: 1 },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'slide_number']),
  ),
  tool(
    'office_presentation_delete_slide',
    { zh: '删除 PPT 幻灯片', en: 'Delete presentation slide' },
    'Delete one PowerPoint slide by its 1-based number and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      slide_number: { type: 'integer', minimum: 1 },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'slide_number']),
  ),
  tool(
    'office_presentation_insert_image',
    { zh: '插入 PPT 图片', en: 'Insert presentation image' },
    'Insert an image from the granted workspace on a PowerPoint slide and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      image_path: { ...PATH_PROPERTY, description: 'Image path relative to the user-granted workspace.' },
      slide_number: { type: 'integer', minimum: 1 },
      x_mm: { type: 'number', minimum: 0, maximum: 1000, description: 'Left position. Defaults to 20 mm.' },
      y_mm: { type: 'number', minimum: 0, maximum: 1000, description: 'Top position. Defaults to 30 mm.' },
      width_mm: { type: 'number', minimum: 1, maximum: 1000, description: 'Width. Defaults to 120 mm.' },
      height_mm: { type: 'number', minimum: 1, maximum: 1000, description: 'Height. Defaults to 70 mm.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'image_path', 'slide_number']),
  ),
  tool(
    'office_presentation_insert_table',
    { zh: '插入 PPT 表格', en: 'Insert presentation table' },
    'Insert a bounded table on a PowerPoint slide and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      slide_number: { type: 'integer', minimum: 1 },
      values: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: { type: ['string', 'number', 'boolean', 'null'] },
        },
      },
      has_header: { type: 'boolean', description: 'Bold and shade the first row. Defaults to false.' },
      x_mm: { type: 'number', minimum: 0, maximum: 1000, description: 'Left position. Defaults to 20 mm.' },
      y_mm: { type: 'number', minimum: 0, maximum: 1000, description: 'Top position. Defaults to 40 mm.' },
      width_mm: { type: 'number', minimum: 1, maximum: 1000, description: 'Width. Defaults to 180 mm.' },
      height_mm: { type: 'number', minimum: 1, maximum: 1000, description: 'Height. Defaults to 80 mm.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'slide_number', 'values']),
  ),
  tool(
    'office_presentation_set_notes',
    { zh: '设置 PPT 演讲者备注', en: 'Set presentation speaker notes' },
    'Set or clear speaker notes on one PowerPoint slide and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      slide_number: { type: 'integer', minimum: 1 },
      notes: { type: 'string', maxLength: 20000 },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'slide_number', 'notes']),
  ),
  tool(
    'office_template_fill',
    { zh: '填充 Office 模板', en: 'Fill Office template' },
    'Replace template variables throughout a Word, Excel, or PowerPoint file and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      replacements: {
        type: 'object',
        minProperties: 1,
        maxProperties: 100,
        additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
      },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'replacements']),
  ),
  tool(
    'office_template_batch_fill',
    { zh: '批量填充 Office 模板', en: 'Batch fill Office template' },
    'Create up to 50 Word, Excel, or PowerPoint files from one template and validated replacement records.',
    schema({
      path: PATH_PROPERTY,
      records: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          minProperties: 1,
          maxProperties: 100,
          additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
        },
      },
      output_name_key: {
        type: 'string',
        maxLength: 200,
        description: 'Optional replacement key whose value becomes each output file suffix. Defaults to record numbers.',
      },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'records']),
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

function wordTableValues(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new Error('values must contain between 1 and 50 table rows');
  }
  let width = -1;
  for (const row of value) {
    if (!Array.isArray(row) || row.length === 0 || row.length > 20) {
      throw new Error('Each table row must contain between 1 and 20 cells');
    }
    if (width === -1) width = row.length;
    if (row.length !== width) throw new Error('values must be a rectangular array');
    for (const cell of row) {
      if (cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)) {
        throw new Error('Word table cells may only contain strings, numbers, booleans, or null');
      }
    }
  }
  return value;
}

function presentationTableValues(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error('values must contain between 1 and 20 table rows');
  }
  let width = -1;
  let characters = 0;
  for (const row of value) {
    if (!Array.isArray(row) || row.length === 0 || row.length > 10) {
      throw new Error('Each presentation table row must contain between 1 and 10 cells');
    }
    if (width === -1) width = row.length;
    if (row.length !== width) throw new Error('values must be a rectangular array');
    for (const cell of row) {
      if (cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)) {
        throw new Error('Presentation table cells may only contain strings, numbers, booleans, or null');
      }
      characters += cell === null ? 0 : String(cell).length;
    }
  }
  if (characters > 50000) throw new Error('Presentation table values may contain at most 50000 characters');
  return value;
}

function colorValue(value, label) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    throw new Error(`${label} must be a six-digit hex color such as #336699`);
  }
  return value.toUpperCase();
}

function slideBody(value) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.length > 20
    || value.some((item) => typeof item !== 'string' || item.length > 2000)
    || value.reduce((total, item) => total + item.length, 0) > 20000
  ) {
    throw new Error('body must contain at most 20 text items and 20000 characters');
  }
  return value;
}

function integerValue(value, label, minimum, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}`);
  }
  return value;
}

function numberValue(value, label, minimum, maximum, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

function replacementMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('replacements must be an object with between 1 and 100 entries');
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 100) {
    throw new Error('replacements must be an object with between 1 and 100 entries');
  }
  let characters = 0;
  const normalized = [];
  for (const [find, replacement] of entries) {
    if (!find || find.length > 200) throw new Error('replacement keys must contain between 1 and 200 characters');
    if (replacement !== null && !['string', 'number', 'boolean'].includes(typeof replacement)) {
      throw new Error('replacement values may only be strings, numbers, booleans, or null');
    }
    const text = replacement === null ? '' : String(replacement);
    characters += find.length + text.length;
    normalized.push([find, text]);
  }
  if (characters > 50000) throw new Error('replacements may contain at most 50000 characters');
  return Object.fromEntries(normalized);
}

function replacementRecords(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new Error('records must contain between 1 and 50 replacement objects');
  }
  return value.map(replacementMap);
}

function outputNameLabel(value) {
  const label = [...String(value)]
    .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
    .join('')
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  if (!label) throw new Error('output_name_key must resolve to a non-empty safe file name for every record');
  return label;
}

function boundedExcelRange(value, label) {
  if (!RANGE_REFERENCE.test(value)) throw new Error(`${label} must use A1 notation such as A1:F40`);
  const [startReference, endReference = startReference] = value.split(':');
  const position = (reference) => {
    const [, letters, row] = reference.match(/^([A-Z]{1,3})([1-9]\d*)$/);
    let column = 0;
    for (const letter of letters) column = (column * 26) + letter.charCodeAt(0) - 64;
    return { column, row: Number(row) };
  };
  const start = position(startReference);
  const end = position(endReference);
  const rows = Math.abs(end.row - start.row) + 1;
  const columns = Math.abs(end.column - start.column) + 1;
  if (rows > 200 || columns > 50 || rows * columns > 5000) {
    throw new Error(`${label} may cover at most 200 rows, 50 columns, and 5000 cells`);
  }
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

    if (functionName === 'office_word_read_changes') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, WORD_EXTENSIONS, 'Word');
      const result = await callUno({ operation: 'word_read_changes', inputPath }, options);
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

    if (functionName === 'office_word_replace_tracked') {
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
        operation: 'word_replace_tracked',
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

    if (functionName === 'office_word_insert_table') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const values = wordTableValues(args.values);
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, WORD_EXTENSIONS, 'Word');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'word_insert_table',
        inputPath,
        outputPath: output.absolutePath,
        values,
        hasHeader: args.has_header === true,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        rows: Number(result.rows) || values.length,
        columns: Number(result.columns) || values[0].length,
      };
    }

    if (functionName === 'office_word_insert_image') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const relativeImagePath = stringValue(args.image_path, 'image_path', { required: true, maxLength: 1000 });
      const inputPath = await workspace.resolveInput(relativePath);
      const imagePath = await workspace.resolveInput(relativeImagePath);
      requireExtension(inputPath, WORD_EXTENSIONS, 'Word');
      requireExtension(imagePath, IMAGE_EXTENSIONS, 'image');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'word_insert_image',
        inputPath,
        outputPath: output.absolutePath,
        imagePath,
        widthMm: numberValue(args.width_mm, 'width_mm', 1, 300),
        heightMm: numberValue(args.height_mm, 'height_mm', 1, 300),
      }, options);
      return {
        source: relativePath,
        image: relativeImagePath,
        written: output.relativePath,
        imageInserted: result.imageInserted === true,
      };
    }

    if (functionName === 'office_word_set_header_footer') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const hasHeader = args.header !== undefined;
      const hasFooter = args.footer !== undefined;
      if (!hasHeader && !hasFooter) throw new Error('Word formatting requires a header or footer value');
      const header = hasHeader ? stringValue(args.header, 'header', { maxLength: 20000 }) : undefined;
      const footer = hasFooter ? stringValue(args.footer, 'footer', { maxLength: 20000 }) : undefined;
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, WORD_EXTENSIONS, 'Word');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'word_set_header_footer',
        inputPath,
        outputPath: output.absolutePath,
        header,
        footer,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        headerEnabled: result.headerEnabled === true,
        footerEnabled: result.footerEnabled === true,
      };
    }

    if (functionName === 'office_word_add_comment') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const find = stringValue(args.find, 'find', { required: true, maxLength: 2000 });
      const comment = stringValue(args.comment, 'comment', { required: true, maxLength: 20000 });
      const occurrence = args.occurrence === undefined
        ? 1
        : integerValue(args.occurrence, 'occurrence', 1);
      const author = stringValue(args.author, 'author', { maxLength: 200 }) || 'Magies Office AI';
      const initials = stringValue(args.initials, 'initials', { maxLength: 20 }) || 'AI';
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, WORD_EXTENSIONS, 'Word');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'word_add_comment',
        inputPath,
        outputPath: output.absolutePath,
        find,
        comment,
        author,
        initials,
        occurrence,
        matchCase: args.match_case !== false,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        commentAdded: result.commentAdded === true,
        author: String(result.author || author),
        occurrence: Number(result.occurrence) || occurrence,
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

    if (functionName === 'office_excel_sort_range') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const range = boundedExcelRange(
        stringValue(args.range, 'range', { required: true, maxLength: 50 }).toUpperCase(),
        'range',
      );
      const keyColumn = integerValue(args.key_column, 'key_column', 1);
      if (keyColumn > 50) throw new Error('key_column must be an integer between 1 and 50');
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, EXCEL_EXTENSIONS, 'Excel');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'excel_sort_range',
        inputPath,
        outputPath: output.absolutePath,
        sheet: stringValue(args.sheet, 'sheet', { maxLength: 128 }),
        range,
        keyColumn,
        ascending: args.ascending !== false,
        containsHeader: args.has_header !== false,
        caseSensitive: args.match_case === true,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        sortedRange: String(result.sortedRange || range),
        keyColumn: Number(result.keyColumn) || keyColumn,
        ascending: result.ascending !== false,
      };
    }

    if (functionName === 'office_excel_apply_autofilter') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const range = boundedExcelRange(
        stringValue(args.range, 'range', { required: true, maxLength: 50 }).toUpperCase(),
        'range',
      );
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, EXCEL_EXTENSIONS, 'Excel');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'excel_apply_autofilter',
        inputPath,
        outputPath: output.absolutePath,
        sheet: stringValue(args.sheet, 'sheet', { maxLength: 128 }),
        range,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        filterRange: String(result.filterRange || range),
        databaseRange: String(result.databaseRange || ''),
      };
    }

    if (functionName === 'office_excel_format_range') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const range = boundedExcelRange(
        stringValue(args.range, 'range', { required: true, maxLength: 50 }).toUpperCase(),
        'range',
      );
      const hasFormat = ['bold', 'background_color', 'text_color', 'horizontal_alignment', 'optimal_width']
        .some((key) => args[key] !== undefined);
      if (!hasFormat) throw new Error('Excel formatting requires at least one format option');
      if (args.bold !== undefined && typeof args.bold !== 'boolean') throw new Error('bold must be a boolean');
      if (args.optimal_width !== undefined && typeof args.optimal_width !== 'boolean') {
        throw new Error('optimal_width must be a boolean');
      }
      const alignment = args.horizontal_alignment;
      if (alignment !== undefined && !['left', 'center', 'right'].includes(alignment)) {
        throw new Error('horizontal_alignment must be left, center, or right');
      }
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, EXCEL_EXTENSIONS, 'Excel');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'excel_format_range',
        inputPath,
        outputPath: output.absolutePath,
        sheet: stringValue(args.sheet, 'sheet', { maxLength: 128 }),
        range,
        bold: args.bold,
        backgroundColor: colorValue(args.background_color, 'background_color'),
        textColor: colorValue(args.text_color, 'text_color'),
        horizontalAlignment: alignment,
        optimalWidth: args.optimal_width,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        formattedRange: String(result.formattedRange || range),
      };
    }

    if (functionName === 'office_excel_add_conditional_format') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const range = boundedExcelRange(
        stringValue(args.range, 'range', { required: true, maxLength: 50 }).toUpperCase(),
        'range',
      );
      const operators = {
        equal: 'EQUAL',
        not_equal: 'NOT_EQUAL',
        greater: 'GREATER',
        greater_equal: 'GREATER_EQUAL',
        less: 'LESS',
        less_equal: 'LESS_EQUAL',
        between: 'BETWEEN',
        not_between: 'NOT_BETWEEN',
        formula: 'FORMULA',
      };
      const requestedOperator = stringValue(args.operator, 'operator', { required: true, maxLength: 30 });
      const operator = operators[requestedOperator];
      if (!operator) throw new Error('operator is not supported');
      const formula1 = stringValue(args.formula1, 'formula1', { required: true, maxLength: 2000 });
      const formula2 = stringValue(args.formula2, 'formula2', { maxLength: 2000 });
      if (['BETWEEN', 'NOT_BETWEEN'].includes(operator) && !formula2) {
        throw new Error('formula2 is required for between and not_between');
      }
      const hasStyle = ['bold', 'background_color', 'text_color'].some((key) => args[key] !== undefined);
      if (!hasStyle) throw new Error('Conditional formatting requires at least one style option');
      if (args.bold !== undefined && typeof args.bold !== 'boolean') throw new Error('bold must be a boolean');
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, EXCEL_EXTENSIONS, 'Excel');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'excel_add_conditional_format',
        inputPath,
        outputPath: output.absolutePath,
        sheet: stringValue(args.sheet, 'sheet', { maxLength: 128 }),
        range,
        operator,
        formula1,
        formula2,
        backgroundColor: colorValue(args.background_color, 'background_color'),
        textColor: colorValue(args.text_color, 'text_color'),
        bold: args.bold,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        formattedRange: String(result.formattedRange || range),
        styleName: String(result.styleName || ''),
      };
    }

    if (functionName === 'office_excel_create_chart') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const dataRange = boundedExcelRange(
        stringValue(args.data_range, 'data_range', { required: true, maxLength: 50 }).toUpperCase(),
        'data_range',
      );
      const chartType = stringValue(args.chart_type, 'chart_type', { required: true, maxLength: 20 });
      if (!['column', 'bar', 'line', 'pie', 'area'].includes(chartType)) {
        throw new Error('chart_type must be column, bar, line, pie, or area');
      }
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, EXCEL_EXTENSIONS, 'Excel');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'excel_create_chart',
        inputPath,
        outputPath: output.absolutePath,
        sheet: stringValue(args.sheet, 'sheet', { maxLength: 128 }),
        dataRange,
        chartType,
        title: stringValue(args.title, 'title', { maxLength: 200 }),
        chartName: stringValue(args.chart_name, 'chart_name', { maxLength: 128 }),
        firstRowLabels: args.first_row_labels !== false,
        firstColumnLabels: args.first_column_labels !== false,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        chartName: String(result.chartName || args.chart_name || args.title || 'Chart'),
      };
    }

    if (functionName === 'office_excel_create_pivot') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const sourceRange = boundedExcelRange(
        stringValue(args.source_range, 'source_range', { required: true, maxLength: 50 }).toUpperCase(),
        'source_range',
      );
      const rowField = stringValue(args.row_field, 'row_field', { required: true, maxLength: 128 });
      const columnField = stringValue(args.column_field, 'column_field', { maxLength: 128 });
      const dataField = stringValue(args.data_field, 'data_field', { required: true, maxLength: 128 });
      const selectedFields = [rowField, columnField, dataField].filter(Boolean);
      if (new Set(selectedFields).size !== selectedFields.length) {
        throw new Error('row_field, column_field, and data_field must use different fields');
      }
      const functions = {
        sum: 'SUM',
        count: 'COUNT',
        average: 'AVERAGE',
        min: 'MIN',
        max: 'MAX',
      };
      const requestedFunction = stringValue(args.function, 'function', { maxLength: 20 }) || 'sum';
      const dataFunction = functions[requestedFunction];
      if (!dataFunction) throw new Error('function must be sum, count, average, min, or max');
      const destinationCell = (
        stringValue(args.destination_cell, 'destination_cell', { maxLength: 20 }) || 'A1'
      ).toUpperCase();
      if (!CELL_REFERENCE.test(destinationCell)) {
        throw new Error('destination_cell must use A1 notation such as A1');
      }
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, EXCEL_EXTENSIONS, 'Excel');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'excel_create_pivot',
        inputPath,
        outputPath: output.absolutePath,
        sourceSheet: stringValue(args.source_sheet, 'source_sheet', { maxLength: 128 }),
        sourceRange,
        rowField,
        columnField,
        dataField,
        dataFunction,
        destinationSheet: stringValue(args.destination_sheet, 'destination_sheet', { maxLength: 128 }) || 'Pivot',
        destinationCell,
        pivotName: stringValue(args.name, 'name', { maxLength: 128 }) || 'MagiesPivot',
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        pivotName: String(result.pivotName || 'MagiesPivot'),
        destinationSheet: String(result.destinationSheet || 'Pivot'),
        outputRange: String(result.outputRange || ''),
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

    if (functionName === 'office_presentation_add_slide') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const title = stringValue(args.title, 'title', { maxLength: 1000 });
      const body = slideBody(args.body);
      if (!title && body.length === 0) throw new Error('A new slide requires a title or body text');
      const afterSlide = integerValue(args.after_slide, 'after_slide', 0, { optional: true });
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, PRESENTATION_EXTENSIONS, 'PowerPoint');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'presentation_add_slide',
        inputPath,
        outputPath: output.absolutePath,
        afterSlide,
        title,
        body,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        slideNumber: Number(result.slideNumber) || 0,
        slidesTotal: Number(result.slidesTotal) || 0,
      };
    }

    if (functionName === 'office_presentation_duplicate_slide') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const slideNumber = integerValue(args.slide_number, 'slide_number', 1);
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, PRESENTATION_EXTENSIONS, 'PowerPoint');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'presentation_duplicate_slide',
        inputPath,
        outputPath: output.absolutePath,
        slideNumber,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        sourceSlideNumber: Number(result.sourceSlideNumber) || slideNumber,
        duplicatedSlideNumber: Number(result.duplicatedSlideNumber) || 0,
        slidesTotal: Number(result.slidesTotal) || 0,
      };
    }

    if (functionName === 'office_presentation_delete_slide') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const slideNumber = integerValue(args.slide_number, 'slide_number', 1);
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, PRESENTATION_EXTENSIONS, 'PowerPoint');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'presentation_delete_slide',
        inputPath,
        outputPath: output.absolutePath,
        slideNumber,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        deletedSlideNumber: Number(result.deletedSlideNumber) || slideNumber,
        slidesRemaining: Number(result.slidesRemaining) || 0,
      };
    }

    if (functionName === 'office_presentation_insert_image') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const relativeImagePath = stringValue(args.image_path, 'image_path', { required: true, maxLength: 1000 });
      const slideNumber = integerValue(args.slide_number, 'slide_number', 1);
      const inputPath = await workspace.resolveInput(relativePath);
      const imagePath = await workspace.resolveInput(relativeImagePath);
      requireExtension(inputPath, PRESENTATION_EXTENSIONS, 'PowerPoint');
      requireExtension(imagePath, IMAGE_EXTENSIONS, 'image');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'presentation_insert_image',
        inputPath,
        outputPath: output.absolutePath,
        imagePath,
        slideNumber,
        xMm: numberValue(args.x_mm, 'x_mm', 0, 1000, 20),
        yMm: numberValue(args.y_mm, 'y_mm', 0, 1000, 30),
        widthMm: numberValue(args.width_mm, 'width_mm', 1, 1000, 120),
        heightMm: numberValue(args.height_mm, 'height_mm', 1, 1000, 70),
      }, options);
      return {
        source: relativePath,
        image: relativeImagePath,
        written: output.relativePath,
        slideNumber,
        imageInserted: result.imageInserted === true,
      };
    }

    if (functionName === 'office_presentation_insert_table') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const slideNumber = integerValue(args.slide_number, 'slide_number', 1);
      const values = presentationTableValues(args.values);
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, PRESENTATION_EXTENSIONS, 'PowerPoint');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'presentation_insert_table',
        inputPath,
        outputPath: output.absolutePath,
        slideNumber,
        values,
        hasHeader: args.has_header === true,
        xMm: numberValue(args.x_mm, 'x_mm', 0, 1000, 20),
        yMm: numberValue(args.y_mm, 'y_mm', 0, 1000, 40),
        widthMm: numberValue(args.width_mm, 'width_mm', 1, 1000, 180),
        heightMm: numberValue(args.height_mm, 'height_mm', 1, 1000, 80),
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        slideNumber,
        rows: Number(result.rows) || values.length,
        columns: Number(result.columns) || values[0].length,
      };
    }

    if (functionName === 'office_presentation_set_notes') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const slideNumber = integerValue(args.slide_number, 'slide_number', 1);
      if (args.notes === undefined) throw new Error('notes must be a string no longer than 20000 characters');
      const notes = stringValue(args.notes, 'notes', { maxLength: 20000 });
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, PRESENTATION_EXTENSIONS, 'PowerPoint');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'presentation_set_notes',
        inputPath,
        outputPath: output.absolutePath,
        slideNumber,
        notes,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        slideNumber,
        noteCharacters: Number(result.noteCharacters) || 0,
      };
    }

    if (functionName === 'office_template_fill') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const replacements = replacementMap(args.replacements);
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, CONVERTIBLE_EXTENSIONS, 'Office');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'template_fill',
        inputPath,
        outputPath: output.absolutePath,
        replacements,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        documentType: String(result.documentType || ''),
        replacementCount: Number(result.replacementCount) || 0,
      };
    }

    if (functionName === 'office_template_batch_fill') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const records = replacementRecords(args.records);
      const outputNameKey = stringValue(args.output_name_key, 'output_name_key', { maxLength: 200 });
      const outputLabels = records.map((record, index) => {
        if (!outputNameKey) return String(index + 1);
        if (!Object.hasOwn(record, outputNameKey)) {
          throw new Error('output_name_key must exist in every replacement record');
        }
        return outputNameLabel(record[outputNameKey]);
      });
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, CONVERTIBLE_EXTENSIONS, 'Office');
      const outputDirectory = stringValue(args.output_directory, 'output_directory', { maxLength: 1000 })
        || DEFAULT_OUTPUT_DIRECTORY;
      const extension = path.extname(inputPath);
      const stem = path.basename(inputPath, extension);
      const written = [];
      let documentType = '';
      let replacementCount = 0;
      try {
        for (let index = 0; index < records.length; index += 1) {
          const output = await workspace.uniqueOutputPath(
            outputDirectory,
            `${stem} - ${outputLabels[index]}${extension}`,
          );
          const result = await callUno({
            operation: 'template_fill',
            inputPath,
            outputPath: output.absolutePath,
            replacements: records[index],
          }, options);
          written.push(output.relativePath);
          documentType ||= String(result.documentType || '');
          replacementCount += Number(result.replacementCount) || 0;
          options.onProgress?.((index + 1) / records.length);
        }
      } catch (cause) {
        const completed = written.length ? ` Completed outputs: ${written.join(', ')}.` : '';
        throw new Error(`Batch template filling failed after ${written.length} files.${completed}`, { cause });
      }
      return {
        source: relativePath,
        generated: written.length,
        written,
        documentType,
        replacementCount,
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
  wordTableValues,
};
