/**
 * Binary resolution for the Rift engine (issue #5).
 *
 * Replaces the old postinstall-download flow with an on-demand resolver: check for an explicit
 * override, then PATH, then a local version cache, and only reach for the network as a last
 * resort — and never when the environment is air-gapped. Every IO dependency is injectable so
 * the resolution order can be verified without touching the real filesystem/network (see
 * test/unit/spawn.test.ts), while sane real implementations back each dependency by default.
 */

import { execSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Env lookup shape shared by every function here — matches `process.env`'s shape structurally. */
export type EnvRecord = Record<string, string | undefined>;

const DEFAULT_DOWNLOAD_BASE = 'https://github.com/achird-labs/rift/releases/download';

/**
 * Default engine version to resolve when the caller doesn't pin one — the latest Rift release
 * this SDK is tested against. Always ≥ package.json's `minEngineVersion`, which moves
 * independently (it only rises when the SDK depends on newer engine behavior).
 */
export const DEFAULT_ENGINE_VERSION = 'v0.17.0';

/** Binary names to probe, in order of preference, newest/most-specific first. */
const BINARY_NAMES: readonly string[] =
  process.platform === 'win32'
    ? ['rift-http-proxy.exe', 'rift.exe', 'mb.exe']
    : ['rift-http-proxy', 'rift', 'mb'];

const CANONICAL_BINARY_NAME = BINARY_NAMES[0] as string;

/** Rust target triple + archive shape for a given (platform, arch) pair. */
export interface PlatformTarget {
  target: string;
  ext: 'tar.gz' | 'zip';
  /** Archive filename for a given engine version, e.g. `rift-v0.12.0-x86_64-apple-darwin.tar.gz`. */
  archiveName(version: string): string;
}

const TARGET_MAP: Record<string, { target: string; ext: 'tar.gz' | 'zip' }> = {
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', ext: 'tar.gz' },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', ext: 'tar.gz' },
  'darwin-x64': { target: 'x86_64-apple-darwin', ext: 'tar.gz' },
  'darwin-arm64': { target: 'aarch64-apple-darwin', ext: 'tar.gz' },
  'win32-x64': { target: 'x86_64-pc-windows-msvc', ext: 'zip' },
};

/** Linux C library flavor. Only meaningful on `linux`; other platforms report `glibc` inertly. */
export type Libc = 'glibc' | 'musl';

/**
 * Detects the running Linux C library (issue #84). Alpine and other musl distros need the
 * `*-unknown-linux-musl` release asset — the glibc build won't run there without `gcompat`.
 *
 * Heuristic (fast, dependency-free): Node's report exposes `glibcVersionRuntime` only when linked
 * against glibc; its absence on Linux means musl. `/etc/alpine-release` is a secondary signal.
 * Non-Linux platforms always report `glibc` (the value is unused for them).
 */
export function detectLibc(platform: string = process.platform): Libc {
  if (platform !== 'linux') return 'glibc';
  // Only the host's own libc is knowable here. When a caller simulates a *different* platform
  // (tests, cross-fetch for another target), we can't probe it — default to gnu and let callers
  // pass `libc: 'musl'` explicitly for a cross-target musl build.
  if (platform !== process.platform) return 'glibc';
  try {
    const report = process.report?.getReport?.() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    if (report?.header && 'glibcVersionRuntime' in report.header) {
      return report.header.glibcVersionRuntime ? 'glibc' : 'musl';
    }
  } catch {
    // fall through to the filesystem signal
  }
  return fs.existsSync('/etc/alpine-release') ? 'musl' : 'glibc';
}

/**
 * Maps a (platform, arch) pair to its Rust release target. Defaults to the current process's.
 * On Linux the C library flavor selects gnu vs musl (defaults to {@link detectLibc}).
 */
export function platformTarget(
  platform: string = process.platform,
  arch: string = process.arch,
  libc: Libc = detectLibc(platform)
): PlatformTarget {
  const key = `${platform}-${arch}`;
  const entry = TARGET_MAP[key];
  if (!entry) {
    throw new Error(
      `Unsupported platform/arch combination: ${key}. Supported: ${Object.keys(TARGET_MAP).join(', ')}`
    );
  }
  // Linux ships both gnu and musl builds; select musl on musl hosts (Alpine) so the binary runs.
  const target =
    platform === 'linux' && libc === 'musl'
      ? entry.target.replace('-linux-gnu', '-linux-musl')
      : entry.target;
  const { ext } = entry;
  return {
    target,
    ext,
    archiveName(version: string): string {
      return `rift-${version}-${target}.${ext}`;
    },
  };
}

export interface DownloadUrlOptions {
  env?: EnvRecord;
  mirror?: string;
  platform?: string;
  arch?: string;
  /** Override the detected C library flavor (Linux gnu vs musl). Defaults to {@link detectLibc}. */
  libc?: Libc;
}

/**
 * Builds the download URL for a release archive, honoring (in priority order) an explicit
 * mirror, `RIFT_DOWNLOAD_URL`, `RIFT_MIRROR_URL`, then the public GitHub releases base.
 */
