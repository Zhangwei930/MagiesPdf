import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ENGINE_PACKAGES,
  VIEWER_ONLY_PACKAGES,
  checkRendererBundle,
  enginePayloads,
  enginesIn,
} from './bundleBoundary.mjs';

describe('enginesIn', () => {
  it('finds nothing in a chunk built only from app code', () => {
    assert.deepEqual(enginesIn(['../../src/app/App.tsx', '../../src/core/types.ts']), []);
  });

  it('names the engine that got pulled in', () => {
    assert.deepEqual(enginesIn(['../../node_modules/mupdf/dist/mupdf.js']), ['mupdf']);
  });

  it('finds a scoped package', () => {
    assert.deepEqual(enginesIn(['../../node_modules/@signpdf/signpdf/dist/index.js']), [
      '@signpdf/signpdf',
    ]);
  });

  it('reports each engine once, however many files it contributed', () => {
    assert.deepEqual(
      enginesIn([
        'node_modules/pdf-lib/es/a.js',
        'node_modules/pdf-lib/es/b.js',
        'node_modules/pdf-lib/es/c.js',
      ]),
      ['pdf-lib'],
    );
  });

  it('does not fire on a different package with a matching prefix', () => {
    // `pdf-lib-fontkit` is not `pdf-lib`, and treating it as one would make the
    // check cry wolf until someone switched it off.
    assert.deepEqual(enginesIn(['node_modules/pdf-lib-fontkit/index.js']), []);
  });

  it('does not fire on app code that merely mentions the name', () => {
    assert.deepEqual(enginesIn(['../../src/core/tools/mupdfHelpers.ts']), []);
    assert.deepEqual(enginesIn(['../../src/app/notes-about-pdf-lib.ts']), []);
  });

  it('handles a nested node_modules copy', () => {
    assert.deepEqual(enginesIn(['node_modules/foo/node_modules/mupdf/index.js']), ['mupdf']);
  });

  it('survives junk in the sources list', () => {
    assert.deepEqual(enginesIn(['', null, undefined, 42]), []);
    assert.deepEqual(enginesIn(null), []);
  });

  it('covers every engine the renderer must never contain', () => {
    for (const engine of ENGINE_PACKAGES) {
      assert.deepEqual(enginesIn([`node_modules/${engine}/index.js`]), [engine]);
    }
  });
});

describe('enginePayloads', () => {
  it('accepts an asset directory with no engine payload', () => {
    assert.deepEqual(enginePayloads(['index-abc.js', 'index-abc.css', 'logo.png']), []);
  });

  it('flags a wasm binary, whatever it is called', () => {
    assert.deepEqual(enginePayloads(['index.js', 'mupdf-xyz.wasm']), ['mupdf-xyz.wasm']);
  });

  it('matches the extension case-insensitively', () => {
    assert.deepEqual(enginePayloads(['THING.WASM']), ['THING.WASM']);
  });

  it('survives junk', () => {
    assert.deepEqual(enginePayloads(null), []);
  });
});

describe('checkRendererBundle', () => {
  const entry = { name: 'index-abc.js', sources: ['../../src/app/App.tsx'], byteLength: 1000 };
  const viewer = { name: 'Viewer-abc.js', sources: ['node_modules/pdfjs-dist/build/pdf.mjs'], byteLength: 400 };
  const clean = { chunks: [entry, viewer], assets: ['index-abc.js'], entryName: 'index-abc.js', limit: 2000 };

  it('passes a bundle where only the viewer chunk holds pdfjs', () => {
    assert.deepEqual(checkRendererBundle(clean), { ok: true, problems: [] });
  });

  it('fails when an engine reached the entry chunk', () => {
    const result = checkRendererBundle({
      ...clean,
      chunks: [{ ...entry, sources: ['node_modules/mupdf/a.js'] }, viewer],
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /mupdf/);
  });

  it('fails when an engine hid in a lazily-loaded chunk', () => {
    // The rule is that the renderer never imports an engine — not merely that
    // the first chunk does not. A leak into a lazy screen is the same break.
    const result = checkRendererBundle({
      ...clean,
      chunks: [entry, viewer, { name: 'SettingsPanel-x.js', sources: ['node_modules/pdf-lib/a.js'], byteLength: 50 }],
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /pdf-lib/);
    assert.match(result.problems.join('\n'), /SettingsPanel/);
  });

  it('fails when pdfjs reaches the entry chunk, where it must stay lazy', () => {
    const result = checkRendererBundle({
      ...clean,
      chunks: [{ ...entry, sources: ['node_modules/pdfjs-dist/build/pdf.mjs'] }, viewer],
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /pdfjs-dist/);
  });

  it('allows pdfjs in any lazily-loaded chunk, not just one named Viewer', () => {
    const result = checkRendererBundle({
      ...clean,
      chunks: [entry, { name: 'Preview-x.js', sources: ['node_modules/pdfjs-dist/a.js'], byteLength: 400 }],
    });
    assert.equal(result.ok, true);
  });

  it('fails on a wasm payload, which means an engine came with it', () => {
    const result = checkRendererBundle({ ...clean, assets: ['index-abc.js', 'engine.wasm'] });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /engine\.wasm/);
  });

  it('fails when the entry chunk outgrew its ceiling', () => {
    const result = checkRendererBundle({ ...clean, chunks: [{ ...entry, byteLength: 3000 }, viewer] });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('\n'), /ceiling/);
  });

  it('passes at exactly the ceiling', () => {
    assert.equal(checkRendererBundle({ ...clean, chunks: [{ ...entry, byteLength: 2000 }] }).ok, true);
  });

  it('does not hold a lazy chunk to the entry chunk ceiling', () => {
    // The Viewer chunk is far bigger than the entry and always will be.
    const result = checkRendererBundle({ ...clean, chunks: [entry, { ...viewer, byteLength: 99999 }] });
    assert.equal(result.ok, true);
  });

  it('fails loudly when the entry chunk is missing rather than passing by default', () => {
    const result = checkRendererBundle({ ...clean, entryName: 'nope.js' });
    assert.equal(result.ok, false);
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const result = checkRendererBundle({
      ...clean,
      chunks: [{ ...entry, sources: ['node_modules/mupdf/a.js'], byteLength: 9000 }],
      assets: ['engine.wasm'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 3);
  });

  it('keeps the two lists disjoint, so nothing is both banned and allowed', () => {
    for (const allowed of VIEWER_ONLY_PACKAGES) {
      assert.ok(!ENGINE_PACKAGES.includes(allowed), `${allowed} cannot be both`);
    }
  });
});
