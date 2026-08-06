import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { validateMcpConfigText } from './mcpConfigText.ts';

describe('validateMcpConfigText', () => {
  it('accepts a well-formed configuration and counts its servers', () => {
    const result = validateMcpConfigText(JSON.stringify({
      mcpServers: {
        notion: { url: 'https://example.com/mcp' },
        local: { command: 'npx', args: ['-y', 'server'] },
      },
    }));

    assert.equal(result.state, 'valid');
    assert.equal(result.serverCount, 2);
  });

  it('accepts a bare server map, which is what people usually paste', () => {
    const result = validateMcpConfigText(JSON.stringify({ notion: { url: 'https://x/mcp' } }));
    assert.equal(result.state, 'valid');
    assert.equal(result.serverCount, 1);
  });

  it('says nothing about an empty box', () => {
    assert.equal(validateMcpConfigText('').state, 'empty');
    assert.equal(validateMcpConfigText('   \n ').state, 'empty');
  });

  it('reports the line the JSON breaks on when the parser says', () => {
    const result = validateMcpConfigText('{\n  "mcpServers": {\n    "a" {}\n  }\n}');
    assert.equal(result.state, 'invalid');
    assert.match(result.message.zh, /第 3 行/);
    assert.match(result.message.en, /line 3/);
  });

  it('still reports a syntax error when the parser gives no position', () => {
    // V8 truncates the message for this shape and names no offset.
    const result = validateMcpConfigText('{ "mcpServers": { "a": } }');
    assert.equal(result.state, 'invalid');
    assert.match(result.message.en, /invalid json/i);
  });

  it('catches the smart quotes and ellipsis a copied snippet carries', () => {
    const result = validateMcpConfigText('{ "mcpServers": { "a": { "url": "https://x" … } } }');
    assert.equal(result.state, 'invalid');
    assert.match(result.message.zh, /…|省略号/);
  });

  it('rejects a top-level value that is not an object', () => {
    assert.equal(validateMcpConfigText('[]').state, 'invalid');
    assert.equal(validateMcpConfigText('"text"').state, 'invalid');
  });

  it('rejects a configuration with no servers in it', () => {
    const result = validateMcpConfigText('{ "mcpServers": {} }');
    assert.equal(result.state, 'invalid');
    assert.match(result.message.en, /no server/i);
  });
});
