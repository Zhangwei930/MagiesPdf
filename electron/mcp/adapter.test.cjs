const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');

const {
  buildMcpTools,
  callRestTool,
} = require('./adapter.cjs');

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const transformTool = {
  id: 'edit.compress',
  category: 'edit',
  name: { zh: '压缩', en: 'Compress' },
  description: { zh: '压缩 PDF', en: 'Compress a PDF' },
  input: { accept: ['.pdf'], min: 1, max: 1 },
  output: 'single',
  runtime: 'worker',
  params: [
    {
      key: 'level',
      type: 'select',
      label: { zh: '级别', en: 'Level' },
      default: 'balanced',
      options: [{ value: 'balanced', label: { zh: '均衡', en: 'Balanced' } }],
    },
    { key: 'password', type: 'password', label: { zh: '密码', en: 'Password' }, default: '' },
  ],
};

describe('MCP tool adapter', () => {
  it('maps the shared catalogue to path-based MCP tools', () => {
    const [tool] = buildMcpTools([transformTool]);
    assert.equal(tool.name, 'edit__compress');
    assert.deepEqual(tool.inputSchema.required, ['input_paths', 'output_directory']);
    assert.deepEqual(tool.inputSchema.properties.input_paths, {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 1,
      description: 'Absolute local file paths to process.',
    });
    assert.equal(tool.inputSchema.properties.level.enum[0], 'balanced');
    assert.equal('password' in tool.inputSchema.properties, false);
  });

  it('omits tools whose required operation depends on a secret', () => {
    const tools = buildMcpTools([
      transformTool,
      {
        ...transformTool,
        id: 'security.add-password',
        params: [{
          key: 'userPassword',
          type: 'password',
          label: { zh: '密码', en: 'Password' },
          default: '',
          required: true,
        }],
      },
    ]);
    assert.deepEqual(tools.map((tool) => tool.name), ['edit__compress']);
  });

  it('reads explicit inputs, calls the local API, and writes without overwriting', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magies-office-mcp-'));
    temporaryDirectories.push(directory);
    const inputPath = path.join(directory, 'source.pdf');
    const outputDirectory = path.join(directory, 'output');
    fs.writeFileSync(inputPath, Buffer.from([1, 2, 3]));
    fs.mkdirSync(outputDirectory);
    fs.writeFileSync(path.join(outputDirectory, 'source-compressed.pdf'), 'existing');
    let requestBody;

    const result = await callRestTool({
      tool: transformTool,
      args: {
        input_paths: [inputPath],
        output_directory: outputDirectory,
        level: 'balanced',
      },
      apiUrl: 'http://127.0.0.1:8737/v1',
      token: 'token',
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return new globalThis.Response(JSON.stringify({
          files: [{
            name: 'source-compressed.pdf',
            mime: 'application/pdf',
            bytesBase64: Buffer.from([4, 5, 6]).toString('base64'),
          }],
          summary: { zh: '完成', en: 'Done' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    assert.equal(requestBody.files[0].bytesBase64, 'AQID');
    assert.deepEqual(requestBody.params, { level: 'balanced' });
    assert.equal(fs.readFileSync(path.join(outputDirectory, 'source-compressed (2).pdf')).toString('hex'), '040506');
    assert.deepEqual(result.written, [path.join(outputDirectory, 'source-compressed (2).pdf')]);
  });

  it('rejects relative paths and missing output directories before calling the API', async () => {
    await assert.rejects(
      callRestTool({
        tool: transformTool,
        args: { input_paths: ['relative.pdf'], output_directory: '/missing' },
        apiUrl: 'http://127.0.0.1:8737/v1',
        token: 'token',
        fetchImpl: async () => { throw new Error('must not fetch'); },
      }),
      /absolute/i,
    );
  });
});
