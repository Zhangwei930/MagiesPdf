import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { LIBREOFFICE_VERSION, officeRuntimeExecutable } from './officeRuntime.mjs';
import { copyTree, isPrepared } from './prepare-office-runtime.mjs';

/**
 * The runtime is copied out of a mounted disk image, or out of a directory the
 * installer was unpacked into, and the source is gone a moment later. A copy
 * that rewrites each relative link as an absolute path into the source leaves
 * every link dangling then — and inside a macOS framework that breaks the code
 * signature, so the system kills LibreOffice's python the moment it starts.
 */
describe('copying the runtime out of where it was unpacked', {
  skip: process.platform === 'win32' ? 'creating symlinks needs privileges on Windows' : false,
}, () => {
  it('keeps relative links relative, so they survive the source going away', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'magies-copy-'));
    try {
      // The shape of every framework in LibreOffice.app.
      const source = path.join(root, 'mount', 'Python.framework');
      await mkdir(path.join(source, 'Versions', '3.12', 'Resources'), { recursive: true });
      await writeFile(path.join(source, 'Versions', '3.12', 'Resources', 'Info.plist'), 'plist');
      await symlink('3.12', path.join(source, 'Versions', 'Current'));
      await symlink(path.join('Versions', 'Current', 'Resources'), path.join(source, 'Resources'));

      const target = path.join(root, 'staged', 'Python.framework');
      await copyTree(source, target);
      await rm(path.join(root, 'mount'), { recursive: true, force: true });

      assert.equal(await readlink(path.join(target, 'Versions', 'Current')), '3.12');
      assert.equal(await readlink(path.join(target, 'Resources')), path.join('Versions', 'Current', 'Resources'));
      assert.equal(await readFile(path.join(target, 'Resources', 'Info.plist'), 'utf8'), 'plist');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Re-running the script is how a broken or outdated runtime gets replaced, so
 * it must not take one for finished just because the executable is there.
 */
describe('telling a prepared runtime from one that only looks it', {
  skip: process.platform === 'win32' ? 'creating symlinks needs privileges on Windows' : false,
}, () => {
  async function runtime({ version = LIBREOFFICE_VERSION, manifest = true } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'magies-runtime-'));
    const executable = officeRuntimeExecutable(root, process.platform);
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, '#!/bin/sh\n');
    if (manifest) await writeFile(path.join(root, 'runtime.json'), JSON.stringify({ version }));
    return root;
  }

  it('accepts an intact runtime of this version', async () => {
    const root = await runtime();
    try {
      // A link that resolves is part of an intact runtime, not a sign of a broken one.
      await symlink(path.relative(root, officeRuntimeExecutable(root, process.platform)), path.join(root, 'link'));
      assert.equal(await isPrepared(root, process.platform), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redoes one with a link that points at nothing', async () => {
    const root = await runtime();
    try {
      await mkdir(path.join(root, 'Python.framework'));
      await symlink('/gone/mount/Python.framework/Versions/3.12', path.join(root, 'Python.framework', 'Current'));
      assert.equal(await isPrepared(root, process.platform), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redoes one prepared for another version, rather than relabelling it', async () => {
    const root = await runtime({ version: '0.0.1' });
    try {
      assert.equal(await isPrepared(root, process.platform), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redoes one that does not say which version it is', async () => {
    const root = await runtime({ manifest: false });
    try {
      assert.equal(await isPrepared(root, process.platform), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
