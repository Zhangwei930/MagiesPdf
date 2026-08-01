import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertExecutableArchitecture,
  executableMachine,
  expectedMachine,
  hostCanRunTarget,
} from './verify-office-package.mjs';

function machO(machine) {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(machine, 4);
  return bytes;
}

function portableExecutable(machine) {
  const bytes = Buffer.alloc(72);
  bytes.write('MZ', 0);
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write('PE\0\0', 64);
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}

function elf(machine) {
  const bytes = Buffer.alloc(20);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

describe('packaged Office executable verification', () => {
  it('reads macOS, Windows and Linux architecture headers', () => {
    assert.equal(executableMachine(machO(0x01000007), 'darwin'), 0x01000007);
    assert.equal(executableMachine(portableExecutable(0xaa64), 'win32'), 0xaa64);
    assert.equal(executableMachine(elf(62), 'linux'), 62);
  });

  it('rejects an Office runtime for the wrong package architecture', () => {
    assert.throws(
      () => assertExecutableArchitecture(machO(0x01000007), 'darwin', 'arm64'),
      /expected arm64/i,
    );
    assert.doesNotThrow(
      () => assertExecutableArchitecture(portableExecutable(0x8664), 'win32', 'x64'),
    );
  });

  it('declares the supported target machines and runs smoke tests only natively', () => {
    assert.equal(expectedMachine('darwin', 'arm64'), 0x0100000c);
    assert.equal(expectedMachine('win32', 'x64'), 0x8664);
    assert.equal(expectedMachine('linux', 'x64'), 62);
    assert.equal(hostCanRunTarget('darwin', 'x64', 'darwin', 'x64'), true);
    assert.equal(hostCanRunTarget('darwin', 'arm64', 'darwin', 'x64'), false);
  });
});
