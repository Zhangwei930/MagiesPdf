import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyLoadError } from './loadError.ts';

describe('classifyLoadError', () => {
  it('reports a locked document that has had no password tried yet', () => {
    assert.equal(
      classifyLoadError({ name: 'PasswordException', code: 1, message: 'No password given' }),
      'needs-password',
    );
  });

  it('reports a rejected password separately, so the user can retype it', () => {
    assert.equal(
      classifyLoadError({ name: 'PasswordException', code: 2, message: 'Incorrect Password' }),
      'wrong-password',
    );
  });

  it('treats a corrupt file as unreadable', () => {
    assert.equal(
      classifyLoadError({ name: 'InvalidPDFException', message: 'Invalid PDF structure' }),
      'unreadable',
    );
  });

  it('treats a plain Error as unreadable', () => {
    assert.equal(classifyLoadError(new Error('boom')), 'unreadable');
  });

  it('does not crash on null or a bare string', () => {
    assert.equal(classifyLoadError(null), 'unreadable');
    assert.equal(classifyLoadError('nope'), 'unreadable');
  });

  it('ignores an unknown code on a password exception', () => {
    assert.equal(classifyLoadError({ name: 'PasswordException', code: 99 }), 'unreadable');
  });
});
