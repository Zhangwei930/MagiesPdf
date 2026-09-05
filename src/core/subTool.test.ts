import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runSubTool } from './subTool.ts';
import type { ToolDescriptor } from './types.ts';

const descriptor = (over: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  id: 'edit.compress',
  category: 'edit',
  name: { zh: '', en: '' },
  description: { zh: '', en: '' },
  icon: 'FileText',
  keywords: [],
  input: { accept: ['.pdf'], min: 1, max: 1 },
  output: 'single',
  params: [],
  runtime: 'worker',
  run: async () => ({ files: [{ name: 'ran-here.pdf', mime: 'application/pdf', bytes: new Uint8Array() }] }),
  ...over,
}) as ToolDescriptor;

const options = (host?: unknown) => ({
  files: [{ name: 'a.pdf', mime: 'application/pdf', bytes: new Uint8Array([1]) }],
  params: { level: 'high' },
  signal: new AbortController().signal,
  host: host as never,
});

/**
 * `advanced.batch` and `advanced.pipeline` are `runtime: 'main'` because a
 * step *might* need the host. Most do not — and running their work inline
 * meant the main process did it, so a large batch froze the window, its own
 * cancel button and the local API for as long as it took.
 */
describe('running one tool from inside another', () => {
  it('hands a worker tool back to the host to run elsewhere', async () => {
    const asked: unknown[] = [];
    const host = {
      runTool: async (toolId: string, files: unknown, params: unknown) => {
        asked.push({ toolId, files, params });
        return { files: [{ name: 'ran-off-thread.pdf', mime: 'application/pdf', bytes: new Uint8Array() }] };
      },
    };

    const result = await runSubTool(descriptor(), options(host));

    assert.equal(result.files[0]?.name, 'ran-off-thread.pdf');
    assert.equal(asked.length, 1);
    assert.deepEqual((asked[0] as { params: unknown }).params, { level: 'high' });
  });

  /**
   * A step that needs the host has to run where the host is. Dispatching it
   * would put it somewhere with no printToPDF and no external converter.
   */
  it('runs a main-process tool here, where the host is', async () => {
    let dispatched = false;
    const host = {
      runTool: async () => {
        dispatched = true;
        return { files: [] };
      },
    };

    const result = await runSubTool(descriptor({ runtime: 'main' }), options(host));

    assert.equal(dispatched, false);
    assert.equal(result.files[0]?.name, 'ran-here.pdf');
  });

  it('runs it here when the host cannot dispatch', async () => {
    const result = await runSubTool(descriptor(), options({ htmlToPdf: async () => new Uint8Array() }));
    assert.equal(result.files[0]?.name, 'ran-here.pdf');
  });

  it('runs it here when there is no host at all', async () => {
    const result = await runSubTool(descriptor(), options(undefined));
    assert.equal(result.files[0]?.name, 'ran-here.pdf');
  });

  /** Cancelling a batch has to reach the step that is actually running. */
  it('passes the cancellation signal on', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const host = {
      runTool: async (_id: string, _files: unknown, _params: unknown, signal?: AbortSignal) => {
        seen = signal;
        return { files: [] };
      },
    };

    await runSubTool(descriptor(), { ...options(host), signal: controller.signal });
    assert.equal(seen, controller.signal);
  });
});
