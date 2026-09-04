'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const fs = require('node:fs');
const path = require('node:path');

const builderConfig = require('../../electron-builder.config.cjs');
const ipcSource = fs.readFileSync(path.join(__dirname, '..', 'ipc.cjs'), 'utf8');

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

  /**
   * The server entry reaches outside its own directory — `serverFactory.cjs`
   * requires `../ai/toolCatalog.cjs`, and the version comes from
   * `../../package.json`. Neither is unpacked, and unpacking the whole of
   * `electron/ai` to fix that would drag most of the app out of the archive.
   *
   * So the path handed to a CLI has to stay inside the asar, which Electron
   * reads transparently under ELECTRON_RUN_AS_NODE. Rewriting it to the
   * unpacked copy produced a server that died at require time:
   *
   *     Error: Cannot find module '../ai/toolCatalog.cjs'
   *
   * — which meant every packaged install wrote a broken MCP entry into every
   * CLI it was added to, and the failure surfaced far away, as an agent that
   * could not reach any Magies tool.
   */
  it('hands the CLI a path inside the asar, not the unpacked copy', () => {
    assert.doesNotMatch(ipcSource, /asar\.unpacked/);
  });

  it('is right to, because the entry requires things that are not unpacked', () => {
    const unpacked = new Set(builderConfig.asarUnpack);
    const mcpDir = path.join(__dirname);
    const outside = new Set();
    for (const file of fs.readdirSync(mcpDir)) {
      if (!file.endsWith('.cjs') || file.includes('.test.')) continue;
      const source = fs.readFileSync(path.join(mcpDir, file), 'utf8');
      for (const [, target] of source.matchAll(/require\('(\.\.\/[^']+)'\)/g)) {
        outside.add(target);
      }
    }

    assert.ok(outside.size > 0, 'the entry does reach outside electron/mcp');
    for (const target of outside) {
      // Everything it reaches for lives under electron/ or the project root,
      // and none of those are in asarUnpack. If that ever changes, the
      // rewrite above could be reconsidered — deliberately, not by accident.
      const covered = [...unpacked].some((pattern) => (
        pattern.startsWith('electron/ai') || pattern === 'package.json'
      ));
      assert.equal(covered, false, `${target} is unexpectedly unpacked`);
    }
  });
});
