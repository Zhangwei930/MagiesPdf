const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, it } = require('node:test');

const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const ciWorkflow = readFileSync(
  join(__dirname, '..', '.github', 'workflows', 'ci.yml'),
  'utf8',
);

describe('dependency security policy', () => {
  it('uses the maintained SheetJS package instead of vulnerable npm xlsx 0.18', () => {
    assert.equal(packageJson.dependencies.exceljs, undefined);
    assert.equal(
      packageJson.dependencies.xlsx,
      'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz',
    );
  });

  it('blocks vulnerabilities in shipped dependencies without breaking build-only tools', () => {
    assert.match(ciWorkflow, /npm audit --omit=dev --audit-level=high/);
  });

  /**
   * `fast-uri` and `hono` were once pinned in `overrides` to escape advisories.
   * A pin is written against what is known that day, and then it stops moving:
   * `fast-uri` was held at exactly 3.1.5, and four later advisories named
   * 3.0.0–3.1.5 as the affected range — the pin was keeping the tree inside it.
   *
   * The pins are gone. `ajv` asks for ^3.0.1 and the MCP SDK for ^4.11.4, so
   * both resolve past those ranges on their own and can keep rising.
   *
   * The check moved with them, from `overrides` to the lock file: an override
   * says what we tried to force, while the lock says what `npm ci` will install,
   * and an advisory is about the second one.
   */
  it('locks fast-uri and hono past the ranges their advisories name', () => {
    const lock = JSON.parse(readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8'));
    const atLeast = (name, floor) => {
      const installed = lock.packages[`node_modules/${name}`]?.version;
      assert.ok(installed, `${name} is missing from the lock file`);
      const [major, minor, patch] = installed.split('.').map(Number);
      const [minMajor, minMinor, minPatch] = floor.split('.').map(Number);
      const ok =
        major > minMajor ||
        (major === minMajor && (minor > minMinor || (minor === minMinor && patch >= minPatch)));
      assert.ok(ok, `${name} resolves to ${installed}, below the required ${floor}`);
    };
    // GHSA-5jgf-p345-68v8 and three sibling advisories: fast-uri <= 3.1.5.
    atLeast('fast-uri', '3.1.7');
    // hono carries no advisory today; the floor is the version the pin was
    // holding it below, so the tree cannot silently sink back to it.
    atLeast('hono', '4.13.0');
  });

  /**
   * Every `resolved` url names the public registry, and the rewriting is
   * one-directional: npm replaces the host of a `registry.npmjs.org` url with
   * whatever registry is configured, so a mirror user still fetches from their
   * mirror. A lock that names the mirror instead does not get rewritten back —
   * it sends everyone there, CI runners included, and makes a build in one
   * country depend on a mirror in another.
   *
   * The SheetJS tarball is the exception the package.json declares: that
   * package is distributed from its own CDN and not from npm at all.
   */
  it('resolves every dependency from the public registry', () => {
    const lock = JSON.parse(readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8'));
    const elsewhere = Object.entries(lock.packages)
      .filter(([, meta]) => typeof meta.resolved === 'string')
      .filter(([, meta]) => !meta.resolved.startsWith('https://registry.npmjs.org/'))
      .filter(([, meta]) => !meta.resolved.startsWith('https://cdn.sheetjs.com/'))
      .map(([name, meta]) => `${name} <- ${meta.resolved}`);
    assert.deepEqual(elsewhere, []);
  });

  it('builds the worker bundle before running worker integration coverage', () => {
    assert.match(packageJson.scripts['test:coverage'], /^npm run build:node && c8 /);
  });
});
