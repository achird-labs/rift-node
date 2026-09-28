/**
 * Gate for issue #9 — cdylib (librift_ffi) resolution for the future `@rift-vs/rift-embedded`.
 *
 * Mirrors test/unit/spawn.test.ts's injected-IO style: every filesystem/network dependency is
 * faked, and `RIFT_CACHE_DIR` pins the cache root to a fake, in-memory path so no test touches the
 * real cache dir or network. Covers, in resolution order: RIFT_FFI_LIB/libPath override (verbatim,
 * missing-file error), the sidecar-validated cache (hit / corrupt sidecar / mismatched sidecar),
 * the download flow (manifest fetch, missing classifier, non-v2 ABI, mandatory sha verification +
 * temp cleanup, atomic rename + sidecar write), air-gap (message contains filename + release URL +
 * cache dest), the concurrent-download lock, and `platformClassifier`/`classifierInfo` (all six
 * platform rows + the musl-probe injection + the linux/arm64+musl gap).
 */

import { jest } from '@jest/globals';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import {
  resolveCdylib,
  classifierInfo,
  platformClassifier,
  DEFAULT_CDYLIB_VERSION,
} from '../../src/natives/index.js';
import { NativeLibraryError } from '../../src/errors.js';
import type { NativeManifest, ResolveCdylibOptions } from '../../src/natives/index.js';

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const CLASSIFIER = 'linux-x86_64';
const FILE = `librift_ffi-${CLASSIFIER}.so`;
const FAKE_CACHE_ROOT = '/fake-cache-root';

function destPathFor(version = DEFAULT_CDYLIB_VERSION): string {
  return path.join(FAKE_CACHE_ROOT, 'rift-node', 'ffi', version, FILE);
}

/** In-memory filesystem + injected IO, matching resolveCdylib's ResolveCdylibOptions shape. */
function fakeFs() {
  const files = new Map<string, Buffer>();
  const tryLock = jest.fn(() => true);
  const unlock = jest.fn(() => {});
  const sleep = jest.fn(async () => {});
  const opts: Required<
    Pick<
      ResolveCdylibOptions,
      'env' | 'fileExists' | 'readFile' | 'writeFile' | 'mkdirp' | 'rename' | 'unlink' | 'tryLock' | 'unlock' | 'sleep'
    >
  > = {
    env: { RIFT_CACHE_DIR: FAKE_CACHE_ROOT },
    fileExists: (p) => files.has(p),
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, data) => {
      files.set(p, data);
    },
    mkdirp: () => {},
    rename: jest.fn((src: string, dest: string) => {
      const data = files.get(src);
      if (data === undefined) throw new Error(`rename: source missing: ${src}`);
      files.set(dest, data);
      files.delete(src);
    }),
    unlink: jest.fn((p: string) => {
      files.delete(p);
    }),
    tryLock,
    unlock,
    sleep,
  };
  return { files, ...opts };
}

function goodManifest(data: Buffer, overrides: Partial<NativeManifest> = {}): NativeManifest {
  return {
    version: DEFAULT_CDYLIB_VERSION,
    abi: 'v2',
    artifacts: [
      { platform: CLASSIFIER, file: FILE, sha256: sha256(data), url: 'https://example.test/lib.so' },
    ],
    ...overrides,
  };
}

const linuxX64 = { platform: 'linux', arch: 'x64', isMusl: () => false } as const;

