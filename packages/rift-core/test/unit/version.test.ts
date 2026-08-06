/**
 * Gate for `src/version.ts` (issue #124).
 *
 * These four functions decide whether a security feature is allowed to proceed — `isAtLeastVersion`
 * is what stops `rift.spawn({ intercept: { auth } })` handing a credential to an engine that will
 * ignore it. They are shared between `engine.ts` and `spawn/spawn.ts` and are therefore tested
 * directly rather than only through whichever caller happens to exercise them.
 */

import { extractEngineVersion, isAtLeastVersion, isBelowVersion, parseSemver } from '../../src/version.js';

describe('version — parseSemver', () => {
  it('parses a plain version, with or without a v prefix', () => {
    expect(parseSemver('0.17.0')).toEqual([0, 17, 0]);
    expect(parseSemver('v0.17.0')).toEqual([0, 17, 0]);
    expect(parseSemver('1.20.300')).toEqual([1, 20, 300]);
  });

  it('parses the leading triple out of a longer string', () => {
    // `--version` output and prerelease/build suffixes both arrive with trailing noise.
    expect(parseSemver('0.17.0-rc.1')).toEqual([0, 17, 0]);
    expect(parseSemver('0.17.0+build.5')).toEqual([0, 17, 0]);
  });

  it('returns undefined when there is no version at the front', () => {
    expect(parseSemver('nightly')).toBeUndefined();
    expect(parseSemver('')).toBeUndefined();
    expect(parseSemver('0.17')).toBeUndefined();
    expect(parseSemver('rift 0.17.0')).toBeUndefined();
  });
});

describe('version — isBelowVersion', () => {
  it('compares major, then minor, then patch', () => {
    expect(isBelowVersion([0, 16, 9], [0, 17, 0])).toBe(true);
    expect(isBelowVersion([0, 17, 0], [0, 17, 0])).toBe(false);
    expect(isBelowVersion([0, 17, 1], [0, 17, 0])).toBe(false);
    // A higher major wins even when minor/patch are lower, and vice versa.
    expect(isBelowVersion([1, 0, 0], [0, 99, 99])).toBe(false);
    expect(isBelowVersion([0, 99, 99], [1, 0, 0])).toBe(true);
    // Patch only decides once major and minor tie.
    expect(isBelowVersion([0, 18, 0], [0, 17, 9])).toBe(false);
  });
});

describe('version — isAtLeastVersion fails closed', () => {
  it('answers true only for a recognizable version at or above the floor', () => {
    expect(isAtLeastVersion('0.17.0', '0.17.0')).toBe(true);
    expect(isAtLeastVersion('v0.18.2', '0.17.0')).toBe(true);
    expect(isAtLeastVersion('1.0.0', '0.17.0')).toBe(true);
    expect(isAtLeastVersion('0.16.9', '0.17.0')).toBe(false);
  });

  it('answers false — never true — when it cannot tell', () => {
    // This is the whole point: "I could not determine the version" must never read as "yes" on a
    // path that is deciding whether a credential will be enforced.
    expect(isAtLeastVersion(undefined, '0.17.0')).toBe(false);
    expect(isAtLeastVersion('', '0.17.0')).toBe(false);
    expect(isAtLeastVersion('nightly', '0.17.0')).toBe(false);
    expect(isAtLeastVersion('0.17', '0.17.0')).toBe(false);
    expect(isAtLeastVersion('0.17.0', 'not-a-floor')).toBe(false);
  });

  it('treats a prerelease of the floor as meeting it', () => {
    // Documented consequence of parsing only the leading triple. `0.17.0-rc.1` carries the flag, so
    // admitting it is right for this gate; pinned so the behaviour is a decision, not an accident.
    expect(isAtLeastVersion('0.17.0-rc.1', '0.17.0')).toBe(true);
  });
});

describe('version — extractEngineVersion', () => {
  it('reads options.version from a /config body', () => {
    expect(extractEngineVersion({ options: { version: '0.17.0' } })).toBe('0.17.0');
  });

  it('returns undefined for every shape that does not carry one', () => {
    expect(extractEngineVersion({})).toBeUndefined();
    expect(extractEngineVersion({ options: {} })).toBeUndefined();
    expect(extractEngineVersion({ options: null })).toBeUndefined();
    expect(extractEngineVersion({ options: 'nope' })).toBeUndefined();
    expect(extractEngineVersion({ options: { version: 17 } })).toBeUndefined();
    expect(extractEngineVersion({ version: '0.17.0' })).toBeUndefined();
  });
});
