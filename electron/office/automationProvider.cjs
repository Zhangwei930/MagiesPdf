'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createOfficeWorkspace } = require('./workspace.cjs');
const { blocksFromMarkdown, slidesFromMarkdown } = require('./markdownDocument.cjs');
const { IMAGE_EXTENSIONS } = require('./formats.cjs');

const WORD_EXTENSIONS = new Set(['.doc', '.docx', '.odt', '.rtf']);
const EXCEL_EXTENSIONS = new Set(['.xls', '.xlsx', '.ods']);
const PRESENTATION_EXTENSIONS = new Set(['.ppt', '.pptx', '.odp']);
const MACRO_DOCUMENT_EXTENSIONS = new Set(['.odt', '.ods', '.odp']);
const CONVERTIBLE_EXTENSIONS = new Set([...WORD_EXTENSIONS, ...EXCEL_EXTENSIONS, ...PRESENTATION_EXTENSIONS]);
const CELL_REFERENCE = /^[A-Za-z]{1,3}[1-9]\d*$/;
const RANGE_REFERENCE = /^[A-Za-z]{1,3}[1-9]\d*(?::[A-Za-z]{1,3}[1-9]\d*)?$/;
const DEFAULT_OUTPUT_DIRECTORY = 'Magies Office Output';

/**
 * Single-document mutators. After UNO writes a staging copy, Magies applies that
 * copy onto the source so the open tab can reload the same path.
 */
const IN_PLACE_MUTATORS = new Set([
  'office_word_resolve_changes',
  'office_word_replace',
  'office_word_replace_tracked',
  'office_word_append',
  'office_word_add_footnotes',
  'office_word_format_text',
  'office_word_insert_table',
  'office_word_insert_image',
  'office_word_set_header_footer',
  'office_word_add_comment',
  'office_excel_write',
  'office_excel_add_comments',
  'office_excel_sort_range',
  'office_excel_apply_autofilter',
  'office_excel_format_range',
  'office_excel_compose_table',
  'office_excel_add_conditional_format',
  'office_excel_create_chart',
  'office_excel_create_pivot',
  'office_presentation_replace',
  'office_presentation_compose',
  'office_presentation_format_text',
  'office_presentation_apply_theme',
  'office_presentation_set_background',
  'office_presentation_add_slide',
  'office_presentation_duplicate_slide',
  'office_presentation_delete_slide',
  'office_presentation_insert_image',
  'office_presentation_insert_table',
  'office_presentation_set_notes',
  'office_template_fill',
  'office_macro_run',
]);

function schema(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, required };
}

