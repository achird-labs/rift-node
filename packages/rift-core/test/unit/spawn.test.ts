/**
 * Spawn transport gate (issue #5)
 *
 * Manifest-driven binary discovery (RIFT_BINARY_PATH -> PATH -> version+sha cache -> download),
 * mirror/air-gap env overrides, sha256 verification, ephemeral-port spawn arg building, and the
 * Mountebank-compat create() surface. The resolver takes injectable IO deps so the resolution
 * order and env overrides are verified without touching the real fs/network.
 */

import { jest } from '@jest/globals';
import { createHash } from 'crypto';
import path from 'path';
import {
  resolveBinary,
  binaryDownloadUrl,
  platformTarget,
  detectLibc,
  isAirGapped,
  verifySha256,
  parseSha256Sidecar,
  fetchAndVerifyChecksum,
  extractedBinaryCandidates,
  buildSpawnArgs,
  spawn,
} from '../../src/spawn/index.js';
import { InvalidDefinition } from '../../src/errors.js';

const DEFAULT_BASE = 'https://github.com/achird-labs/rift/releases/download';

describe('spawn — platform target mapping', () => {
  it('maps known platforms to rust target triples + archive ext', () => {
    expect(platformTarget('linux', 'x64')).toMatchObject({
      target: 'x86_64-unknown-linux-gnu',
      ext: 'tar.gz',
    });
    expect(platformTarget('darwin', 'arm64')).toMatchObject({
      target: 'aarch64-apple-darwin',
      ext: 'tar.gz',
    });
    expect(platformTarget('win32', 'x64')).toMatchObject({
      target: 'x86_64-pc-windows-msvc',
      ext: 'zip',
    });
  });

  it('throws on an unsupported platform', () => {
    expect(() => platformTarget('sunos', 'sparc')).toThrow();
  });

  it('selects the musl target on Linux when libc=musl (#84)', () => {
    expect(platformTarget('linux', 'x64', 'musl').target).toBe('x86_64-unknown-linux-musl');
    expect(platformTarget('linux', 'arm64', 'musl').target).toBe('aarch64-unknown-linux-musl');
    // gnu stays the default for glibc.
    expect(platformTarget('linux', 'x64', 'glibc').target).toBe('x86_64-unknown-linux-gnu');
    // libc is inert on non-Linux platforms.
    expect(platformTarget('darwin', 'arm64', 'musl').target).toBe('aarch64-apple-darwin');
  });

  it('binaryDownloadUrl honors an explicit musl libc (#84)', () => {
    const url = binaryDownloadUrl('v0.14.0', {
      env: {},
      platform: 'linux',
      arch: 'arm64',
      libc: 'musl',
    });
    expect(url).toBe(`${DEFAULT_BASE}/v0.14.0/rift-v0.14.0-aarch64-unknown-linux-musl.tar.gz`);
  });

  it('detectLibc reports glibc for non-Linux and when simulating another platform', () => {
    expect(detectLibc('darwin')).toBe('glibc');
    expect(detectLibc('win32')).toBe('glibc');
    // Simulating linux from a non-linux host can't probe -> defaults to glibc (unless host IS linux).
    if (process.platform !== 'linux') {
      expect(detectLibc('linux')).toBe('glibc');
    }
  });
});

