const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { pathToFileURL } = require('node:url');

/**
 * Unit tests for the REST handler without binding a real port for every case.
 * Uses the real tool catalogue + worker pool for one end-to-end POST.
 */

const settings = require('../settings.cjs');
const { createHandler, resolveServerMode } = require('./server.cjs');
const { JobPool } = require('../jobs/pool.cjs');

// settings.cjs needs Electron's app path; in node:test we stub userData.
const originalRead = settings.read;
const originalWrite = settings.write;
let testSettings = {
  api: { enabled: true, port: 18737, token: 'test-token', allowLan: false },
};

function withSettings(patch) {
  testSettings = {
    ...testSettings,
    ...patch,
    api: { ...testSettings.api, ...(patch.api || {}) },
  };
}

before(() => {
  settings.read = () => testSettings;
  settings.write = (patch) => {
    withSettings(patch);
    return testSettings;
  };
});

after(() => {
  settings.read = originalRead;
  settings.write = originalWrite;
});

function mockReqRes({ method, url, headers = {}, body }) {
  const reqChunks = body ? [Buffer.from(body)] : [];
  const req = {
    method,
    url,
    headers,
    on(event, cb) {
      if (event === 'data') {
        for (const chunk of reqChunks) cb(chunk);
      }
      if (event === 'end') queueMicrotask(cb);
      return req;
    },
    destroy() {},
  };

  let statusCode = 0;
  let responseBody = '';
  const res = {
    writeHead(code) {
      statusCode = code;
    },
    end(payload) {
      responseBody = payload || '';
    },
  };

  return {
    req,
    res,
    result: async () => {
      // allow the handler promise to settle
      await new Promise((r) => setImmediate(r));
      return { statusCode, body: responseBody ? JSON.parse(responseBody) : null };
    },
  };
}

const AUTH = { authorization: 'Bearer test-token' };

function toolRequest(body, url = '/v1/tools/organize.rotate') {
  return mockReqRes({
    method: 'POST',
    url,
    headers: AUTH,
    body: JSON.stringify(body),
  });
}

