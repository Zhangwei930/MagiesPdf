import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * `files:save` answers `null` when the user closes the folder picker without
 * choosing one. Nothing was written, so nothing may say it was.
 *
 * One caller ignored that and reported "saved" anyway — and, worse, replaced
 * the panel offering the files with the success notice, so the only way back
 * to them was to run the tool again. Every other call site already checks.
 * This guards the shape rather than the one bug, because the mistake is easy
 * to repeat and the failure is silent.
 */
const sources = [
  '../App.tsx',
  './ToolPage.tsx',
  './SignPage.tsx',
  './PipelinePage.tsx',
  './BatchPage.tsx',
  './JobPanel.tsx',
  './ApplyToolPanel.tsx',
  './AIChatPanel.tsx',
].map((path) => ({ path, text: readFileSync(new URL(path, import.meta.url), 'utf8') }));

describe('saving what a tool produced', () => {
  it('is called somewhere, or this test is guarding nothing', () => {
    const callers = sources.filter((source) => source.text.includes('saveOutputs('));
    assert.ok(callers.length >= 6, `only ${callers.length} call sites found`);
  });

  it('never claims a save the user cancelled', () => {
    for (const { path, text } of sources) {
      // The `.then(...)` / `await` body that follows each call, far enough to
      // cover the handler.
      for (const match of text.matchAll(/saveOutputs\([^)]*\)/g)) {
        const after = text.slice(match.index, match.index + 400);
        const claimsSuccess = /savedTo|setSavedTo|markJobSaved|kind: 'ok'/.test(after);
        if (!claimsSuccess) continue;
        assert.match(
          after,
          /if \(!result\) return|if \(result\)/,
          `${path} reports a save without checking the folder picker was answered`,
        );
      }
    }
  });
});
