/**
 * Semver comparison shared by the version gates.
 *
 * Lives here rather than in `engine.ts` because `spawn/spawn.ts` needs it too, and it cannot import
 * `engine.ts` — `engine.ts` already imports `spawn/spawn.js`, so that direction would cycle.
 */

/** Reads the engine version out of a `GET /config` body (`{ options: { version } }`). `undefined`
 * when the engine reported none — old builds did not. */
export function extractEngineVersion(cfg: Record<string, unknown>): string | undefined {
  const options = cfg['options'];
  if (options === null || typeof options !== 'object') return undefined;
  const { version } = options as { version?: unknown };
  return typeof version === 'string' ? version : undefined;
}

/** Parses a leading `major.minor.patch`, tolerating a `v` prefix and any suffix (`-rc.1`, build
 * metadata). `undefined` when there is no recognizable version at the front. */
export function parseSemver(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `found` is strictly below `required` (major, then minor, then patch). */
export function isBelowVersion(found: [number, number, number], required: [number, number, number]): boolean {
  const [fMajor, fMinor, fPatch] = found;
  const [rMajor, rMinor, rPatch] = required;
  if (fMajor !== rMajor) return fMajor < rMajor;
  if (fMinor !== rMinor) return fMinor < rMinor;
  return fPatch < rPatch;
}

/**
 * True when `found` is a recognizable version at or above `required`.
 *
 * Deliberately answers **false** for an absent or unparseable version, so a caller gating a security
 * feature on it fails closed: "I could not tell" must never read as "yes". A caller that wants to
 * distinguish those cases should parse it itself.
 */
export function isAtLeastVersion(found: string | undefined, required: string): boolean {
  if (found === undefined) return false;
  const parsed = parseSemver(found);
  const floor = parseSemver(required);
  if (parsed === undefined || floor === undefined) return false;
  return !isBelowVersion(parsed, floor);
}
