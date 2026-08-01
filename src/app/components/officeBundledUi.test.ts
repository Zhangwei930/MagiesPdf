import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const homeSource = readFileSync(new URL('./Home.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('./OfficeSettingsSection.tsx', import.meta.url), 'utf8');

describe('bundled Office customer experience', () => {
  it('does not ask customers to download or locate another editor', () => {
    for (const source of [homeSource, settingsSource]) {
      assert.doesNotMatch(source, /pickLibreOfficeExecutable/);
      assert.doesNotMatch(source, /openLibreOfficeDownload/);
      assert.doesNotMatch(source, /installLibreOffice/);
    }
  });

  it('does not expose an executable path setting', () => {
    assert.doesNotMatch(settingsSource, /libreOfficeExecutable/);
    assert.doesNotMatch(settingsSource, /<input/);
  });

  it('exposes both manual editing and AI automation from the home screen', () => {
    assert.match(homeSource, /manualOfficeMode/);
    assert.match(homeSource, /aiOfficeMode/);
    assert.match(homeSource, /onOpenAi/);
    assert.match(appSource, /onOpenAi=\{openAi\}/);
    assert.match(appSource, /setAiMounted\(true\);\s*setAiOpen\(true\)/);
  });
});
