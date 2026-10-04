import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

/**
 * `npm audit`, told apart from npm being down.
 *
 * The plain command exits non-zero for two unrelated reasons: this project
 * depends on something vulnerable, or npm's advisory endpoint did not answer.
 * Only the first is about this repository, and treating them the same made a
 * release wait on someone else's uptime — on 2026-09-04 that step failed three
 * times in twenty minutes with a 503, a 400 and another 503, each after five to
 * seven minutes of npm's own retrying.
 *
 * So: a vulnerability still fails the build, every time. An endpoint that will
 * not answer is retried, and if it never answers it is reported loudly and the
 * build continues — the gate could not be evaluated, and a gate that cannot be
 * evaluated must not silently become a verdict in either direction.
 *
 * And an advisory that has been read and found not to reach this app can be
 * accepted in `ACCEPTED`, for the one package it was read for. That sets aside
 * that finding and nothing else: any other high or critical advisory still
 * fails the build, including one that arrives later in the same package.
 */

const ATTEMPTS = 3;
const BACKOFF_MS = [0, 5_000, 15_000];
/** Short, because npm's own default keeps one attempt going for minutes. */
const FETCH_TIMEOUT_MS = 60_000;

export const AUDIT_ARGS = [
  'audit',
  '--omit=dev',
  '--audit-level=high',
  '--json',
  `--fetch-timeout=${FETCH_TIMEOUT_MS}`,
  '--fetch-retries=1',
];

/**
 * Advisories read and found not to reach this app, each with the reason.
 *
 * Every entry is a standing decision that the code path is unreachable, so the
 * reason has to say why in terms someone can check. The audit says when an
 * entry can go: when npm reports a fix for it, or stops reporting it at all.
 */
export const ACCEPTED = [
  {
    id: 'GHSA-86w9-cpqp-85rv',
    package: 'node-forge',
    reason:
      'The flaw is in RSA PKCS#1 v1.5 signature verification, and node-forge only '
      + 'signs here. @signpdf/signer-p12 parses the P12 (whose integrity check is '
      + 'an HMAC, not an RSA signature) and creates a PKCS#7 signature; forge\'s own '
      + 'PKCS#7 verify is unimplemented and throws. PDF signatures are verified with '
      + 'pkijs. No fixed release exists as of 2026-10-04.',
  },
];

const BLOCKING = new Set(['high', 'critical']);

function advisoryId(via) {
  return /GHSA-\w{4}-\w{4}-\w{4}/.exec(via?.url ?? '')?.[0] ?? '';
}

function reportsAdvisory(entry, id) {
  return Array.isArray(entry?.via) && entry.via.some((via) => typeof via !== 'string' && advisoryId(via) === id);
}

/**
 * The packages that still block once accepted advisories are set aside.
 *
 * npm lists a package's findings in `via`: an advisory of its own, or the name
 * of a dependency it is vulnerable through. Whatever cannot be resolved — a
 * name with no entry, a loop of names — blocks, so a gap in the report never
 * decides in a package's favour.
 */
function blockingPackages(vulnerabilities, accepted) {
  const isAccepted = (via) => accepted.some((a) => a.id === advisoryId(via) && a.package === via.name);
  const verdicts = new Map();
  const visiting = new Set();

  function blocks(name) {
    if (verdicts.has(name)) return verdicts.get(name);
    const entry = vulnerabilities[name];
    if (!Array.isArray(entry?.via) || visiting.has(name)) return true;
    visiting.add(name);
    const verdict = entry.via.some((via) =>
      typeof via === 'string' ? blocks(via) : BLOCKING.has(via.severity) && !isAccepted(via));
    visiting.delete(name);
    verdicts.set(name, verdict);
    return verdict;
  }

  return Object.keys(vulnerabilities).filter((name) => BLOCKING.has(vulnerabilities[name]?.severity) && blocks(name));
}

