const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { collectFilePaths } = require('./walk.cjs');

describe('collectFilePaths', () => {
  /** @type {string} */
  let root;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'magiespdf-walk-'));
    await fs.mkdir(path.join(root, 'sub', 'deep'), { recursive: true });
    await fs.writeFile(path.join(root, 'a.pdf'), '%PDF');
    await fs.writeFile(path.join(root, 'b.txt'), 'hi');
    await fs.writeFile(path.join(root, 'sub', 'c.pdf'), '%PDF');
    await fs.writeFile(path.join(root, 'sub', 'deep', 'd.pdf'), '%PDF');
    await fs.writeFile(path.join(root, '.hidden.pdf'), '%PDF');
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('collects matching files recursively', async () => {
    const paths = await collectFilePaths(root, { accept: ['.pdf'], recursive: true });
    assert.equal(paths.length, 3);
    assert.ok(paths.every((p) => p.endsWith('.pdf')));
    assert.ok(!paths.some((p) => p.includes('.hidden')));
  });

  it('can stay non-recursive', async () => {
    const paths = await collectFilePaths(root, { accept: ['.pdf'], recursive: false });
    assert.equal(paths.length, 1);
    assert.ok(paths[0].endsWith('a.pdf'));
  });

  it('respects maxFiles', async () => {
    const paths = await collectFilePaths(root, { accept: ['.pdf'], maxFiles: 2 });
    assert.equal(paths.length, 2);
  });

  it('filters by extension', async () => {
    const paths = await collectFilePaths(root, { accept: ['.txt'], recursive: true });
    assert.equal(paths.length, 1);
    assert.ok(paths[0].endsWith('b.txt'));
  });
});
