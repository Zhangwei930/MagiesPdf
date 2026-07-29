import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchShortcut, type KeyChord } from './shortcuts.ts';

const press = (chord: Partial<KeyChord>): KeyChord => ({
  key: '',
  code: '',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...chord,
});

/** The same physical press, as macOS and as Windows/Linux report it. */
const cmd = (rest: Partial<KeyChord>) => press({ metaKey: true, ...rest });
const ctrl = (rest: Partial<KeyChord>) => press({ ctrlKey: true, ...rest });

describe('matchShortcut — file actions', () => {
  it('maps ⌘O and Ctrl+O to open', () => {
    assert.equal(matchShortcut(cmd({ key: 'o' }), 'mac'), 'open');
    assert.equal(matchShortcut(ctrl({ key: 'o' }), 'other'), 'open');
  });

  it('maps ⌘S to save and ⌘⇧S to save-as', () => {
    assert.equal(matchShortcut(cmd({ key: 's' }), 'mac'), 'save');
    assert.equal(matchShortcut(cmd({ key: 's', shiftKey: true }), 'mac'), 'saveAs');
  });

  it('reads an upper-case key the same as a lower-case one', () => {
    // Holding shift makes the browser report "S", not "s".
    assert.equal(matchShortcut(cmd({ key: 'S', shiftKey: true }), 'mac'), 'saveAs');
  });

  it('maps ⌘W to close', () => {
    assert.equal(matchShortcut(cmd({ key: 'w' }), 'mac'), 'close');
  });

  it('ignores the platform modifier that is not in use', () => {
    // Ctrl+S on a Mac is not Save — that is ⌘S.
    assert.equal(matchShortcut(ctrl({ key: 's' }), 'mac'), null);
    assert.equal(matchShortcut(cmd({ key: 's' }), 'other'), null);
  });

  it('ignores a bare letter', () => {
    assert.equal(matchShortcut(press({ key: 's' }), 'mac'), null);
  });
});

describe('matchShortcut — history', () => {
  it('maps ⌘Z to undo', () => {
    assert.equal(matchShortcut(cmd({ key: 'z' }), 'mac'), 'undo');
  });

  it('maps ⌘⇧Z to redo', () => {
    assert.equal(matchShortcut(cmd({ key: 'z', shiftKey: true }), 'mac'), 'redo');
  });

  it('also accepts Ctrl+Y for redo, which is what Windows users press', () => {
    assert.equal(matchShortcut(ctrl({ key: 'y' }), 'other'), 'redo');
  });
});

describe('matchShortcut — zoom', () => {
  it('maps ⌘+ and ⌘- to zoom, whichever key produced them', () => {
    assert.equal(matchShortcut(cmd({ key: '=' }), 'mac'), 'zoomIn');
    assert.equal(matchShortcut(cmd({ key: '+' }), 'mac'), 'zoomIn');
    assert.equal(matchShortcut(cmd({ key: '-' }), 'mac'), 'zoomOut');
    // The numeric keypad reports different key values for the same intent.
    assert.equal(matchShortcut(cmd({ key: 'Add', code: 'NumpadAdd' }), 'mac'), 'zoomIn');
    assert.equal(matchShortcut(cmd({ key: 'Subtract', code: 'NumpadSubtract' }), 'mac'), 'zoomOut');
  });

  it('maps ⌘0 to actual size, ⌘1 to fit width, ⌘2 to fit page', () => {
    assert.equal(matchShortcut(cmd({ key: '0' }), 'mac'), 'zoomReset');
    assert.equal(matchShortcut(cmd({ key: '1' }), 'mac'), 'fitWidth');
    assert.equal(matchShortcut(cmd({ key: '2' }), 'mac'), 'fitPage');
  });
});

describe('matchShortcut — navigation', () => {
  it('maps the page keys', () => {
    assert.equal(matchShortcut(press({ key: 'PageDown' }), 'mac'), 'nextPage');
    assert.equal(matchShortcut(press({ key: 'PageUp' }), 'mac'), 'prevPage');
  });

  it('maps Home and End to the ends of the document', () => {
    assert.equal(matchShortcut(press({ key: 'Home' }), 'mac'), 'firstPage');
    assert.equal(matchShortcut(press({ key: 'End' }), 'mac'), 'lastPage');
  });

  it('maps ⌘K to the command palette and Escape on its own', () => {
    assert.equal(matchShortcut(cmd({ key: 'k' }), 'mac'), 'palette');
    assert.equal(matchShortcut(press({ key: 'Escape' }), 'mac'), 'dismiss');
  });

  it('leaves plain arrow keys to the scroll container', () => {
    assert.equal(matchShortcut(press({ key: 'ArrowDown' }), 'mac'), null);
  });
});

describe('matchShortcut — typing', () => {
  const typing = { typing: true };

  it('does not steal an unmodified key while the user is typing', () => {
    assert.equal(matchShortcut(press({ key: 'PageDown' }), 'mac', typing), null);
    assert.equal(matchShortcut(press({ key: 'Home' }), 'mac', typing), null);
  });

  it('still honours the modified shortcuts, which no text field claims', () => {
    assert.equal(matchShortcut(cmd({ key: 's' }), 'mac', typing), 'save');
    assert.equal(matchShortcut(cmd({ key: 'k' }), 'mac', typing), 'palette');
  });

  it('still lets Escape out of a field', () => {
    assert.equal(matchShortcut(press({ key: 'Escape' }), 'mac', typing), 'dismiss');
  });

  it('leaves ⌘Z alone while typing, so the field can undo its own text', () => {
    assert.equal(matchShortcut(cmd({ key: 'z' }), 'mac', typing), null);
  });
});
