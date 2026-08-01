'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const { createOfficeWorkspace } = require('./workspace.cjs');

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magies-office-workspace-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('createOfficeWorkspace', () => {
  it('lists supported documents using relative paths inside the granted directory', async () => {
    const root = await temporaryDirectory();
    await fs.mkdir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'Report.docx'), 'word');
    await fs.writeFile(path.join(root, 'nested', 'Budget.xlsx'), 'sheet');
    await fs.writeFile(path.join(root, 'notes.txt'), 'ignored');

    const workspace = createOfficeWorkspace();
    await workspace.setRoot(root);
    const canonicalRoot = await fs.realpath(root);

    assert.deepEqual(workspace.getStatus(), { configured: true, path: canonicalRoot });
    assert.deepEqual(
      await workspace.listDocuments({ recursive: true }),
      {
        documents: [
          { path: 'nested/Budget.xlsx', extension: '.xlsx', size: 5 },
          { path: 'Report.docx', extension: '.docx', size: 4 },
        ],
        truncated: false,
      },
    );
  });

  it('rejects absolute paths, traversal, unsupported files, and symlink escapes', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await fs.writeFile(path.join(root, 'Document.docx'), 'word');
    await fs.writeFile(path.join(root, 'notes.txt'), 'text');
    await fs.writeFile(path.join(outside, 'Secret.docx'), 'secret');
    await fs.symlink(path.join(outside, 'Secret.docx'), path.join(root, 'linked.docx'));

    const workspace = createOfficeWorkspace();
    await workspace.setRoot(root);

    await assert.rejects(() => workspace.resolveInput(path.join(root, 'Document.docx')), /relative path/);
    await assert.rejects(() => workspace.resolveInput('../Secret.docx'), /outside/i);
    await assert.rejects(() => workspace.resolveInput('notes.txt'), /supported Office or PDF document/);
    await assert.rejects(() => workspace.resolveInput('linked.docx'), /symbolic link/);
    assert.equal(
      await workspace.resolveInput('Document.docx'),
      path.join(await fs.realpath(root), 'Document.docx'),
    );
  });

  it('creates output directories safely and chooses a non-overwriting destination', async () => {
    const root = await temporaryDirectory();
    const workspace = createOfficeWorkspace();
    await workspace.setRoot(root);

    const first = await workspace.uniqueOutputPath('Processed/2026', 'Report.pdf');
    await fs.writeFile(first.absolutePath, 'first');
    const second = await workspace.uniqueOutputPath('Processed/2026', 'Report.pdf');

    assert.equal(first.relativePath, 'Processed/2026/Report.pdf');
    assert.equal(second.relativePath, 'Processed/2026/Report (2).pdf');
    await assert.rejects(() => workspace.uniqueOutputPath('../outside', 'Report.pdf'), /outside/i);
  });

  it('clears the grant and refuses operations without an active workspace', async () => {
    const root = await temporaryDirectory();
    const workspace = createOfficeWorkspace();
    await workspace.setRoot(root);
    workspace.clear();

    assert.deepEqual(workspace.getStatus(), { configured: false, path: '' });
    await assert.rejects(() => workspace.listDocuments(), /workspace folder/i);
  });
});
