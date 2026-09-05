import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acceptsUpdate } from './jobStatus.ts';

describe('whether a job row may still change', () => {
  it('accepts anything while the job is still in motion', () => {
    assert.equal(acceptsUpdate('queued'), true);
    assert.equal(acceptsUpdate('running'), true);
  });

  /**
   * The one that was wrong. A progress message arriving after the cancel set
   * the row back to "running", and the result behind it then found a running
   * job and marked it done — a cancelled job reported as finished.
   */
  it('accepts nothing once the job has been cancelled', () => {
    assert.equal(acceptsUpdate('cancelled'), false);
  });

  it('accepts nothing once the job has finished either way', () => {
    assert.equal(acceptsUpdate('done'), false);
    assert.equal(acceptsUpdate('error'), false);
  });
});
