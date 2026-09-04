import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const viewerSource = readFileSync(new URL('./Viewer.tsx', import.meta.url), 'utf8');
const chromeSource = readFileSync(new URL('./PdfChrome.tsx', import.meta.url), 'utf8');

/**
 * Issue #26. The viewer offered text highlighting and a freehand pen, and
 * neither kept anything.
 *
 * The highlight palette set a colour in the Viewer's own state and stopped
 * there — `onHighlightText` was never handed to the selection menu, and
 * `DocumentState.highlights` had no mutation behind it. The pen drew a red
 * line that disappeared the moment the button came up. Neither marked the
 * document dirty, so closing the tab asked nothing and the user was told
 * their annotations were safe by the absence of a warning.
 *
 * These are hidden rather than repaired: making them real means putting the
 * annotations into the PDF, through the same undo history as a page rotation,
 * and that is a feature rather than a fix. Until then the honest interface is
 * one that does not offer what it cannot keep.
 */
describe('annotation entry points that keep nothing', () => {
  it('does not offer a highlight palette that highlights nothing', () => {
    assert.doesNotMatch(viewerSource, /HighlightToolbar/);
    assert.doesNotMatch(viewerSource, /highlightColor/);
  });

  it('does not offer a freehand pen that keeps no stroke', () => {
    assert.doesNotMatch(chromeSource, /modeDraw/);
  });

  /**
   * Add-text is a different thing and it works, so it stays — but its banner
   * used to promise highlighting in the same sentence.
   */
  it('still offers adding text, and promises only that', () => {
    assert.match(chromeSource, /modeText/);
    assert.doesNotMatch(viewerSource, /choose color to highlight/i);
  });
});
