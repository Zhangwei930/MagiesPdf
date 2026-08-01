'use strict';

const TOOL_NAME_SEPARATOR = '__';

function functionNameForToolId(toolId) {
  return String(toolId).replace('.', TOOL_NAME_SEPARATOR);
}

function toolIdForFunctionName(name) {
  if (typeof name !== 'string' || name.includes('.')) return null;
  const parts = name.split(TOOL_NAME_SEPARATOR);
  if (parts.length !== 2 || parts.some((part) => !part)) return null;
  return `${parts[0]}.${parts[1]}`;
}

function localized(value, locale) {
  if (!value || typeof value !== 'object') return '';
  return String(value[locale] || value.en || value.zh || '');
}

function parameterSchema(param, locale) {
  const description = [localized(param.label, locale), localized(param.help, locale)]
    .filter(Boolean)
    .join(' — ');
  let schema;

  switch (param.type) {
    case 'number':
      schema = { type: param.integer ? 'integer' : 'number', description };
      if (typeof param.min === 'number') schema.minimum = param.min;
      if (typeof param.max === 'number') schema.maximum = param.max;
      break;
    case 'boolean':
      schema = { type: 'boolean', description };
      break;
    case 'select':
      schema = {
        type: 'string',
        description,
        enum: (param.options || []).map((option) => option.value),
      };
      break;
    case 'multiselect':
      schema = {
        type: 'array',
        description,
        items: {
          type: 'string',
          enum: (param.options || []).map((option) => option.value),
        },
      };
      if (typeof param.minSelected === 'number') schema.minItems = param.minSelected;
      break;
    default:
      schema = { type: 'string', description };
      if (typeof param.maxLength === 'number') schema.maxLength = param.maxLength;
      break;
  }

  if (param.default !== undefined) schema.default = param.default;
  return schema;
}

function buildInputFileSchema(input) {
  const schema = {
    type: 'array',
    items: { type: 'string' },
    minItems: input.min,
    description: 'Workspace file IDs to process. Available IDs are listed in the system context.',
  };
  if (typeof input.max === 'number') schema.maxItems = input.max;
  return schema;
}

function buildAgentTools(catalog, locale = 'en') {
  return catalog.map((tool) => {
    const properties = {};
    const required = [];

    if (tool.input.max !== 0) {
      properties.input_file_ids = buildInputFileSchema(tool.input);
      if (tool.input.min > 0) required.push('input_file_ids');
    }

    for (const param of tool.params || []) {
      // Passwords are local execution context. Sending them through a model
      // tool call would disclose a document or certificate secret.
      if (param.type === 'password') continue;
      properties[param.key] = parameterSchema(param, locale);
      if (param.required) required.push(param.key);
    }

    const accepts = (tool.input.accept || []).join(', ');
    const description = [
      localized(tool.description, locale),
      accepts ? `Accepted inputs: ${accepts}.` : 'No input file required.',
      `Output: ${tool.output}.`,
    ].join(' ');

    return {
      type: 'function',
      function: {
        name: functionNameForToolId(tool.id),
        description,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties,
          required,
        },
      },
    };
  });
}

module.exports = {
  buildAgentTools,
  functionNameForToolId,
  parameterSchema,
  toolIdForFunctionName,
};
