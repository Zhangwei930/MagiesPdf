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
   * Freehand draw used to draw a red line that vanished on mouse-up: the
   * Viewer never passed `onAddInkAnnotation`, so nothing was recorded and the
   * document never became dirty. The entry point was taken away until the mark
   * could reach the file. It can now — a stroke is a tool run that writes an
   * `/Ink` annotation — so the way in is back.
   */
  it('offers the annotation modes now that a mark reaches the file', () => {
    const actions = PDF_RIBBON_TABS.flatMap((tab) =>
      tab.items.filter((item) => item.kind === 'action').map((item) => item.action),
    );
    assert.ok(actions.includes('modeDraw' as (typeof actions)[number]));
    assert.ok(actions.includes('modeText' as (typeof actions)[number]));
  });
});
