'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { DOCUMENT_EXTENSIONS, IMAGE_EXTENSIONS } = require('./formats.cjs');

const MAX_DOCUMENTS = 200;
const MAX_DEPTH = 20;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const WORKSPACE_EXTENSIONS = new Set([...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS]);

function slashPath(candidate) {
  return candidate.split(path.sep).join('/');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function relativeCandidate(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const normalized = path.normalize(value.trim());
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} points outside the granted workspace`);
  }
  return normalized;
}

function safeFileName(value) {
  if (
    typeof value !== 'string'
    || value === ''
    || path.basename(value) !== value
    || value === '.'
    || value === '..'
    || [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error('A safe output file name is required');
  }
  return value;
}

function createOfficeWorkspace({ fileSystem = fs } = {}) {
  let root = '';

  const requireRoot = () => {
    if (!root) throw new Error('Choose a workspace folder before using Office Agent tools');
    return root;
  };

  const setRoot = async (candidate) => {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
      throw new Error('The workspace folder must be an absolute path selected by the user');
    }
    const resolved = await fileSystem.realpath(candidate);
    const stat = await fileSystem.stat(resolved);
    if (!stat.isDirectory()) throw new Error('The selected workspace path is not a directory');
    root = resolved;
    return { configured: true, path: root };
  };

  const clear = () => {
    root = '';
    return { configured: false, path: '' };
  };

  const getStatus = () => ({ configured: root !== '', path: root });

  const resolveInput = async (relativePath) => {
    const workspaceRoot = requireRoot();
    const normalized = relativeCandidate(relativePath, 'Document path');
    const candidate = path.resolve(workspaceRoot, normalized);
    if (!isInside(workspaceRoot, candidate)) {
      throw new Error('Document path points outside the granted workspace');
    }
    const linkStat = await fileSystem.lstat(candidate);
    if (linkStat.isSymbolicLink()) throw new Error('Document path may not be a symbolic link');
    const resolved = await fileSystem.realpath(candidate);
    if (!isInside(workspaceRoot, resolved)) {
      throw new Error('Document path points outside the granted workspace');
    }
    const stat = await fileSystem.stat(resolved);
    if (!stat.isFile()) throw new Error(`Document path is not a file: ${relativePath}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`Document is larger than ${MAX_FILE_BYTES} bytes`);
    if (!WORKSPACE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      throw new Error('Document path is not a supported Office, PDF, or image file');
    }
    return resolved;
  };

  const ensureOutputDirectory = async (relativeDirectory) => {
    const workspaceRoot = requireRoot();
    const normalized = relativeCandidate(relativeDirectory, 'Output directory');
    const target = path.resolve(workspaceRoot, normalized);
    if (!isInside(workspaceRoot, target)) {
      throw new Error('Output directory points outside the granted workspace');
    }

    let current = workspaceRoot;
    for (const segment of path.relative(workspaceRoot, target).split(path.sep)) {
      current = path.join(current, segment);
      try {
        const stat = await fileSystem.lstat(current);
        if (stat.isSymbolicLink()) throw new Error('Output directory may not contain symbolic links');
        if (!stat.isDirectory()) throw new Error('Output directory contains a non-directory path');
      } catch (cause) {
        if (cause?.code !== 'ENOENT') throw cause;
        break;
      }
    }

    await fileSystem.mkdir(target, { recursive: true });
    const resolved = await fileSystem.realpath(target);
    if (!isInside(workspaceRoot, resolved)) {
      throw new Error('Output directory points outside the granted workspace');
    }
    return resolved;
  };

  const uniqueOutputPath = async (relativeDirectory, requestedName) => {
    const directory = await ensureOutputDirectory(relativeDirectory);
    const name = safeFileName(requestedName);
    const extension = path.extname(name);
    const stem = path.basename(name, extension);
    for (let index = 1; ; index += 1) {
      const candidateName = index === 1 ? name : `${stem} (${index})${extension}`;
      const absolutePath = path.join(directory, candidateName);
      try {
        await fileSystem.access(absolutePath);
      } catch (cause) {
        if (cause?.code !== 'ENOENT') throw cause;
        return {
          absolutePath,
          relativePath: slashPath(path.relative(requireRoot(), absolutePath)),
        };
      }
    }
  };

  const listDocuments = async ({ recursive = true, query = '', extensions } = {}) => {
    const workspaceRoot = requireRoot();
    const allowed = Array.isArray(extensions) && extensions.length > 0
      ? new Set(extensions.map((extension) => {
          const normalized = String(extension).toLowerCase();
          return normalized.startsWith('.') ? normalized : `.${normalized}`;
        }).filter((extension) => WORKSPACE_EXTENSIONS.has(extension)))
      : WORKSPACE_EXTENSIONS;
    const needle = String(query || '').trim().toLowerCase();
    const documents = [];
    const pending = [{ directory: workspaceRoot, depth: 0 }];

    while (pending.length > 0 && documents.length <= MAX_DOCUMENTS) {
      const current = pending.pop();
      const entries = await fileSystem.readdir(current.directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolutePath = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          if (recursive && current.depth < MAX_DEPTH) {
            pending.push({ directory: absolutePath, depth: current.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).toLowerCase();
        const relativePath = slashPath(path.relative(workspaceRoot, absolutePath));
        if (!allowed.has(extension) || (needle && !relativePath.toLowerCase().includes(needle))) continue;
        const stat = await fileSystem.stat(absolutePath);
        documents.push({ path: relativePath, extension, size: stat.size });
        if (documents.length > MAX_DOCUMENTS) break;
      }
    }

    const truncated = documents.length > MAX_DOCUMENTS;
    documents.length = Math.min(documents.length, MAX_DOCUMENTS);
    documents.sort((left, right) => left.path.localeCompare(right.path, 'en', { sensitivity: 'base' }));
    return { documents, truncated };
  };

  return {
    clear,
    getStatus,
    listDocuments,
    resolveInput,
    setRoot,
    uniqueOutputPath,
  };
}

module.exports = {
  MAX_DOCUMENTS,
  createOfficeWorkspace,
  isInside,
  relativeCandidate,
};
