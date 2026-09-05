import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEditQueue } from './editQueue.ts';

/** A promise the test decides when to settle. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Every edit in the viewer is a tool run over the document's bytes, and the
 * result replaces the document whole. Two of them in flight at once therefore
 * both start from the same bytes and the second to finish erases the first —
 * two pen strokes on different pages, and only one survives.
 *
 * Serialising them is what makes each one start from what the one before it
 * produced.
 */
describe('running document edits one at a time', () => {
  it('does not start the second until the first has finished', async () => {
    const queue = createEditQueue();
    const first = deferred<string>();
    const order: string[] = [];

    const a = queue.run(async () => {
      order.push('a:start');
      const value = await first.promise;
      order.push('a:end');
      return value;
    });
    const b = queue.run(async () => {
      order.push('b:start');
      return 'b';
    });

    await Promise.resolve();
    assert.deepEqual(order, ['a:start'], 'b must not have started');

    first.resolve('a');
    assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start']);
  });

  it('gives each caller its own result', async () => {
    const queue = createEditQueue();
    const results = await Promise.all([
      queue.run(async () => 1),
      queue.run(async () => 2),
      queue.run(async () => 3),
    ]);
    assert.deepEqual(results, [1, 2, 3]);
  });

  /** One failed edit must not wedge every edit after it. */
  it('carries on after a task that threw', async () => {
    const queue = createEditQueue();
    const failed = queue.run(async () => {
      throw new Error('tool failed');
    });

    await assert.rejects(failed, /tool failed/);
    assert.equal(await queue.run(async () => 'still works'), 'still works');
  });

  it('rejects the caller that failed, and only that one', async () => {
    const queue = createEditQueue();
    const bad = queue.run(async () => {
      throw new Error('nope');
    });
    const good = queue.run(async () => 'fine');

    await assert.rejects(bad, /nope/);
    assert.equal(await good, 'fine');
  });

  /**
   * `busy` used to be cleared by whichever edit finished first, so the second
   * ran with the viewer saying it was idle — and accepting more input.
   */
  it('counts every edit still outstanding', async () => {
    const queue = createEditQueue();
    assert.equal(queue.pending, 0);

    const first = deferred<void>();
    const a = queue.run(() => first.promise);
    const b = queue.run(async () => undefined);
    assert.equal(queue.pending, 2);

    first.resolve();
    await Promise.all([a, b]);
    assert.equal(queue.pending, 0);
  });

  it('is back to zero after a failure too', async () => {
    const queue = createEditQueue();
    await assert.rejects(
      queue.run(async () => {
        throw new Error('x');
      }),
    );
    assert.equal(queue.pending, 0);
  });
});
