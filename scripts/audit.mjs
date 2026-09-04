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
 * What one run of `npm audit --json` means.
 *
 * npm prints a JSON object either way; the difference is which keys it has.
 * An answered audit carries `metadata.vulnerabilities`, whether or not
 * anything was found. An endpoint failure carries `error` and no metadata.
 */
export function classify({ code, stdout }) {
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

  const blocking = (counts.high ?? 0) + (counts.critical ?? 0);
  if (blocking > 0) {
    return {
      outcome: 'vulnerable',
      detail: `${counts.critical ?? 0} critical, ${counts.high ?? 0} high`,
    };
  }
  return { outcome: 'clean', detail: 'no high or critical advisories' };
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