export function binaryDownloadUrl(version: string, opts: DownloadUrlOptions = {}): string {
  const env = opts.env ?? process.env;
  const base = opts.mirror ?? env.RIFT_DOWNLOAD_URL ?? env.RIFT_MIRROR_URL ?? DEFAULT_DOWNLOAD_BASE;
  const { archiveName } = platformTarget(opts.platform, opts.arch, opts.libc);
  return `${base}/${version}/${archiveName(version)}`;
}

/** True when the environment opts out of network binary downloads. */
export function isAirGapped(env: EnvRecord = process.env): boolean {
  return Boolean(env.RIFT_OFFLINE) || Boolean(env.RIFT_SKIP_BINARY_DOWNLOAD);
}

/** Verifies `data` against an expected sha256 hex digest (case-insensitive). */
export function verifySha256(data: Buffer | Uint8Array, expectedHex: string): boolean {
  const actual = createHash('sha256').update(data).digest('hex');
  return actual.toLowerCase() === expectedHex.trim().toLowerCase();
}

/** Extracts the hex digest from a `.sha256` sidecar (`<hex>` or `<hex>  filename`). */
export function parseSha256Sidecar(text: string): string | null {
  const token = text.trim().split(/\s+/)[0] ?? '';
  return /^[0-9a-fA-F]{64}$/.test(token) ? token : null;
}

/** True when checksum verification is explicitly opted out (`RIFT_SKIP_CHECKSUM`). */
function checksumOptOut(env: EnvRecord): boolean {
  return Boolean(env.RIFT_SKIP_CHECKSUM);
}

/**
 * Fetches the `<url>.sha256` sidecar and verifies `data` against it. A tampered/corrupt download
 * throws; a MISSING checksum also throws (refuse unverified) unless `RIFT_SKIP_CHECKSUM` is set —
 * downloads must never run unverified silently.
 */
export async function fetchAndVerifyChecksum(
  url: string,
  data: Buffer | Uint8Array,
  opts: { env?: EnvRecord; fetchImpl?: typeof fetch } = {}
): Promise<void> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  let sha: string | null = null;
  try {
    const response = await doFetch(`${url}.sha256`);
    if (response.ok) {
      sha = parseSha256Sidecar(await response.text());
    }
  } catch {
    sha = null;
  }
  if (sha === null) {
    if (checksumOptOut(env)) return;
    throw new Error(
      `No SHA-256 checksum available for ${url}; refusing to use an unverified download. ` +
        'Set RIFT_SKIP_CHECKSUM=1 to override (not recommended).'
    );
  }
  if (!verifySha256(data, sha)) {
    throw new Error(`Checksum mismatch for Rift binary downloaded from ${url}`);
  }
}

function defaultCacheDir(): string {
  return path.join(os.homedir(), '.cache', 'rift-node', 'binaries');
}

function defaultCacheLookup(version: string): string | null {
  const candidate = path.join(defaultCacheDir(), `rift-${version}`, CANONICAL_BINARY_NAME);
  return fs.existsSync(candidate) ? candidate : null;
}

function defaultLookupPath(name: string): string | null {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = execSync(`${whichCmd} ${name}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const found = result.trim().split(/\r?\n/)[0];
    return found && fs.existsSync(found) ? found : null;
  } catch {
    return null;
  }
}

/**
 * Confirms a PATH candidate is actually the Rift engine (issue #84).
 *
 * `mb` is in {@link BINARY_NAMES} for Mountebank-migration ergonomics, but Homebrew's Mountebank
 * installs a `/usr/local/bin/mb` too — accepting it verbatim would **silently run Mountebank while
 * the caller believes it runs Rift**. Rift reports `rift <version>` for `--version`; Mountebank
 * reports a bare `<version>`. So we accept a PATH hit only when its `--version` names Rift. On any
 * probe error we reject (safer to fall through to the cache/download than to run an unknown binary).
 */
function defaultProbeIsRift(binPath: string): boolean {
  try {
    const out = execSync(`"${binPath}" --version`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return /\brift\b/i.test(out);
  } catch {
    return false;
  }
}

/**
 * Candidate locations of the engine binary inside an extracted release archive, in preference
 * order. Release archives (v0.12.0+) nest their binaries under `rift-<version>-<target>/bin/`
 * (where the engine is named `rift`); earlier layouts placed the binary directly under the
 * versioned directory or at the archive root.
 */
export function extractedBinaryCandidates(
  destDir: string,
  version: string,
  target: string
): string[] {
  const nested = path.join(destDir, `rift-${version}-${target}`);
  const roots = [path.join(nested, 'bin'), nested, destDir];
  return roots.flatMap((root) => BINARY_NAMES.map((name) => path.join(root, name)));
}

function extractArchive(archivePath: string, destDir: string, ext: 'tar.gz' | 'zip'): void {
  try {
    if (ext === 'tar.gz') {
      execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'pipe' });
    } else if (process.platform === 'win32') {
      execSync(
        `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`,
        { stdio: 'pipe' }
      );
    } else {
      execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'pipe' });
    }
  } catch (cause) {
    throw new Error(`Failed to extract Rift archive ${archivePath}: ${String(cause)}`);
  }
}

/** Builds the real (network-hitting) `download` dependency, closing over the resolved version. */
function makeDefaultDownload(
  version: string,
  platform: string | undefined,
  arch: string | undefined,
  env: EnvRecord
): (url: string, sha: string | null) => Promise<string> {
  return async function download(url: string, sha: string | null): Promise<string> {
    const { ext, target } = platformTarget(platform, arch);
    const destDir = path.join(defaultCacheDir(), `rift-${version}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download Rift binary from ${url}: HTTP ${response.status}`);
    }
    const data = Buffer.from(await response.arrayBuffer());

    // Verify BEFORE writing/extracting anything: a caller-supplied digest wins, otherwise the
    // `.sha256` sidecar is fetched and enforced (missing checksum is fatal unless opted out).
    if (sha) {
      if (!verifySha256(data, sha)) {
        throw new Error(`Checksum mismatch for Rift binary downloaded from ${url}`);
      }
    } else {
      await fetchAndVerifyChecksum(url, data, { env });
    }

    fs.mkdirSync(destDir, { recursive: true });
    const archivePath = path.join(destDir, `archive.${ext}`);
    fs.writeFileSync(archivePath, data);
    extractArchive(archivePath, destDir, ext);
    fs.unlinkSync(archivePath);

    const binaryPath = path.join(destDir, CANONICAL_BINARY_NAME);
    if (!fs.existsSync(binaryPath)) {
      for (const candidate of extractedBinaryCandidates(destDir, version, target)) {
        if (fs.existsSync(candidate)) {
          fs.renameSync(candidate, binaryPath);
          break;
        }
      }
    }
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Downloaded archive did not contain the expected binary: ${binaryPath}`);
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
    }
    return binaryPath;
  };
}

