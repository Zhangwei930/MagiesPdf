'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..');
const builderSource = fs.readFileSync(path.join(root, 'electron-builder.config.cjs'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'electron', 'ipc.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');

describe('Office Agent wiring', () => {
  it('shares one local Office provider with the Agent and folder-grant IPC handlers', () => {
    assert.match(ipcSource, /createOfficeAutomationProvider/);
    assert.match(ipcSource, /officeToolProvider:\s*officeAutomation/);
    assert.match(ipcSource, /ai:workspaceStatus/);
    assert.match(ipcSource, /ai:pickWorkspace/);
    assert.match(ipcSource, /ai:clearWorkspace/);
    assert.match(ipcSource, /properties:\s*\['openDirectory'\]/);
  });

  it('exposes only status, explicit folder selection, and clear actions to the renderer', () => {
    assert.match(preloadSource, /getAiWorkspaceStatus/);
    assert.match(preloadSource, /pickAiWorkspace/);
    assert.match(preloadSource, /clearAiWorkspace/);
    assert.doesNotMatch(preloadSource, /setAiWorkspaceRoot/);
  });

  it('ships the fixed-operation Python bridge outside the asar archive', () => {
    assert.match(builderSource, /electron\/office\/uno_worker\.py/);
  });
});