describe('natives — RIFT_FFI_LIB / libPath override (step 1)', () => {
  it('returns the explicit path verbatim, no checksum, no cache/network consulted', async () => {
    const fetchManifest = jest.fn();
    const got = await resolveCdylib({
      libPath: '/opt/rift/librift_ffi.so',
      fileExists: (p) => p === '/opt/rift/librift_ffi.so',
      fetchManifest: fetchManifest as unknown as (u: string) => Promise<NativeManifest>,
    });
    expect(got).toBe('/opt/rift/librift_ffi.so');
    expect(fetchManifest).not.toHaveBeenCalled();
  });

  it('env.RIFT_FFI_LIB works the same way, and opts.libPath beats it', async () => {
    const got = await resolveCdylib({
      env: { RIFT_FFI_LIB: '/from/env.so' },
      fileExists: (p) => p === '/from/env.so',
    });
    expect(got).toBe('/from/env.so');

    const got2 = await resolveCdylib({
      libPath: '/explicit-wins.so',
      env: { RIFT_FFI_LIB: '/from/env.so' },
      fileExists: (p) => p === '/explicit-wins.so',
    });
    expect(got2).toBe('/explicit-wins.so');
  });

  it('throws NativeLibraryError naming the missing override path', async () => {
    await expect(
      resolveCdylib({ libPath: '/missing/librift_ffi.so', fileExists: () => false })
    ).rejects.toThrow(NativeLibraryError);
    await expect(
      resolveCdylib({ libPath: '/missing/librift_ffi.so', fileExists: () => false })
    ).rejects.toThrow(/missing\/librift_ffi\.so/);
  });
});

describe('natives — cache validation (step 2)', () => {
  it('a valid cached artifact + sidecar is returned without touching the network', async () => {
    const fs = fakeFs();
    const data = Buffer.from('cdylib-bytes');
    fs.files.set(destPathFor(), data);
    fs.files.set(`${destPathFor()}.sha256`, Buffer.from(`${sha256(data)}  ${FILE}\n`));
    const fetchManifest = jest.fn();

    const got = await resolveCdylib({
      ...linuxX64,
      env: fs.env,
      fileExists: fs.fileExists,
      readFile: fs.readFile,
      fetchManifest: fetchManifest as unknown as (u: string) => Promise<NativeManifest>,
    });

    expect(got).toBe(destPathFor());
    expect(fetchManifest).not.toHaveBeenCalled();
  });

  it('a corrupt sidecar (unparsable digest) is a miss and triggers a re-download', async () => {
    const fs = fakeFs();
    const staleData = Buffer.from('irrelevant-stale-bytes');
    fs.files.set(destPathFor(), staleData);
    fs.files.set(`${destPathFor()}.sha256`, Buffer.from('not-a-valid-sha256-digest'));

    const freshData = Buffer.from('freshly-downloaded-bytes');
    const fetchManifest = jest.fn(async (url: string) => {
      expect(url).toContain('/ffi-manifest.json');
      return goodManifest(freshData);
    });
    const fetchArtifact = jest.fn(async () => freshData);

    const got = await resolveCdylib({
      ...linuxX64,
      env: fs.env,
      fileExists: fs.fileExists,
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      mkdirp: fs.mkdirp,
      rename: fs.rename,
      unlink: fs.unlink,
      tryLock: fs.tryLock,
      unlock: fs.unlock,
      fetchManifest,
      fetchArtifact,
    });

    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect(got).toBe(destPathFor());
    expect(fs.files.get(got)).toEqual(freshData);
  });

  it('a mismatched sidecar (digest does not match the cached bytes) is a miss and re-downloads', async () => {
    const fs = fakeFs();
    const staleData = Buffer.from('stale-bytes-that-were-corrupted');
    fs.files.set(destPathFor(), staleData);
    // Sidecar digest doesn't match staleData's actual hash (simulates a torn/corrupted write).
    fs.files.set(`${destPathFor()}.sha256`, Buffer.from(`${'a'.repeat(64)}  ${FILE}\n`));

    const freshData = Buffer.from('fresh-bytes');
    const fetchManifest = jest.fn(async () => goodManifest(freshData));
    const fetchArtifact = jest.fn(async () => freshData);

    const got = await resolveCdylib({
      ...linuxX64,
      env: fs.env,
      fileExists: fs.fileExists,
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      mkdirp: fs.mkdirp,
      rename: fs.rename,
      unlink: fs.unlink,
      tryLock: fs.tryLock,
      unlock: fs.unlock,
      fetchManifest,
      fetchArtifact,
    });

    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect(got).toBe(destPathFor());
    expect(fs.files.get(got)).toEqual(freshData);
  });
});

