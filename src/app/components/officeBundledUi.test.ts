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

  /**
   * The start centre is about the customer's files, not about explaining how
   * the suite works. Two panels used to describe editing by hand and editing
   * by assistant, which is a description of the product rather than a way into
   * a document; the assistant is reached from the rail and the title bar.
   */
  it('does not spend the start centre explaining its own modes', () => {
    assert.doesNotMatch(homeSource, /manualOfficeMode/);
    assert.doesNotMatch(homeSource, /aiOfficeMode/);
  });

  it('still opens the assistant from the home screen', () => {
    assert.match(homeSource, /onOpenAi/);
    assert.match(appSource, /onOpenAi=\{openAi\}/);
    assert.match(appSource, /setAiMounted\(true\);\s*setAiOpen\(true\)/);
  });

  /**
   * The start centre puts the customer's documents in the middle and what can
   * be done to them at the side, the way a file-first office suite does —
   * rather than a page of panels that has to be scrolled past to reach a file.
   */
  it('leads with documents, with the tools alongside them', () => {
    assert.match(homeSource, /data-home-region="documents"/);
    assert.match(homeSource, /data-home-region="tools"/);
    assert.ok(
      homeSource.indexOf('data-home-region="documents"') < homeSource.indexOf('data-home-region="tools"'),
      'documents come first',
    );
  });

  /**
   * The toolbox is not on the start centre. Every one of those tools is in the
   * ribbon of an open PDF, which is where someone is when they want one — a
   * copy here is a second list to keep in step, and a category to pick before
   * a document exists to apply it to.
   */
  it('does not repeat the toolbox before a document is open', () => {
    assert.doesNotMatch(homeSource, /pdfToolbox/);
    assert.doesNotMatch(homeSource, /selectedCategory/);
    assert.doesNotMatch(homeSource, /railTools/);
  });

  /** Creating something is one button, not a grid competing with the files. */
  it('puts creating a document behind one control', () => {
    assert.match(homeSource, /createOpen/);
  });
});

describe('the title bar', () => {
  /**
   * The mark belongs where the app is named, which is the title bar. The start
   * centre used to name the app again above the customer's files — a second
   * title on a page whose subject is their documents, not the product.
   */
  it('carries the mark beside the name', () => {
    assert.match(appSource, /logo\.png/);
    assert.doesNotMatch(homeSource, /logo\.png/);
    assert.doesNotMatch(homeSource, /officeTagline/);
  });

  /** Jobs were a panel of their own; the work they showed now speaks for itself. */
  it('does not offer a jobs panel', () => {
    assert.doesNotMatch(appSource, /setJobsOpen/);
    assert.doesNotMatch(appSource, /JobPanel/);
  });
});
