import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isActionable, shouldShowToast, type Dismissal } from './updateToast.ts';

const at = (state: string, version?: string) =>
  ({ state, version }) as Parameters<typeof shouldShowToast>[0];

describe('isActionable', () => {
  it('covers the states the toast has something to offer', () => {
    assert.equal(isActionable('available'), true);
    assert.equal(isActionable('downloading'), true);
    assert.equal(isActionable('ready'), true);
  });

  it('excludes the quiet states', () => {
    assert.equal(isActionable('idle'), false);
    assert.equal(isActionable('checking'), false);
    assert.equal(isActionable('current'), false);
    assert.equal(isActionable('error'), false);
  });
});

describe('shouldShowToast', () => {
  it('shows an available update nobody has dismissed', () => {
    assert.equal(shouldShowToast(at('available', '1.0.3'), null), true);
  });

  it('shows errors, which are never suppressed', () => {
    assert.equal(shouldShowToast(at('error'), null), true);
    assert.equal(shouldShowToast(at('error'), { version: null, state: 'error' }), true);
  });

  it('stays quiet for states with nothing to act on', () => {
    assert.equal(shouldShowToast(at('idle'), null), false);
    assert.equal(shouldShowToast(at('checking'), null), false);
    assert.equal(shouldShowToast(at('current'), null), false);
  });

  it('stays dismissed once the ready toast is closed', () => {
    const dismissed: Dismissal = { version: '1.0.3', state: 'ready' };
    assert.equal(shouldShowToast(at('ready', '1.0.3'), dismissed), false);
  });

  it('does not re-nag while the version the user dismissed keeps downloading', () => {
    const dismissed: Dismissal = { version: '1.0.3', state: 'available' };
    assert.equal(shouldShowToast(at('downloading', '1.0.3'), dismissed), false);
  });

  it('speaks up again when a dismissed download finishes and can be installed', () => {
    const dismissed: Dismissal = { version: '1.0.3', state: 'downloading' };
    assert.equal(shouldShowToast(at('ready', '1.0.3'), dismissed), true);
  });

  it('shows a different version even if an earlier one was dismissed', () => {
    const dismissed: Dismissal = { version: '1.0.3', state: 'ready' };
    assert.equal(shouldShowToast(at('available', '1.0.4'), dismissed), true);
  });
});