export interface ResolveBinaryOptions {
  /** Engine version to resolve when falling through to cache/download. Defaults to {@link DEFAULT_ENGINE_VERSION}. */
  version?: string;
  /** Explicit binary path override; beats `env.RIFT_BINARY_PATH`. */
  binaryPath?: string;
  env?: EnvRecord;
  fileExists?: (p: string) => boolean;
  lookupPath?: (name: string) => string | null;
  /** Confirms a PATH candidate is really Rift (rejects a shadowing `mb`/Mountebank). See #84. */
  probeIsRift?: (binPath: string) => boolean;
  cacheLookup?: (version: string) => string | null;
  download?: (url: string, sha: string | null) => Promise<string>;
  mirror?: string;
  platform?: string;
  arch?: string;
}

/**
 * Resolves a path to a runnable Rift engine binary.
 *
 * Resolution order:
 *   1. `opts.binaryPath ?? env.RIFT_BINARY_PATH`, if it exists on disk.
 *   2. The first of `rift-http-proxy` / `rift` / `mb` found on `PATH` **that `--version`-probes as
 *      Rift** — a PATH `mb` that is actually Mountebank is skipped, not run (#84).
 *   3. A previously-downloaded copy in the local version cache.
 *   4. If air-gapped (`RIFT_OFFLINE` / `RIFT_SKIP_BINARY_DOWNLOAD`), throw — never download.
 *   5. Otherwise, download the release archive for the resolved version and cache it.
 */
export async function resolveBinary(opts: ResolveBinaryOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const version = opts.version ?? DEFAULT_ENGINE_VERSION;
  const fileExists = opts.fileExists ?? fs.existsSync;
  const lookupPath = opts.lookupPath ?? defaultLookupPath;
  const probeIsRift = opts.probeIsRift ?? defaultProbeIsRift;
  const cacheLookup = opts.cacheLookup ?? defaultCacheLookup;
  const download = opts.download ?? makeDefaultDownload(version, opts.platform, opts.arch, env);

  // 1. Explicit override.
  const explicitPath = opts.binaryPath ?? env.RIFT_BINARY_PATH;
  if (explicitPath && fileExists(explicitPath)) {
    return explicitPath;
  }

  // 2. PATH lookup — but only accept a hit that version-probes as Rift, so a Mountebank `mb` on
  // PATH doesn't get silently run in Rift's place (#84).
  for (const name of BINARY_NAMES) {
    const found = lookupPath(name);
    if (found && probeIsRift(found)) return found;
  }

  // 3. Local version cache.
  const cached = cacheLookup(version);
  if (cached) return cached;

  // 4. Air-gapped: refuse to reach the network.
  if (isAirGapped(env)) {
    throw new Error(
      'Rift binary not found locally and downloads are disabled (air-gapped mode: ' +
        'RIFT_OFFLINE or RIFT_SKIP_BINARY_DOWNLOAD is set). Set RIFT_BINARY_PATH to an existing ' +
        `binary, install it to PATH, or unset the air-gap override to allow downloading ${version}.`
    );
  }

  // 5. Download as a last resort.
  const url = binaryDownloadUrl(version, {
    env,
    mirror: opts.mirror,
    platform: opts.platform,
    arch: opts.arch,
  });
  return download(url, null);
}
