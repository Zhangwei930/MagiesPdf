const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { cacheControlFor } = require('./editorRuntime.cjs');

describe('editor HTTP cache', () => {
  it('never caches session pages or document bytes', () => {
    assert.equal(cacheControlFor('/editor/abc'), 'no-store');
    assert.equal(cacheControlFor('/session/abc/Editor.bin'), 'no-store');
    assert.equal(cacheControlFor('/media/image1.png'), 'no-store');
    assert.equal(cacheControlFor('/editors/downloadas/abc'), 'no-store');
    assert.equal(cacheControlFor('/editors/web-apps/vendor/socketio/socket.io.min.js'), 'no-store');
  });

  it('caches engine scripts and fonts for the life of the app', () => {
    assert.match(cacheControlFor('/editors/sdkjs/word/sdk-all-min.js'), /max-age=/);
    assert.match(cacheControlFor('/editors/sdkjs/common/AllFonts.js'), /immutable/);
    assert.match(cacheControlFor('/editors/web-apps/apps/documenteditor/main/code.js'), /max-age=/);
  });
});
