const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..');
const ipcSource = fs.readFileSync(path.join(root, 'electron', 'ipc.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');

describe('AI task history wiring', () => {
  it('exposes only narrow list, append, remove, and clear operations over trusted IPC', () => {
    assert.match(ipcSource, /createAiHistoryStore/);
    assert.match(ipcSource, /ai:historyList/);
    assert.match(ipcSource, /ai:historyAppend/);
    assert.match(ipcSource, /ai:historyRemove/);
    assert.match(ipcSource, /ai:historyClear/);
    assert.match(preloadSource, /getAiHistory/);
    assert.match(preloadSource, /appendAiHistory/);
    assert.match(preloadSource, /removeAiHistoryEntry/);
    assert.match(preloadSource, /clearAiHistory/);
    assert.doesNotMatch(preloadSource, /ai:historyPath|readAiHistoryFile/);
  });
});
