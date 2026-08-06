'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createSecretStore({ filePath, safeStorage }) {
  const requireEncryption = () => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS encryption is unavailable; the API key was not stored');
    }
  };

  const readSecrets = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (cause) {
      if (cause?.code === 'ENOENT') return {};
      throw cause;
    }
  };

  const writeSecrets = (secrets) => {
    const hasValues = Object.entries(secrets)
      .some(([key, value]) => key !== 'version' && typeof value === 'string' && value !== '');
    if (!hasValues) {
      try {
        fs.unlinkSync(filePath);
      } catch (cause) {
        if (cause?.code !== 'ENOENT') throw cause;
      }
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ ...secrets, version: 1 }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.chmodSync(filePath, 0o600);
  };

  const hasSecret = (key) => {
    const value = readSecrets()[key];
    return typeof value === 'string' && value !== '';
  };

  const getSecret = (key) => {
    const encrypted = readSecrets()[key];
    if (typeof encrypted !== 'string' || !encrypted) return '';
    requireEncryption();
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  };

  const setSecret = (key, value) => {
    const secret = String(value || '');
    const secrets = readSecrets();
    if (!secret) {
      delete secrets[key];
      writeSecrets(secrets);
      return;
    }
    requireEncryption();
    secrets[key] = safeStorage.encryptString(secret).toString('base64');
    writeSecrets(secrets);
  };

  return {
    /**
     * Per-provider access. The key name comes from `secretKeyForProvider`, so
     * the provider that predates the provider list still resolves to `apiKey`.
     */
    hasSecret(key) {
      return key ? hasSecret(key) : false;
    },

    getSecret(key) {
      return key ? getSecret(key) : '';
    },

    setSecret(key, value) {
      if (key) setSecret(key, value);
    },

    hasApiKey() {
      return hasSecret('apiKey');
    },

    getApiKey() {
      return getSecret('apiKey');
    },

    setApiKey(value) {
      setSecret('apiKey', value);
    },

    hasWebSearchKey() {
      return hasSecret('webSearch');
    },

    getWebSearchKey() {
      return getSecret('webSearch');
    },

    setWebSearchKey(value) {
      setSecret('webSearch', value);
    },

    hasImageSearchKey() {
      return hasSecret('imageSearch');
    },

    getImageSearchKey() {
      return getSecret('imageSearch');
    },

    setImageSearchKey(value) {
      setSecret('imageSearch', value);
    },

    hasMcpConfig() {
      return hasSecret('mcpConfig');
    },

    getMcpConfig() {
      return getSecret('mcpConfig');
    },

    setMcpConfig(value) {
      setSecret('mcpConfig', value);
    },
  };
}

let defaultStore;

function getSecretStore() {
  if (!defaultStore) {
    const { app, safeStorage } = require('electron');
    defaultStore = createSecretStore({
      filePath: path.join(app.getPath('userData'), 'ai-secrets.json'),
      safeStorage,
    });
  }
  return defaultStore;
}

module.exports = { createSecretStore, getSecretStore };
