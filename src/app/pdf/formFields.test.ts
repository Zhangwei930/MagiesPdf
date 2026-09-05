import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const renderer = readFileSync(new URL('./renderer.ts', import.meta.url), 'utf8');
const pageView = readFileSync(new URL('../components/PageView.tsx', import.meta.url), 'utf8');

/**
 * A radio group is several widgets sharing one field name, and its value is
 * *which option*, not on-or-off.
 *
 * The renderer folded `radioButton` in with `checkBox`, so the page drew a row
 * of tickboxes that all wrote `true` to the same name: no option could be
 * chosen, and the group could only be cleared. They also all had the same
 * React key, since the key was the field name.
 *
 * pdf.js resolves `/Opt`, so `buttonValue` is the option's own name — the same
 * spelling `edit.fill-form` matches against with MuPDF's `getOptions()`, which
 * is what makes the two ends agree.
 */
describe('a radio group on the page', () => {
  it('is not reported as a checkbox', () => {
    assert.doesNotMatch(renderer, /checkBox === true \|\| annotation\.radioButton === true/);
    assert.match(renderer, /radioValue:/);
    assert.match(renderer, /annotation\.buttonValue/);
  });

  it('is drawn as radio buttons, one per option', () => {
    assert.match(pageView, /type="radio"/);
    const input = /type="radio"[\s\S]{0,600}/.exec(pageView)?.[0] ?? '';
    assert.match(input, /name=\{field\.name\}/, 'the buttons of one group belong together');
    assert.match(input, /field\.radioValue\)/, 'choosing one has to name its option');
  });

  it('gives each button its own key', () => {
    assert.doesNotMatch(pageView, /key=\{field\.name\}/);
  });
});
