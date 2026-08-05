/**
 * Spawn transport — barrel export (issue #5).
 *
 * Binary resolution (manifest-driven discovery, mirror/air-gap overrides, sha256 verification)
 * plus the process-spawning transport that hands back a connected `RemoteClient`.
 */

export {
  resolveBinary,
  binaryDownloadUrl,
  platformTarget,
  detectLibc,
  isAirGapped,
  verifySha256,
  parseSha256Sidecar,
  fetchAndVerifyChecksum,
  extractedBinaryCandidates,
  DEFAULT_ENGINE_VERSION,
} from './resolve.js';
export type { PlatformTarget, DownloadUrlOptions, ResolveBinaryOptions, EnvRecord, Libc } from './resolve.js';

export { buildSpawnArgs, resolveApiKey, spawn } from './spawn.js';
export type { SpawnedEngine, SpawnOptions, SpawnArgsOptions, SpawnDeps } from './spawn.js';
