/**
 * Guard for the fork release-tag scheme.
 *
 * Fork releases are tagged `vX.Y.Z.W-rspur.N` so an upstream tag fetch can
 * never overwrite our release pointers. The suffix belongs on the git tag and
 * nowhere else. `VERSION_RE` is a strict numeric gate, so a suffix in the
 * manifest makes `parseSemver(VERSION)` return null, which silently breaks
 * every local version comparison: `check-update`, `self-upgrade --check-only`,
 * and the `thin_client_upgrade_drift` doctor check all degrade instead of
 * comparing. That shipped once in 0.42.72.2 and cost 15 test failures.
 *
 * Suffixes on *remote* version strings stay supported at the network boundary
 * by `parseVersionFileBody`, which strips them and compares the numeric base.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidVersionString, parseSemver } from '../src/core/semver.ts';
import { VERSION } from '../src/version.ts';

const ROOT = join(import.meta.dir, '..');
const VERSION_FILE = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();

describe('fork version manifest stays plain numeric', () => {
  test('package.json version parses as a semver tuple', () => {
    expect(isValidVersionString(VERSION)).toBe(true);
    expect(parseSemver(VERSION)).not.toBeNull();
  });

  test('VERSION file parses as a semver tuple', () => {
    expect(isValidVersionString(VERSION_FILE)).toBe(true);
    expect(parseSemver(VERSION_FILE)).not.toBeNull();
  });

  test('VERSION file and package.json version agree', () => {
    expect(VERSION_FILE).toBe(VERSION);
  });

  test('no release-channel suffix leaked into either manifest', () => {
    for (const v of [VERSION, VERSION_FILE]) {
      expect(v).not.toContain('-');
      expect(v).not.toContain('+');
    }
  });
});
