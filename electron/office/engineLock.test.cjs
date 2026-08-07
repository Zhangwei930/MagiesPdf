'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');

const { createEngineLock } = require('./engineLock.cjs');

const directories = [];

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magies-engine-lock-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('createEngineLock', () => {
  it('runs one LibreOffice operation at a time', async () => {
    // Two live instances stop each other: whichever starts second never opens
    // its acceptor, and the caller sees "couldn't connect to pipe" rather than
    // anything that names the real cause. A preview render while the assistant
    // edits another document is enough to hit it.
    const lockPath = path.join(await temporaryDirectory(), 'engine.lock');
    const lock = createEngineLock({ lockPath, retryDelayMs: 1 });
    const order = [];

    const first = lock.run(async () => {
      order.push('first in');
      await new Promise((resolve) => { setTimeout(resolve, 40); });
      order.push('first out');
      return 1;
    });
    const second = lock.run(async () => {
      order.push('second in');
      return 2;
    });

    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(order, ['first in', 'first out', 'second in']);
    assert.equal(existsSync(lockPath), false, 'the lock is released');
  });

  it('releases the lock when the operation throws', async () => {
    const lockPath = path.join(await temporaryDirectory(), 'engine.lock');
    const lock = createEngineLock({ lockPath, retryDelayMs: 1 });

    await assert.rejects(() => lock.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(lockPath), false);
    assert.equal(await lock.run(async () => 'after'), 'after');
  });

  it('takes over a lock left behind by a process that died', async () => {
    // A crash or a kill leaves the file, and without this every later Office
    // operation would wait for a holder that no longer exists.
    const lockPath = path.join(await temporaryDirectory(), 'engine.lock');
    await fs.writeFile(lockPath, 'stale');
    const lock = createEngineLock({ lockPath, retryDelayMs: 1, staleAfterMs: 0 });

    assert.equal(await lock.run(async () => 'taken'), 'taken');
    assert.equal(existsSync(lockPath), false);
  });

  it('gives up rather than waiting forever', async () => {
    const lockPath = path.join(await temporaryDirectory(), 'engine.lock');
    await fs.writeFile(lockPath, 'held');
    const lock = createEngineLock({
      lockPath, retryDelayMs: 1, staleAfterMs: 600000, waitTimeoutMs: 20,
    });

    await assert.rejects(() => lock.run(async () => 'never'), /busy/i);
  });
});
