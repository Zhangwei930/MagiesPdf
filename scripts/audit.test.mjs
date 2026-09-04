import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUDIT_ARGS, classify } from './audit.mjs';

const answered = (counts) => JSON.stringify({ metadata: { vulnerabilities: counts } });

describe('telling a vulnerability apart from npm being down', () => {
  it('passes an audit that answered with nothing to report', () => {
    const { outcome } = classify({
      code: 0,
      stdout: answered({ info: 0, low: 3, moderate: 1, high: 0, critical: 0 }),
    });
    assert.equal(outcome, 'clean');
  });

  /**
   * The whole point of the gate. This must fail every time, and must never be
   * reachable by the endpoint being unavailable.
   */
  it('fails on a high or critical advisory', () => {
    assert.equal(classify({ code: 1, stdout: answered({ high: 1, critical: 0 }) }).outcome, 'vulnerable');
    assert.equal(classify({ code: 1, stdout: answered({ high: 0, critical: 2 }) }).outcome, 'vulnerable');
  });

  it('names what it found, so the log says why the build stopped', () => {
    const { detail } = classify({ code: 1, stdout: answered({ high: 4, critical: 1 }) });
    assert.match(detail, /1 critical/);
    assert.match(detail, /4 high/);
  });

  /**
   * The three shapes seen from npm on 2026-09-04, within twenty minutes of
   * each other, on a dependency tree that `npm ci --dry-run` accepted and that
   * had passed this same step half an hour earlier.
   */
  it('calls an endpoint error unreachable, not vulnerable', () => {
    const service = classify({
      code: 1,
      stdout: JSON.stringify({ error: { code: 'E503', summary: 'Service Unavailable', detail: '' } }),
    });
    assert.equal(service.outcome, 'unreachable');
    assert.match(service.detail, /Service Unavailable/);

    const badRequest = classify({
      code: 1,
      stdout: JSON.stringify({
        error: { code: 'E400', summary: 'Bad Request', detail: 'Invalid package tree' },
      }),
    });
    assert.equal(badRequest.outcome, 'unreachable');
  });

  it('treats output that is not a report as unreachable rather than a finding', () => {
    const { outcome } = classify({ code: 1, stdout: 'npm error audit endpoint returned an error' });
    assert.equal(outcome, 'unreachable');
  });

  it('does not read a missing vulnerability count as a clean bill of health', () => {
    assert.equal(classify({ code: 1, stdout: JSON.stringify({ metadata: {} }) }).outcome, 'unreachable');
  });

  it('asks npm for the machine-readable report, and for a short attempt', () => {
    assert.ok(AUDIT_ARGS.includes('--json'), 'the classification reads JSON, not prose');
    assert.ok(AUDIT_ARGS.includes('--omit=dev'));
    assert.ok(AUDIT_ARGS.includes('--audit-level=high'));
    // npm's own default keeps a single failing attempt going for minutes, which
    // is what made three failures cost twenty.
    assert.ok(AUDIT_ARGS.some((arg) => arg.startsWith('--fetch-timeout=')));
  });
});
