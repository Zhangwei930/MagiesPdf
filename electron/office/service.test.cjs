const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createOfficeService, normalizeLibreOfficeSelection } = require('./service.cjs');

function dependencies(overrides = {}) {
  const calls = { launched: [], rendered: [], openedExternal: [], renamed: [], trashed: [], written: [], settings: [] };
  let stored = {
    office: { libreOfficeExecutable: '' },
    recentDocuments: [],
  };
  const deps = {
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    settings: {
      read: () => stored,
      write: (patch) => {
        stored = { ...stored, ...patch };
        calls.settings.push(patch);
        return stored;
      },
    },
    fs: {
      access: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      rename: async (from, to) => calls.renamed.push([from, to]),
      stat: async () => ({ isFile: () => true, mtimeMs: 1000 }),
      writeFile: async (target, bytes) => calls.written.push([target, [...bytes]]),
    },
    loadCore: async () => ({
      createBlankOfficeDocument: (kind) => ({
        name: kind === 'word' ? 'Untitled.docx' : 'Untitled.xlsx',
        bytes: new Uint8Array([1, 2, 3]),
      }),
    }),
    now: () => 2000,
    resolveExecutable: () => '/usr/bin/libreoffice',
    launch: (executable, paths) => calls.launched.push([executable, paths]),
    preview: {
      render: async (paths) => {
        calls.rendered.push([...paths]);
        return paths.map((target) => ({
          name: `${target.split('/').pop().replace(/\.[^.]+$/, '')}.pdf`,
          path: '',
          size: 3,
          mime: 'application/pdf',
          bytes: Buffer.from('pdf'),
          origin: { path: target, kind: 'word' },
        }));
      },
    },
    openExternal: async (url) => calls.openedExternal.push(url),
    trash: async (target) => calls.trashed.push(target),
    ...overrides,
  };
  return { calls, deps, getStored: () => stored };
}

