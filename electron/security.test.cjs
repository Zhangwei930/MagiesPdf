const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  MAIN_WINDOW_WEB_PREFERENCES,
  constantTimeTokenEqual,
  isExternalUrlAllowed,
  isTrustedIpcSender,
  isTrustedRendererUrl,
  safeFileName,
} = require('./security.cjs');

describe('Electron security boundary', () => {
  it('keeps the main renderer sandboxed', () => {
    assert.equal(MAIN_WINDOW_WEB_PREFERENCES.sandbox, true);
    assert.equal(MAIN_WINDOW_WEB_PREFERENCES.contextIsolation, true);
    assert.equal(MAIN_WINDOW_WEB_PREFERENCES.nodeIntegration, false);
  });

  it('accepts only the configured renderer origin in development', () => {
    const expected = 'http://localhost:5273/';
    assert.equal(isTrustedRendererUrl('http://localhost:5273/#/tool', expected), true);
    assert.equal(isTrustedRendererUrl('http://localhost:5273.evil.test/', expected), false);
    assert.equal(isTrustedRendererUrl('http://localhost:5274/', expected), false);
    assert.equal(isTrustedRendererUrl('https://localhost:5273/', expected), false);
  });

  it('accepts only the packaged index file in production', () => {
    const index = pathToFileURL(path.join('/opt', 'MagiesPdf', 'dist', 'index.html')).href;
    assert.equal(isTrustedRendererUrl(`${index}#/home`, index), true);
    assert.equal(isTrustedRendererUrl('file:///opt/MagiesPdf/dist/other.html', index), false);
    assert.equal(isTrustedRendererUrl('https://example.com/', index), false);
  });

  it('accepts plain output names and rejects traversal or nested paths', () => {
    assert.equal(safeFileName('result.pdf'), 'result.pdf');
    for (const name of ['../result.pdf', 'nested/result.pdf', String.raw`nested\result.pdf`, '/tmp/x']) {
      assert.throws(() => safeFileName(name), /safe file name/i);
    }
  });

  it('compares equal bearer tokens without accepting length or content differences', () => {
    assert.equal(constantTimeTokenEqual('secret-token', 'secret-token'), true);
    assert.equal(constantTimeTokenEqual('secret-token', 'secret-tokeN'), false);
    assert.equal(constantTimeTokenEqual('secret-token', 'short'), false);
    assert.equal(constantTimeTokenEqual('', ''), false);
  });

  it('hands the desktop only the schemes a browser would have opened', () => {
    assert.equal(isExternalUrlAllowed('https://example.com/docs'), true);
    assert.equal(isExternalUrlAllowed('http://example.com/docs'), true);
    assert.equal(isExternalUrlAllowed('mailto:someone@example.com'), true);
  });

  it('refuses schemes that would make openExternal a way to launch things', () => {
    for (const url of [
      'file:///etc/passwd',
      'file:///C:/Windows/System32/calc.exe',
      'smb://attacker.example/share',
      'ms-msdt:/id',
      'javascript:steal()',
      'data:text/html,<script>steal()</script>',
      'vscode://file/etc/passwd',
      '',
      'not a url',
    ]) {
      assert.equal(isExternalUrlAllowed(url), false, url);
    }
  });

  it('refuses anything that is not a string', () => {
    for (const value of [undefined, null, 42, {}, ['https://example.com']]) {
      assert.equal(isExternalUrlAllowed(value), false);
    }
  });

  it('accepts IPC only from the active trusted renderer frame', () => {
    const webContents = { id: 7, isDestroyed: () => false, getURL: () => 'http://localhost:5273/' };
    const window = { isDestroyed: () => false, webContents };
    const expected = 'http://localhost:5273/';

    assert.equal(
      isTrustedIpcSender(
        { sender: webContents, senderFrame: { url: 'http://localhost:5273/#/home' } },
        window,
        expected,
      ),
      true,
    );
    assert.equal(
      isTrustedIpcSender(
        { sender: { ...webContents, id: 8 }, senderFrame: { url: 'http://localhost:5273/' } },
        window,
        expected,
      ),
      false,
    );
    assert.equal(
      isTrustedIpcSender(
        { sender: webContents, senderFrame: { url: 'https://attacker.example/' } },
        window,
        expected,
      ),
      false,
    );
  });
});