describe('natives — download flow (step 4)', () => {
  it('fetches the manifest, verifies the sha256, and atomically writes the cache + sidecar', async () => {
    const fs = fakeFs();
    const data = Buffer.from('good-cdylib-bytes');
    const fetchManifest = jest.fn(async (url: string) => {
      expect(url).toContain('/releases/download/');
      expect(url).toContain(`/${DEFAULT_CDYLIB_VERSION}/ffi-manifest.json`);
      return goodManifest(data);
    });
    const fetchArtifact = jest.fn(async (url: string) => {
      expect(url).toBe('https://example.test/lib.so');
      return data;
    });

    const got = await resolveCdylib({
      ...linuxX64,
      env: fs.env,
      fileExists: fs.fileExists,
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      mkdirp: fs.mkdirp,
      rename: fs.rename,
      unlink: fs.unlink,
      tryLock: fs.tryLock,
      unlock: fs.unlock,
      fetchManifest,
      fetchArtifact,
    });

    expect(got).toBe(destPathFor());
    expect(fs.files.get(got)).toEqual(data);
    expect(fs.files.get(`${got}.sha256`)?.toString('utf8')).toContain(sha256(data));
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(fs.unlock).toHaveBeenCalledTimes(1);
    expect(fs.tryLock).toHaveBeenCalledTimes(1);
  });

  it('sha256 mismatch throws NativeLibraryError and deletes the temp file (mandatory, no skip flag)', async () => {
    const fs = fakeFs();
    const goodData = Buffer.from('correct-bytes');
    const tamperedData = Buffer.from('tampered-in-transit');
    const fetchManifest = jest.fn(async () => goodManifest(goodData));
    const fetchArtifact = jest.fn(async () => tamperedData);

    await expect(
      resolveCdylib({
        ...linuxX64,
        env: fs.env,
        fileExists: fs.fileExists,
        readFile: fs.readFile,
        writeFile: fs.writeFile,
        mkdirp: fs.mkdirp,
        rename: fs.rename,
        unlink: fs.unlink,
        tryLock: fs.tryLock,
        unlock: fs.unlock,
        fetchManifest,
        fetchArtifact,
      })
    ).rejects.toBeDefined();
    const err = await resolveCdylib({
      ...linuxX64,
      env: fs.env,
      fileExists: fs.fileExists,
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      mkdirp: fs.mkdirp,
      rename: fs.rename,
      unlink: fs.unlink,
      tryLock: fs.tryLock,
      unlock: fs.unlock,
      fetchManifest,
      fetchArtifact,
    }).then(() => new Error('resolveCdylib resolved; expected a rejection'), (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(NativeLibraryError); // type + message both asserted
    expect(err.message).toMatch(/checksum mismatch/i);

    expect(fs.files.has(destPathFor())).toBe(false);
    const tmpEntries = [...fs.files.keys()].filter((k) => k.includes('.tmp-'));
    expect(tmpEntries).toEqual([]); // the temp file was written, then deleted on mismatch
    expect(fs.unlock).toHaveBeenCalledTimes(2); // once per resolve attempt above
  });

  it('manifest missing this platform lists the available classifiers', async () => {
    const fs = fakeFs();
    const data = Buffer.from('bytes');
    const fetchManifest = jest.fn(async () => ({
      version: DEFAULT_CDYLIB_VERSION,
      abi: 'v2',
      artifacts: [
        { platform: 'darwin-aarch64', file: 'librift_ffi-darwin-aarch64.dylib', sha256: sha256(data), url: 'x' },
        { platform: 'windows-x86_64', file: 'librift_ffi-windows-x86_64.dll', sha256: sha256(data), url: 'y' },
      ],
    }));
    const resolve = () =>
      resolveCdylib({
        ...linuxX64,
        env: fs.env,
        fileExists: fs.fileExists,
        readFile: fs.readFile,
        mkdirp: fs.mkdirp,
        tryLock: fs.tryLock,
        unlock: fs.unlock,
        fetchManifest,
      });

    await expect(resolve()).rejects.toThrow(NativeLibraryError);
    await expect(resolve()).rejects.toThrow(/darwin-aarch64/);
    await expect(resolve()).rejects.toThrow(/windows-x86_64/);
  });

  it('a non-"v2" ABI throws with a version-pin hint', async () => {
    const fs = fakeFs();
    const fetchManifest = jest.fn(async () => ({ version: DEFAULT_CDYLIB_VERSION, abi: 'v3', artifacts: [] }));
    const resolve = () =>
      resolveCdylib({
        ...linuxX64,
        env: fs.env,
        fileExists: fs.fileExists,
        readFile: fs.readFile,
        mkdirp: fs.mkdirp,
        tryLock: fs.tryLock,
        unlock: fs.unlock,
        fetchManifest,
      });

    await expect(resolve()).rejects.toThrow(NativeLibraryError);
    await expect(resolve()).rejects.toThrow(/abi/i);
    await expect(resolve()).rejects.toThrow(/minEngineVersion|pin/i);
  });
});

describe('natives — air-gap (step 3)', () => {
  it.each(['RIFT_OFFLINE', 'RIFT_SKIP_BINARY_DOWNLOAD'])(
    '%s throws with the filename + release URL + cache destination',
    async (envKey) => {
      const fs = fakeFs();
      await expect(
        resolveCdylib({
          ...linuxX64,
          env: { ...fs.env, [envKey]: '1' },
          fileExists: fs.fileExists,
          readFile: fs.readFile,
        })
      ).rejects.toMatchObject({
        message: expect.stringContaining(FILE) as unknown as string,
      });
      const err = await resolveCdylib({
        ...linuxX64,
        env: { ...fs.env, [envKey]: '1' },
        fileExists: fs.fileExists,
        readFile: fs.readFile,
      }).then(() => new Error('resolveCdylib resolved; expected a rejection'), (e: unknown) => e as Error);
      expect(err.message).toContain('releases/download');
      expect(err.message).toContain(DEFAULT_CDYLIB_VERSION);
      expect(err.message).toContain(destPathFor());
      // The manual-install URL must point at the cdylib ASSET, not the manifest JSON — a user
      // copy-pasting it must fetch the library itself.
      expect(err.message).toContain(`/releases/download/${DEFAULT_CDYLIB_VERSION}/${FILE}`);
      expect(err.message).not.toContain('ffi-manifest.json');
      expect(err).toBeInstanceOf(NativeLibraryError);
    }
  );

  it('opts.download === false also refuses the network unconditionally', async () => {
    const fs = fakeFs();
    const fetchManifest = jest.fn();
    await expect(
      resolveCdylib({
        ...linuxX64,
        download: false,
        env: fs.env,
        fileExists: fs.fileExists,
        readFile: fs.readFile,
        fetchManifest: fetchManifest as unknown as (u: string) => Promise<NativeManifest>,
      })
    ).rejects.toThrow(NativeLibraryError);
    expect(fetchManifest).not.toHaveBeenCalled();
  });
});

describe('natives — concurrent-resolution lock', () => {
  it('when the lock is already held, waits and revalidates the cache instead of double-downloading', async () => {
    const fs = fakeFs();
    const data = Buffer.from('winner-bytes');
    let pollCount = 0;
    const fetchManifest = jest.fn();

    const got = await resolveCdylib({
      ...linuxX64,
      env: fs.env,
      tryLock: () => false, // another resolver holds the lock
      unlock: fs.unlock,
      sleep: async () => {
        pollCount += 1;
        // Simulate the lock-holder finishing its download after a couple of poll cycles.
        if (pollCount === 2) {
          fs.files.set(destPathFor(), data);
          fs.files.set(`${destPathFor()}.sha256`, Buffer.from(`${sha256(data)}  ${FILE}\n`));
        }
      },
      fileExists: fs.fileExists,
      readFile: fs.readFile,
      mkdirp: fs.mkdirp,
      fetchManifest: fetchManifest as unknown as (u: string) => Promise<NativeManifest>,
      lockPollAttempts: 10,
      lockPollIntervalMs: 0,
    });

    expect(got).toBe(destPathFor());
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  it('gives up after exhausting the poll budget', async () => {
    const fs = fakeFs();
    await expect(
      resolveCdylib({
        ...linuxX64,
        env: fs.env,
        tryLock: () => false,
        fileExists: () => false,
        readFile: fs.readFile,
        mkdirp: fs.mkdirp,
        sleep: async () => {},
        lockPollAttempts: 3,
        lockPollIntervalMs: 0,
      })
    ).rejects.toThrow(/timed out|lock/i);
  });

  it('releases the lock in a finally, even when the download throws', async () => {
    const fs = fakeFs();
    const fetchManifest = jest.fn(async () => {
      throw new Error('network blip');
    });
    await expect(
      resolveCdylib({
        ...linuxX64,
        env: fs.env,
        fileExists: fs.fileExists,
        readFile: fs.readFile,
        mkdirp: fs.mkdirp,
        tryLock: fs.tryLock,
        unlock: fs.unlock,
        fetchManifest,
      })
    ).rejects.toThrow(/network blip/);
    expect(fs.unlock).toHaveBeenCalledTimes(1);
  });
});

describe('natives — win32 cache-dir special-case (issue #13)', () => {
  const LOCALAPPDATA = '/fake-localappdata';
  const WIN_FILE = 'librift_ffi-windows-x86_64.dll';
  const win32X64 = { platform: 'win32', arch: 'x64', isMusl: () => false } as const;

  /** A pre-populated cache hit at `destPath`, so a successful `resolveCdylib` resolution (with no
   * network call) proves the resolver computed exactly that path — pinning `cacheDirFor`'s choice
   * of cache root without reaching into its internals. */
  function cacheHitAt(destPath: string, data: Buffer, file: string) {
    const files = new Map<string, Buffer>([
      [destPath, data],
      [`${destPath}.sha256`, Buffer.from(`${sha256(data)}  ${file}\n`)],
    ]);
    return {
      fileExists: (p: string) => files.has(p),
      readFile: (p: string) => files.get(p) ?? null,
    };
  }

  it('win32 + LOCALAPPDATA set resolves under <LOCALAPPDATA>/rift-node', async () => {
    const data = Buffer.from('win32-localappdata-bytes');
    const destPath = path.join(LOCALAPPDATA, 'rift-node', 'ffi', DEFAULT_CDYLIB_VERSION, WIN_FILE);
    const { fileExists, readFile } = cacheHitAt(destPath, data, WIN_FILE);
    const fetchManifest = jest.fn();

    const got = await resolveCdylib({
      ...win32X64,
      env: { LOCALAPPDATA },
      fileExists,
      readFile,
      fetchManifest: fetchManifest as unknown as (u: string) => Promise<NativeManifest>,
    });

    expect(got).toBe(destPath);
    expect(fetchManifest).not.toHaveBeenCalled();
  });

  it('win32 without LOCALAPPDATA falls back to ~/.cache, same as every other platform', async () => {
    const data = Buffer.from('win32-no-localappdata-bytes');
    const destPath = path.join(os.homedir(), '.cache', 'rift-node', 'ffi', DEFAULT_CDYLIB_VERSION, WIN_FILE);
    const { fileExists, readFile } = cacheHitAt(destPath, data, WIN_FILE);

    const got = await resolveCdylib({ ...win32X64, env: {}, fileExists, readFile });

    expect(got).toBe(destPath);
  });

  it('non-win32 platforms ignore LOCALAPPDATA even when it is set', async () => {
    const data = Buffer.from('darwin-ignores-localappdata-bytes');
    const file = 'librift_ffi-darwin-aarch64.dylib';
    const destPath = path.join(os.homedir(), '.cache', 'rift-node', 'ffi', DEFAULT_CDYLIB_VERSION, file);
    const { fileExists, readFile } = cacheHitAt(destPath, data, file);

    const got = await resolveCdylib({
      platform: 'darwin',
      arch: 'arm64',
      env: { LOCALAPPDATA },
      fileExists,
      readFile,
    });

    expect(got).toBe(destPath);
  });

  it('RIFT_CACHE_DIR beats LOCALAPPDATA on win32', async () => {
    const data = Buffer.from('rift-cache-dir-wins-bytes');
    const destPath = path.join('/fake-rift-cache-dir', 'rift-node', 'ffi', DEFAULT_CDYLIB_VERSION, WIN_FILE);
    const { fileExists, readFile } = cacheHitAt(destPath, data, WIN_FILE);

    const got = await resolveCdylib({
      ...win32X64,
      env: { RIFT_CACHE_DIR: '/fake-rift-cache-dir', LOCALAPPDATA },
      fileExists,
      readFile,
    });

    expect(got).toBe(destPath);
  });

  it('XDG_CACHE_HOME beats LOCALAPPDATA on win32', async () => {
    const data = Buffer.from('xdg-cache-home-wins-bytes');
    const destPath = path.join('/fake-xdg-cache-home', 'rift-node', 'ffi', DEFAULT_CDYLIB_VERSION, WIN_FILE);
    const { fileExists, readFile } = cacheHitAt(destPath, data, WIN_FILE);

    const got = await resolveCdylib({
      ...win32X64,
      env: { XDG_CACHE_HOME: '/fake-xdg-cache-home', LOCALAPPDATA },
      fileExists,
      readFile,
    });

    expect(got).toBe(destPath);
  });
});

describe('natives — platformClassifier / classifierInfo', () => {
  it.each([
    ['linux', 'x64', false, 'linux-x86_64', '.so'],
    ['linux', 'x64', true, 'linux-x86_64-musl', '.so'],
    ['linux', 'arm64', false, 'linux-aarch64', '.so'],
    ['darwin', 'x64', false, 'darwin-x86_64', '.dylib'],
    ['darwin', 'arm64', false, 'darwin-aarch64', '.dylib'],
    ['win32', 'x64', false, 'windows-x86_64', '.dll'],
  ])('%s/%s (musl=%s) -> %s (%s)', (platform, arch, musl, classifier, ext) => {
    const info = classifierInfo({ platform, arch, isMusl: () => musl as boolean });
    expect(info.classifier).toBe(classifier);
    expect(info.ext).toBe(ext);
    expect(info.file).toBe(`librift_ffi-${classifier}${ext}`);
  });

  it('platformClassifier is a thin string-returning wrapper', () => {
    expect(platformClassifier('darwin', 'arm64')).toBe('darwin-aarch64');
  });

  it('linux/arm64 + musl (e.g. Alpine on arm64) has no published cdylib and throws', () => {
    expect(() => classifierInfo({ platform: 'linux', arch: 'arm64', isMusl: () => true })).toThrow(
      NativeLibraryError
    );
    expect(() => classifierInfo({ platform: 'linux', arch: 'arm64', isMusl: () => true })).toThrow(
      /musl|alpine/i
    );
  });

  it('an unsupported platform/arch throws', () => {
    expect(() => classifierInfo({ platform: 'sunos', arch: 'sparc' })).toThrow(NativeLibraryError);
  });

  it('the musl probe is injectable (not hard-coded to the real Node runtime)', () => {
    const probe = jest.fn(() => true);
    const info = classifierInfo({ platform: 'linux', arch: 'x64', isMusl: probe });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(info.classifier).toBe('linux-x86_64-musl');
  });
});
