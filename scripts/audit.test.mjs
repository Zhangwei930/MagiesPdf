import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACCEPTED, AUDIT_ARGS, classify } from './audit.mjs';

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

const advisory = (id, name, severity = 'high') => ({
  source: 1,
  name,
  dependency: name,
  title: `an advisory in ${name}`,
  url: `https://github.com/advisories/${id}`,
  severity,
  range: '*',
});
const entry = (name, severity, via, fixAvailable = false) => ({ name, severity, via, fixAvailable });
/** The shape `npm audit --json` prints, counts derived from the entries. */
const report = (vulnerabilities) => {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const { severity } of Object.values(vulnerabilities)) counts[severity] += 1;
  return JSON.stringify({ vulnerabilities, metadata: { vulnerabilities: counts } });
};

/**
 * The tree on 2026-10-04: an advisory in node-forge with no fixed release, and
 * the signer flagged only because it depends on node-forge.
 */
const FORGE = 'GHSA-86w9-cpqp-85rv';
const forgeTree = () => ({
  'node-forge': entry('node-forge', 'high', [advisory(FORGE, 'node-forge')]),
  '@signpdf/signer-p12': entry('@signpdf/signer-p12', 'high', ['node-forge']),
});
const acceptForge = [{ id: FORGE, package: 'node-forge', reason: 'read and found unreachable' }];

describe('accepting an advisory that has been read', () => {
  it('passes when every blocking advisory is accepted, and says which', () => {
    const { outcome, detail } = classify({ code: 1, stdout: report(forgeTree()) }, acceptForge);
    assert.equal(outcome, 'clean');
    assert.match(detail, new RegExp(FORGE));
  });

  it('still fails on an advisory nobody accepted, beside one that was', () => {
    const tree = { ...forgeTree(), 'js-yaml': entry('js-yaml', 'high', [advisory('GHSA-2883-xcg3-v3hh', 'js-yaml')]) };
    const { outcome, detail } = classify({ code: 1, stdout: report(tree) }, acceptForge);
    assert.equal(outcome, 'vulnerable');
    assert.match(detail, /js-yaml/);
    assert.doesNotMatch(detail, /node-forge/);
  });

  it('accepts an advisory only for the package it was read for', () => {
    const elsewhere = [{ ...acceptForge[0], package: 'some-other-package' }];
    assert.equal(classify({ code: 1, stdout: report(forgeTree()) }, elsewhere).outcome, 'vulnerable');

    const anotherAdvisory = [{ ...acceptForge[0], id: 'GHSA-aaaa-bbbb-cccc' }];
    assert.equal(classify({ code: 1, stdout: report(forgeTree()) }, anotherAdvisory).outcome, 'vulnerable');
  });

  it('fails everything that depends on a package with an advisory nobody accepted', () => {
    const tree = forgeTree();
    tree['node-forge'].via.push(advisory('GHSA-dddd-eeee-ffff', 'node-forge'));
    const { outcome, detail } = classify({ code: 1, stdout: report(tree) }, acceptForge);
    assert.equal(outcome, 'vulnerable');
    assert.match(detail, /node-forge/);
    assert.match(detail, /@signpdf\/signer-p12/);
  });

  it('leaves a moderate advisory below the gate, even beside an accepted one', () => {
    const tree = forgeTree();
    tree['node-forge'].via.push(advisory('GHSA-dddd-eeee-ffff', 'node-forge', 'moderate'));
    assert.equal(classify({ code: 1, stdout: report(tree) }, acceptForge).outcome, 'clean');
  });

  it('does not let packages that only point at each other pass', () => {
    const tree = { a: entry('a', 'high', ['b']), b: entry('b', 'high', ['a']) };
    assert.equal(classify({ code: 1, stdout: report(tree) }, acceptForge).outcome, 'vulnerable');
  });

  it('does not pass a report whose counts its findings do not account for', () => {
    const stdout = JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { high: 1, critical: 0 } } });
    assert.equal(classify({ code: 1, stdout }, acceptForge).outcome, 'vulnerable');
  });

  it('says when an acceptance can go', () => {
    const fixed = forgeTree();
    fixed['node-forge'].fixAvailable = true;
    const upgrade = classify({ code: 1, stdout: report(fixed) }, acceptForge);
    assert.equal(upgrade.outcome, 'clean');
    assert.equal(upgrade.notes.length, 1);
    assert.match(upgrade.notes[0], /fix available/);

    const gone = classify({ code: 0, stdout: report({}) }, acceptForge);
    assert.equal(gone.outcome, 'clean');
    assert.equal(gone.notes.length, 1);
    assert.match(gone.notes[0], /no longer reported/);

    assert.deepEqual(classify({ code: 1, stdout: report(forgeTree()) }, acceptForge).notes, []);
  });

  it('records each acceptance with its advisory, its package and the reason', () => {
    assert.ok(ACCEPTED.length > 0);
    for (const acceptance of ACCEPTED) {
      assert.match(acceptance.id, /^GHSA-\w{4}-\w{4}-\w{4}$/);
      assert.ok(acceptance.package, `${acceptance.id} names no package`);
      assert.ok(acceptance.reason.length > 80, `${acceptance.id} needs a reason someone can check`);
    }
  });
});
