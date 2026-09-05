const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');
const { writeWithoutOverwriting } = require('./writeOutputs.cjs');

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magies-save-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * "Rename rather than overwrite" was a look-then-leap: `access` said the name
 * was free, and the write took it some time later. Two saves running at once
 * both saw it free and the second wrote over the first — two successful-looking
 * saves, one file on disk, and nothing to say which result was lost.
 */
describe('writing a result without overwriting one', () => {
  it('uses the name when it is free', async () => {
    const dir = tempDir();
    const written = await writeWithoutOverwriting(dir, 'out.pdf', Buffer.from('a'));

    assert.equal(written, path.join(dir, 'out.pdf'));
    assert.equal(await fsp.readFile(written, 'utf8'), 'a');
  });

  it('steps to the next name rather than replacing a file', async () => {
    const dir = tempDir();
    await fsp.writeFile(path.join(dir, 'out.pdf'), 'first');

    const written = await writeWithoutOverwriting(dir, 'out.pdf', Buffer.from('second'));

    assert.equal(written, path.join(dir, 'out (2).pdf'));
    assert.equal(await fsp.readFile(path.join(dir, 'out.pdf'), 'utf8'), 'first');
  });

  it('keeps every result when saves overlap', async () => {
    const dir = tempDir();
    const contents = ['a', 'b', 'c', 'd', 'e'];

    const written = await Promise.all(
      contents.map((body) => writeWithoutOverwriting(dir, 'out.pdf', Buffer.from(body))),
    );

    assert.equal(new Set(written).size, contents.length, 'no two saves took the same name');
    const onDisk = (await fsp.readdir(dir)).sort();
    assert.equal(onDisk.length, contents.length, `one file each, got ${onDisk.join(', ')}`);
    const bodies = await Promise.all(
      onDisk.map((name) => fsp.readFile(path.join(dir, name), 'utf8')),
    );
    assert.deepEqual(bodies.sort(), contents, 'every result survived');
  });

  it('keeps the extension when it has to rename', async () => {
    const dir = tempDir();
    await fsp.writeFile(path.join(dir, 'a.b.pdf'), 'first');

    const written = await writeWithoutOverwriting(dir, 'a.b.pdf', Buffer.from('second'));
    assert.equal(path.basename(written), 'a.b (2).pdf');
  });

  it('does not swallow a failure that is not a name collision', async () => {
    await assert.rejects(
      writeWithoutOverwriting(path.join(tempDir(), 'no', 'such', 'dir'), 'out.pdf', Buffer.from('a')),
      /ENOENT/,
    );
  });
});
