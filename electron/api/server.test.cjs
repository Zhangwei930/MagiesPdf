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
const { createHandler } = require('./server.cjs');
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
