const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

/**
 * Worker-thread pool for tool execution.
 *
 * PDF work is CPU-bound and can take tens of seconds on a large file, so it must
 * not run on the main thread — a frozen main thread means a frozen window. Each
 * worker takes one job at a time; extra jobs queue.
 */

const WORKER_ENTRY = path.join(__dirname, '..', '..', 'dist-electron', 'worker.mjs');

/** Leave a core for the UI, and cap the pool so many queued jobs cannot exhaust RAM. */
function defaultPoolSize() {
  return Math.max(1, Math.min(4, (os.cpus()?.length ?? 2) - 1));
}

class JobPool {
  #size;
  #workers = [];
  #queue = [];
  /** jobId -> { worker, handlers } for jobs currently executing. */
  #active = new Map();
  /** jobId -> queued entry, so a job can be cancelled before it starts. */
  #pending = new Map();
  #destroyed = false;

  constructor(size = defaultPoolSize()) {
    this.#size = size;
  }

  /**
   * Runs a job. `onProgress` may fire many times before the promise settles.
   * Resolves with `{ files, data, summary }`, rejects with a serialized ToolError.
   */
  run(request, onProgress) {
    if (this.#destroyed) {
      return Promise.reject(new Error('Job pool has been destroyed'));
    }

    return new Promise((resolve, reject) => {
      const entry = { request, onProgress, resolve, reject };
      this.#pending.set(request.jobId, entry);
      this.#queue.push(entry);
      this.#pump();
    });
  }

  cancel(jobId) {
    const queued = this.#pending.get(jobId);
    if (queued) {
      this.#pending.delete(jobId);
      this.#queue = this.#queue.filter((e) => e !== queued);
      queued.reject(cancelledError());
      return true;
    }

    const active = this.#active.get(jobId);
    if (active) {
      active.worker.instance.postMessage({ type: 'cancel', jobId });
      return true;
    }

    return false;
  }

  async destroy() {
    this.#destroyed = true;
    for (const entry of this.#queue) entry.reject(cancelledError());
    this.#queue = [];
    this.#pending.clear();

    await Promise.all(this.#workers.map((w) => w.instance.terminate()));
    this.#workers = [];
  }

  get stats() {
    return { size: this.#size, workers: this.#workers.length, active: this.#active.size, queued: this.#queue.length };
  }

  #pump() {
    if (this.#queue.length === 0) return;

    const worker = this.#idleWorker();
    if (!worker) return;

    const entry = this.#queue.shift();
    this.#pending.delete(entry.request.jobId);

    worker.busy = true;
    this.#active.set(entry.request.jobId, { worker, entry });

    // Transfer the input buffers rather than copying them: a 200 MB scan should
    // not be duplicated on its way into the worker.
    const transfer = [];
    for (const file of entry.request.files) {
      if (file.bytes?.buffer && !transfer.includes(file.bytes.buffer)) {
        transfer.push(file.bytes.buffer);
      }
    }

    worker.instance.postMessage({ type: 'run', ...entry.request }, transfer);
  }

  #idleWorker() {
    const idle = this.#workers.find((w) => !w.busy);
    if (idle) return idle;
    if (this.#workers.length >= this.#size) return undefined;
    return this.#spawn();
  }

  #spawn() {
    const instance = new Worker(WORKER_ENTRY, { stdout: false, stderr: false });
    const worker = { instance, busy: false };

    instance.on('message', (message) => this.#onMessage(worker, message));
    instance.on('error', (error) => this.#onWorkerDeath(worker, error));
    instance.on('exit', (code) => {
      if (code !== 0) this.#onWorkerDeath(worker, new Error(`Worker exited with code ${code}`));
    });
    // Deliberately not unref'd: a worker with a job in flight has to keep the
    // event loop alive, or the result is dropped. `destroy()` on quit clears them.
    this.#workers.push(worker);
    return worker;
  }

  #onMessage(worker, message) {
    const active = this.#active.get(message.jobId);
    if (!active) return;

    if (message.type === 'progress') {
      active.entry.onProgress?.(message.fraction, message.message);
      return;
    }

    this.#active.delete(message.jobId);
    worker.busy = false;

    if (message.type === 'done') {
      active.entry.resolve({ files: message.files, data: message.data, summary: message.summary });
    } else {
      active.entry.reject(message.error);
    }

    this.#pump();
  }

  /**
   * A worker that dies takes its in-flight job with it. Failing that one job and
   * dropping the worker lets the next job spawn a fresh one, rather than wedging
   * the whole pool.
   */
  #onWorkerDeath(worker, error) {
    this.#workers = this.#workers.filter((w) => w !== worker);

    for (const [jobId, active] of this.#active) {
      if (active.worker !== worker) continue;
      this.#active.delete(jobId);
      active.entry.reject({
        __toolError: true,
        code: 'INTERNAL',
        message: error.message,
        userMessage: {
          zh: '处理进程意外退出，可能是文件过大或已损坏。请重试。',
          en: 'The processing thread stopped unexpectedly — the file may be too large or damaged. Please retry.',
        },
      });
    }

    this.#pump();
  }
}

function cancelledError() {
  return {
    __toolError: true,
    code: 'CANCELLED',
    message: 'Job cancelled before execution',
    userMessage: { zh: '任务已取消。', en: 'The job was cancelled.' },
  };
}

module.exports = { JobPool, defaultPoolSize, WORKER_ENTRY };
