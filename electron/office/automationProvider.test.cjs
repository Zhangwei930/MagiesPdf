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
        'office_word_resolve_changes',
        'office_word_replace',
        'office_word_replace_tracked',
        'office_word_append',
        'office_word_compose',
        'office_word_add_footnotes',
        'office_word_format_text',
        'office_word_insert_table',
        'office_word_insert_image',
        'office_word_set_header_footer',
        'office_word_add_comment',
        'office_excel_read',
        'office_excel_write',
        'office_excel_add_comments',
        'office_excel_sort_range',
        'office_excel_apply_autofilter',
        'office_excel_format_range',
        'office_excel_compose_table',
        'office_excel_add_conditional_format',
        'office_excel_create_chart',
        'office_excel_create_pivot',
        'office_presentation_read',
        'office_presentation_replace',
        'office_presentation_add_slide',
        'office_presentation_compose',
        'office_presentation_format_text',
        'office_presentation_apply_theme',
        'office_presentation_set_background',
        'office_presentation_duplicate_slide',
        'office_presentation_delete_slide',
        'office_presentation_insert_image',
        'office_presentation_insert_table',
        'office_presentation_set_notes',
        'office_template_fill',
        'office_template_batch_fill',
        'office_macro_run',
        'office_batch_convert_pdf',
        'office_workspace_archive',
      ],
    );
    assert.ok(tools.every((tool) => tool.requiresApproval === true));
    assert.equal(tools.find((tool) => tool.functionName === 'office_macro_run').unattended, false);
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

  it('accepts or rejects all Word revisions in a non-overwriting copy', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Contract.docx'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { action: request.action, resolvedChanges: 3, remainingChanges: 0 };
      },
    });
    await provider.setWorkspaceRoot(root);

    assert.deepEqual(await provider.callTool('office_word_resolve_changes', {
      path: 'Contract.docx', action: 'accept', output_directory: 'Reviewed',
    }), {
      source: 'Contract.docx',
      written: 'Reviewed/Contract.docx',
      action: 'accept',
      resolvedChanges: 3,
      remainingChanges: 0,
    });
    assert.equal(calls[0].operation, 'word_resolve_changes');
    assert.equal(calls[0].action, 'accept');
    await assert.rejects(() => provider.callTool('office_word_resolve_changes', {
      path: 'Contract.docx', action: 'some',
    }), /action must be accept or reject/);
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
      grand_total_label: '总计',
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
    // The engine names the grand total in English otherwise, which is the same
    // tell as an English footer on a Chinese report.
    assert.equal(calls[0].grandTotalLabel, '总计');

    assert.deepEqual(await provider.callTool('office_excel_create_pivot', {
      path: '销售.xlsx',
      source_range: 'A1:B20',
      row_field: '地区',
      data_field: '销售额',
    }), {
      source: '销售.xlsx',
      written: '销售.xlsx', appliedInPlace: true,
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
      // Empty because this deck was never composed by Magies, so it keeps its
      // own look rather than having one slide restyled to ours.
      theme: '',
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

  it('runs only a document-scoped LibreOffice Basic macro in an approved copy', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Trusted.odt'), 'source');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.writeFile(request.inputPath, 'macro result');
        return { returnValue: '完成' };
      },
    });
    await provider.setWorkspaceRoot(root);
    const scriptUri = 'vnd.sun.star.script:Standard.Module1.Main?language=Basic&location=document';

    assert.deepEqual(await provider.callTool('office_macro_run', {
      path: 'Trusted.odt', script_uri: scriptUri, arguments: ['中文', 2, true, null],
      output_directory: 'Macro Output',
    }), {
      source: 'Trusted.odt',
      written: 'Macro Output/Trusted.odt',
      scriptUri,
      returnValue: '完成',
    });
    assert.equal(calls[0].operation, 'macro_run');
    assert.equal(calls[0].inputPath, path.join(await fs.realpath(root), 'Macro Output', 'Trusted.odt'));
    assert.equal(calls[0].outputPath, undefined);
    assert.deepEqual(calls[0].arguments, ['中文', 2, true, null]);
    assert.equal(await fs.readFile(path.join(root, 'Trusted.odt'), 'utf8'), 'source');
    assert.equal(await fs.readFile(calls[0].inputPath, 'utf8'), 'macro result');
    await assert.rejects(() => provider.callTool('office_macro_run', {
      path: 'Trusted.odt',
      script_uri: 'vnd.sun.star.script:Standard.Module1.Main?language=Basic&location=user',
    }), /document-scoped/);
    await assert.rejects(() => provider.callTool('office_macro_run', {
      path: 'Trusted.odt', script_uri: scriptUri, arguments: [{ command: 'unsafe' }],
    }), /primitive/);
    await assert.rejects(() => provider.callTool('office_macro_run', {
      path: 'Trusted.odt', script_uri: scriptUri.replace('language=Basic', 'language=Python'),
    }), /LibreOffice Basic/);
  });

  it('removes the macro copy if execution fails and preserves the original', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Trusted.odt'), 'source');
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async () => {
        throw new Error('Macro failed');
      },
    });
    await provider.setWorkspaceRoot(root);

    await assert.rejects(() => provider.callTool('office_macro_run', {
      path: 'Trusted.odt',
      script_uri: 'vnd.sun.star.script:Standard.Module1.Main?language=Basic&location=document',
      output_directory: 'Macro Output',
    }), /Macro failed/);
    assert.equal(await fs.readFile(path.join(root, 'Trusted.odt'), 'utf8'), 'source');
    await assert.rejects(() => fs.access(path.join(root, 'Macro Output', 'Trusted.odt')), /ENOENT/);
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
      written: 'Report.docx', appliedInPlace: true,
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
      written: 'Quarterly.pptx', appliedInPlace: true,
      slideNumber: 0,
      slidesTotal: 0,
      theme: '',
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

  it('applies Excel writes in place with a backup and refresh hooks', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Live.xlsx'), 'before');
    const hooks = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        await fs.writeFile(request.outputPath, 'after-ai');
        return { cellsWritten: 3 };
      },
      onBeforeDocumentWrite: async (absolutePath) => { hooks.push(['before', absolutePath]); },
      onAfterDocumentWrite: async (absolutePath) => { hooks.push(['after', absolutePath]); },
    });
    await provider.setWorkspaceRoot(root);

    // Default output directory (omitted) → in-place apply so the open tab can reload.
    const result = await provider.callTool('office_excel_write', {
      path: 'Live.xlsx',
      start_cell: 'A1',
      values: [['x']],
    });
    assert.equal(result.written, 'Live.xlsx');
    assert.equal(result.appliedInPlace, true);
    assert.equal(await fs.readFile(path.join(root, 'Live.xlsx'), 'utf8'), 'after-ai');
    // Nothing else is left beside it.
    assert.deepEqual((await fs.readdir(root)).filter((n) => n.includes('backup')), []);
    assert.equal(hooks.length, 2);
    assert.equal(hooks[0][0], 'before');
    assert.equal(hooks[1][0], 'after');
  });

  it('writes Word content the agent composed, with real paragraph styles', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Report.docx'), 'doc');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { blocksWritten: request.blocks.length };
      },
    });
    await provider.setWorkspaceRoot(root);

    const result = await provider.callTool('office_word_append', {
      path: 'Report.docx',
      blocks: [
        { style: 'title', text: '季度报告' },
        { style: 'heading1', text: '收入' },
        { style: 'body', text: '本季度收入增长 12%。' },
        { style: 'bullet', text: '华东区领先' },
      ],
    });
    assert.equal(result.written, 'Report.docx');
    assert.equal(result.appliedInPlace, true);
    assert.equal(calls[0].operation, 'word_append');
    assert.deepEqual(calls[0].blocks[0], { style: 'title', text: '季度报告' });

    await assert.rejects(
      () => provider.callTool('office_word_append', { path: 'Report.docx', blocks: [] }),
      /either blocks or markdown/,
    );

    // Markdown is the easier route, and lands as the same styled blocks.
    const fromMarkdown = await provider.callTool('office_word_append', {
      path: 'Report.docx',
      markdown: '# 季度报告\n## 收入\n- 同比 +12%\n  - 华东领先',
    });
    assert.equal(fromMarkdown.written, 'Report.docx');
    // Only list items carry a level; a heading has no depth Word could draw.
    assert.deepEqual(calls.at(-1).blocks, [
      { style: 'title', text: '季度报告' },
      { style: 'heading2', text: '收入' },
      { style: 'bullet', text: '同比 +12%', level: 0 },
      { style: 'bullet', text: '华东领先', level: 1 },
    ]);
    await assert.rejects(
      () => provider.callTool('office_word_append', {
        path: 'Report.docx',
        blocks: [{ style: 'chapter', text: 'x' }],
      }),
      /style/,
    );
  });

  it('styles Word text the agent points at', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Report.docx'), 'doc');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { matched: 2 };
      },
    });
    await provider.setWorkspaceRoot(root);

    const result = await provider.callTool('office_word_format_text', {
      path: 'Report.docx',
      find: '收入',
      bold: true,
      font_size: 14,
      text_color: '#1F4E79',
      alignment: 'center',
    });
    assert.equal(result.matched, 2);
    assert.equal(calls[0].fontSize, 14);
    assert.equal(calls[0].textColor, '#1F4E79');

    await assert.rejects(
      () => provider.callTool('office_word_format_text', { path: 'Report.docx', find: '收入' }),
      /at least one format option/,
    );
    await assert.rejects(
      () => provider.callTool('office_word_format_text', {
        path: 'Report.docx', find: '收入', font_size: 400,
      }),
      /font_size/,
    );
  });

  it('formats Excel the way a readable sheet needs, not just bold and a fill', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Budget.xlsx'), 'sheet');
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

    await provider.callTool('office_excel_format_range', {
      path: 'Budget.xlsx',
      range: 'A1:F1',
      number_format: '#,##0.00',
      font_size: 12,
      font_name: '微软雅黑',
      italic: false,
      borders: 'all',
      wrap_text: true,
      vertical_alignment: 'middle',
      merge: false,
    });
    const [request] = calls;
    assert.equal(request.numberFormat, '#,##0.00');
    assert.equal(request.fontSize, 12);
    assert.equal(request.fontName, '微软雅黑');
    assert.equal(request.borders, 'all');
    assert.equal(request.wrapText, true);
    assert.equal(request.verticalAlignment, 'middle');

    for (const invalid of [
      { font_size: 0 },
      { borders: 'dotted' },
      { vertical_alignment: 'baseline' },
      { number_format: 'x'.repeat(200) },
    ]) {
      await assert.rejects(() => provider.callTool('office_excel_format_range', {
        path: 'Budget.xlsx', range: 'A1', ...invalid,
      }), /font_size|borders|vertical_alignment|number_format/);
    }
  });

  it('offers the picture tool only when one is configured, and saves inside the grant', async () => {
    const root = await temporaryDirectory();
    const saves = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async () => ({}),
      createImageProvider: (saveImage) => ({
        listTools: async () => [{ functionName: 'office_image_search', toolId: 'office:image:search' }],
        callTool: async (_name, args) => {
          // The save it was handed is the only way out to disk.
          const relativePath = await saveImage('Images', 'cover', '.png', Buffer.from('png'));
          saves.push(relativePath);
          return { query: args.query, images: [{ path: relativePath }] };
        },
      }),
    });
    await provider.setWorkspaceRoot(root);

    const tools = (await provider.listTools()).map((tool) => tool.functionName);
    assert.ok(tools.includes('office_image_search'));
    assert.equal(tools.at(-1), 'office_image_search', 'listed after the Office tools');

    const result = await provider.callTool('office_image_search', { query: 'city skyline' });
    assert.equal(result.images[0].path, 'Images/cover.png');
    assert.equal(await fs.readFile(path.join(root, 'Images', 'cover.png'), 'utf8'), 'png');
    assert.deepEqual(saves, ['Images/cover.png']);

    // Without a provider the tool is simply not there.
    const bare = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async () => ({}),
    });
    await bare.setWorkspaceRoot(root);
    assert.equal(
      (await bare.listTools()).some((tool) => tool.functionName === 'office_image_search'),
      false,
    );
  });

  it('attaches footnotes and endnotes in one call, defaulting to numbered footnotes', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Report.docx'), 'doc');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { notesWritten: request.footnotes.length };
      },
    });
    await provider.setWorkspaceRoot(root);

    const result = await provider.callTool('office_word_add_footnotes', {
      path: 'Report.docx',
      footnotes: [
        { find: '18%', text: '不含汇兑影响。' },
        { find: '增长', text: '口径见附录一。', kind: 'endnote', occurrence: 2, label: '*' },
      ],
    });
    assert.equal(result.notesWritten, 2);
    assert.equal(calls.length, 1, 'one call, not one per note');
    // An empty label is what keeps a note automatically numbered, so the
    // default has to be a footnote at occurrence 1 with no label at all.
    assert.deepEqual(calls[0].footnotes[0], {
      find: '18%', text: '不含汇兑影响。', kind: 'footnote', occurrence: 1, label: '', matchCase: true,
    });
    assert.equal(calls[0].footnotes[1].kind, 'endnote');
    assert.equal(calls[0].footnotes[1].occurrence, 2);
    assert.equal(calls[0].footnotes[1].label, '*');

    for (const [footnotes, message] of [
      [[], /at least one/],
      [[{ find: '18%' }], /text/],
      [[{ text: 'x' }], /find/],
      [[{ find: 'x', text: 'y', kind: 'sidenote' }], /kind/],
    ]) {
      await assert.rejects(
        () => provider.callTool('office_word_add_footnotes', { path: 'Report.docx', footnotes }),
        message,
      );
    }
  });

  it('writes every review note in one call and refuses a bad cell', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Book.xlsx'), 'book');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { sheet: 'Sheet1', commentsWritten: request.comments.length };
      },
    });
    await provider.setWorkspaceRoot(root);

    const result = await provider.callTool('office_excel_add_comments', {
      path: 'Book.xlsx',
      sheet: 'Sheet1',
      comments: [
        { cell: 'b4', text: '这个数字待核' },
        { cell: 'C7', text: '来源：财务', visible: true },
      ],
    });
    assert.equal(result.commentsWritten, 2);
    assert.equal(calls[0].operation, 'excel_add_comments');
    // A review is one action to the user, so it is one approval and one engine
    // start rather than one of each per note.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].comments[0], { cell: 'B4', text: '这个数字待核', visible: false });
    assert.equal(calls[0].comments[1].visible, true);

    for (const [comments, message] of [
      [[], /at least one/],
      [[{ cell: 'B4' }], /text/],
      [[{ cell: 'B4:C7', text: 'x' }], /A1 notation/],
      [[{ cell: '', text: 'x' }], /cell/],
    ]) {
      await assert.rejects(
        () => provider.callTool('office_excel_add_comments', { path: 'Book.xlsx', comments }),
        message,
      );
    }
  });

  it('composes a whole Word document in one call, from Markdown', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Report.docx'), 'doc');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { blocksWritten: request.blocks.length };
      },
    });
    await provider.setWorkspaceRoot(root);

    const result = await provider.callTool('office_word_compose', {
      path: 'Report.docx',
      theme: 'slate',
      title: '2026 年第三季度经营回顾',
      subtitle: '增长、成本与下一步',
      byline: '经营分析组 · 2026-08',
      table_of_contents: true,
      markdown: '# 摘要\n\n本季收入同比增长 18%。\n\n## 增长\n\n- 企业版需求明确\n- 渠道复制性强\n',
    });
    assert.equal(result.written, 'Magies Office Output/Report.docx');
    assert.equal(calls[0].operation, 'word_compose');
    assert.equal(calls[0].theme, 'slate');
    assert.equal(calls[0].cover.title, '2026 年第三季度经营回顾');
    assert.equal(calls[0].cover.byline, '经营分析组 · 2026-08');
    assert.equal(calls[0].tableOfContents, true);
    // Page numbers are what a printed report is missing when nobody asked.
    assert.equal(calls[0].pageNumbers, true);
    // The Markdown became real styles, not sized body text.
    assert.deepEqual(
      calls[0].blocks.map((block) => block.style),
      ['heading1', 'body', 'heading2', 'bullet', 'bullet'],
    );

    // A document with no cover is a document, not an error.
    await provider.callTool('office_word_compose', {
      path: 'Report.docx',
      markdown: '# 只有正文\n\n一段话。\n',
    });
    assert.equal(calls.at(-1).cover, null);
    assert.equal(calls.at(-1).theme, 'azure');

    for (const [args, message] of [
      [{ path: 'Report.docx' }, /markdown|blocks/],
      [{ path: 'Report.docx', markdown: '# x', theme: 'neon' }, /theme/],
      [{ path: 'Missing.docx', markdown: '# x' }, /no such file/i],
    ]) {
      await assert.rejects(() => provider.callTool('office_word_compose', args), message);
    }
  });

  it('composes a themed deck in one call, with visuals and workspace-scoped images', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Deck.pptx'), 'deck');
    await fs.writeFile(path.join(root, 'chart.png'), 'png');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { slidesComposed: request.slides.length };
      },
    });
    await provider.setWorkspaceRoot(root);

    const result = await provider.callTool('office_presentation_compose', {
      path: 'Deck.pptx',
      theme: 'midnight',
      slides: [
        { layout: 'title', title: '季度回顾', subtitle: '2026 Q1' },
        { layout: 'bullets', title: '收入', body: ['同比 +12%'] },
        { layout: 'image', title: '趋势', image_path: 'chart.png' },
      ],
    });
    assert.equal(result.slidesComposed, 3);
    assert.equal(result.theme, 'midnight');
    assert.equal(calls[0].operation, 'presentation_compose');
    assert.equal(calls[0].replaceExisting, true);
    // The image is resolved inside the grant, never handed through raw.
    assert.equal(calls[0].slides[2].imagePath, path.join(await fs.realpath(root), 'chart.png'));

    // Charts and KPI tiles are how a deck gets a picture without a picture file.
    const visual = await provider.callTool('office_presentation_compose', {
      path: 'Deck.pptx',
      slides: [
        {
          layout: 'chart',
          title: '收入',
          chart_type: 'line',
          categories: ['1月', '2月'],
          series: [{ name: '收入', values: [12, 18] }],
        },
        { layout: 'kpi', title: '指标', kpis: [{ value: '+12%', label: '同比' }] },
      ],
    });
    assert.equal(visual.slidesComposed, 2);
    assert.equal(calls.at(-1).slides[0].chartType, 'line');
    assert.deepEqual(calls.at(-1).slides[0].series[0].values, [12, 18]);
    assert.equal(calls.at(-1).slides[1].kpis[0].value, '+12%');

    // An image slide with no picture is not an error: almost no installation has
    // a picture provider, and the composer draws a themed figure in its place.
    // Rejecting it here would make that fallback unreachable.
    const drawn = await provider.callTool('office_presentation_compose', {
      path: 'Deck.pptx',
      slides: [{ layout: 'image', title: '产品线', body: ['进入企业版'] }],
    });
    assert.equal(drawn.slidesComposed, 1);
    assert.equal(calls.at(-1).slides[0].imagePath, undefined);

    for (const [slides, message] of [
      [[{ layout: 'carousel' }], /layout/],
      [[{ layout: 'image', image_path: '../outside.png' }], /workspace|escape|outside/i],
      [[{ layout: 'chart', categories: ['a'] }], /series/],
      [[{ layout: 'chart', categories: ['a', 'b'], series: [{ name: 'x', values: [1] }] }],
        /one number per category/],
      [[{ layout: 'kpi', title: 'x' }], /kpis/],
    ]) {
      await assert.rejects(
        () => provider.callTool('office_presentation_compose', { path: 'Deck.pptx', slides }),
        message,
      );
    }
  });

  it('styles presentation text so a generated deck is not raw default template', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Deck.pptx'), 'deck');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { shapesFormatted: 2 };
      },
    });
    await provider.setWorkspaceRoot(root);

    const result = await provider.callTool('office_presentation_format_text', {
      path: 'Deck.pptx',
      slide_number: 1,
      target: 'title',
      font_name: 'Source Han Sans',
      font_size: 40,
      bold: true,
      text_color: '#FFFFFF',
      alignment: 'center',
    });
    assert.equal(result.shapesFormatted, 2);
    assert.equal(calls[0].operation, 'presentation_format_text');
    assert.equal(calls[0].target, 'title');

    await assert.rejects(
      () => provider.callTool('office_presentation_format_text', {
        path: 'Deck.pptx', slide_number: 1, target: 'footer',
      }),
      /target/,
    );
    await assert.rejects(
      () => provider.callTool('office_presentation_format_text', {
        path: 'Deck.pptx', slide_number: 1, target: 'title',
      }),
      /at least one format option/,
    );
  });

  it('paints slide backgrounds, one slide or the whole deck', async () => {
    const root = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Deck.pptx'), 'deck');
    const calls = [];
    const provider = createOfficeAutomationProvider({
      workspace: createOfficeWorkspace(),
      getLibreOfficeExecutable: () => '/office/soffice',
      runUno: async (request) => {
        calls.push(request);
        await fs.copyFile(request.inputPath, request.outputPath);
        return { slidesPainted: 3 };
      },
    });
    await provider.setWorkspaceRoot(root);

    const result = await provider.callTool('office_presentation_set_background', {
      path: 'Deck.pptx',
      color: '#0F2B46',
      gradient_to: '#1F4E79',
    });
    assert.equal(result.slidesPainted, 3);
    // No slide number means the whole deck, which is what a theme change means.
    assert.equal(calls[0].slideNumber, 0);
    assert.equal(calls[0].gradientTo, '#1F4E79');

    await assert.rejects(
      () => provider.callTool('office_presentation_set_background', { path: 'Deck.pptx' }),
      /color/,
    );
  });

});
