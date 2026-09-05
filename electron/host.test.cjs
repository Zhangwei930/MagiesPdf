const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  PRINT_WEB_PREFERENCES,
  converterConfigFrom,
  createHostBridge,
  converterSupports,
  isSafePrintRequest,
  safeTemporaryName,
} = require('./host.cjs');

describe('host boundary helpers', () => {
  it('uses a configured converter before the detected LibreOffice executable', () => {
    assert.deepEqual(
      converterConfigFrom(
        {
          externalConverter: {
            executable: '/custom/converter',
            argumentTemplate: '--to pdf {in} {out}',
            timeoutMs: 5000,
          },
          office: { libreOfficeExecutable: '/custom/soffice' },
        },
        {
          isExecutable: (candidate) => candidate === '/custom/converter',
          resolveLibreOffice: () => '/custom/soffice',
        },
      ),
      {
        kind: 'custom',
        executable: '/custom/converter',
        argumentTemplate: '--to pdf {in} {out}',
        timeoutMs: 5000,
      },
    );
  });

  it('automatically uses LibreOffice for Office-to-PDF conversion', () => {
    const config = converterConfigFrom(
      {
        externalConverter: { executable: '', argumentTemplate: '', timeoutMs: 120000 },
        office: { libreOfficeExecutable: '' },
      },
      {
        isExecutable: () => false,
        resolveLibreOffice: () => '/usr/bin/libreoffice',
      },
    );

    assert.equal(config.kind, 'libreoffice');
    assert.equal(config.executable, '/usr/bin/libreoffice');
    assert.ok(config.argumentTemplate.includes('--headless'));
    assert.ok(config.argumentTemplate.includes('--convert-to {target}'));
    assert.equal(converterSupports(config, 'pdf'), true);
    assert.equal(converterSupports(config, 'docx'), false);
  });

  it('resolves Office conversion from packaged app resources', () => {
    let resolution;
    const config = converterConfigFrom(
      { externalConverter: { executable: '' }, office: { libreOfficeExecutable: '/custom/soffice' } },
      {
        isExecutable: () => false,
        packaged: true,
        resourcesPath: '/app/resources',
        platform: 'linux',
        arch: 'x64',
        resolveLibreOffice: (options) => {
          resolution = options;
          return '/app/resources/office-runtime/program/soffice';
        },
      },
    );

    assert.equal(config.executable, '/app/resources/office-runtime/program/soffice');
    assert.deepEqual(resolution, {
      bundledRoot: '/app/resources/office-runtime',
      configured: '/custom/soffice',
      packaged: true,
      platform: 'linux',
    });
  });

  it('accepts a plain file name for the external converter', () => {
    assert.equal(safeTemporaryName('report.docx'), 'report.docx');
  });

  it('rejects names that can escape the converter temporary directory', () => {
    for (const name of ['../report.docx', 'nested/report.docx', '/tmp/report.docx', '', '.', '..']) {
      assert.throws(() => safeTemporaryName(name), /safe file name/i, name);
    }
  });

  it('runs print windows without JavaScript or Node privileges', () => {
    assert.equal(PRINT_WEB_PREFERENCES.javascript, false);
    assert.equal(PRINT_WEB_PREFERENCES.nodeIntegration, false);
    assert.equal(PRINT_WEB_PREFERENCES.contextIsolation, true);
    assert.equal(PRINT_WEB_PREFERENCES.sandbox, true);
  });

  it('allows inline print resources but blocks filesystem and network requests', () => {
    assert.equal(isSafePrintRequest('data:text/html,hello'), true);
    assert.equal(isSafePrintRequest('blob:null/id'), true);
    assert.equal(isSafePrintRequest('https://example.com/pixel'), false);
    assert.equal(isSafePrintRequest('http://127.0.0.1:8737/v1/health'), false);
    assert.equal(isSafePrintRequest('file:///etc/passwd'), false);
    assert.equal(isSafePrintRequest('ws://127.0.0.1/socket'), false);
  });
});

/**
 * `advanced.batch` and `advanced.pipeline` have to be `runtime: 'main'`,
 * because a step might need this bridge. Most steps do not, and doing their
 * work in the main process froze the window, its own cancel button, the
 * editor and the local API for the length of the run — so the bridge offers a
 * way back out to wherever tools normally run.
 */
describe('running another tool from a main-process tool', () => {
  it('is not offered when there is nowhere to dispatch to', () => {
    assert.equal(createHostBridge().runTool, undefined);
  });

  it('is offered when the caller supplies one', async () => {
    const asked = [];
    const bridge = createHostBridge({
      runTool: async (toolId) => {
        asked.push(toolId);
        return { files: [] };
      },
    });

    await bridge.runTool('edit.compress', [], {});
    assert.deepEqual(asked, ['edit.compress']);
  });

  it('keeps the rest of the bridge either way', () => {
    for (const bridge of [createHostBridge(), createHostBridge({ runTool: async () => ({}) })]) {
      assert.equal(typeof bridge.htmlToPdf, 'function');
      assert.equal(typeof bridge.externalConvert, 'function');
      assert.equal(typeof bridge.hasExternalConverter, 'function');
    }
  });

  /** The one this app actually installs sends the step to the job pool. */
  it('is wired to the pool in ipc.cjs', () => {
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'ipc.cjs'),
      'utf8',
    );
    const call = /createHostBridge\(\{[\s\S]{0,900}/.exec(source)?.[0] ?? '';
    assert.match(call, /runTool:/);
    assert.match(call, /pool\s*\n?\s*\.run\(/, 'the step has to reach the pool');
    assert.match(call, /pool\.cancel\(jobId\)/, 'cancelling a batch has to reach the step');
  });
});
