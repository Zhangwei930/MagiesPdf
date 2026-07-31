const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createOfficeService } = require('./service.cjs');

function dependencies(overrides = {}) {
  const calls = { launched: [], written: [] };
  return {
    calls,
    deps: {
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true }),
      },
      settings: {
        read: () => ({
          office: { libreOfficeExecutable: '', collaboraUrl: '', wopiPublicUrl: '' },
        }),
      },
      fs: {
        stat: async () => ({ isFile: () => true }),
        writeFile: async (target, bytes) => calls.written.push([target, [...bytes]]),
      },
      loadCore: async () => ({
        createBlankOfficeDocument: (kind) => ({
          name: kind === 'word' ? 'Untitled.docx' : 'Untitled.xlsx',
          bytes: new Uint8Array([1, 2, 3]),
        }),
      }),
      resolveExecutable: () => '/usr/bin/libreoffice',
      launch: (executable, paths) => calls.launched.push([executable, paths]),
      checkCollabora: async (url) => ({ configured: Boolean(url), reachable: Boolean(url), serverUrl: url }),
      collaboraAction: async () => 'https://office.example.com/browser/editor?',
      wopiStore: {
        register: async () => ({ id: 'file-id', accessToken: 'opaque-token', accessTokenTtl: 1234 }),
      },
      getWopiServerStatus: () => ({ running: true }),
      ...overrides,
    },
  };
}

describe('Office service', () => {
  it('reports the detected local editor and configured collaboration server', async () => {
    const { deps } = dependencies({
      settings: {
        read: () => ({
          office: {
            libreOfficeExecutable: '/custom/soffice',
            collaboraUrl: 'https://office.example.com',
            wopiPublicUrl: 'https://files.example.com',
          },
        }),
      },
      resolveExecutable: ({ configured }) => `${configured}:resolved`,
    });
    const service = createOfficeService(deps);

    assert.deepEqual(service.status(), {
      libreOffice: { available: true, executable: '/custom/soffice:resolved' },
      collabora: { configured: true, serverUrl: 'https://office.example.com' },
      wopiPublicUrl: 'https://files.example.com',
    });
  });

  it('creates a file only after Save As and opens the saved path', async () => {
    const { deps, calls } = dependencies({
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async (_window, options) => {
          assert.equal(options.defaultPath, 'Untitled.docx');
          return { canceled: false, filePath: '/docs/Letter.docx' };
        },
      },
    });
    const service = createOfficeService(deps);

    const result = await service.createAndOpen({}, 'word');

    assert.deepEqual(result, { opened: ['/docs/Letter.docx'], canceled: false });
    assert.deepEqual(calls.written, [['/docs/Letter.docx', [1, 2, 3]]]);
    assert.deepEqual(calls.launched, [['/usr/bin/libreoffice', ['/docs/Letter.docx']]]);
  });

  it('can create a document without launching it so the renderer can open it online', async () => {
    const { deps, calls } = dependencies({
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: false, filePath: '/docs/Online.docx' }),
      },
    });
    const service = createOfficeService(deps);

    assert.deepEqual(await service.create({}, 'word'), {
      created: '/docs/Online.docx',
      canceled: false,
    });
    assert.deepEqual(calls.written, [['/docs/Online.docx', [1, 2, 3]]]);
    assert.deepEqual(calls.launched, []);
  });

  it('does not create or launch anything when Save As is cancelled', async () => {
    const { deps, calls } = dependencies();
    const service = createOfficeService(deps);

    assert.deepEqual(await service.createAndOpen({}, 'word'), { opened: [], canceled: true });
    assert.deepEqual(calls.written, []);
    assert.deepEqual(calls.launched, []);
  });

  it('opens only existing Office files selected by the user', async () => {
    const { deps, calls } = dependencies({
      dialog: {
        showOpenDialog: async () => ({
          canceled: false,
          filePaths: ['/docs/A.docx', '/docs/B.pptx'],
        }),
        showSaveDialog: async () => ({ canceled: true }),
      },
    });
    const service = createOfficeService(deps);

    assert.deepEqual(await service.pickAndOpen({}, true), {
      opened: ['/docs/A.docx', '/docs/B.pptx'],
      canceled: false,
    });
    assert.deepEqual(calls.launched, [
      ['/usr/bin/libreoffice', ['/docs/A.docx', '/docs/B.pptx']],
    ]);
  });

  it('checks Collabora only through the configured endpoint', async () => {
    const { deps } = dependencies({
      settings: {
        read: () => ({
          office: {
            libreOfficeExecutable: '',
            collaboraUrl: 'https://office.example.com',
            wopiPublicUrl: '',
          },
        }),
      },
    });
    const service = createOfficeService(deps);

    assert.deepEqual(await service.checkCollabora(), {
      configured: true,
      reachable: true,
      serverUrl: 'https://office.example.com',
    });
  });

  it('prepares an in-app Collabora session backed by the configured WOPI origin', async () => {
    const { deps } = dependencies({
      settings: {
        read: () => ({
          office: {
            libreOfficeExecutable: '',
            collaboraUrl: 'https://office.example.com',
            wopiPublicUrl: 'https://files.example.com/base/',
          },
        }),
      },
    });
    const service = createOfficeService(deps);

    assert.deepEqual(await service.prepareOnline('/docs/Letter.docx'), {
      name: 'Letter.docx',
      editorUrl: 'https://office.example.com/browser/editor?WOPISrc=https%3A%2F%2Ffiles.example.com%2Fbase%2Fwopi%2Ffiles%2Ffile-id',
      accessToken: 'opaque-token',
      accessTokenTtl: 1234,
    });
  });

  it('refuses an online session until both Collabora and WOPI are ready', async () => {
    const { deps } = dependencies();
    const service = createOfficeService(deps);

    await assert.rejects(service.prepareOnline('/docs/Letter.docx'), /not configured/i);
  });
});
