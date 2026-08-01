'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const builderConfig = require('../../electron-builder.config.cjs');

describe('MCP packaging', () => {
  it('unpacks the stdio server and every runtime dependency loaded by the SDK', () => {
    const unpacked = new Set(builderConfig.asarUnpack);
    for (const pattern of [
      'electron/mcp/**/*',
      'node_modules/@modelcontextprotocol/sdk/**/*',
      'node_modules/ajv/**/*',
      'node_modules/ajv-formats/**/*',
      'node_modules/fast-deep-equal/**/*',
      'node_modules/fast-uri/**/*',
      'node_modules/json-schema-traverse/**/*',
      'node_modules/zod/**/*',
      'node_modules/zod-to-json-schema/**/*',
    ]) {
      assert.ok(unpacked.has(pattern), `${pattern} must be available to ELECTRON_RUN_AS_NODE`);
    }
  });
});
