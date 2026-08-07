'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/**
 * One LibreOffice operation at a time.
 *
 * Two live instances stop each other: whichever starts second never opens its
 * UNO acceptor, and the caller sees `couldn't connect to pipe` — an error that
 * names none of this. It is not a rare race. A preview render while the
 * assistant edits another document is enough, and so is the test suite, where
 * the engine-backed files run in parallel and take turns failing.
 *
 * The lock is a file rather than a variable because the operations run in more
 * than one process: the app's main process holds one, and each test file is
 * another. A holder that dies leaves the file behind, so an old enough lock is
 * taken over rather than waited on.
 */

const DEFAULT_LOCK_PATH = path.join(os.tmpdir(), 'magies-office-engine.lock');
/** Longer than any single operation, so a live holder is never robbed. */
const DEFAULT_STALE_AFTER_MS = 240000;
const DEFAULT_WAIT_TIMEOUT_MS = 300000;
const DEFAULT_RETRY_DELAY_MS = 120;

function sleep(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function createEngineLock({
  lockPath = DEFAULT_LOCK_PATH,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  /** Serialises this process's own callers without touching the filesystem. */
  let queue = Promise.resolve();

  const claim = async () => {
    const deadline = Date.now() + waitTimeoutMs;
    for (;;) {
      try {
        const handle = await fs.open(lockPath, 'wx');
        await handle.writeFile(`${process.pid}`);
        await handle.close();
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }

      const age = await fs.stat(lockPath).then(
        (stats) => Date.now() - stats.mtimeMs,
        // Released between the failed claim and the check: try again at once.
        () => -1,
      );
      if (age >= staleAfterMs) {
        // The holder is gone; nothing is going to release this.
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('The Office engine is busy and did not become free in time');
      }
      await sleep(retryDelayMs);
    }
  };

  const run = (operation) => {
    const pending = queue.then(async () => {
      await claim();
      try {
        return await operation();
      } finally {
        await fs.rm(lockPath, { force: true });
      }
    });
    // Keep the chain alive whatever this operation did.
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  };

  return { run };
}

let sharedLock;

/** The lock every Office operation in this application shares. */
function withEngineLock(operation) {
  if (!sharedLock) sharedLock = createEngineLock();
  return sharedLock.run(operation);
}

module.exports = { createEngineLock, withEngineLock };
