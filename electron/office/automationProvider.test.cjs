'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const { createOfficeAutomationProvider } = require('./automationProvider.cjs');
const { createOfficeWorkspace } = require('./workspace.cjs');

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magies-office-provider-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('createOfficeAutomationProvider', () => {
  it('exposes no tools before the user grants a workspace folder', async () => {
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async () => ({}),
    });

    assert.deepEqual(await provider.listTools(), []);
  });

  it('exposes filesystem, Word, Excel, PowerPoint, conversion, and archive tools after a grant', async () => {
    const root = await temporaryDirectory();
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async () => ({}),
    });
    await provider.setWorkspaceRoot(root);

    const tools = await provider.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.functionName),
      [
        'office_workspace_list',
        'office_word_read',
        'office_word_read_changes',
        'office_word_replace',
        'office_word_replace_tracked',
        'office_word_insert_table',
        'office_word_insert_image',
        'office_word_set_header_footer',
        'office_word_add_comment',
        'office_excel_read',
        'office_excel_write',
        'office_excel_sort_range',
        'office_excel_apply_autofilter',
        'office_excel_format_range',
        'office_excel_add_conditional_format',
        'office_excel_create_chart',
        'office_excel_create_pivot',
        'office_presentation_read',
        'office_presentation_replace',
        'office_presentation_add_slide',
        'office_presentation_duplicate_slide',
        'office_presentation_delete_slide',
        'office_presentation_insert_image',
        'office_presentation_insert_table',
        'office_presentation_set_notes',
        'office_template_fill',
        'office_template_batch_fill',
        'office_batch_convert_pdf',
        'office_workspace_archive',
      ],
    );
    assert.ok(tools.every((tool) => tool.requiresApproval === true));
    assert.match(tools[0].providerTool.function.description, /Office, PDF, and image files/);
  });

  it('reads and replaces PowerPoint text through LibreOffice', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Quarterly.pptx'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        if (request.operation === 'presentation_read') {
          return { slides: [{ number: 1, text: 'Q1 results' }], truncated: false };
        }
        await fs.copyFile(request.inputPath, request.outputPath);
        return { replacementCount: 1 };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(
      await provider.callTool('office_presentation_read', { path: 'Quarterly.pptx' }),
      { path: 'Quarterly.pptx', slides: [{ number: 1, text: 'Q1 results' }], truncated: false },
    );
    assert.deepEqual(
      await provider.callTool('office_presentation_replace', {
        path: 'Quarterly.pptx', find: 'Q1', replace: 'Q2', output_directory: 'Edited',
      }),
      { source: 'Quarterly.pptx', written: 'Edited/Quarterly.pptx', replacementCount: 1 },
    );
    assert.equal(calls.at(-1).operation, 'presentation_replace');
  });

  it('reads Word text and writes replacements to a non-overwriting copy', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Letter.docx'), 'source');
    await fs.mkdir(path.join(root, 'Edited'));
    await fs.writeFile(path.join(root, 'Edited', 'Letter.docx'), 'existing');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        if (request.operation === 'word_read') return { text: 'Hello world', truncated: false };
        await fs.copyFile(request.inputPath, request.outputPath);
        return { replacementCount: 2 };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(
      await provider.callTool('office_word_read', { path: 'Letter.docx' }),
      { path: 'Letter.docx', text: 'Hello world', truncated: false },
    );
    assert.deepEqual(
      await provider.callTool('office_word_replace', {
        path: 'Letter.docx',
        find: 'Hello',
        replace: 'Hi',
        output_directory: 'Edited',
      }),
      { source: 'Letter.docx', written: 'Edited/Letter (2).docx', replacementCount: 2 },
    );
    assert.equal(calls[1].outputPath, path.join(await fs.realpath(root), 'Edited', 'Letter (2).docx'));
  });

  it('reads Word revisions and writes replacements with change tracking enabled', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Contract.docx'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        if (request.operation === 'word_read_changes') {
          return {
            changes: [{ type: 'Insert', author: 'Ada', text: 'updated clause' }],
            truncated: false,
          };
        }
        await fs.copyFile(request.inputPath, request.outputPath);
        return { replacementCount: 1 };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(await provider.callTool('office_word_read_changes', {
      path: 'Contract.docx',
    }), {
      path: 'Contract.docx',
      changes: [{ type: 'Insert', author: 'Ada', text: 'updated clause' }],
      truncated: false,
    });
    assert.deepEqual(await provider.callTool('office_word_replace_tracked', {
      path: 'Contract.docx',
      find: 'old clause',
      replace: 'updated clause',
      match_case: false,
      output_directory: 'Reviewed',
    }), {
      source: 'Contract.docx',
      written: 'Reviewed/Contract.docx',
      replacementCount: 1,
    });
    assert.equal(calls[0].operation, 'word_read_changes');
    assert.deepEqual(calls[1], {
      operation: 'word_replace_tracked',
      inputPath: path.join(await fs.realpath(root), 'Contract.docx'),
      outputPath: path.join(await fs.realpath(root), 'Reviewed', 'Contract.docx'),
      find: 'old clause',
      replace: 'updated clause',
      matchCase: false,
      executable: '/office/soffice',
      signal: undefined,
    });
  });

  it('inserts a rectangular table into a Word copy', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Report.docx'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { rows: 2, columns: 2 };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(await provider.callTool('office_word_insert_table', {
      path: 'Report.docx',
      values: [['Department', 'Total'], ['Sales', 120]],
      has_header: true,
      output_directory: 'Edited',
    }), {
      source: 'Report.docx',
      written: 'Edited/Report.docx',
      rows: 2,
      columns: 2,
    });
    assert.equal(calls[0].operation, 'word_insert_table');
    assert.equal(calls[0].hasHeader, true);

    await assert.rejects(() => provider.callTool('office_word_insert_table', {
      path: 'Report.docx', values: [['A', 'B'], ['C']],
    }), /rectangular/);
  });

  it('inserts workspace images and configures Word headers and footers', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Report.docx'), 'source');
    await fs.writeFile(path.join(root, 'Logo.png'), 'image');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return request.operation === 'word_insert_image'
          ? { imageInserted: true }
          : { headerEnabled: true, footerEnabled: true };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(await provider.callTool('office_word_insert_image', {
      path: 'Report.docx',
      image_path: 'Logo.png',
      width_mm: 40,
      height_mm: 20,
      output_directory: 'Edited',
    }), {
      source: 'Report.docx',
      image: 'Logo.png',
      written: 'Edited/Report.docx',
      imageInserted: true,
    });
    assert.equal(calls[0].operation, 'word_insert_image');
    assert.equal(calls[0].imagePath, path.join(await fs.realpath(root), 'Logo.png'));
    assert.equal(calls[0].widthMm, 40);

    assert.deepEqual(await provider.callTool('office_word_set_header_footer', {
      path: 'Report.docx',
      header: 'Confidential',
      footer: 'Page footer',
      output_directory: 'Edited',
    }), {
      source: 'Report.docx',
      written: 'Edited/Report (2).docx',
      headerEnabled: true,
      footerEnabled: true,
    });
    assert.equal(calls[1].operation, 'word_set_header_footer');

    await assert.rejects(() => provider.callTool('office_word_insert_image', {
      path: 'Report.docx', image_path: 'Report.docx',
    }), /supported image/);
    await assert.rejects(() => provider.callTool('office_word_insert_image', {
      path: 'Report.docx', image_path: 'Logo.png', width_mm: 0,
    }), /width_mm/);
    await assert.rejects(() => provider.callTool('office_word_set_header_footer', {
      path: 'Report.docx',
    }), /header or footer/);
  });

  it('adds a Word comment to a selected text occurrence', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Report.docx'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { commentAdded: true, author: request.author, occurrence: request.occurrence };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(await provider.callTool('office_word_add_comment', {
      path: 'Report.docx',
      find: 'Revenue',
      comment: 'Verify this figure',
      author: 'Ada',
      initials: 'AD',
      occurrence: 2,
      match_case: false,
      output_directory: 'Reviewed',
    }), {
      source: 'Report.docx',
      written: 'Reviewed/Report.docx',
      commentAdded: true,
      author: 'Ada',
      occurrence: 2,
    });
    assert.equal(calls[0].operation, 'word_add_comment');
    assert.equal(calls[0].matchCase, false);
    assert.equal(calls[0].initials, 'AD');

    await assert.rejects(() => provider.callTool('office_word_add_comment', {
      path: 'Report.docx', find: 'Revenue', comment: '',
    }), /comment/);
    await assert.rejects(() => provider.callTool('office_word_add_comment', {
      path: 'Report.docx', find: 'Revenue', comment: 'Check', occurrence: 0,
    }), /occurrence/);
  });

  it('validates and delegates Excel range reads and writes', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Budget.xlsx'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        if (request.operation === 'excel_read') {
          return { sheet: 'Sheet1', range: 'A1:B2', values: [['Name', 'Total'], ['A', 10]], formulas: [] };
        }
        await fs.copyFile(request.inputPath, request.outputPath);
        return { cellsWritten: 4 };
      },
    });
    await provider.setWorkspaceRoot(root);

    const read = await provider.callTool('office_excel_read', {
      path: 'Budget.xlsx', sheet: 'Sheet1', range: 'A1:B2',
    });
    assert.deepEqual(read.values, [['Name', 'Total'], ['A', 10]]);

    const written = await provider.callTool('office_excel_write', {
      path: 'Budget.xlsx',
      sheet: 'Sheet1',
      start_cell: 'C2',
      values: [[10, '=SUM(A1:B1)'], [20, 30]],
      output_directory: 'Edited',
    });
    assert.equal(written.written, 'Edited/Budget.xlsx');
    assert.equal(written.cellsWritten, 4);
    assert.equal(calls.at(-1).startCell, 'C2');

    await assert.rejects(() => provider.callTool('office_excel_write', {
      path: 'Budget.xlsx', sheet: 'Sheet1', start_cell: 'not-a-cell', values: [[1]],
    }), /start_cell/);
  });

  it('formats Excel ranges and creates charts in non-overwriting copies', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Budget.xlsx'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        if (request.operation === 'excel_format_range') return { formattedRange: 'A1:B3' };
        return { chartName: 'Revenue' };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(await provider.callTool('office_excel_format_range', {
      path: 'Budget.xlsx',
      sheet: 'Sheet1',
      range: 'A1:B3',
      bold: true,
      background_color: '#ffeeaa',
      text_color: '#112233',
      horizontal_alignment: 'center',
      optimal_width: true,
      output_directory: 'Edited',
    }), {
      source: 'Budget.xlsx',
      written: 'Edited/Budget.xlsx',
      formattedRange: 'A1:B3',
    });
    assert.equal(calls[0].backgroundColor, '#FFEEAA');
    assert.equal(calls[0].horizontalAlignment, 'center');

    assert.deepEqual(await provider.callTool('office_excel_create_chart', {
      path: 'Budget.xlsx',
      sheet: 'Sheet1',
      data_range: 'A1:B3',
      chart_type: 'column',
      title: 'Revenue',
      first_row_labels: true,
      first_column_labels: true,
      output_directory: 'Edited',
    }), {
      source: 'Budget.xlsx',
      written: 'Edited/Budget (2).xlsx',
      chartName: 'Revenue',
    });
    assert.equal(calls[1].operation, 'excel_create_chart');
    assert.equal(calls[1].chartType, 'column');

    await assert.rejects(() => provider.callTool('office_excel_format_range', {
      path: 'Budget.xlsx', range: 'A1:B3',
    }), /at least one format/);
    await assert.rejects(() => provider.callTool('office_excel_create_chart', {
      path: 'Budget.xlsx', data_range: 'not-a-range', chart_type: 'column',
    }), /data_range/);
    await assert.rejects(() => provider.callTool('office_excel_format_range', {
      path: 'Budget.xlsx', range: 'A1:AZ200', bold: true,
    }), /at most 200 rows, 50 columns, and 5000 cells/);
  });

  it('creates an Excel pivot table from named fields, including Chinese headers', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, '销售.xlsx'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        if (calls.length > 1) return {};
        return {
          pivotName: '地区销售汇总',
          destinationSheet: '数据透视',
          outputRange: 'A1:C5',
        };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(await provider.callTool('office_excel_create_pivot', {
      path: '销售.xlsx',
      source_sheet: '销售明细',
      source_range: 'A1:C20',
      row_field: '地区',
      column_field: '产品',
      data_field: '销售额',
      function: 'sum',
      destination_sheet: '数据透视',
      destination_cell: 'A1',
      name: '地区销售汇总',
      output_directory: '分析结果',
    }), {
      source: '销售.xlsx',
      written: '分析结果/销售.xlsx',
      pivotName: '地区销售汇总',
      destinationSheet: '数据透视',
      outputRange: 'A1:C5',
    });
    assert.equal(calls[0].operation, 'excel_create_pivot');
    assert.equal(calls[0].rowField, '地区');
    assert.equal(calls[0].dataFunction, 'SUM');

    assert.deepEqual(await provider.callTool('office_excel_create_pivot', {
      path: '销售.xlsx',
      source_range: 'A1:B20',
      row_field: '地区',
      data_field: '销售额',
    }), {
      source: '销售.xlsx',
      written: 'Magies Office Output/销售.xlsx',
      pivotName: 'MagiesPivot',
      destinationSheet: 'Pivot',
      outputRange: '',
    });
    assert.equal(calls[1].columnField, '');
    assert.equal(calls[1].dataFunction, 'SUM');
    assert.equal(calls[1].destinationCell, 'A1');
    assert.equal(calls[1].destinationSheet, 'Pivot');

    await assert.rejects(() => provider.callTool('office_excel_create_pivot', {
      path: '销售.xlsx', source_range: 'A1:C20', row_field: '地区', data_field: '地区',
    }), /different fields/);
    await assert.rejects(() => provider.callTool('office_excel_create_pivot', {
      path: '销售.xlsx', source_range: 'A1:C20', row_field: '地区',
      data_field: '销售额', function: 'median',
    }), /function/);
    await assert.rejects(() => provider.callTool('office_excel_create_pivot', {
      path: '销售.xlsx', source_range: 'A1:C20', row_field: '地区',
      data_field: '销售额', destination_cell: 'invalid',
    }), /destination_cell/);
  });

  it('sorts Excel rows and applies an auto filter to a bounded range', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Budget.xlsx'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return request.operation === 'excel_sort_range'
          ? { sortedRange: request.range, keyColumn: request.keyColumn, ascending: request.ascending }
          : { filterRange: request.range, databaseRange: 'MagiesFilter' };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(await provider.callTool('office_excel_sort_range', {
      path: 'Budget.xlsx',
      sheet: 'Sheet1',
      range: 'A1:C5',
      key_column: 2,
      ascending: false,
      has_header: true,
      match_case: true,
      output_directory: 'Edited',
    }), {
      source: 'Budget.xlsx',
      written: 'Edited/Budget.xlsx',
      sortedRange: 'A1:C5',
      keyColumn: 2,
      ascending: false,
    });
    assert.equal(calls[0].operation, 'excel_sort_range');
    assert.equal(calls[0].containsHeader, true);
    assert.equal(calls[0].caseSensitive, true);

    assert.deepEqual(await provider.callTool('office_excel_apply_autofilter', {
      path: 'Budget.xlsx', sheet: 'Sheet1', range: 'A1:C5', output_directory: 'Edited',
    }), {
      source: 'Budget.xlsx',
      written: 'Edited/Budget (2).xlsx',
      filterRange: 'A1:C5',
      databaseRange: 'MagiesFilter',
    });
    assert.equal(calls[1].operation, 'excel_apply_autofilter');

    await assert.rejects(() => provider.callTool('office_excel_sort_range', {
      path: 'Budget.xlsx', range: 'A1:C5', key_column: 0,
    }), /key_column/);
    await assert.rejects(() => provider.callTool('office_excel_sort_range', {
      path: 'Budget.xlsx', range: 'A1:C5', key_column: 51,
    }), /key_column/);
    await assert.rejects(() => provider.callTool('office_excel_apply_autofilter', {
      path: 'Budget.xlsx', range: 'not-a-range',
    }), /range/);
  });

  it('adds, duplicates, and deletes PowerPoint slides in non-overwriting copies', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Quarterly.pptx'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        if (request.operation === 'presentation_add_slide') {
          return { slideNumber: 2, slidesTotal: 3 };
        }
        if (request.operation === 'presentation_duplicate_slide') {
          return { sourceSlideNumber: 1, duplicatedSlideNumber: 2, slidesTotal: 3 };
        }
        return { deletedSlideNumber: 1, slidesRemaining: 1 };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(await provider.callTool('office_presentation_add_slide', {
      path: 'Quarterly.pptx',
      after_slide: 1,
      title: 'Next quarter',
      body: ['Revenue target', 'Hiring plan'],
      output_directory: 'Edited',
    }), {
      source: 'Quarterly.pptx',
      written: 'Edited/Quarterly.pptx',
      slideNumber: 2,
      slidesTotal: 3,
    });
    assert.equal(calls[0].afterSlide, 1);
    assert.deepEqual(calls[0].body, ['Revenue target', 'Hiring plan']);

    assert.deepEqual(await provider.callTool('office_presentation_duplicate_slide', {
      path: 'Quarterly.pptx', slide_number: 1, output_directory: 'Edited',
    }), {
      source: 'Quarterly.pptx',
      written: 'Edited/Quarterly (2).pptx',
      sourceSlideNumber: 1,
      duplicatedSlideNumber: 2,
      slidesTotal: 3,
    });
    assert.equal(calls[1].operation, 'presentation_duplicate_slide');
    assert.equal(calls[1].slideNumber, 1);

    assert.deepEqual(await provider.callTool('office_presentation_delete_slide', {
      path: 'Quarterly.pptx', slide_number: 1, output_directory: 'Edited',
    }), {
      source: 'Quarterly.pptx',
      written: 'Edited/Quarterly (3).pptx',
      deletedSlideNumber: 1,
      slidesRemaining: 1,
    });

    await assert.rejects(() => provider.callTool('office_presentation_duplicate_slide', {
      path: 'Quarterly.pptx', slide_number: 0,
    }), /slide_number/);
    await assert.rejects(() => provider.callTool('office_presentation_delete_slide', {
      path: 'Quarterly.pptx', slide_number: 0,
    }), /slide_number/);
  });

  it('inserts PowerPoint images and updates speaker notes', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Quarterly.pptx'), 'source');
    await fs.writeFile(path.join(root, 'Chart.jpg'), 'image');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return request.operation === 'presentation_insert_image'
          ? { imageInserted: true }
          : { noteCharacters: 18 };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(await provider.callTool('office_presentation_insert_image', {
      path: 'Quarterly.pptx',
      image_path: 'Chart.jpg',
      slide_number: 1,
      x_mm: 20,
      y_mm: 30,
      width_mm: 120,
      height_mm: 70,
      output_directory: 'Edited',
    }), {
      source: 'Quarterly.pptx',
      image: 'Chart.jpg',
      written: 'Edited/Quarterly.pptx',
      slideNumber: 1,
      imageInserted: true,
    });
    assert.equal(calls[0].operation, 'presentation_insert_image');
    assert.equal(calls[0].xMm, 20);

    assert.deepEqual(await provider.callTool('office_presentation_set_notes', {
      path: 'Quarterly.pptx',
      slide_number: 1,
      notes: 'Discuss the forecast',
      output_directory: 'Edited',
    }), {
      source: 'Quarterly.pptx',
      written: 'Edited/Quarterly (2).pptx',
      slideNumber: 1,
      noteCharacters: 18,
    });
    assert.equal(calls[1].operation, 'presentation_set_notes');

    await assert.rejects(() => provider.callTool('office_presentation_insert_image', {
      path: 'Quarterly.pptx', image_path: 'Chart.jpg', slide_number: 0,
    }), /slide_number/);
    await assert.rejects(() => provider.callTool('office_presentation_set_notes', {
      path: 'Quarterly.pptx', slide_number: 1, notes: 'x'.repeat(20001),
    }), /notes/);
  });

  it('inserts a bounded table into a PowerPoint slide', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Quarterly.pptx'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { rows: request.values.length, columns: request.values[0].length };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(await provider.callTool('office_presentation_insert_table', {
      path: 'Quarterly.pptx',
      slide_number: 1,
      values: [['Region', 'Revenue'], ['West', 120]],
      has_header: true,
      x_mm: 20,
      y_mm: 40,
      width_mm: 180,
      height_mm: 80,
      output_directory: 'Edited',
    }), {
      source: 'Quarterly.pptx',
      written: 'Edited/Quarterly.pptx',
      slideNumber: 1,
      rows: 2,
      columns: 2,
    });
    assert.equal(calls[0].operation, 'presentation_insert_table');
    assert.equal(calls[0].hasHeader, true);
    assert.equal(calls[0].widthMm, 180);

    assert.deepEqual(await provider.callTool('office_presentation_insert_table', {
      path: 'Quarterly.pptx', slide_number: 1, values: [['Flag', null, true]],
      output_directory: 'Edited',
    }), {
      source: 'Quarterly.pptx',
      written: 'Edited/Quarterly (2).pptx',
      slideNumber: 1,
      rows: 1,
      columns: 3,
    });
    assert.equal(calls[1].hasHeader, false);
    assert.equal(calls[1].xMm, 20);
    assert.equal(calls[1].heightMm, 80);

    await assert.rejects(() => provider.callTool('office_presentation_insert_table', {
      path: 'Quarterly.pptx', slide_number: 1, values: [['A', 'B'], ['C']],
    }), /rectangular/);
    await assert.rejects(() => provider.callTool('office_presentation_insert_table', {
      path: 'Quarterly.pptx', slide_number: 0, values: [['A']],
    }), /slide_number/);
    await assert.rejects(() => provider.callTool('office_presentation_insert_table', {
      path: 'Quarterly.pptx', slide_number: 1, values: 'not-an-array',
    }), /between 1 and 20 table rows/);
    await assert.rejects(() => provider.callTool('office_presentation_insert_table', {
      path: 'Quarterly.pptx', slide_number: 1, values: [],
    }), /between 1 and 20 table rows/);
    await assert.rejects(() => provider.callTool('office_presentation_insert_table', {
      path: 'Quarterly.pptx', slide_number: 1, values: Array.from({ length: 21 }, () => ['A']),
    }), /between 1 and 20 table rows/);
    await assert.rejects(() => provider.callTool('office_presentation_insert_table', {
      path: 'Quarterly.pptx', slide_number: 1, values: [[]],
    }), /between 1 and 10 cells/);
    await assert.rejects(() => provider.callTool('office_presentation_insert_table', {
      path: 'Quarterly.pptx', slide_number: 1, values: [Array(11).fill('A')],
    }), /between 1 and 10 cells/);
    await assert.rejects(() => provider.callTool('office_presentation_insert_table', {
      path: 'Quarterly.pptx', slide_number: 1, values: [[Symbol('invalid')]],
    }), /table cells/);
    await assert.rejects(() => provider.callTool('office_presentation_insert_table', {
      path: 'Quarterly.pptx', slide_number: 1, values: [['x'.repeat(50001)]],
    }), /50000 characters/);
  });

  it('fills template variables in Word, Excel, or PowerPoint copies', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Template.docx'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { documentType: 'word', replacementCount: 2 };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(await provider.callTool('office_template_fill', {
      path: 'Template.docx',
      replacements: { '{{name}}': 'Ada', '{{total}}': 42, '{{optional}}': null },
      output_directory: 'Generated',
    }), {
      source: 'Template.docx',
      written: 'Generated/Template.docx',
      documentType: 'word',
      replacementCount: 2,
    });
    assert.equal(calls[0].operation, 'template_fill');
    assert.deepEqual(calls[0].replacements, {
      '{{name}}': 'Ada', '{{total}}': '42', '{{optional}}': '',
    });

    await assert.rejects(() => provider.callTool('office_template_fill', {
      path: 'Template.docx', replacements: {},
    }), /replacements/);
    await assert.rejects(() => provider.callTool('office_template_fill', {
      path: 'Template.docx', replacements: { '{{name}}': { unsafe: true } },
    }), /replacement values/);
  });

  it('fills one Office template from multiple validated records', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Template.docx'), 'source');
    const calls = [];
    const progress = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { documentType: 'word', replacementCount: 2 };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(await provider.callTool('office_template_batch_fill', {
      path: 'Template.docx',
      records: [
        { '{{name}}': 'Ada', '{{total}}': 42 },
        { '{{name}}': '张伟', '{{total}}': 18 },
      ],
      output_name_key: '{{name}}',
      output_directory: 'Generated',
    }, { onProgress: (value) => progress.push(value) }), {
      source: 'Template.docx',
      generated: 2,
      written: ['Generated/Template - Ada.docx', 'Generated/Template - 张伟.docx'],
      documentType: 'word',
      replacementCount: 4,
    });
    assert.deepEqual(calls.map((call) => call.operation), ['template_fill', 'template_fill']);
    assert.deepEqual(calls[0].replacements, { '{{name}}': 'Ada', '{{total}}': '42' });
    assert.deepEqual(progress, [0.5, 1]);

    await assert.rejects(() => provider.callTool('office_template_batch_fill', {
      path: 'Template.docx', records: [],
    }), /records/);
    await assert.rejects(() => provider.callTool('office_template_batch_fill', {
      path: 'Template.docx', records: [{ '{{name}}': { unsafe: true } }],
    }), /replacement values/);
    await assert.rejects(() => provider.callTool('office_template_batch_fill', {
      path: 'Template.docx', records: [{ '{{name}}': 'Ada' }], output_name_key: '{{missing}}',
    }), /output_name_key/);
    assert.equal(calls.length, 2);
  });

  it('reports completed template outputs when a later record fails', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Template.docx'), 'source');
    let callCount = 0;
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        callCount += 1;
        if (callCount === 2) throw new Error('LibreOffice stopped');
        await fs.copyFile(request.inputPath, request.outputPath);
        return { documentType: 'word', replacementCount: 1 };
      },
    });
    await provider.setWorkspaceRoot(root);

    await assert.rejects(() => provider.callTool('office_template_batch_fill', {
      path: 'Template.docx',
      records: [{ '{{name}}': 'Ada' }, { '{{name}}': 'Grace' }],
      output_directory: 'Generated',
    }), /failed after 1 files.*Generated\/Template - 1\.docx/);
    assert.equal(await fs.readFile(path.join(root, 'Generated', 'Template - 1.docx'), 'utf8'), 'source');
  });

  it('adds bounded Excel conditional formatting with a dedicated cell style', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Budget.xlsx'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { formattedRange: 'B2:B20', styleName: 'MagiesConditional' };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(await provider.callTool('office_excel_add_conditional_format', {
      path: 'Budget.xlsx',
      sheet: 'Summary',
      range: 'b2:b20',
      operator: 'greater_equal',
      formula1: '100',
      background_color: '#fff2cc',
      text_color: '#9c0006',
      bold: true,
      output_directory: 'Formatted',
    }), {
      source: 'Budget.xlsx',
      written: 'Formatted/Budget.xlsx',
      formattedRange: 'B2:B20',
      styleName: 'MagiesConditional',
    });
    assert.deepEqual(calls[0], {
      operation: 'excel_add_conditional_format',
      inputPath: path.join(await fs.realpath(root), 'Budget.xlsx'),
      outputPath: path.join(await fs.realpath(root), 'Formatted', 'Budget.xlsx'),
      sheet: 'Summary',
      range: 'B2:B20',
      operator: 'GREATER_EQUAL',
      formula1: '100',
      formula2: '',
      backgroundColor: '#FFF2CC',
      textColor: '#9C0006',
      bold: true,
      executable: '/office/soffice',
      signal: undefined,
    });

    await assert.rejects(() => provider.callTool('office_excel_add_conditional_format', {
      path: 'Budget.xlsx', range: 'A1:A5', operator: 'between', formula1: '1', background_color: '#FFFFFF',
    }), /formula2/);
    await assert.rejects(() => provider.callTool('office_excel_add_conditional_format', {
      path: 'Budget.xlsx', range: 'A1:A5', operator: 'contains', formula1: '1', background_color: '#FFFFFF',
    }), /operator/);
    await assert.rejects(() => provider.callTool('office_excel_add_conditional_format', {
      path: 'Budget.xlsx', range: 'A1:A5', operator: 'equal', formula1: '1',
    }), /style option/);
  });

  it('rejects invalid structural-editing arguments and supports safe defaults', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Report.docx'), 'source');
    await fs.writeFile(path.join(root, 'Budget.xlsx'), 'source');
    await fs.writeFile(path.join(root, 'Quarterly.pptx'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return {};
      },
    });
    await provider.setWorkspaceRoot(root);

    for (const values of [[], [[]], [[Symbol('invalid')]]]) {
      await assert.rejects(() => provider.callTool('office_word_insert_table', {
        path: 'Report.docx', values,
      }), /values|table row|table cells/);
    }
    assert.deepEqual(await provider.callTool('office_word_insert_table', {
      path: 'Report.docx', values: [['A']],
    }), {
      source: 'Report.docx',
      written: 'Magies Office Output/Report.docx',
      rows: 1,
      columns: 1,
    });

    const invalidFormats = [
      { bold: 'yes' },
      { optimal_width: 'yes' },
      { horizontal_alignment: 'justify' },
      { background_color: '#XYZXYZ' },
      { text_color: 123456 },
    ];
    for (const format of invalidFormats) {
      await assert.rejects(() => provider.callTool('office_excel_format_range', {
        path: 'Budget.xlsx', range: 'A1', ...format,
      }), /boolean|horizontal_alignment|six-digit hex color/);
    }
    assert.equal((await provider.callTool('office_excel_format_range', {
      path: 'Budget.xlsx', range: 'A1', bold: false,
    })).formattedRange, 'A1');

    await assert.rejects(() => provider.callTool('office_excel_create_chart', {
      path: 'Budget.xlsx', data_range: 'A1:B2', chart_type: 'scatter',
    }), /chart_type/);
    assert.equal((await provider.callTool('office_excel_create_chart', {
      path: 'Budget.xlsx',
      data_range: 'A1:B2',
      chart_type: 'line',
      first_row_labels: false,
      first_column_labels: false,
    })).chartName, 'Chart');
    assert.equal(calls.at(-1).firstRowLabels, false);
    assert.equal(calls.at(-1).firstColumnLabels, false);

    await assert.rejects(() => provider.callTool('office_presentation_add_slide', {
      path: 'Quarterly.pptx',
    }), /requires a title or body/);
    await assert.rejects(() => provider.callTool('office_presentation_add_slide', {
      path: 'Quarterly.pptx', body: 'not-an-array',
    }), /body/);
    await assert.rejects(() => provider.callTool('office_presentation_add_slide', {
      path: 'Quarterly.pptx', body: Array(11).fill('x'.repeat(2000)),
    }), /body/);
    await assert.rejects(() => provider.callTool('office_presentation_add_slide', {
      path: 'Quarterly.pptx', title: 'Title', after_slide: 1.5,
    }), /after_slide/);
    assert.deepEqual(await provider.callTool('office_presentation_add_slide', {
      path: 'Quarterly.pptx', body: ['Only body'],
    }), {
      source: 'Quarterly.pptx',
      written: 'Magies Office Output/Quarterly.pptx',
      slideNumber: 0,
      slidesTotal: 0,
    });
    assert.equal(calls.at(-1).afterSlide, undefined);
  });

  it('converts Office files to unique PDFs and archives without overwriting', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'A.docx'), 'a');
    await fs.writeFile(path.join(root, 'B.xlsx'), 'b');
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        await fs.writeFile(request.outputPath, 'pdf');
        return { pageCount: 1 };
      },
    });
    await provider.setWorkspaceRoot(root);

    const converted = await provider.callTool('office_batch_convert_pdf', {
      paths: ['A.docx', 'B.xlsx'], output_directory: 'PDF',
    });
    assert.deepEqual(converted.written, ['PDF/A.pdf', 'PDF/B.pdf']);

    await fs.mkdir(path.join(root, 'Archive'));
    await fs.writeFile(path.join(root, 'Archive', 'A.docx'), 'existing');
    const archived = await provider.callTool('office_workspace_archive', {
      paths: ['A.docx'], destination: 'Archive', mode: 'copy',
    });
    assert.deepEqual(archived.written, ['Archive/A (2).docx']);
    assert.equal(await fs.readFile(path.join(root, 'A.docx'), 'utf8'), 'a');
  });

  it('fails loudly when LibreOffice is unavailable or a tool name is unknown', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Letter.docx'), 'source');
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '',
      runUno: async () => ({}),
    });
    await provider.setWorkspaceRoot(root);

    await assert.rejects(
      () => provider.callTool('office_word_read', { path: 'Letter.docx' }),
      /LibreOffice is unavailable/,
    );
    await assert.rejects(() => provider.callTool('office_unknown', {}), /Unknown Office Agent tool/);
  });
});
