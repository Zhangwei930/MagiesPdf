'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..');
const ipcSource = fs.readFileSync(path.join(root, 'electron', 'ipc.cjs'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');

describe('external MCP client wiring', () => {
  it('shares one client manager with the Agent and narrow IPC handlers', () => {
    assert.match(ipcSource, /createExternalMcpClientManager/);
    assert.match(ipcSource, /externalToolProvider:\s*externalMcpManager/);
    assert.match(ipcSource, /mcp:externalStatus/);
    assert.match(ipcSource, /mcp:externalSetConfig/);
    assert.match(ipcSource, /mcp:externalRefresh/);
    assert.match(ipcSource, /mcp:externalClearConfig/);
  });

  it('never exposes a getter for the encrypted MCP configuration', () => {
    assert.match(preloadSource, /getExternalMcpStatus/);
    assert.match(preloadSource, /setExternalMcpConfig/);
    assert.doesNotMatch(preloadSource, /getExternalMcpConfig/);
  });

  it('closes spawned MCP clients when the application exits', () => {
    assert.match(mainSource, /ipcServices\?\.close/);
  });
});