describe('spawn — download URL (mirror / air-gap overrides)', () => {
  it('defaults to the GitHub releases base', () => {
    const url = binaryDownloadUrl('v0.12.0', { env: {}, platform: 'linux', arch: 'x64' });
    expect(url).toBe(`${DEFAULT_BASE}/v0.12.0/rift-v0.12.0-x86_64-unknown-linux-gnu.tar.gz`);
  });

  it('honors a mirror via RIFT_DOWNLOAD_URL', () => {
    const url = binaryDownloadUrl('v0.12.0', {
      env: { RIFT_DOWNLOAD_URL: 'https://mirror.internal/rift' },
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(url).toBe('https://mirror.internal/rift/v0.12.0/rift-v0.12.0-aarch64-apple-darwin.tar.gz');
  });

  it('an explicit opts.mirror beats the env var', () => {
    const url = binaryDownloadUrl('v0.12.0', {
      env: { RIFT_DOWNLOAD_URL: 'https://env.example' },
      mirror: 'https://explicit.example',
      platform: 'linux',
      arch: 'x64',
    });
    expect(url.startsWith('https://explicit.example/')).toBe(true);
  });
});

describe('spawn — air-gap detection', () => {
  it('true when RIFT_OFFLINE or RIFT_SKIP_BINARY_DOWNLOAD set', () => {
    expect(isAirGapped({ RIFT_OFFLINE: '1' })).toBe(true);
    expect(isAirGapped({ RIFT_SKIP_BINARY_DOWNLOAD: '1' })).toBe(true);
    expect(isAirGapped({})).toBe(false);
  });
});

describe('spawn — extracted archive binary candidates', () => {
  it('probes the release layout (rift-<version>-<target>/bin/rift) before legacy layouts', () => {
    // Build expectations with path.join so the assertions hold on both POSIX and Windows
    // (separators and the platform binary suffix differ — the production code uses path.join too).
    const dest = path.join(path.sep, 'cache', 'rift-v0.14.0');
    const versioned = path.join(dest, 'rift-v0.14.0-aarch64-apple-darwin');
    const riftName = process.platform === 'win32' ? 'rift.exe' : 'rift';
    const inBin = path.join(versioned, 'bin', riftName);
    const inVersioned = path.join(versioned, riftName);
    const inRoot = path.join(dest, riftName);

    const candidates = extractedBinaryCandidates(dest, 'v0.14.0', 'aarch64-apple-darwin');
    // v0.12.0+ archives nest binaries under bin/, and the engine binary is named `rift`.
    expect(candidates).toContain(inBin);
    // Legacy layouts stay probed: directly under the versioned dir, and at the archive root.
    expect(candidates).toContain(inVersioned);
    expect(candidates).toContain(inRoot);
    // bin/ layout wins over the versioned dir, which wins over the root.
    expect(candidates.indexOf(inBin)).toBeLessThan(candidates.indexOf(inVersioned));
    expect(candidates.indexOf(inVersioned)).toBeLessThan(candidates.indexOf(inRoot));
  });
});

describe('spawn — sha256 verification', () => {
  it('accepts a matching digest and rejects a mismatch (case-insensitive hex)', () => {
    const data = Buffer.from('hello rift');
    const digest = createHash('sha256').update(data).digest('hex');
    expect(verifySha256(data, digest)).toBe(true);
    expect(verifySha256(data, digest.toUpperCase())).toBe(true);
    expect(verifySha256(data, 'deadbeef')).toBe(false);
  });
});

describe('spawn — buildSpawnArgs', () => {
  it('always sets the admin port; adds host/loglevel when given', () => {
    expect(buildSpawnArgs(2525, {})).toEqual(['--port', '2525']);
    expect(buildSpawnArgs(0, { host: '127.0.0.1', loglevel: 'debug' })).toEqual([
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      '--loglevel',
      'debug',
    ]);
  });
});

describe('spawn — resolveBinary resolution order (injected IO)', () => {
  const okPath = '/opt/rift/rift';

  it('1) returns RIFT_BINARY_PATH when set and present — no PATH/cache/download consulted', async () => {
    const lookupPath = jest.fn(() => '/should/not/be/used');
    const download = jest.fn(async () => '/downloaded');
    const got = await resolveBinary({
      env: { RIFT_BINARY_PATH: okPath },
      fileExists: (p) => p === okPath,
      lookupPath: lookupPath as unknown as (n: string) => string | null,
      download: download as unknown as (u: string, s: string | null) => Promise<string>,
    });
    expect(got).toBe(okPath);
    expect(lookupPath).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('2) falls back to a PATH lookup (that version-probes as Rift)', async () => {
    const download = jest.fn(async () => '/downloaded');
    const got = await resolveBinary({
      env: {},
      fileExists: () => false,
      lookupPath: (name) => {
        // Match any of the binary names (platform-independent)
        if (name === 'rift' || name === 'rift.exe') {
          return '/usr/local/bin/rift';
        }
        return null;
      },
      probeIsRift: () => true,
      download: download as unknown as (u: string, s: string | null) => Promise<string>,
    });
    expect(got).toBe('/usr/local/bin/rift');
    expect(download).not.toHaveBeenCalled();
  });

  it('2b) skips a PATH hit that is NOT Rift (Mountebank `mb` shadowing, #84)', async () => {
    const download = jest.fn(async () => '/downloaded');
    const probed: string[] = [];
    const got = await resolveBinary({
      env: {},
      fileExists: () => false,
      // A Homebrew Mountebank is on PATH as `mb`; nothing else matches. (On Windows the probe
      // name is `mb.exe`, so match both so the test isn't platform-fragile.)
      lookupPath: (name) => (name === 'mb' || name === 'mb.exe' ? '/opt/homebrew/bin/mb' : null),
      probeIsRift: (p) => {
        probed.push(p);
        return false; // `mb --version` -> "2.9.1", not Rift
      },
      cacheLookup: () => null,
      download: download as unknown as (u: string, s: string | null) => Promise<string>,
    });
    expect(probed).toContain('/opt/homebrew/bin/mb');
    expect(got).toBe('/downloaded'); // fell through instead of running Mountebank
  });

  it('3) uses the version+sha cache before downloading', async () => {
    const download = jest.fn(async () => '/downloaded');
    const got = await resolveBinary({
      env: {},
      version: 'v0.12.0',
      fileExists: () => false,
      lookupPath: () => null,
      cacheLookup: (v) => (v === 'v0.12.0' ? '/cache/rift-v0.12.0' : null),
      download: download as unknown as (u: string, s: string | null) => Promise<string>,
    });
    expect(got).toBe('/cache/rift-v0.12.0');
    expect(download).not.toHaveBeenCalled();
  });

  it('4) downloads (via the resolved URL) when nothing local is found', async () => {
    const download = jest.fn(async () => '/cache/rift-downloaded');
    const got = await resolveBinary({
      env: {},
      version: 'v0.12.0',
      platform: 'linux',
      arch: 'x64',
      fileExists: () => false,
      lookupPath: () => null,
      cacheLookup: () => null,
      download: download as unknown as (u: string, s: string | null) => Promise<string>,
    });
    expect(got).toBe('/cache/rift-downloaded');
    expect(download).toHaveBeenCalledTimes(1);
    const url = (download.mock.calls[0] as unknown[])[0] as string;
    expect(url).toContain('/v0.12.0/rift-v0.12.0-x86_64-unknown-linux-gnu.tar.gz');
  });

  it('air-gapped + nothing local → throws naming the override, never downloads', async () => {
    const download = jest.fn(async () => '/downloaded');
    await expect(
      resolveBinary({
        env: { RIFT_OFFLINE: '1' },
        version: 'v0.12.0',
        fileExists: () => false,
        lookupPath: () => null,
        cacheLookup: () => null,
        download: download as unknown as (u: string, s: string | null) => Promise<string>,
      })
    ).rejects.toThrow(/air-?gap|offline|RIFT_OFFLINE|RIFT_SKIP_BINARY_DOWNLOAD/i);
    expect(download).not.toHaveBeenCalled();
  });
});

describe('compat — create() surface is preserved', () => {
  it('still exports create and default.create', async () => {
    const mod = await import('../../src/index.js');
    expect(typeof mod.create).toBe('function');
    expect(typeof mod.default.create).toBe('function');
  });
});

describe('spawn — sha256 sidecar parsing + checksum enforcement', () => {
  it('parses a bare digest and a "<hex>  file" sidecar; rejects garbage', () => {
    const hex = 'a'.repeat(64);
    expect(parseSha256Sidecar(hex)).toBe(hex);
    expect(parseSha256Sidecar(`${hex}  rift-v0.12.0-x86_64-unknown-linux-gnu.tar.gz\n`)).toBe(hex);
    expect(parseSha256Sidecar('not-a-digest')).toBeNull();
  });

  it('verifies a matching sidecar, throws on mismatch, and refuses a missing checksum', async () => {
    const data = Buffer.from('rift-archive-bytes');
    const good = createHash('sha256').update(data).digest('hex');
    const okFetch = ((_url: string) =>
      Promise.resolve(new Response(`${good}  archive.tar.gz`, { status: 200 }))) as unknown as typeof fetch;
    await expect(
      fetchAndVerifyChecksum('http://x/archive.tar.gz', data, { env: {}, fetchImpl: okFetch })
    ).resolves.toBeUndefined();

    const badFetch = ((_url: string) =>
      Promise.resolve(new Response('b'.repeat(64), { status: 200 }))) as unknown as typeof fetch;
    await expect(
      fetchAndVerifyChecksum('http://x/archive.tar.gz', data, { env: {}, fetchImpl: badFetch })
    ).rejects.toThrow(/mismatch/i);

    const missingFetch = ((_url: string) =>
      Promise.resolve(new Response('', { status: 404 }))) as unknown as typeof fetch;
    await expect(
      fetchAndVerifyChecksum('http://x/archive.tar.gz', data, { env: {}, fetchImpl: missingFetch })
    ).rejects.toThrow(/refusing.*unverified|no sha-256/i);
    // opt-out lets a missing checksum through
    await expect(
      fetchAndVerifyChecksum('http://x/archive.tar.gz', data, {
        env: { RIFT_SKIP_CHECKSUM: '1' },
        fetchImpl: missingFetch,
      })
    ).resolves.toBeUndefined();
  });
});

describe('spawn — remaining env overrides', () => {
  it('honors RIFT_MIRROR_URL when RIFT_DOWNLOAD_URL is absent', () => {
    const url = binaryDownloadUrl('v0.12.0', {
      env: { RIFT_MIRROR_URL: 'https://mirror2.internal' },
      platform: 'linux',
      arch: 'x64',
    });
    expect(url.startsWith('https://mirror2.internal/')).toBe(true);
  });

  it('RIFT_SKIP_BINARY_DOWNLOAD air-gaps resolveBinary (throws, no download)', async () => {
    const download = jest.fn(async () => '/x');
    await expect(
      resolveBinary({
        env: { RIFT_SKIP_BINARY_DOWNLOAD: '1' },
        version: 'v0.12.0',
        fileExists: () => false,
        lookupPath: () => null,
        cacheLookup: () => null,
        download: download as unknown as (u: string, s: string | null) => Promise<string>,
      })
    ).rejects.toThrow(/air-?gap|RIFT_SKIP_BINARY_DOWNLOAD|offline/i);
    expect(download).not.toHaveBeenCalled();
  });
});

// --- blank admin api key (issue #96, engine rift#862) -----------------------------------------
//
// A blank `--api-key` used to switch the engine's auth gate ON and then authenticate every
// unauthenticated request. Engine >= 0.17.0 refuses to start instead; older engines still exhibit
// the open-admin-plane bug. Rejecting it in the SDK gives the same fail-closed answer on every
// engine, and names the offending option instead of surfacing a child-process exit code.

describe('spawn — blank apiKey is rejected (issue #96)', () => {
  it('buildSpawnArgs rejects an empty apiKey', () => {
    expect(() => buildSpawnArgs(2525, { apiKey: '' })).toThrow(InvalidDefinition);
  });

  it('buildSpawnArgs rejects a whitespace-only apiKey', () => {
    expect(() => buildSpawnArgs(2525, { apiKey: '   ' })).toThrow(InvalidDefinition);
    expect(() => buildSpawnArgs(2525, { apiKey: '\t\n' })).toThrow(InvalidDefinition);
  });

  it('passes a key containing spaces through untrimmed — only blank keys are invalid', () => {
    expect(buildSpawnArgs(2525, { apiKey: ' my key ' })).toEqual(
      expect.arrayContaining(['--api-key', ' my key '])
    );
  });

  it('omitting apiKey stays unchanged — no --api-key flag, no throw', () => {
    expect(buildSpawnArgs(2525, {})).not.toContain('--api-key');
  });

  it('rejects unicode whitespace, not just ASCII', () => {
    // Pins that the guard uses trim()'s full unicode reach — a hand-rolled ASCII-only "optimization"
    // would let a non-breaking space through as if it were a real key.
    expect(() => buildSpawnArgs(2525, { apiKey: ' ' })).toThrow(InvalidDefinition);
    expect(() => buildSpawnArgs(2525, { apiKey: '　' })).toThrow(InvalidDefinition);
  });

  it('spawn() rejects a blank apiKey before it resolves a binary', async () => {
    // RIFT_OFFLINE makes resolveBinary fail fast and deterministically with its own air-gap Error,
    // so InvalidDefinition here can ONLY mean the guard ran first. Without it the assertion would
    // still pass today, but by way of the host's PATH/cache/network rather than by construction.
    await expect(
      spawn({
        apiKey: '',
        binaryPath: '/nonexistent/rift-binary-issue-96',
        env: { RIFT_OFFLINE: '1' },
      })
    ).rejects.toThrow(InvalidDefinition);
  });
});
