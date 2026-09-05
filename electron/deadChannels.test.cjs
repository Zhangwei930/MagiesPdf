'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..');
const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'electron', 'ipc.cjs'), 'utf8');
const rendererFiles = [];
(function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) rendererFiles.push(full);
  }
})(path.join(root, 'src', 'app'));
const rendererSource = rendererFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

/**
 * Every channel the preload exposes is something a compromised renderer can
 * reach. One nobody calls is not merely dead code — it is surface kept open
 * for no one, which is the same argument that made reading a file a capability
 * in issue #31.
 *
 * Seven were found that way, all left over from when Office documents were
 * handed to a separate application: `office:status`, `office:pickExecutable`
 * (superseded by `files:pickExecutable`), `office:openDownloadPage`,
 * `office:pickAndOpen`, `office:createAndOpen`, `office:openPaths`, and
 * `shell:openExternal` — that last one reachable but unused, because a link in
 * an assistant reply goes through the main window's own open handler instead.
 */
describe('the surface the preload exposes', () => {
  /** `name: (…) => ipcRenderer.invoke('channel'…` — what the renderer may call. */
  function exposed() {
    return [...preloadSource.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*\(/gm)].map((m) => m[1]);
  }

  it('exposes nothing the renderer never calls', () => {
    const unused = exposed().filter((name) => {
      const used = new RegExp(`\\b${name}\\s*\\(`).test(rendererSource);
      return !used;
    });
    assert.deepEqual(unused, [], `these are reachable but never called: ${unused.join(', ')}`);
  });

  it('handles no channel the preload cannot reach', () => {
    const handled = [...ipcSource.matchAll(/handle\('([a-zA-Z:]+)'/g)].map((m) => m[1]);
    const invoked = new Set(
      [...preloadSource.matchAll(/invoke\('([a-zA-Z:]+)'/g)].map((m) => m[1]),
    );
    const orphaned = handled.filter((channel) => !invoked.has(channel));
    assert.deepEqual(orphaned, [], `handlers nothing can call: ${orphaned.join(', ')}`);
  });
});
