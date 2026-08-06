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
const { createHandler, isEnabled, resolveServerMode } = require('./server.cjs');
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

  /** @type {ReturnType<typeof createHandler>} */
  let officeHandler;
  /** Same provider, no approver wired — as a build that forgot to pass one. */
  /** @type {ReturnType<typeof createHandler>} */
  let bareOfficeHandler;
  /** @type {Array<[string, object]>} */
  let officeCalls;
  /** @type {Array<object>} */
  const approvalRequests = [];
  let approvalAnswer = true;

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

    officeCalls = [];
    let workspace = { configured: false, path: '' };
    const officeProvider = {
      describeTools: () => ([
        {
          functionName: 'office_excel_write',
          toolId: 'office:excel:write',
          description: 'Write Excel',
          parameters: { type: 'object', properties: {} },
          unattended: true,
        },
        {
          functionName: 'office_macro_run',
          toolId: 'office:macro:run',
          description: 'Macro',
          parameters: { type: 'object', properties: {} },
          unattended: false,
        },
      ]),
      getWorkspaceStatus: () => workspace,
      setWorkspaceRoot: async (candidate) => {
        workspace = { configured: true, path: candidate };
        return workspace;
      },
      setWorkspaceFromDocumentPath: async (documentPath) => {
        workspace = { configured: true, path: path.dirname(documentPath) };
        return workspace;
      },
      clearWorkspace: () => {
        workspace = { configured: false, path: '' };
        return workspace;
      },
      callTool: async (functionName, args) => {
        officeCalls.push([functionName, args]);
        return { written: 'Magies Office Output/out.xlsx', cellsWritten: 2 };
      },
    };
    bareOfficeHandler = createHandler({ pool, officeProvider });
    officeHandler = createHandler({
      pool,
      officeProvider,
      requestApproval: async (request) => {
        approvalRequests.push(request);
        return approvalAnswer;
      },
    });
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

  it('lists Office automation tools and grants a workspace over REST', async () => {
    const listed = mockReqRes({
      method: 'GET',
      url: '/v1/office/tools',
      headers: AUTH,
    });
    await officeHandler(listed.req, listed.res);
    const listedResponse = await listed.result();
    assert.equal(listedResponse.statusCode, 200);
    assert.ok(listedResponse.body.tools.some((tool) => tool.functionName === 'office_excel_write'));
    assert.equal(listedResponse.body.workspace.configured, false);

    const grant = mockReqRes({
      method: 'POST',
      url: '/v1/office/workspace',
      headers: AUTH,
      body: JSON.stringify({ path: path.join(__dirname) }),
    });
    await officeHandler(grant.req, grant.res);
    const grantResponse = await grant.result();
    assert.equal(grantResponse.statusCode, 200);
    assert.equal(grantResponse.body.configured, true);
  });

  it('calls Office automation tools and refuses interactive-only macros', async () => {
    const grant = mockReqRes({
      method: 'POST',
      url: '/v1/office/workspace',
      headers: AUTH,
      body: JSON.stringify({ path: path.join(__dirname) }),
    });
    await officeHandler(grant.req, grant.res);

    officeCalls.length = 0;
    const write = mockReqRes({
      method: 'POST',
      url: '/v1/office/tools/office_excel_write',
      headers: AUTH,
      body: JSON.stringify({ path: '555.xlsx', start_cell: 'A1', values: [['a']] }),
    });
    await officeHandler(write.req, write.res);
    const writeResponse = await write.result();
    assert.equal(writeResponse.statusCode, 200);
    assert.equal(writeResponse.body.ok, true);
    assert.equal(writeResponse.body.result.cellsWritten, 2);
    assert.deepEqual(officeCalls[0][0], 'office_excel_write');

    const macro = mockReqRes({
      method: 'POST',
      url: '/v1/office/tools/office_macro_run',
      headers: AUTH,
      body: JSON.stringify({ path: 'a.ods', script_uri: 'vnd.sun.star.script:x' }),
    });
    await officeHandler(macro.req, macro.res);
    const macroResponse = await macro.result();
    // Default settings carry no permission mode, which normalises to confirm —
    // where a person is asked, so the call is allowed to reach the tool.
    assert.equal(macroResponse.statusCode, 200);
    assert.deepEqual(officeCalls.at(-1)[0], 'office_macro_run');

    // With nobody to ask, an interactive-only tool is still refused.
    const previousSettings = testSettings;
    withSettings({ ai: { ...(testSettings.ai || {}), permissionMode: 'auto' } });
    try {
      const unattended = mockReqRes({
        method: 'POST',
        url: '/v1/office/tools/office_macro_run',
        headers: AUTH,
        body: JSON.stringify({ path: 'a.ods', script_uri: 'vnd.sun.star.script:x' }),
      });
      await officeHandler(unattended.req, unattended.res);
      const refused = await unattended.result();
      assert.equal(refused.statusCode, 403);
      assert.equal(refused.body.error, 'interactive_only');
    } finally {
      testSettings = previousSettings;
    }
  });

  it('returns 503 for Office routes when no provider is wired', async () => {
    const bare = mockReqRes({
      method: 'GET',
      url: '/v1/office/tools',
      headers: AUTH,
    });
    await handler(bare.req, bare.res);
    const response = await bare.result();
    assert.equal(response.statusCode, 503);
  });

  it('observer mode lists only read Office tools and blocks writes', async () => {
    const previous = testSettings;
    withSettings({ ai: { ...(testSettings.ai || {}), permissionMode: 'observer' } });
    try {
      const listed = mockReqRes({
        method: 'GET',
        url: '/v1/office/tools',
        headers: AUTH,
      });
      await officeHandler(listed.req, listed.res);
      const listedResponse = await listed.result();
      assert.equal(listedResponse.statusCode, 200);
      assert.equal(listedResponse.body.permissionMode, 'observer');
      // Mock provider only exposes write tools — observer filters them out.
      assert.equal(listedResponse.body.tools.length, 0);

      const grant = mockReqRes({
        method: 'POST',
        url: '/v1/office/workspace',
        headers: AUTH,
        body: JSON.stringify({ path: path.join(__dirname) }),
      });
      await officeHandler(grant.req, grant.res);

      const write = mockReqRes({
        method: 'POST',
        url: '/v1/office/tools/office_excel_write',
        headers: AUTH,
        body: JSON.stringify({ path: '555.xlsx', start_cell: 'A1', values: [['a']] }),
      });
      await officeHandler(write.req, write.res);
      const writeResponse = await write.result();
      assert.equal(writeResponse.statusCode, 403);
      assert.equal(writeResponse.body.error, 'observer_mode');
    } finally {
      testSettings = previous;
    }
  });

  /** Grant the workspace the Office routes need, on whichever handler is used. */
  async function grantWorkspace(target) {
    const grant = mockReqRes({
      method: 'POST',
      url: '/v1/office/workspace',
      headers: AUTH,
      body: JSON.stringify({ path: path.join(__dirname) }),
    });
    await target(grant.req, grant.res);
    await grant.result();
  }

  async function callExcelWrite(target) {
    const write = mockReqRes({
      method: 'POST',
      url: '/v1/office/tools/office_excel_write',
      headers: AUTH,
      body: JSON.stringify({ path: '555.xlsx', start_cell: 'A1', values: [['a']] }),
    });
    await target(write.req, write.res);
    return write.result();
  }

  it('asks the user in confirm mode before running an Office tool over REST', async () => {
    const previous = testSettings;
    withSettings({ ai: { ...(testSettings.ai || {}), permissionMode: 'confirm' } });
    approvalRequests.length = 0;
    officeCalls.length = 0;
    approvalAnswer = true;
    try {
      await grantWorkspace(officeHandler);
      const response = await callExcelWrite(officeHandler);
      assert.equal(response.statusCode, 200);
      assert.equal(approvalRequests.length, 1);
      assert.equal(approvalRequests[0].functionName, 'office_excel_write');
      assert.equal(approvalRequests[0].toolId, 'office:excel:write');
      assert.equal(approvalRequests[0].path, '555.xlsx');
      assert.equal(officeCalls.length, 1);
    } finally {
      testSettings = previous;
    }
  });

  it('refuses the call when the user declines', async () => {
    const previous = testSettings;
    withSettings({ ai: { ...(testSettings.ai || {}), permissionMode: 'confirm' } });
    approvalRequests.length = 0;
    officeCalls.length = 0;
    approvalAnswer = false;
    try {
      await grantWorkspace(officeHandler);
      const response = await callExcelWrite(officeHandler);
      assert.equal(response.statusCode, 403);
      assert.equal(response.body.error, 'approval_denied');
      assert.equal(officeCalls.length, 0);
    } finally {
      approvalAnswer = true;
      testSettings = previous;
    }
  });

  it('denies Office calls in confirm mode when nothing can ask the user', async () => {
    const previous = testSettings;
    withSettings({ ai: { ...(testSettings.ai || {}), permissionMode: 'confirm' } });
    officeCalls.length = 0;
    try {
      await grantWorkspace(bareOfficeHandler);
      const response = await callExcelWrite(bareOfficeHandler);
      assert.equal(response.statusCode, 403);
      assert.equal(response.body.error, 'approval_denied');
      assert.equal(officeCalls.length, 0);
    } finally {
      testSettings = previous;
    }
  });

  it('runs without asking in automatic mode', async () => {
    const previous = testSettings;
    withSettings({ ai: { ...(testSettings.ai || {}), permissionMode: 'auto' } });
    approvalRequests.length = 0;
    officeCalls.length = 0;
    try {
      await grantWorkspace(officeHandler);
      const response = await callExcelWrite(officeHandler);
      assert.equal(response.statusCode, 200);
      assert.equal(approvalRequests.length, 0);
      assert.equal(officeCalls.length, 1);
    } finally {
      testSettings = previous;
    }
  });
});

describe('REST API activation', () => {
  it('stays disabled when the automation API is disabled', () => {
    const previous = testSettings;
    withSettings({
      api: { enabled: false, token: '' },
    });
    try {
      assert.equal(isEnabled(), false);
    } finally {
      testSettings = previous;
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