function tool(functionName, name, description, parameters, { unattended = true } = {}) {
  return {
    functionName,
    toolId: `office:${functionName.replace(/^office_/, '').replaceAll('_', ':')}`,
    name,
    requiresApproval: true,
    unattended,
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
  description: (
    'Optional. Leave empty (recommended) to apply the edit in place on the source file '
    + 'so the open tab reloads and shows the change. '
    + 'Set a custom folder only to write a separate copy instead.'
  ),
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
    'office_word_resolve_changes',
    { zh: '接受或拒绝 Word 修订', en: 'Accept or reject Word changes' },
    'Accept or reject all tracked changes in a Word document and save a new non-overwriting copy.',
    schema({
      path: PATH_PROPERTY,
      action: { type: 'string', enum: ['accept', 'reject'] },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'action']),
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
    'office_word_append',
    { zh: '追加 Word 内容', en: 'Append Word content' },
    'Append styled paragraphs to the end of a Word document and save a new non-overwriting copy. '
      + 'Each block carries a real paragraph style, so headings become headings in the navigator '
      + 'and the table of contents, not merely larger text. '
      + 'Use this to add to a document that already exists; to write one, use '
      + 'office_word_compose, which also lays out a cover, a type scale and page numbers.',
    schema({
      path: PATH_PROPERTY,
      blocks: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: schema({
          style: {
            type: 'string',
            enum: ['title', 'subtitle', 'heading1', 'heading2', 'heading3', 'body', 'bullet', 'number', 'quote'],
          },
          text: { type: 'string', maxLength: 20000 },
          level: {
            type: 'integer',
            minimum: 0,
            maximum: 4,
            description: 'Nesting depth for bullet and number blocks. 0 is the outer level.',
          },
        }, ['style', 'text']),
      },
      markdown: {
        type: 'string',
        maxLength: 40000,
        description: 'Write the document as Markdown instead of building blocks — usually easier. '
          + 'The first "# " becomes the document title, "#"/"##"/"###" become real heading styles, '
          + '"-" bullets, "1." numbered items, "> " a quotation.',
      },
      page_break_before: { type: 'boolean', description: 'Start the appended content on a new page.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path']),
  ),
  tool(
    'office_word_compose',
    { zh: '生成整份 Word 文稿', en: 'Compose a Word document' },
    'Write a whole document in ONE call: cover page, real heading styles in theme colours, a type '
      + 'scale, page margins, line spacing, a table of contents and page numbers are applied for you. '
      + 'This is the right way to write a report — appending content and formatting it afterwards '
      + 'produces a document that only looks like it has headings, and the contents page comes out '
      + 'empty. Themes: azure (deep blue), slate (grey), forest (green), plum (aubergine), mono '
      + '(black). Supply the words as Markdown; the theme decides how they look. This replaces the '
      + "document's contents, so pass everything you want it to say.",
    schema({
      path: PATH_PROPERTY,
      theme: { type: 'string', enum: ['azure', 'slate', 'forest', 'plum', 'mono'] },
      markdown: {
        type: 'string',
        maxLength: 40000,
        description: 'The document body. The first "# " and later "#"/"##"/"###" become real '
          + 'heading styles, "-" bullets, "1." numbered items, "> " a quotation. Usually easier '
          + 'and better than building the blocks array.',
      },
      blocks: {
        type: 'array',
        maxItems: 200,
        items: schema({
          style: {
            type: 'string',
            enum: ['title', 'subtitle', 'heading1', 'heading2', 'heading3', 'body', 'bullet', 'number', 'quote'],
          },
          text: { type: 'string', maxLength: 20000 },
          level: {
            type: 'integer',
            minimum: 0,
            maximum: 4,
            description: 'Nesting depth for bullet and number blocks. 0 is the outer level.',
          },
        }, ['style', 'text']),
        description: 'Instead of markdown, when you need exact control of each paragraph.',
      },
      title: { type: 'string', maxLength: 300, description: 'Cover page. Omit for a document with no cover.' },
      subtitle: { type: 'string', maxLength: 300 },
      byline: { type: 'string', maxLength: 200, description: 'Author, team or date under the title.' },
      table_of_contents: { type: 'boolean', description: 'A generated contents page after the cover.' },
      table_of_contents_title: {
        type: 'string',
        maxLength: 100,
        description: 'What the contents page is called, in the document\'s language — 目录 / Contents.',
      },
      page_numbers: { type: 'boolean', description: 'Centred in the footer. Defaults to true.' },
      columns: {
        type: 'integer',
        minimum: 1,
        maximum: 4,
        description: 'Lay the body out in this many columns. Defaults to one. Newsletters and '
          + 'briefs read better in two; a report with tables and figures does not.',
      },
      column_gap_mm: { type: 'number', minimum: 0, maximum: 40, description: 'Defaults to 6.' },
      column_rule: { type: 'boolean', description: 'Draw a hairline between columns.' },
      font_name: {
        type: 'string',
        maxLength: 128,
        description: 'Optional face for the whole document. Leave empty unless the user asked for one.',
      },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path']),
  ),
  tool(
    'office_word_add_footnotes',
    { zh: '添加 Word 脚注尾注', en: 'Add Word footnotes' },
    'Attach real footnotes or endnotes to phrases in a Word document and save a new non-overwriting '
      + 'copy. Pass every note in ONE call. A note written in brackets in the running text is not a '
      + 'footnote: it does not number itself, does not sit at the foot of its page, and does not '
      + 'follow the sentence when it moves — use this instead whenever the user asks for a citation, '
      + 'a source or an aside.',
    schema({
      path: PATH_PROPERTY,
      footnotes: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: schema({
          find: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            description: 'The phrase the mark goes after.',
          },
          text: { type: 'string', minLength: 1, maxLength: 20000, description: 'The note itself.' },
          kind: {
            type: 'string',
            enum: ['footnote', 'endnote'],
            description: 'Foot of the page, or collected at the end. Defaults to footnote.',
          },
          occurrence: {
            type: 'integer',
            minimum: 1,
            description: '1-based match to use when the phrase repeats. Defaults to 1.',
          },
          label: {
            type: 'string',
            maxLength: 20,
            description: 'A fixed mark such as * or †. Leave empty to keep it numbered.',
          },
          match_case: { type: 'boolean', description: 'Defaults to true.' },
        }, ['find', 'text']),
      },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'footnotes']),
  ),
  tool(
    'office_word_format_text',
    { zh: '设置 Word 文字格式', en: 'Format Word text' },
    'Format every occurrence of a phrase in a Word document and save a new non-overwriting copy. '
      + 'At least one format option is required.',
    schema({
      path: PATH_PROPERTY,
      find: { type: 'string', minLength: 1, maxLength: 2000, description: 'The exact text to format.' },
      bold: { type: 'boolean' },
      italic: { type: 'boolean' },
      underline: { type: 'boolean' },
      font_name: { type: 'string', maxLength: 128 },
      font_size: { type: 'number', minimum: 6, maximum: 96, description: 'Points.' },
      text_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      highlight_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      alignment: { type: 'string', enum: ['left', 'center', 'right', 'justify'], description: 'Applies to the whole paragraph holding each match.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'find']),
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
    'office_excel_add_comments',
    { zh: '添加 Excel 单元格批注', en: 'Comment on Excel cells' },
    'Attach review notes to cells and save a new non-overwriting copy. Pass every note in ONE call: '
      + 'a review is one action to the user, and one call per note asks for approval once per note. '
      + 'Commenting on a cell that already has a note replaces it.',
    schema({
      path: PATH_PROPERTY,
      sheet: { type: 'string', maxLength: 128, description: 'Defaults to the first sheet.' },
      comments: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: schema({
          cell: { type: 'string', maxLength: 20, description: 'A1 notation, such as B4.' },
          text: { type: 'string', minLength: 1, maxLength: 4000 },
          visible: {
            type: 'boolean',
            description: 'Show the note as an open box instead of on hover. Defaults to false.',
          },
        }, ['cell', 'text']),
      },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'comments']),
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
      italic: { type: 'boolean' },
      font_name: { type: 'string', maxLength: 128 },
      font_size: { type: 'number', minimum: 6, maximum: 96, description: 'Points.' },
      background_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      text_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      horizontal_alignment: { type: 'string', enum: ['left', 'center', 'right'] },
      vertical_alignment: { type: 'string', enum: ['top', 'middle', 'bottom'] },
      number_format: {
        type: 'string',
        maxLength: 120,
        description: 'LibreOffice/Excel format code, such as #,##0.00, ¥#,##0, 0.0% or yyyy-mm-dd. '
          + 'Money and percentages are unreadable without one.',
      },
      borders: {
        type: 'string',
        enum: ['all', 'outline', 'none'],
        description: 'all draws every cell edge, outline only the range border, none clears them.',
      },
      merge: { type: 'boolean', description: 'Merge the range into one cell (used for titles).' },
      wrap_text: { type: 'boolean' },
      optimal_width: { type: 'boolean', description: 'Automatically fit the selected columns.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'range']),
  ),
  tool(
    'office_excel_compose_table',
    { zh: '生成排版好的表格', en: 'Compose a formatted table' },
    'Write a finished, readable table in ONE call: themed header, banded rows, per-column number '
      + 'formats, borders, fitted widths, frozen header and an autofilter. '
      + 'Prefer this over writing values and then formatting them — that route reliably ends with '
      + 'raw digits and no widths. Give money and percentage columns a number_format '
      + '(#,##0.00 / ¥#,##0 / 0.0%) or the sheet reads as a wall of numbers.',
    schema({
      path: PATH_PROPERTY,
      sheet: { type: 'string', maxLength: 128 },
      start_cell: { type: 'string', description: 'Top-left cell, A1 notation. Defaults to A1.' },
      title: { type: 'string', maxLength: 300, description: 'Optional heading merged above the table.' },
      theme: { type: 'string', enum: ['azure', 'slate', 'forest', 'plum', 'mono'] },
      headers: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 200 } },
      rows: {
        type: 'array',
        maxItems: 500,
        items: {
          type: 'array',
          maxItems: 50,
          items: { type: ['string', 'number', 'boolean', 'null'] },
        },
      },
      column_formats: {
        type: 'array',
        maxItems: 50,
        items: { type: 'string', maxLength: 120 },
        description: 'One format code per column, empty string for text columns.',
      },
      totals_row: { type: 'boolean', description: 'Sum every column that has a number format.' },
      totals_label: { type: 'string', maxLength: 100 },
      banded_rows: { type: 'boolean', description: 'Defaults to true.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'headers', 'rows']),
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
      grand_total_label: {
        type: 'string',
        maxLength: 60,
        description: 'What the grand total row is called, in the document\'s language — 总计 / Total. '
          + 'The engine writes "Total Result" otherwise, which reads as machine output in a '
          + 'document that is not in English.',
      },
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
    'Add one slide to a presentation and save a new non-overwriting copy. '
      + 'A deck built by office_presentation_compose is joined automatically: the slide picks up '
      + "that deck's theme, type scale and footer, so use this to extend a deck you composed "
      + 'rather than composing it again. A deck Magies did not compose keeps its own look and '
      + 'gets a plain title-and-body slide. To build or rebuild a whole deck, use '
      + 'office_presentation_compose instead — it is what makes a deck look designed.',
    schema({
      path: PATH_PROPERTY,
      after_slide: { type: 'integer', minimum: 0, description: 'Insert after this 1-based slide number. Use 0 for the beginning; omit for the end.' },
      title: { type: 'string', maxLength: 1000 },
      body: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 2000 } },
      layout: {
        type: 'string',
        enum: ['title', 'section', 'bullets', 'two_column', 'quote', 'closing'],
        description: 'Only used on a deck Magies composed. Defaults to bullets.',
      },
      theme: {
        type: 'string',
        enum: ['azure', 'midnight', 'sand', 'forest', 'mono'],
        description: "Overrides the deck's own theme. Leave empty to match it.",
      },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path']),
  ),
  tool(
    'office_presentation_compose',
    { zh: '生成整份 PPT', en: 'Compose a presentation' },
    'Build a whole deck from an outline in ONE call: theme colours, backgrounds, type sizes, '
      + 'margins, accent rules and per-layout placement are applied for you. '
      + 'This is the right way to make a presentation — building slides one call at a time and '
      + 'styling them afterwards produces a half-designed deck. '
      + 'Themes: azure (deep blue), midnight (dark violet), sand (warm light), forest (deep green), '
      + 'mono (white, black type). '
      + 'Layouts: title, section, bullets, two_column, chart, kpi, steps, image, quote, closing. '
      + 'Prefer chart / kpi / steps over another bullet list — a deck of nothing but bullets is what '
      + 'makes a generated deck look generated. Charts are drawn from the numbers you pass, so a '
      + 'visual costs you nothing and needs no picture file. '
      + 'Supply the words; the theme decides how they look.',
    schema({
      path: PATH_PROPERTY,
      theme: { type: 'string', enum: ['azure', 'midnight', 'sand', 'forest', 'mono'] },
      font_name: {
        type: 'string',
        maxLength: 128,
        description: 'Optional face for every slide. Leave empty unless the user asked for one.',
      },
      markdown: {
        type: 'string',
        maxLength: 40000,
        description: 'Write the whole deck as Markdown instead of building the slides array — '
          + 'usually the easier and better route. First "# " is the cover, later "# " are section '
          + 'dividers, "## " starts a slide, "-" bullets fill it, a numbered list becomes a process, '
          + '"> " a quote, "![](workspace/path.png)" an image, "---" forces a new slide. '
          + 'A ```chart fence takes {"type","categories","series"} JSON and a ```kpi fence takes '
          + '"value | label" lines.',
      },
      footer: {
        type: 'string',
        maxLength: 120,
        description: 'Small text on every content slide, e.g. the deck title or the date.',
      },
      replace_existing: {
        type: 'boolean',
        description: 'Clear the deck first. Defaults to true — compose builds the whole deck.',
      },
      slides: {
        type: 'array',
        minItems: 1,
        maxItems: 60,
        items: schema({
          layout: {
            type: 'string',
            enum: [
              'title', 'section', 'bullets', 'two_column',
              'chart', 'kpi', 'steps', 'image', 'quote', 'closing',
            ],
          },
          chart_type: {
            type: 'string',
            enum: ['column', 'bar', 'line', 'pie', 'area'],
            description: 'chart layout. Defaults to column.',
          },
          categories: {
            type: 'array',
            maxItems: 12,
            items: { type: 'string', maxLength: 60 },
            description: 'chart layout: the x-axis labels.',
          },
          series: {
            type: 'array',
            maxItems: 4,
            items: schema({
              name: { type: 'string', maxLength: 60 },
              values: { type: 'array', maxItems: 12, items: { type: 'number' } },
            }, ['name', 'values']),
            description: 'chart layout: one entry per line or bar group.',
          },
          kpis: {
            type: 'array',
            maxItems: 4,
            items: schema({
              value: { type: 'string', maxLength: 40, description: 'e.g. 12% or ¥1,240万' },
              label: { type: 'string', maxLength: 80 },
            }, ['value', 'label']),
            description: 'kpi layout: two to four headline numbers.',
          },
          title: { type: 'string', maxLength: 300, description: 'For quote layouts this is the quote itself.' },
          subtitle: { type: 'string', maxLength: 300, description: 'title and closing layouts.' },
          body: {
            type: 'array',
            maxItems: 8,
            items: { type: 'string', maxLength: 400 },
            description: 'Bullets. For quote, one entry is the attribution. Keep them short — '
              + 'a slide is not a paragraph.',
          },
          right: {
            type: 'array',
            maxItems: 8,
            items: { type: 'string', maxLength: 400 },
            description: 'The second column of a two_column slide.',
          },
          image_path: {
            ...PATH_PROPERTY,
            description: 'Image layout only. Workspace-relative path to a picture that already exists. '
              + 'Leaving it out is fine and needs no apology: the slide draws a themed figure in the '
              + "picture's place, so use the image layout for pacing whether or not you have a file.",
          },
        }, ['layout']),
      },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path']),
  ),
  tool(
    'office_presentation_format_text',
    { zh: '设置 PPT 文字格式', en: 'Format presentation text' },
    'Format the title or body text of one slide (or every slide) and save a new non-overwriting copy. '
      + 'Without this a generated deck keeps the template default and reads as raw bullet text. '
      + 'At least one format option is required.',
    schema({
      path: PATH_PROPERTY,
      slide_number: { type: 'integer', minimum: 0, description: '1-based slide number. Use 0 for every slide.' },
      target: {
        type: 'string',
        enum: ['title', 'body', 'all'],
        description: 'Which placeholders to format on the selected slides.',
      },
      font_name: { type: 'string', maxLength: 128 },
      font_size: { type: 'number', minimum: 6, maximum: 200, description: 'Points.' },
      bold: { type: 'boolean' },
      italic: { type: 'boolean' },
      text_color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      alignment: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'target']),
  ),
  tool(
    'office_presentation_apply_theme',
    { zh: '为整份 PPT 换一套主题', en: 'Restyle a whole presentation' },
    'Give an existing presentation one of the composed themes, applied through its slide master so '
      + 'every slide inherits it — including slides added afterwards. Use this when the user wants a '
      + 'deck they already have to look different; use office_presentation_compose when you are '
      + 'writing the deck. Themes: azure (deep blue), midnight (dark violet), sand (warm light), '
      + 'forest (deep green), mono (white, black type).',
    schema({
      path: PATH_PROPERTY,
      theme: { type: 'string', enum: ['azure', 'midnight', 'sand', 'forest', 'mono'] },
      footer: { type: 'string', maxLength: 120, description: 'Small text and a number on every slide.' },
      font_name: { type: 'string', maxLength: 128, description: 'Optional face for every slide.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'theme']),
  ),
  tool(
    'office_presentation_set_background',
    { zh: '设置 PPT 背景', en: 'Set presentation background' },
    'Paint the background of one slide or the whole deck, as a solid colour or a two-colour '
      + 'gradient, then save a new non-overwriting copy. Pair it with office_presentation_format_text '
      + 'so the text stays readable against the new background.',
    schema({
      path: PATH_PROPERTY,
      slide_number: { type: 'integer', minimum: 0, description: '1-based slide number. Use 0 or omit for every slide.' },
      color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$', description: 'Solid fill, or the start of the gradient.' },
      gradient_to: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$', description: 'End colour. Omit for a solid fill.' },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'color']),
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
    'office_macro_run',
    { zh: '运行可信文档宏', en: 'Run trusted document macro' },
    'Run one document-scoped LibreOffice Basic macro in an ODT, ODS, or ODP copy. This always requires interactive approval and is never available to unattended automation.',
    schema({
      path: PATH_PROPERTY,
      script_uri: {
        type: 'string',
        maxLength: 600,
        description: 'Document-scoped LibreOffice Basic URI ending in ?language=Basic&location=document.',
      },
      arguments: {
        type: 'array',
        maxItems: 20,
        items: { type: ['string', 'number', 'boolean', 'null'] },
      },
      output_directory: OUTPUT_DIRECTORY_PROPERTY,
    }, ['path', 'script_uri']),
    { unattended: false },
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

/** Paragraph blocks for a Word append: a style the document really has, plus text. */
const BLOCK_STYLES = new Set([
  'title', 'subtitle', 'heading1', 'heading2', 'heading3', 'body', 'bullet', 'number', 'quote',
]);

/** The styles a level means anything for. */
const LIST_BLOCK_STYLES = new Set(['bullet', 'number']);

function documentBlocks(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('blocks must contain at least one block');
  }
  if (value.length > 200) throw new Error('blocks may contain at most 200 blocks');
  return value.map((block, index) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new Error(`blocks[${index}] must be an object with style and text`);
    }
    const style = String(block.style || '');
    if (!BLOCK_STYLES.has(style)) {
      throw new Error(`blocks[${index}].style must be one of ${[...BLOCK_STYLES].join(', ')}`);
    }
    const text = stringValue(block.text, `blocks[${index}].text`, { maxLength: 20000 });
    // Only a list has a level. Carrying it on everything else would let a model
    // indent a heading, which Word has no way to draw.
    const level = Math.min(
      Math.max(integerValue(block.level, `blocks[${index}].level`, 0, { optional: true }) ?? 0, 0),
      4,
    );
    return LIST_BLOCK_STYLES.has(style) ? { style, text, level } : { style, text };
  });
}

const SLIDE_LAYOUTS = new Set([
  'title', 'section', 'bullets', 'two_column',
  'chart', 'kpi', 'steps', 'image', 'quote', 'closing',
]);

/** Chart data for a composed slide: labels, and one number per label per series. */
function slideChartData(slide, index) {
  const categories = (Array.isArray(slide.categories) ? slide.categories : [])
    .map((label, at) => stringValue(label, `slides[${index}].categories[${at}]`, { maxLength: 60 }));
  if (categories.length === 0) {
    throw new Error(`slides[${index}] is a chart and needs categories`);
  }
  if (categories.length > 12) throw new Error(`slides[${index}].categories may hold at most 12 labels`);
  const rawSeries = Array.isArray(slide.series) ? slide.series : [];
  if (rawSeries.length === 0) throw new Error(`slides[${index}] is a chart and needs series`);
  if (rawSeries.length > 4) throw new Error(`slides[${index}].series may hold at most 4 series`);
  const series = rawSeries.map((entry, at) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`slides[${index}].series[${at}] must be an object`);
    }
    const values = (Array.isArray(entry.values) ? entry.values : []).map((value, position) => {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        throw new Error(`slides[${index}].series[${at}].values[${position}] must be a number`);
      }
      return number;
    });
    if (values.length !== categories.length) {
      throw new Error(
        `slides[${index}].series[${at}].values must hold one number per category`,
      );
    }
    return {
      name: stringValue(entry.name, `slides[${index}].series[${at}].name`, { maxLength: 60 }),
      values,
    };
  });
  return { categories, series };
}

function slideKpis(slide, index) {
  const entries = Array.isArray(slide.kpis) ? slide.kpis : [];
  if (entries.length === 0) throw new Error(`slides[${index}] is a kpi slide and needs kpis`);
  if (entries.length > 4) throw new Error(`slides[${index}].kpis may hold at most 4 numbers`);
  return entries.map((entry, at) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`slides[${index}].kpis[${at}] must be an object`);
    }
    return {
      value: stringValue(entry.value, `slides[${index}].kpis[${at}].value`, { maxLength: 40 }),
      label: stringValue(entry.label, `slides[${index}].kpis[${at}].label`, { maxLength: 80 }),
    };
  });
}

/**
 * Validates a composed deck. Image paths are resolved through the workspace
 * here, so a slide can never point the renderer at a file outside the grant.
 */
async function composedSlides(value, workspace) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('slides must contain at least one slide');
  }
  if (value.length > 60) throw new Error('slides may contain at most 60 slides');
  const composed = [];
  for (const [index, slide] of value.entries()) {
    if (!slide || typeof slide !== 'object' || Array.isArray(slide)) {
      throw new Error(`slides[${index}] must be an object`);
    }
    const layout = String(slide.layout || '');
    if (!SLIDE_LAYOUTS.has(layout)) {
      throw new Error(`slides[${index}].layout must be one of ${[...SLIDE_LAYOUTS].join(', ')}`);
    }
    const bullets = (list, label) => {
      if (list === undefined || list === null) return [];
      if (!Array.isArray(list)) throw new Error(`${label} must be an array of strings`);
      if (list.length > 8) throw new Error(`${label} may contain at most 8 lines`);
      return list.map((item, at) => stringValue(item, `${label}[${at}]`, { maxLength: 400 }));
    };
    const entry = {
      layout,
      title: stringValue(slide.title, `slides[${index}].title`, { maxLength: 300 }),
      subtitle: stringValue(slide.subtitle, `slides[${index}].subtitle`, { maxLength: 300 }),
      body: bullets(slide.body, `slides[${index}].body`),
      right: bullets(slide.right, `slides[${index}].right`),
    };
    if (layout === 'image') {
      // Optional on purpose: the slide draws a themed figure when there is no
      // picture, which is the only visual most installations can produce.
      const imageRelative = stringValue(slide.image_path, `slides[${index}].image_path`, {
        maxLength: 1000,
      });
      if (imageRelative) entry.imagePath = await workspace.resolveInput(imageRelative);
    }
    if (layout === 'chart') {
      const { categories, series } = slideChartData(slide, index);
      entry.chartType = enumValue(
        slide.chart_type, `slides[${index}].chart_type`, ['column', 'bar', 'line', 'pie', 'area'],
      ) || 'column';
      entry.categories = categories;
      entry.series = series;
    }
    if (layout === 'kpi') entry.kpis = slideKpis(slide, index);
    composed.push(entry);
  }
  return composed;
}

function enumValue(value, label, allowed) {
  if (value === undefined || value === null) return undefined;
  if (!allowed.includes(value)) throw new Error(`${label} must be one of ${allowed.join(', ')}`);
  return value;
}

function booleanValue(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function pointSize(value, label, minimum, maximum) {
  if (value === undefined || value === null) return undefined;
  const size = Number(value);
  if (!Number.isFinite(size) || size < minimum || size > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum} points`);
  }
  return size;
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

function macroScriptUri(value) {
  const uri = stringValue(value, 'script_uri', { required: true, maxLength: 600 });
  if (!/^vnd\.sun\.star\.script:[^?&\r\n]{1,500}\?language=Basic&location=document$/.test(uri)) {
    throw new Error('script_uri must identify a document-scoped LibreOffice Basic macro');
  }
  return uri;
}

function macroArguments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error('arguments must contain at most 20 primitive values');
  }
  let characters = 0;
  for (const argument of value) {
    if (argument !== null && !['string', 'number', 'boolean'].includes(typeof argument)) {
      throw new Error('Macro arguments may only contain primitive values');
    }
    if (typeof argument === 'number' && !Number.isFinite(argument)) {
      throw new Error('Macro number arguments must be finite');
    }
    characters += typeof argument === 'string' ? argument.length : 0;
  }
  if (characters > 10000) throw new Error('Macro string arguments may contain at most 10000 characters');
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
  /**
   * Close any open editor session on this absolute path before LibreOffice
   * mutates the file (stale Editor.bin would otherwise overwrite AI work).
   */
  onBeforeDocumentWrite = null,
  /** Tell the UI to reopen / refresh the path after an in-place apply. */
  onAfterDocumentWrite = null,
  /**
   * Builds the picture tool around a workspace-bound save, so a downloaded or
   * generated image can only ever land inside the granted folder. Given as a
   * factory because the save it needs belongs to this provider's workspace.
   */
  createImageProvider = null,
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

  /**
   * UNO stages the result to a temp path; this copies it onto the source and
   * removes the staging file. The open tab then reloads that same path.
   *
   * No sibling copy is kept: an agent editing one document repeatedly left a
   * pile of `name.magies-backup.ext` files beside it. Recovery comes from the
   * editor's own undo and from version control, not from litter in the user's
   * folder — and a write is refused outright while the tab holds unsaved edits.
   */
  const applyStagingInPlace = async (sourceRelative, stagingRelative) => {
    const inputPath = await workspace.resolveInput(sourceRelative);
    const stagingPath = await workspace.resolveInput(stagingRelative);
    await fileSystem.copyFile(stagingPath, inputPath);
    try {
      await fileSystem.unlink(stagingPath);
    } catch {
      // Staging may already be gone; the source has the result either way.
    }
    return {
      source: sourceRelative,
      written: sourceRelative,
      appliedInPlace: true,
    };
  };

  const callToolInner = async (functionName, rawArgs = {}, options = {}) => {
    if (functionName === 'office_image_search') {
      const picture = images();
      if (!picture) throw new Error('Pictures are not available in this build');
      // Saving goes through the workspace, so this cannot write outside the grant.
      workspace.getStatus().configured || await workspace.resolveInput('.');
      return picture.callTool(functionName, rawArgs, options);
    }
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

    if (functionName === 'office_word_resolve_changes') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const action = args.action;
      if (action !== 'accept' && action !== 'reject') throw new Error('action must be accept or reject');
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, WORD_EXTENSIONS, 'Word');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'word_resolve_changes',
        inputPath,
        outputPath: output.absolutePath,
        action,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        action,
        resolvedChanges: Number(result.resolvedChanges) || 0,
        remainingChanges: Number(result.remainingChanges) || 0,
      };
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

    if (functionName === 'office_word_append') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const authored = Array.isArray(args.blocks) && args.blocks.length > 0
        ? args.blocks
        : blocksFromMarkdown(stringValue(args.markdown, 'markdown', { maxLength: 40000 }));
      if (!Array.isArray(authored) || authored.length === 0) {
        throw new Error('Pass either blocks or markdown describing the content');
      }
      const blocks = documentBlocks(authored);
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, WORD_EXTENSIONS, 'Word');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'word_append',
        inputPath,
        outputPath: output.absolutePath,
        blocks,
        pageBreakBefore: args.page_break_before === true,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        blocksWritten: Number(result.blocksWritten) || blocks.length,
      };
    }

    if (functionName === 'office_word_compose') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const theme = enumValue(
        args.theme, 'theme', ['azure', 'slate', 'forest', 'plum', 'mono'],
      ) || 'azure';
      const authored = Array.isArray(args.blocks) && args.blocks.length > 0
        ? args.blocks
        : blocksFromMarkdown(stringValue(args.markdown, 'markdown', { maxLength: 40000 }));
      if (!Array.isArray(authored) || authored.length === 0) {
        throw new Error('Pass either blocks or markdown describing the document');
      }
      const blocks = documentBlocks(authored);
      const title = stringValue(args.title, 'title', { maxLength: 300 });
      // Markdown's leading "# " is the document title, but a cover page already
      // carries one. Left alone the document opens with the title twice, once on
      // the cover and once at the top of page two.
      if (title && blocks[0].style === 'title') blocks[0] = { ...blocks[0], style: 'heading1' };
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, WORD_EXTENSIONS, 'Word');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'word_compose',
        inputPath,
        outputPath: output.absolutePath,
        theme,
        blocks,
        // A cover needs a title; a subtitle or a byline on their own is a stray
        // line at the top of page one, not a cover.
        cover: title ? {
          title,
          subtitle: stringValue(args.subtitle, 'subtitle', { maxLength: 300 }),
          byline: stringValue(args.byline, 'byline', { maxLength: 200 }),
        } : null,
        tableOfContents: args.table_of_contents === true,
        tableOfContentsTitle: stringValue(args.table_of_contents_title, 'table_of_contents_title', {
          maxLength: 100,
        }),
        pageNumbers: args.page_numbers !== false,
        columns: integerValue(args.columns, 'columns', 1, { optional: true }) ?? 1,
        columnGapMm: numberValue(args.column_gap_mm, 'column_gap_mm', 0, 40) ?? 6,
        columnRule: args.column_rule === true,
        fontName: stringValue(args.font_name, 'font_name', { maxLength: 128 }),
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        blocksWritten: Number(result.blocksWritten) || blocks.length,
        theme,
      };
    }

    if (functionName === 'office_word_add_footnotes') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const entries = Array.isArray(args.footnotes) ? args.footnotes : [];
      if (entries.length === 0) throw new Error('footnotes must contain at least one note');
      if (entries.length > 100) throw new Error('footnotes may contain at most 100 notes');
      const footnotes = entries.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error(`footnotes[${index}] must be an object with find and text`);
        }
        return {
          find: stringValue(entry.find, `footnotes[${index}].find`, {
            required: true, maxLength: 2000,
          }),
          text: stringValue(entry.text, `footnotes[${index}].text`, {
            required: true, maxLength: 20000,
          }),
          kind: enumValue(entry.kind, `footnotes[${index}].kind`, ['footnote', 'endnote'])
            || 'footnote',
          occurrence: integerValue(entry.occurrence, `footnotes[${index}].occurrence`, 1, {
            optional: true,
          }) ?? 1,
          label: stringValue(entry.label, `footnotes[${index}].label`, { maxLength: 20 }),
          matchCase: entry.match_case !== false,
        };
      });
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, WORD_EXTENSIONS, 'Word');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'word_add_footnotes',
        inputPath,
        outputPath: output.absolutePath,
        footnotes,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        notesWritten: Number(result.notesWritten) || footnotes.length,
      };
    }

    if (functionName === 'office_word_format_text') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const find = stringValue(args.find, 'find', { required: true, maxLength: 2000 });
      const alignment = enumValue(
        args.alignment, 'alignment', ['left', 'center', 'right', 'justify'],
      );
      const fontSize = pointSize(args.font_size, 'font_size', 6, 96);
      const options_ = ['bold', 'italic', 'underline', 'font_name', 'font_size', 'text_color', 'highlight_color', 'alignment'];
      if (!options_.some((key) => args[key] !== undefined)) {
        throw new Error('Word text formatting requires at least one format option');
      }
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, WORD_EXTENSIONS, 'Word');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'word_format_text',
        inputPath,
        outputPath: output.absolutePath,
        find,
        bold: booleanValue(args.bold, 'bold'),
        italic: booleanValue(args.italic, 'italic'),
        underline: booleanValue(args.underline, 'underline'),
        fontName: stringValue(args.font_name, 'font_name', { maxLength: 128 }),
        fontSize,
        textColor: colorValue(args.text_color, 'text_color'),
        highlightColor: colorValue(args.highlight_color, 'highlight_color'),
        alignment,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        matched: Number(result.matched) || 0,
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
        caption: stringValue(args.caption, 'caption', { maxLength: 500 }),
        captionLabel: stringValue(args.caption_label, 'caption_label', { maxLength: 40 }),
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

    if (functionName === 'office_excel_add_comments') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const entries = Array.isArray(args.comments) ? args.comments : [];
      if (entries.length === 0) throw new Error('comments must contain at least one note');
      if (entries.length > 200) throw new Error('comments may contain at most 200 notes');
      const comments = entries.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error(`comments[${index}] must be an object with cell and text`);
        }
        const cell = stringValue(entry.cell, `comments[${index}].cell`, {
          required: true, maxLength: 20,
        }).toUpperCase();
        if (!CELL_REFERENCE.test(cell)) {
          throw new Error(`comments[${index}].cell must use A1 notation such as B4`);
        }
        return {
          cell,
          text: stringValue(entry.text, `comments[${index}].text`, {
            required: true, maxLength: 4000,
          }),
          visible: entry.visible === true,
        };
      });
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, EXCEL_EXTENSIONS, 'Excel');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'excel_add_comments',
        inputPath,
        outputPath: output.absolutePath,
        sheet: stringValue(args.sheet, 'sheet', { maxLength: 128 }),
        comments,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        sheet: String(result.sheet || ''),
        commentsWritten: Number(result.commentsWritten) || comments.length,
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
      const hasFormat = [
        'bold', 'italic', 'font_name', 'font_size', 'background_color', 'text_color',
        'horizontal_alignment', 'vertical_alignment', 'number_format', 'borders', 'merge',
        'wrap_text', 'optimal_width',
      ].some((key) => args[key] !== undefined);
      if (!hasFormat) throw new Error('Excel formatting requires at least one format option');
      booleanValue(args.bold, 'bold');
      booleanValue(args.italic, 'italic');
      booleanValue(args.merge, 'merge');
      booleanValue(args.wrap_text, 'wrap_text');
      booleanValue(args.optimal_width, 'optimal_width');
      const alignment = args.horizontal_alignment;
      if (alignment !== undefined && !['left', 'center', 'right'].includes(alignment)) {
        throw new Error('horizontal_alignment must be left, center, or right');
      }
      const verticalAlignment = enumValue(
        args.vertical_alignment, 'vertical_alignment', ['top', 'middle', 'bottom'],
      );
      const borders = enumValue(args.borders, 'borders', ['all', 'outline', 'none']);
      const fontSize = pointSize(args.font_size, 'font_size', 6, 96);
      const numberFormat = stringValue(args.number_format, 'number_format', { maxLength: 120 });
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
        italic: args.italic,
        fontName: stringValue(args.font_name, 'font_name', { maxLength: 128 }),
        fontSize,
        backgroundColor: colorValue(args.background_color, 'background_color'),
        textColor: colorValue(args.text_color, 'text_color'),
        horizontalAlignment: alignment,
        verticalAlignment,
        numberFormat,
        borders,
        merge: args.merge,
        wrapText: args.wrap_text,
        optimalWidth: args.optimal_width,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        formattedRange: String(result.formattedRange || range),
      };
    }

    if (functionName === 'office_excel_compose_table') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const theme = enumValue(
        args.theme, 'theme', ['azure', 'slate', 'forest', 'plum', 'mono'],
      ) || 'azure';
      const headers = (Array.isArray(args.headers) ? args.headers : []).map((header, index) =>
        stringValue(header, `headers[${index}]`, { maxLength: 200 }));
      if (headers.length === 0) throw new Error('headers must contain at least one column');
      const rows = excelValues(args.rows);
      const columnFormats = (Array.isArray(args.column_formats) ? args.column_formats : [])
        .map((code, index) => stringValue(code, `column_formats[${index}]`, { maxLength: 120 }));
      const startCell = stringValue(args.start_cell, 'start_cell', { maxLength: 20 }) || 'A1';
      if (!CELL_REFERENCE.test(startCell)) throw new Error('start_cell must use A1 notation');
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, EXCEL_EXTENSIONS, 'Excel');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'excel_compose_table',
        inputPath,
        outputPath: output.absolutePath,
        sheet: stringValue(args.sheet, 'sheet', { maxLength: 128 }),
        startCell: startCell.toUpperCase(),
        title: stringValue(args.title, 'title', { maxLength: 300 }),
        theme,
        headers,
        rows,
        columnFormats,
        totalsRow: args.totals_row === true,
        totalsLabel: stringValue(args.totals_label, 'totals_label', { maxLength: 100 }),
        bandedRows: args.banded_rows !== false,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        range: String(result.range || ''),
        rowsWritten: Number(result.rowsWritten) || rows.length,
        columns: Number(result.columns) || headers.length,
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
        grandTotalLabel: stringValue(args.grand_total_label, 'grand_total_label', { maxLength: 60 }),
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

    if (functionName === 'office_presentation_compose') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const theme = enumValue(
        args.theme, 'theme', ['azure', 'midnight', 'sand', 'forest', 'mono'],
      ) || 'azure';
      const outline = Array.isArray(args.slides) && args.slides.length > 0
        ? args.slides
        : slidesFromMarkdown(stringValue(args.markdown, 'markdown', { maxLength: 40000 }));
      if (!Array.isArray(outline) || outline.length === 0) {
        throw new Error('Pass either slides or markdown describing the deck');
      }
      const slides = await composedSlides(outline, workspace);
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, PRESENTATION_EXTENSIONS, 'Presentation');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'presentation_compose',
        inputPath,
        outputPath: output.absolutePath,
        theme,
        fontName: stringValue(args.font_name, 'font_name', { maxLength: 128 }),
        footer: stringValue(args.footer, 'footer', { maxLength: 120 }),
        replaceExisting: args.replace_existing !== false,
        slides,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        slidesComposed: Number(result.slidesComposed) || slides.length,
        theme,
      };
    }

    if (functionName === 'office_presentation_format_text') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const target = enumValue(args.target, 'target', ['title', 'body', 'all']);
      if (!target) throw new Error('target must be one of title, body, all');
      const slideNumber = integerValue(args.slide_number, 'slide_number', 0, { optional: true }) ?? 0;
      const fontSize = pointSize(args.font_size, 'font_size', 6, 200);
      const alignment = enumValue(
        args.alignment, 'alignment', ['left', 'center', 'right', 'justify'],
      );
      const chosen = ['font_name', 'font_size', 'bold', 'italic', 'text_color', 'alignment'];
      if (!chosen.some((key) => args[key] !== undefined)) {
        throw new Error('Slide text formatting requires at least one format option');
      }
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, PRESENTATION_EXTENSIONS, 'Presentation');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'presentation_format_text',
        inputPath,
        outputPath: output.absolutePath,
        slideNumber,
        target,
        fontName: stringValue(args.font_name, 'font_name', { maxLength: 128 }),
        fontSize,
        bold: booleanValue(args.bold, 'bold'),
        italic: booleanValue(args.italic, 'italic'),
        textColor: colorValue(args.text_color, 'text_color'),
        alignment,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        shapesFormatted: Number(result.shapesFormatted) || 0,
      };
    }

    if (functionName === 'office_presentation_apply_theme') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const theme = enumValue(
        args.theme, 'theme', ['azure', 'midnight', 'sand', 'forest', 'mono'],
      );
      if (!theme) throw new Error('theme must be azure, midnight, sand, forest, or mono');
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, PRESENTATION_EXTENSIONS, 'Presentation');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'presentation_apply_theme',
        inputPath,
        outputPath: output.absolutePath,
        theme,
        footer: stringValue(args.footer, 'footer', { maxLength: 120 }),
        fontName: stringValue(args.font_name, 'font_name', { maxLength: 128 }),
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        slidesRestyled: Number(result.slidesRestyled) || 0,
        theme,
      };
    }

    if (functionName === 'office_presentation_set_background') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const color = colorValue(args.color, 'color');
      if (!color) throw new Error('color is required, as #RRGGBB');
      const gradientTo = colorValue(args.gradient_to, 'gradient_to');
      const slideNumber = integerValue(args.slide_number, 'slide_number', 0, { optional: true }) ?? 0;
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, PRESENTATION_EXTENSIONS, 'Presentation');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      const result = await callUno({
        operation: 'presentation_set_background',
        inputPath,
        outputPath: output.absolutePath,
        slideNumber,
        color,
        gradientTo,
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        slidesPainted: Number(result.slidesPainted) || 0,
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
        layout: enumValue(
          args.layout, 'layout',
          ['title', 'section', 'bullets', 'two_column', 'quote', 'closing'],
        ),
        theme: enumValue(
          args.theme, 'theme', ['azure', 'midnight', 'sand', 'forest', 'mono'],
        ),
      }, options);
      return {
        source: relativePath,
        written: output.relativePath,
        slideNumber: Number(result.slideNumber) || 0,
        slidesTotal: Number(result.slidesTotal) || 0,
        // Empty on a deck Magies did not compose, which keeps its own look.
        theme: typeof result.theme === 'string' ? result.theme : '',
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

    if (functionName === 'office_macro_run') {
      const relativePath = stringValue(args.path, 'path', { required: true, maxLength: 1000 });
      const scriptUri = macroScriptUri(args.script_uri);
      const macroArgs = macroArguments(args.arguments);
      const inputPath = await workspace.resolveInput(relativePath);
      requireExtension(inputPath, MACRO_DOCUMENT_EXTENSIONS, 'macro');
      const output = await workspace.uniqueOutputPath(
        stringValue(args.output_directory, 'output_directory', { maxLength: 1000 }) || DEFAULT_OUTPUT_DIRECTORY,
        path.basename(inputPath),
      );
      await fileSystem.copyFile(inputPath, output.absolutePath, constants.COPYFILE_EXCL);
      let result;
      try {
        result = await callUno({
          operation: 'macro_run',
          inputPath: output.absolutePath,
          scriptUri,
          arguments: macroArgs,
        }, options);
      } catch (cause) {
        await fileSystem.rm(output.absolutePath, { force: true });
        throw cause;
      }
      return {
        source: relativePath,
        written: output.relativePath,
        scriptUri,
        returnValue: result.returnValue ?? null,
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

  const callTool = async (functionName, rawArgs = {}, options = {}) => {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const relativePath = typeof args.path === 'string' ? args.path : '';
    /**
     * In-place apply (overwrite source + UI reload) is the default for
     * single-document mutators. An explicit custom output_directory keeps the
     * historical "write a separate copy only" behaviour (used by tests and by
     * callers that want a side-by-side export).
     */
    const outputDirectory = typeof args.output_directory === 'string'
      ? args.output_directory.trim()
      : '';
    const applyInPlace = IN_PLACE_MUTATORS.has(functionName)
      && relativePath
      && (outputDirectory === '' || outputDirectory === DEFAULT_OUTPUT_DIRECTORY);

    let absoluteSource = '';
    if (applyInPlace) {
      absoluteSource = await workspace.resolveInput(relativePath);
      if (typeof onBeforeDocumentWrite === 'function') {
        await onBeforeDocumentWrite(absoluteSource);
      }
    }

    const result = await callToolInner(functionName, rawArgs, options);

    if (
      applyInPlace
      && result
      && typeof result === 'object'
      && typeof result.source === 'string'
      && typeof result.written === 'string'
      && result.written !== result.source
    ) {
      const applied = await applyStagingInPlace(result.source, result.written);
      if (typeof onAfterDocumentWrite === 'function' && absoluteSource) {
        await onAfterDocumentWrite(absoluteSource);
      }
      return { ...result, ...applied };
    }

    return result;
  };

  /** Always available for API/MCP discovery — not gated on workspace grant. */
  const describeTools = () => OFFICE_AUTOMATION_TOOLS.map((definition) => ({
    functionName: definition.functionName,
    toolId: definition.toolId,
    name: definition.name,
    description: definition.providerTool.function.description,
    parameters: definition.providerTool.function.parameters,
    unattended: definition.unattended !== false,
  }));

  /** Built-in AI only sees tools when a workspace is granted. */
  /** Writes image bytes into the grant, never over an existing file. */
  const saveWorkspaceImage = async (relativeDirectory, stem, extension, bytes) => {
    const output = await workspace.uniqueOutputPath(relativeDirectory, `${stem}${extension}`);
    await fileSystem.writeFile(output.absolutePath, bytes);
    return output.relativePath;
  };

  let imageProvider;
  const images = () => {
    if (imageProvider === undefined) {
      imageProvider = typeof createImageProvider === 'function'
        ? createImageProvider(saveWorkspaceImage)
        : null;
    }
    return imageProvider;
  };

  const listTools = async () => {
    if (!workspace.getStatus().configured) return [];
    const office = OFFICE_AUTOMATION_TOOLS.map((definition) => ({ ...definition }));
    const picture = images() ? await images().listTools() : [];
    return [...office, ...picture];
  };

  return {
    callTool,
    clearWorkspace: workspace.clear,
    describeTools,
    getWorkspaceStatus: workspace.getStatus,
    listTools,
    setWorkspaceRoot: workspace.setRoot,
    setWorkspaceFromDocumentPath: workspace.setRootFromDocumentPath,
  };
}

module.exports = {
  DEFAULT_OUTPUT_DIRECTORY,
  IN_PLACE_MUTATORS,
  OFFICE_AUTOMATION_TOOLS,
  createOfficeAutomationProvider,
  excelValues,
  macroArguments,
  macroScriptUri,
  wordTableValues,
};
