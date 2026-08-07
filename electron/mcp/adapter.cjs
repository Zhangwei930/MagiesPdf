'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { functionNameForToolId, parameterSchema } = require('../ai/toolCatalog.cjs');

const MAX_FILE_BYTES = 96 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 50;

function isSecretDependent(tool) {
  return (tool.params || []).some((param) => param.type === 'password' && param.required);
}

function buildMcpTools(catalog) {
  return catalog.filter((tool) => !isSecretDependent(tool)).map((tool) => {
    const properties = {};
    const required = [];

    if (tool.input.max !== 0) {
      properties.input_paths = {
        type: 'array',
        items: { type: 'string' },
        minItems: tool.input.min,
        ...(typeof tool.input.max === 'number' ? { maxItems: tool.input.max } : {}),
        description: 'Absolute local file paths to process.',
      };
      if (tool.input.min > 0) required.push('input_paths');
    }
    if (tool.output !== 'report') {
      properties.output_directory = {
        type: 'string',
        description: 'Existing absolute directory where generated files will be written. Existing files are never overwritten.',
      };
      required.push('output_directory');
    }
    for (const param of tool.params || []) {
      if (param.type === 'password') continue;
      properties[param.key] = parameterSchema(param, 'en');
      if (param.required) required.push(param.key);
    }

    return {
      name: functionNameForToolId(tool.id),
      description: `${tool.description.en} Files are processed locally by Magies Office.`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties,
        required,
      },
      toolId: tool.id,
    };
  });
}

function validateApiUrl(apiUrl) {
  let parsed;
  try {
    parsed = new URL(String(apiUrl));
  } catch {
    throw new Error('MAGIES_OFFICE_API_URL must be a valid URL');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new Error('MCP may only send document bytes to the local Magies Office API');
  }
  return parsed.href.replace(/\/+$/, '');
}

function mimeOf(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }[extension] || 'application/octet-stream';
}

function readInputs(tool, inputPaths) {
  const paths = inputPaths === undefined ? [] : inputPaths;
  if (!Array.isArray(paths) || paths.some((filePath) => typeof filePath !== 'string')) {
    throw new Error('input_paths must be an array of absolute paths');
  }
  if (paths.length < tool.input.min || (typeof tool.input.max === 'number' && paths.length > tool.input.max)) {
    throw new Error(`${tool.id} received the wrong number of input paths`);
  }
  if (paths.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files may be processed`);

  let totalBytes = 0;
  return paths.map((filePath) => {
    if (!path.isAbsolute(filePath)) throw new Error(`Input path must be absolute: ${filePath}`);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`Input path is not a file: ${filePath}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`Input file is too large: ${filePath}`);
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Total input size is too large');
    const bytes = fs.readFileSync(filePath);
    return {
      name: path.basename(filePath),
      mime: mimeOf(filePath),
      bytesBase64: bytes.toString('base64'),
    };
  });
}

function outputDirectoryFrom(tool, value) {
  if (tool.output === 'report') return '';
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error('output_directory must be an existing absolute directory');
  }
  const stat = fs.statSync(value);
  if (!stat.isDirectory()) throw new Error('output_directory must be an existing directory');
  return value;
}

function safeOutputName(name) {
  if (typeof name !== 'string' || !name || path.basename(name) !== name || name === '.' || name === '..') {
    throw new Error('Magies Office returned an unsafe output file name');
  }
  return name;
}

function writeWithoutOverwrite(directory, name, bytes) {
  const safeName = safeOutputName(name);
  const extension = path.extname(safeName);
  const stem = path.basename(safeName, extension);
  for (let index = 1; ; index += 1) {
    const candidateName = index === 1 ? safeName : `${stem} (${index})${extension}`;
    const candidate = path.join(directory, candidateName);
    try {
      fs.writeFileSync(candidate, bytes, { flag: 'wx', mode: 0o600 });
      return candidate;
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause;
    }
  }
}

async function callRestTool({ tool, args, apiUrl, token, fetchImpl = fetch }) {
  const localApiUrl = validateApiUrl(apiUrl);
  if (!token) throw new Error('MAGIES_OFFICE_API_TOKEN is required');
  const inputFiles = readInputs(tool, args?.input_paths);
  const outputDirectory = outputDirectoryFrom(tool, args?.output_directory);
  const params = {};
  for (const param of tool.params || []) {
    if (param.type !== 'password' && Object.prototype.hasOwnProperty.call(args || {}, param.key)) {
      params[param.key] = args[param.key];
    }
  }

  const response = await fetchImpl(`${localApiUrl}/tools/${encodeURIComponent(tool.id)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files: inputFiles, params }),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Magies Office API returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(payload.message || `Magies Office API failed with HTTP ${response.status}`);
  }

  const written = [];
  if (outputDirectory) {
    for (const file of payload.files || []) {
      if (typeof file.bytesBase64 !== 'string') throw new Error('Magies Office API omitted output bytes');
      written.push(writeWithoutOverwrite(
        outputDirectory,
        file.name,
        Buffer.from(file.bytesBase64, 'base64'),
      ));
    }
  }
  return {
    toolId: tool.id,
    written,
    data: payload.data,
    summary: payload.summary,
  };
}

/**
 * Office automation tools already carry OpenAI-style JSON Schema parameters.
 * Expose them on MCP under their function names (office_excel_write, …).
 * Interactive-only tools (document macros) stay out of MCP discovery.
 */
function buildOfficeMcpTools(officeTools) {
  return (Array.isArray(officeTools) ? officeTools : [])
    .filter((tool) => tool && tool.unattended !== false && tool.functionName)
    .map((tool) => ({
      name: String(tool.functionName),
      description: String(tool.description || tool.functionName),
      inputSchema: tool.parameters && typeof tool.parameters === 'object'
        ? tool.parameters
        : { type: 'object', properties: {} },
      toolId: String(tool.toolId || tool.functionName),
      kind: 'office',
      functionName: String(tool.functionName),
    }));
}

async function callRestOfficeTool({ functionName, args, apiUrl, token, fetchImpl = fetch }) {
  const localApiUrl = validateApiUrl(apiUrl);
  if (!token) throw new Error('MAGIES_OFFICE_API_TOKEN is required');
  const name = String(functionName || '');
  if (!name) throw new Error('Office tool name is required');

  const response = await fetchImpl(`${localApiUrl}/office/tools/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args && typeof args === 'object' ? args : {}),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Magies Office API returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(payload.message || `Magies Office automation failed with HTTP ${response.status}`);
  }
  return payload.result !== undefined ? payload.result : payload;
}

module.exports = {
  buildMcpTools,
  buildOfficeMcpTools,
  callRestOfficeTool,
  callRestTool,
  isSecretDependent,
  readInputs,
  validateApiUrl,
  writeWithoutOverwrite,
};