describe('REST API handler', () => {
  /** @type {JobPool} */
  let pool;
  /** @type {ReturnType<typeof createHandler>} */
  let handler;

  before(async () => {
    // Ensure catalogue + worker bundle exist.
    const catalogPath = path.join(__dirname, '..', '..', 'dist-electron', 'catalog.json');
    try {
      require('node:fs').accessSync(catalogPath);
    } catch {
      // Build node bundle if missing so the test stays self-contained.
      const { execFileSync } = require('node:child_process');
      execFileSync('npm', ['run', 'build:node'], {
        cwd: path.join(__dirname, '..', '..'),
        stdio: 'inherit',
      });
    }
    pool = new JobPool({ size: 1 });
    handler = createHandler({ pool });
  });

  after(async () => {
    await pool?.destroy();
  });

  it('serves health without auth', async () => {
    const { req, res, result } = mockReqRes({ method: 'GET', url: '/v1/health' });
    await handler(req, res);
    const { statusCode, body } = await result();
    assert.equal(statusCode, 200);
    assert.equal(body.ok, true);
  });

  it('rejects tools list without a token', async () => {
    const { req, res, result } = mockReqRes({ method: 'GET', url: '/v1/tools' });
    await handler(req, res);
    const { statusCode } = await result();
    assert.equal(statusCode, 401);
  });

  it('lists tools with a valid bearer token', async () => {
    const { req, res, result } = mockReqRes({
      method: 'GET',
      url: '/v1/tools',
      headers: { authorization: 'Bearer test-token' },
    });
    await handler(req, res);
    const { statusCode, body } = await result();
    assert.equal(statusCode, 200);
    assert.ok(Array.isArray(body.tools));
    assert.ok(body.tools.some((t) => t.id === 'organize.merge'));
  });

  it('rejects malformed base64 instead of silently decoding it', async () => {
    const { req, res, result } = toolRequest({
      files: [{ name: 'one.pdf', bytesBase64: '%%%%', mime: 'application/pdf' }],
      params: { angle: 90 },
    });
    await handler(req, res);
    const response = await result();
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, 'invalid_input');
    assert.match(response.body.message, /base64/i);
  });

  it('rejects file names that contain a path', async () => {
    const { req, res, result } = toolRequest({
      files: [
        {
          name: '../one.pdf',
          bytesBase64: Buffer.from('%PDF-1.4').toString('base64'),
          mime: 'application/pdf',
        },
      ],
      params: { angle: 90 },
    });
    await handler(req, res);
    const response = await result();
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, 'invalid_input');
    assert.match(response.body.message, /file name/i);
  });

  it('runs organize.rotate via POST and returns a PDF', async () => {
    // Minimal valid-ish PDF from the worker will validate; use pdf-lib via dynamic import.
    const { PDFDocument } = await import(pathToFileURL(
      require.resolve('pdf-lib'),
    ).href);
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const bytes = await doc.save({ useObjectStreams: false });
    const body = JSON.stringify({
      files: [
        {
          name: 'one.pdf',
          bytesBase64: Buffer.from(bytes).toString('base64'),
          mime: 'application/pdf',
        },
      ],
      params: { angle: 90 },
    });

    // Drive through a real HTTP server for the body stream path.
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/tools/organize.rotate`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body,
      });
      const json = await response.json();
      assert.equal(response.status, 200, JSON.stringify(json));
      assert.ok(json.files?.[0]?.bytesBase64);
      assert.ok(json.files[0].name.endsWith('.pdf'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('REST API transport security', () => {
  it('uses HTTP only for loopback and requires TLS for LAN binding', () => {
    assert.deepEqual(resolveServerMode({ allowLan: false }), {
      host: '127.0.0.1',
      protocol: 'http',
    });
    assert.throws(() => resolveServerMode({ allowLan: true }), /TLS certificate/i);
    assert.deepEqual(
      resolveServerMode({
        allowLan: true,
        tlsCertPath: '/tmp/cert.pem',
        tlsKeyPath: '/tmp/key.pem',
      }),
      {
        host: '0.0.0.0',
        protocol: 'https',
        tlsCertPath: '/tmp/cert.pem',
        tlsKeyPath: '/tmp/key.pem',
      },
    );
  });
});

describe('REST asynchronous jobs', () => {
  it('caps concurrently retained jobs to protect memory', async () => {
    const pool = {
      run: () => new Promise(() => {}),
      cancel: () => false,
    };
    const handler = createHandler({ pool, maxActiveJobs: 1 });
    const body = {
      files: [
        {
          name: 'one.pdf',
          bytesBase64: Buffer.from('%PDF-1.4').toString('base64'),
        },
      ],
    };

    const first = toolRequest(body, '/v1/tools/organize.rotate?async=true');
    await handler(first.req, first.res);
    assert.equal((await first.result()).statusCode, 202);

    const second = toolRequest(body, '/v1/tools/organize.rotate?async=true');
    await handler(second.req, second.res);
    const response = await second.result();
    assert.equal(response.statusCode, 429);
    assert.equal(response.body.error, 'too_many_jobs');
  });

  it('starts, queries, and completes an asynchronous tool job', async () => {
    let finish;
    const pool = {
      run: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      cancel: () => false,
    };
    const handler = createHandler({ pool });
    const requestBody = {
      files: [
        {
          name: 'one.pdf',
          bytesBase64: Buffer.from('%PDF-1.4').toString('base64'),
          mime: 'application/pdf',
        },
      ],
      params: { angle: 90 },
    };

    const started = toolRequest(requestBody, '/v1/tools/organize.rotate?async=true');
    await handler(started.req, started.res);
    const startResponse = await started.result();
    assert.equal(startResponse.statusCode, 202);
    assert.match(startResponse.body.jobId, /^[0-9a-f-]+$/);

    const running = mockReqRes({
      method: 'GET',
      url: `/v1/jobs/${startResponse.body.jobId}`,
      headers: AUTH,
    });
    await handler(running.req, running.res);
    assert.equal((await running.result()).body.status, 'running');

    finish({
      files: [{ name: 'done.pdf', mime: 'application/pdf', bytes: new Uint8Array([1, 2]) }],
      summary: { zh: '完成', en: 'Done' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const completed = mockReqRes({
      method: 'GET',
      url: `/v1/jobs/${startResponse.body.jobId}`,
      headers: AUTH,
    });
    await handler(completed.req, completed.res);
    const completedResponse = await completed.result();
    assert.equal(completedResponse.body.status, 'done');
    assert.equal(completedResponse.body.result.files[0].bytesBase64, 'AQI=');
  });

  it('cancels an asynchronous worker job', async () => {
    let cancelled = '';
    const pool = {
      run: () => new Promise(() => {}),
      cancel: (jobId) => {
        cancelled = jobId;
        return true;
      },
    };
    const handler = createHandler({ pool });
    const started = toolRequest(
      {
        files: [
          {
            name: 'one.pdf',
            bytesBase64: Buffer.from('%PDF-1.4').toString('base64'),
          },
        ],
      },
      '/v1/tools/organize.rotate?async=true',
    );
    await handler(started.req, started.res);
    const { body } = await started.result();

    const cancel = mockReqRes({
      method: 'DELETE',
      url: `/v1/jobs/${body.jobId}`,
      headers: AUTH,
    });
    await handler(cancel.req, cancel.res);
    const response = await cancel.result();
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, 'cancelled');
    assert.equal(cancelled, body.jobId);
  });
});
