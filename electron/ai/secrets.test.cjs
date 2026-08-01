const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');

const { createSecretStore } = require('./secrets.cjs');

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('AI secret store', () => {
  it('persists only encrypted API key bytes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magies-office-ai-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'ai-secrets.json');
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: (value) => value.toString().replace(/^encrypted:/, ''),
    };
    const store = createSecretStore({ filePath, safeStorage });

    store.setApiKey('super-secret-key');

    const persisted = fs.readFileSync(filePath, 'utf8');
    assert.equal(persisted.includes('super-secret-key'), false);
    assert.equal(store.hasApiKey(), true);
    assert.equal(store.getApiKey(), 'super-secret-key');
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  });

  it('fails loudly when OS encryption is unavailable', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magies-office-ai-'));
    temporaryDirectories.push(directory);
    const store = createSecretStore({
      filePath: path.join(directory, 'ai-secrets.json'),
      safeStorage: { isEncryptionAvailable: () => false },
    });

    assert.throws(() => store.setApiKey('secret'), /encryption is unavailable/i);
  });

  it('clears a configured API key', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magies-office-ai-'));
    temporaryDirectories.push(directory);
    const store = createSecretStore({
      filePath: path.join(directory, 'ai-secrets.json'),
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString(),
      },
    });
    store.setApiKey('secret');
    store.setApiKey('');
    assert.equal(store.hasApiKey(), false);
    assert.equal(store.getApiKey(), '');
  });

  it('encrypts external MCP configuration and preserves it when the API key is cleared', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magies-office-ai-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'ai-secrets.json');
    const store = createSecretStore({
      filePath,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`encrypted:${value}`),
        decryptString: (value) => value.toString().replace(/^encrypted:/, ''),
      },
    });

    const config = '{"mcpServers":{"notion":{"headers":{"Authorization":"Bearer token"}}}}';
    store.setApiKey('model-key');
    store.setMcpConfig(config);
    store.setApiKey('');

    assert.equal(store.hasApiKey(), false);
    assert.equal(store.hasMcpConfig(), true);
    assert.equal(store.getMcpConfig(), config);
    assert.equal(fs.readFileSync(filePath, 'utf8').includes('Bearer token'), false);

    store.setMcpConfig('');
    assert.equal(store.hasMcpConfig(), false);
  });
});
