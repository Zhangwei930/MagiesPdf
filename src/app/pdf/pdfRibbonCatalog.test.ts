import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_TOOLS } from '@core/tools/index.ts';
import { PDF_RIBBON_TABS, pdfRibbonToolIds } from './pdfRibbonCatalog.ts';

describe('pdf ribbon catalogue', () => {
  it('only references tools that exist in the engine catalogue', () => {
    const known = new Set(ALL_TOOLS.map((tool) => tool.id));
    for (const id of pdfRibbonToolIds()) {
      assert.ok(known.has(id), `unknown tool on PDF ribbon: ${id}`);
    }
  });

  it('covers the main WPS-style tabs', () => {
    const ids = PDF_RIBBON_TABS.map((tab) => tab.id);
    for (const need of ['home', 'insert', 'edit', 'page', 'annotate', 'convert', 'protect', 'tools']) {
      assert.ok(ids.includes(need as (typeof ids)[number]), `missing tab ${need}`);
    }
  });

  it('puts at least one tool or action on every tab', () => {
    for (const tab of PDF_RIBBON_TABS) {
      assert.ok(tab.items.length > 0, `empty tab ${tab.id}`);
    }
  });

  /**
   * Freehand draw drew a red line that vanished on mouse-up: the Viewer never
   * passed `onAddInkAnnotation`, so nothing was ever recorded, the document
   * never became dirty, and closing the tab asked nothing. An entry point for
   * an annotation that is silently thrown away is worse than no entry point,
   * because the user believes they have marked the document up.
   *
   * The drawing machinery is still here; what is gone is the way in. It comes
   * back when the annotation actually reaches the file — see issue #26.
   */
  it('offers no way into an annotation mode that cannot keep what it draws', () => {
    const actions = PDF_RIBBON_TABS.flatMap((tab) =>
      tab.items.filter((item) => item.kind === 'action').map((item) => item.action),
    );
    assert.equal(actions.includes('modeDraw' as (typeof actions)[number]), false);
  });
});
