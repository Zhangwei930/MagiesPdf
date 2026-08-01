const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { buildMcpClientConfig } = require('./config.cjs');

describe('MCP client configuration', () => {
  it('builds an Electron-as-Node stdio server entry for the running local API', () => {
    const result = buildMcpClientConfig({
      execPath: '/Applications/Magies Office.app/Contents/MacOS/Magies Office',
      serverPath: '/Applications/Magies Office.app/Contents/Resources/app.asar.unpacked/electron/mcp/magies-office-mcp-server.cjs',
      apiStatus: { running: true, address: 'http://127.0.0.1:8737' },
      token: 'secret-token',
    });

    assert.equal(result.ready, true);
    assert.deepEqual(result.config.mcpServers['magies-office'], {
      command: '/Applications/Magies Office.app/Contents/MacOS/Magies Office',
      args: ['/Applications/Magies Office.app/Contents/Resources/app.asar.unpacked/electron/mcp/magies-office-mcp-server.cjs'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        MAGIES_OFFICE_API_URL: 'http://127.0.0.1:8737/v1',
        MAGIES_OFFICE_API_TOKEN: 'secret-token',
      },
    });
  });

  it('reports why setup is not ready', () => {
    const result = buildMcpClientConfig({
      execPath: '/electron',
      serverPath: '/server.cjs',
      apiStatus: { running: false, address: '' },
      token: '',
    });
    assert.equal(result.ready, false);
    assert.match(result.reason, /API|token/i);
  });
});
