const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildAgentTools,
  functionNameForToolId,
  toolIdForFunctionName,
} = require('./toolCatalog.cjs');

const sampleTool = {
  id: 'security.add-watermark',
  category: 'security',
  name: { zh: '添加水印', en: 'Add watermark' },
  description: { zh: '添加文字水印', en: 'Add a text watermark' },
  input: { accept: ['.pdf'], min: 1, max: 1 },
  output: 'single',
  runtime: 'worker',
  params: [
    {
      key: 'text',
      type: 'text',
      label: { zh: '文字', en: 'Text' },
      default: 'CONFIDENTIAL',
      required: true,
      maxLength: 100,
    },
    {
      key: 'opacity',
      type: 'number',
      label: { zh: '透明度', en: 'Opacity' },
      default: 0.2,
      min: 0.05,
      max: 1,
    },
    {
      key: 'password',
      type: 'password',
      label: { zh: '文档密码', en: 'Document password' },
      default: '',
    },
  ],
};

describe('AI tool catalogue', () => {
  it('maps dotted tool ids to provider-safe names reversibly', () => {
    assert.equal(functionNameForToolId('security.add-watermark'), 'security__add-watermark');
    assert.equal(toolIdForFunctionName('security__add-watermark'), 'security.add-watermark');
    assert.equal(toolIdForFunctionName('invalid.name'), null);
  });

  it('builds JSON-schema tools without exposing password fields', () => {
    const [tool] = buildAgentTools([sampleTool], 'zh');

    assert.equal(tool.type, 'function');
    assert.equal(tool.function.name, 'security__add-watermark');
    assert.match(tool.function.description, /添加文字水印/);
    assert.deepEqual(tool.function.parameters.required, ['input_file_ids', 'text']);
    assert.deepEqual(tool.function.parameters.properties.input_file_ids, {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 1,
      description: 'Workspace file IDs to process. Available IDs are listed in the system context.',
    });
    assert.deepEqual(tool.function.parameters.properties.opacity, {
      type: 'number',
      description: '透明度',
      minimum: 0.05,
      maximum: 1,
      default: 0.2,
    });
    assert.equal('password' in tool.function.parameters.properties, false);
  });

  it('does not require inputs for document creation tools', () => {
    const [tool] = buildAgentTools([
      {
        ...sampleTool,
        id: 'edit.create-blank',
        category: 'edit',
        input: { accept: [], min: 0, max: 0 },
        params: [],
      },
    ], 'en');

    assert.equal('input_file_ids' in tool.function.parameters.properties, false);
    assert.deepEqual(tool.function.parameters.required, []);
  });
});
