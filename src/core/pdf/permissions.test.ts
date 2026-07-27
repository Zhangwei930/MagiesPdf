import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALL_PERMISSIONS,
  PERMISSION_KEYS,
  permissionsToBitfield,
  bitfieldToPermissions,
} from './permissions.ts';

describe('permissionsToBitfield', () => {
  it('grants everything when nothing is denied', () => {
    assert.equal(permissionsToBitfield([]), ALL_PERMISSIONS);
  });

  it('clears bit 3 when printing is denied', () => {
    const bits = permissionsToBitfield(['print']);
    assert.equal(bits & 0b100, 0);
    // Untouched permissions stay granted.
    assert.notEqual(bits & 0b10000, 0);
  });

  it('clears both print bits so high-res printing cannot be used as a bypass', () => {
    const bits = permissionsToBitfield(['print']);
    assert.equal(bits & 4, 0);
    assert.equal(bits & 2048, 0);
  });

  it('clears several permissions at once', () => {
    const bits = permissionsToBitfield(['copy', 'modify']);
    assert.equal(bits & 16, 0);
    assert.equal(bits & 8, 0);
    assert.notEqual(bits & 4, 0);
  });

  it('ignores a permission listed twice', () => {
    assert.equal(permissionsToBitfield(['copy', 'copy']), permissionsToBitfield(['copy']));
  });
});

describe('bitfieldToPermissions', () => {
  it('round-trips every single-permission denial', () => {
    for (const key of PERMISSION_KEYS) {
      const denied = bitfieldToPermissions(permissionsToBitfield([key]));
      assert.equal(denied.includes(key), true, `${key} should round-trip as denied`);
    }
  });

  it('reports nothing denied for a fully permissive bitfield', () => {
    assert.deepEqual(bitfieldToPermissions(ALL_PERMISSIONS), []);
  });

  it('reports every permission denied when all bits are clear', () => {
    assert.deepEqual(bitfieldToPermissions(0).sort(), [...PERMISSION_KEYS].sort());
  });
});
