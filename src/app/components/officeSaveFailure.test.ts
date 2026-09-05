import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const editor = readFileSync(new URL('./OfficeEditor.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const assets = readFileSync(
  new URL('../../../electron/office/editorAssets.cjs', import.meta.url),
  'utf8',
);

/**
 * The engine says so when it cannot start a save — it was not ready, or
 * `downloadAs` threw before anything left the frame. The frame posts
 * `saveFailed` out to the host, and the host had no branch for it: the message
 * was dropped, the save sat waiting out its whole timeout, and what the user
 * was told in the end was "the editor did not answer" rather than the reason
 * it had already been given.
 */
describe('the engine reporting that it could not save', () => {
  it('is a message the engine actually sends', () => {
    assert.match(assets, /magies: 'saveFailed'/, 'the engine side moved');
  });

  it('is handled by the frame that receives it', () => {
    assert.match(editor, /data\.magies === 'saveFailed'/);
    assert.match(editor, /onSaveFailed\(/);
  });

  it('reaches the save that is waiting, with the reason', () => {
    assert.match(app, /onSaveFailed=\{/);
    const handler = /onSaveFailed=\{[\s\S]{0,500}/.exec(app)?.[0] ?? '';
    assert.match(handler, /engineSaveFailed\(/);
    assert.match(handler, /message: reason/);
  });
});
