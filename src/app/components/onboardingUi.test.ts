import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const wizardSource = readFileSync(new URL('./OnboardingWizard.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

describe('Welcome tour', () => {
  it('offers a "do not show again" choice on every way out', () => {
    assert.match(wizardSource, /dontShowAgain|onboardingDontShow/);
    assert.match(wizardSource, /type="checkbox"/);
    // Starts unticked: the tour keeps coming back unless the user says stop.
    assert.match(wizardSource, /useState\(false\);/);
    // Skip, the close cross and "Get started" all report the same choice, so
    // the box cannot be honoured on one exit and ignored on another.
    assert.match(wizardSource, /onClose\(dontShowAgain\)/);
    assert.doesNotMatch(wizardSource, /onClose\(\)/);
  });

  it('persists the flag only when the box is ticked', () => {
    // Unticked closes for this session only: the tour is back next launch.
    assert.match(appSource, /onboardingDismissed/);
    assert.match(
      appSource,
      /if \(dontShowAgain\) void updateSettings\(\{ onboardingComplete: true \}\)/,
    );
  });
});