describe('Office service', () => {
  it('accepts selecting the LibreOffice app bundle on macOS', () => {
    assert.equal(
      normalizeLibreOfficeSelection('/Applications/LibreOffice.app', 'darwin'),
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    );
    assert.equal(normalizeLibreOfficeSelection('/usr/bin/libreoffice', 'linux'), '/usr/bin/libreoffice');
  });

  it('reports only the detected local editor', () => {
    const { deps } = dependencies({
      settings: { read: () => ({ office: { libreOfficeExecutable: '/custom/soffice' } }) },
      resolveExecutable: ({ configured }) => `${configured}:resolved`,
    });

    assert.deepEqual(createOfficeService(deps).status(), {
      libreOffice: { available: true, executable: '/custom/soffice:resolved' },
    });
  });

  it('resolves the editor from packaged app resources', () => {
    let resolution;
    const { deps } = dependencies({
      packaged: true,
      resourcesPath: '/app/resources',
      platform: 'linux',
      arch: 'x64',
      resolveExecutable: (options) => {
        resolution = options;
        return '/app/resources/office-runtime/program/soffice';
      },
    });

    assert.equal(createOfficeService(deps).status().libreOffice.available, true);
    assert.deepEqual(resolution, {
      bundledRoot: '/app/resources/office-runtime',
      configured: '',
      packaged: true,
      platform: 'linux',
    });
  });

  it('lets the customer locate an existing LibreOffice installation', async () => {
    const selected = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
    const { deps, getStored } = dependencies({
      dialog: {
        showOpenDialog: async (_window, options) => {
          assert.equal(options.title, 'Locate LibreOffice');
          return { canceled: false, filePaths: [selected] };
        },
        showSaveDialog: async () => ({ canceled: true }),
      },
      resolveExecutable: ({ configured }) => configured,
    });

    assert.deepEqual(await createOfficeService(deps).pickExecutable({}), {
      canceled: false,
      status: { libreOffice: { available: true, executable: selected } },
    });
    assert.equal(getStored().office.libreOfficeExecutable, selected);
  });

  it('does not change settings when locating LibreOffice is cancelled', async () => {
    const { deps, calls } = dependencies();

    assert.deepEqual(await createOfficeService(deps).pickExecutable({}), {
      canceled: true,
      status: { libreOffice: { available: true, executable: '/usr/bin/libreoffice' } },
    });
    assert.deepEqual(calls.settings, []);
  });

  it('opens only the official LibreOffice download page', async () => {
    const { deps, calls } = dependencies();

    assert.deepEqual(await createOfficeService(deps).openDownloadPage(), { opened: true });
    assert.deepEqual(calls.openedExternal, ['https://www.libreoffice.org/download/']);
  });

  it('creates, opens and remembers a document after Save As', async () => {
    const { deps, calls, getStored } = dependencies({
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async (_window, options) => {
          assert.equal(options.defaultPath, 'Untitled.docx');
          return { canceled: false, filePath: '/docs/Letter.docx' };
        },
      },
    });
    const result = await createOfficeService(deps).createAndOpen({}, 'word');

    assert.equal(result.canceled, false);
    assert.deepEqual(result.opened, ['/docs/Letter.docx']);
    assert.deepEqual(calls.written, [['/docs/Letter.docx', [1, 2, 3]]]);
    assert.deepEqual(getStored().recentDocuments, [{ path: '/docs/Letter.docx', openedAt: 2000 }]);
  });

  /**
   * Creating and opening are separate now: a new document goes to the editor,
   * the same way an existing one does, and the service's job ends once the file
   * exists on disk.
   */
  it('creates a blank document and reports where it went', async () => {
    const { deps, calls } = dependencies({
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: false, filePath: '/docs/Untitled.docx' }),
      },
    });

    const result = await createOfficeService(deps).createBlank({}, 'word');

    assert.deepEqual(result, { created: '/docs/Untitled.docx', canceled: false });
    assert.deepEqual(calls.written, [['/docs/Untitled.docx', [1, 2, 3]]]);
    assert.deepEqual(calls.rendered, [], 'creating does not render a preview');
  });

  it('reports a cancelled Save As without writing anything', async () => {
    const { deps, calls } = dependencies();
    assert.deepEqual(await createOfficeService(deps).createBlank({}, 'word'), {
      created: '',
      canceled: true,
    });
    assert.deepEqual(calls.written, []);
  });

  it('does not create or render anything when Save As is cancelled', async () => {
    const { deps, calls } = dependencies();

    assert.deepEqual(await createOfficeService(deps).createAndOpen({}, 'word'), {
      opened: [],
      canceled: true,
      files: [],
    });
    assert.deepEqual(calls.written, []);
    assert.deepEqual(calls.rendered, []);
  });

  /**
   * Opening a document is now rendering, not launching. Nothing about it needs
   * a second application to be installed, so a missing one must not block it.
   */
  it('opens documents without needing a separate application installed', async () => {
    const { deps, calls } = dependencies({ resolveExecutable: () => '' });

    const result = await createOfficeService(deps).openPaths(['/docs/A.docx']);

    assert.equal(result.canceled, false);
    assert.deepEqual(calls.rendered, [['/docs/A.docx']]);
    assert.deepEqual(calls.launched, []);
  });

  it('opens existing Office files selected by the user and remembers newest first', async () => {
    const { deps, calls, getStored } = dependencies({
      dialog: {
        showOpenDialog: async () => ({
          canceled: false,
          filePaths: ['/docs/A.docx', '/docs/B.pptx'],
        }),
        showSaveDialog: async () => ({ canceled: true }),
      },
    });

    const result = await createOfficeService(deps).pickAndOpen({}, true);

    assert.deepEqual(result.opened, ['/docs/A.docx', '/docs/B.pptx']);
    assert.deepEqual(calls.rendered, [['/docs/A.docx', '/docs/B.pptx']]);
    // No second application is started any more; this is the single window.
    assert.deepEqual(calls.launched, []);
    assert.deepEqual(getStored().recentDocuments, [
      { path: '/docs/B.pptx', openedAt: 2000 },
      { path: '/docs/A.docx', openedAt: 2000 },
    ]);
  });

  it('hands the renderer bytes that carry their source, not a path to overwrite', async () => {
    const { deps } = dependencies();

    const { files } = await createOfficeService(deps).openPaths(['/docs/A.docx']);

    assert.equal(files.length, 1);
    assert.equal(files[0].path, '');
    assert.deepEqual(files[0].origin, { path: '/docs/A.docx', kind: 'word' });
  });

  it('lists recent documents with file metadata and prunes missing entries', async () => {
    const writes = [];
    const { deps } = dependencies({
      settings: {
        read: () => ({
          office: { libreOfficeExecutable: '' },
          recentDocuments: [
            { path: '/docs/Report.pdf', openedAt: 300 },
            { path: '/docs/missing.docx', openedAt: 200 },
          ],
        }),
        write: (patch) => writes.push(patch),
      },
      fs: {
        stat: async (target) => {
          if (target.includes('missing')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return { isFile: () => true, mtimeMs: 400 };
        },
      },
    });

    assert.deepEqual(await createOfficeService(deps).listRecent(), [
      {
        path: '/docs/Report.pdf',
        name: 'Report.pdf',
        kind: 'pdf',
        openedAt: 300,
        modifiedAt: 400,
      },
    ]);
    assert.deepEqual(writes, [{ recentDocuments: [{ path: '/docs/Report.pdf', openedAt: 300 }] }]);
  });

  it('renames a recent file without allowing its format to change', async () => {
    const { deps, calls, getStored } = dependencies();
    const service = createOfficeService(deps);
    service.rememberRecent(['/docs/Quarterly Report.xlsx']);

    assert.deepEqual(await service.renameRecent('/docs/Quarterly Report.xlsx', '2026 Results'), {
      path: '/docs/2026 Results.xlsx',
      name: '2026 Results.xlsx',
    });
    assert.deepEqual(calls.renamed, [['/docs/Quarterly Report.xlsx', '/docs/2026 Results.xlsx']]);
    assert.equal(getStored().recentDocuments[0].path, '/docs/2026 Results.xlsx');
    await assert.rejects(
      service.renameRecent('/docs/2026 Results.xlsx', 'unsafe.pdf'),
      /format/i,
    );
  });

  it('moves a document to the system trash and removes it from recent documents', async () => {
    const { deps, calls, getStored } = dependencies();
    const service = createOfficeService(deps);
    service.rememberRecent(['/docs/Old.pptx']);

    assert.deepEqual(await service.trashRecent('/docs/Old.pptx'), { trashed: true });
    assert.deepEqual(calls.trashed, ['/docs/Old.pptx']);
    assert.deepEqual(getStored().recentDocuments, []);
  });

  it('forgets a recent item without deleting the file', () => {
    const { deps, calls, getStored } = dependencies();
    const service = createOfficeService(deps);
    service.rememberRecent(['/docs/Keep.docx']);

    assert.deepEqual(service.forgetRecent('/docs/Keep.docx'), { forgotten: true });
    assert.deepEqual(getStored().recentDocuments, []);
    assert.deepEqual(calls.trashed, []);
  });
});
