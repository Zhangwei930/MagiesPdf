const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const config = require('./electron-builder.config.cjs');

describe('desktop package identity', () => {
  it('shows the Magies Office brand without breaking the existing update identity', () => {
    assert.equal(config.productName, 'Magies Office');
    assert.equal(config.appId, 'top.magies.pdf');
    assert.ok(config.artifactName.startsWith('MagiesPdf-'));
    assert.ok(config.dmg.artifactName.startsWith('MagiesPdf-'));
    assert.equal(config.nsis.shortcutName, 'Magies Office');
  });

  it('registers Office documents in Open With as well as PDF', () => {
    const extensions = config.fileAssociations.flatMap((association) => association.ext);
    for (const extension of ['pdf', 'doc', 'docx', 'odt', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp']) {
      assert.ok(extensions.includes(extension), extension);
    }
  });
});
