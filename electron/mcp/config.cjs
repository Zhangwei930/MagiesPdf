'use strict';

function buildMcpClientConfig({ execPath, serverPath, apiStatus, token }) {
  const ready = Boolean(apiStatus?.running && apiStatus.address && token);
  const reason = ready
    ? ''
    : 'Enable the local API and generate an access token before using MCP.';
  const apiUrl = apiStatus?.address ? `${apiStatus.address.replace(/\/+$/, '')}/v1` : '';
  return {
    ready,
    reason,
    config: {
      mcpServers: {
        'magies-office': {
          command: execPath,
          args: [serverPath],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            MAGIES_OFFICE_API_URL: apiUrl,
            MAGIES_OFFICE_API_TOKEN: token || '',
          },
        },
      },
    },
  };
}

module.exports = { buildMcpClientConfig };