/** Acceptances that can be removed, said so the log tells someone to do it. */
function acceptanceNotes(vulnerabilities, accepted) {
  const notes = [];
  for (const { id, package: name } of accepted) {
    const entry = vulnerabilities[name];
    if (!reportsAdvisory(entry, id)) {
      notes.push(`${id} in ${name} is no longer reported; remove its acceptance from scripts/audit.mjs`);
    } else if (entry.fixAvailable) {
      notes.push(`${id} in ${name} has a fix available; upgrade and remove its acceptance from scripts/audit.mjs`);
    }
  }
  return notes;
}

/**
 * What one run of `npm audit --json` means.
 *
 * npm prints a JSON object either way; the difference is which keys it has.
 * An answered audit carries `metadata.vulnerabilities`, whether or not
 * anything was found. An endpoint failure carries `error` and no metadata.
 */
export function classify({ code, stdout }, accepted = ACCEPTED) {
  let report = null;
  try {
    report = JSON.parse(stdout);
  } catch {
    // Not JSON at all — npm failed before it could report. Unreachable rather
    // than vulnerable: we have no finding to point at.
    return { outcome: code === 0 ? 'clean' : 'unreachable', detail: 'npm printed no report' };
  }

  if (report && typeof report === 'object' && report.error) {
    const { code: errorCode, summary, detail } = report.error;
    return {
      outcome: 'unreachable',
      detail: [errorCode, summary, detail].filter(Boolean).join(' — ') || 'audit endpoint returned an error',
    };
  }

  const counts = report?.metadata?.vulnerabilities;
  if (!counts) {
    return { outcome: code === 0 ? 'clean' : 'unreachable', detail: 'report carried no vulnerability counts' };
  }

  const { vulnerabilities } = report;
  const itemised = vulnerabilities !== null && typeof vulnerabilities === 'object';
  const notes = itemised ? acceptanceNotes(vulnerabilities, accepted) : [];

  const blocking = (counts.high ?? 0) + (counts.critical ?? 0);
  if (blocking === 0) return { outcome: 'clean', detail: 'no high or critical advisories', notes };

  // Counts alone leave nothing to set an acceptance against. And counts that the
  // itemised findings do not account for are a report contradicting itself,
  // which is not a pass either.
  const remaining = itemised ? blockingPackages(vulnerabilities, accepted) : null;
  const applied = itemised
    ? accepted
      .filter(({ id, package: name }) => reportsAdvisory(vulnerabilities[name], id))
      .map(({ id, package: name }) => `${id} in ${name}`)
    : [];
  if (remaining?.length === 0 && applied.length > 0) {
    return {
      outcome: 'clean',
      detail: `no high or critical advisories beyond the accepted ${applied.join(', ')}`,
      notes,
    };
  }
  return {
    outcome: 'vulnerable',
    detail: `${counts.critical ?? 0} critical, ${counts.high ?? 0} high`
      + (remaining ? ` — blocking: ${remaining.join(', ')}` : ''),
    notes,
  };
}

function runNpm(args) {
  return new Promise((resolve) => {
    const child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (cause) => resolve({ code: 1, stdout: '', stderr: String(cause?.message ?? cause) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function main() {
  let last = { outcome: 'unreachable', detail: 'never ran' };

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (BACKOFF_MS[attempt]) await wait(BACKOFF_MS[attempt]);
    const result = await runNpm(AUDIT_ARGS);
    last = classify(result);
    for (const note of last.notes ?? []) {
      console.warn(`::warning title=npm audit acceptance can go::${note}`);
    }

    if (last.outcome === 'clean') {
      console.log(`[audit] ${last.detail}`);
      return 0;
    }
    if (last.outcome === 'vulnerable') {
      console.error(`[audit] blocking advisories: ${last.detail}`);
      console.error(result.stdout);
      return 1;
    }
    console.warn(`[audit] attempt ${attempt + 1}/${ATTEMPTS} could not reach the advisory service: ${last.detail}`);
  }

  // Never answered. Say so plainly rather than claiming either verdict.
  console.warn('::warning title=npm audit could not run::'
    + `The advisory service did not answer after ${ATTEMPTS} attempts (${last.detail}). `
    + 'Dependencies were NOT checked for this run.');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
