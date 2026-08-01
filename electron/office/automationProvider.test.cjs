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
        'office_word_replace',
        'office_excel_read',
        'office_excel_write',
        'office_presentation_read',
        'office_presentation_replace',
        'office_batch_convert_pdf',
        'office_workspace_archive',
      ],
    );
    assert.ok(tools.every((tool) => tool.requiresApproval === true));
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
