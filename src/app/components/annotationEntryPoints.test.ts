import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const viewerSource = readFileSync(new URL('./Viewer.tsx', import.meta.url), 'utf8');
const chromeSource = readFileSync(new URL('./PdfChrome.tsx', import.meta.url), 'utf8');
const paletteSource = readFileSync(new URL('./HighlightToolbar.tsx', import.meta.url), 'utf8');

/**
 * Issue #26, both halves.
 *
 * The viewer used to offer text highlighting and a freehand pen and keep
 * neither: the palette set a colour in local state, the pen's stroke vanished
 * on mouse-up, and because nothing marked the document dirty, closing the tab
 * asked no questions — the user was told their annotations were safe by the
 * absence of a warning. The entry points were taken away rather than left to
 * lie, and this file guarded that.
 *
 * It now guards the other side. A mark is a run of `edit.annotate`, which is a
 * tool like any other, so it lands in the same undo history as a page rotation,
 * marks the document dirty, and reaches the file on ⌘S — none of which needed
 * anything built for it. What must not come back is a control that produces a
 * mark going anywhere other than through that path.
 */
describe('annotations reach the document', () => {
  it('writes a mark through the same edit path as any other change', () => {
    assert.match(viewerSource, /runEdit\('edit\.annotate'/);
  });

  it('offers the pen and the palette again', () => {
    assert.match(chromeSource, /modeDraw/);
    assert.match(viewerSource, /HighlightToolbar/);
  });

  it('hands the drawing surface somewhere to put a finished stroke', () => {
    assert.match(viewerSource, /onAddInkAnnotation=\{addInk\}/);
  });

  it('hands the selection menu somewhere to put a highlight', () => {
    assert.match(viewerSource, /onHighlightText=\{highlightSelection\}/);
  });

  /**
   * The palette used to carry a pen button with no `onClick` at all — a
   * control that did nothing whatsoever. The pen is a ribbon mode; the palette
   * chooses a colour and nothing else.
   */
  it('offers no control that does nothing', () => {
    assert.doesNotMatch(paletteSource, /PenLine/);
  });

  /**
   * A mark that only the viewer knows about is the bug this issue was about.
   * Local state for the marks themselves would be exactly that again.
   */
  it('keeps no mark of its own that the document does not have', () => {
    assert.doesNotMatch(viewerSource, /setHighlights\(|setInkAnnotations\(/);
  });
});
