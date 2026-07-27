const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  PRINT_WEB_PREFERENCES,
  isSafePrintRequest,
  safeTemporaryName,
} = require('./host.cjs');

describe('host boundary helpers', () => {
  it('accepts a plain file name for the external converter', () => {
    assert.equal(safeTemporaryName('report.docx'), 'report.docx');
  });

  it('rejects names that can escape the converter temporary directory', () => {
    for (const name of ['../report.docx', 'nested/report.docx', '/tmp/report.docx', '', '.', '..']) {
      assert.throws(() => safeTemporaryName(name), /safe file name/i, name);
    }
  });

  it('runs print windows without JavaScript or Node privileges', () => {
    assert.equal(PRINT_WEB_PREFERENCES.javascript, false);
    assert.equal(PRINT_WEB_PREFERENCES.nodeIntegration, false);
    assert.equal(PRINT_WEB_PREFERENCES.contextIsolation, true);
    assert.equal(PRINT_WEB_PREFERENCES.sandbox, true);
  });

  it('allows inline print resources but blocks filesystem and network requests', () => {
    assert.equal(isSafePrintRequest('data:text/html,hello'), true);
    assert.equal(isSafePrintRequest('blob:null/id'), true);
    assert.equal(isSafePrintRequest('https://example.com/pixel'), false);
    assert.equal(isSafePrintRequest('http://127.0.0.1:8737/v1/health'), false);
    assert.equal(isSafePrintRequest('file:///etc/passwd'), false);
    assert.equal(isSafePrintRequest('ws://127.0.0.1/socket'), false);
  });
});
