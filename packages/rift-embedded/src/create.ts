/**
 * `rift.embedded()` wiring (issue #10): resolves the `librift_ffi` cdylib, loads the `NativeEngine`,
 * runs the version/feature preflight, and returns the same `RiftEngine` facade `rift.connect`/
 * `rift.spawn` produce — backed by `EmbeddedAdmin` (./admin.ts) instead of an HTTP client.
 *
 * `loadNativeEngine` is injectable specifically so this whole pipeline — preflight, registry, stub
 * routing, and the lazy admin-plane bridge — is unit-testable against a FAKE `NativeEngineLike` with
 * no real cdylib/koffi involved (see test/unit/embedded-admin.test.ts). The default wiring (real
 * `resolveCdylib` + `NativeEngine.load`) is only exercised by the real-cdylib integration suite,
 * which self-skips without `RIFT_FFI_LIB`.
 */

import {
  Engine,
  versionIssue,
  MIN_ENGINE_VERSION,
  assertUpstreamTrust,
  upstreamTrustServeKey,
  warnUpstreamTrustSkipVerify,
  type BuildInfo,
} from '@rift-vs/rift/internal';
import { EngineUnavailable, EngineVersionError, NativeLibraryError } from '@rift-vs/rift';
import { resolveCdylib } from '@rift-vs/rift';
import { EmbeddedInterceptBackend } from './intercept-backend.js';
import { NativeEngine } from './native.js';
import { EmbeddedAdmin, type NativeEngineLike, type StartAdminPlane } from './admin.js';

// `EmbeddedOptions` is DEFINED in core (`engine.ts`) since the #39 split: core's `rift.embedded()`
// must type its options without referencing this package (a type-import here would cycle the build
// order — core builds first). Re-exported so the package root keeps the full boundary surface.
import type { EmbeddedOptions } from '@rift-vs/rift';
export type { EmbeddedOptions };

export interface EmbeddedDeps {
  /** Injectable native-engine loader; defaults to `resolveCdylib` + `NativeEngine.load`. Supplying
   * this SKIPS `resolveCdylib` entirely — tests inject a fake loader with no real cdylib involved.
   * Note: `options.keepAlive` is forwarded only by the DEFAULT loader; an injected loader owns its
   * worker lifecycle and must handle keep-alive itself if it cares. */
  loadNativeEngine?: (libPath: string) => Promise<NativeEngineLike>;
  /** Injectable admin-plane starter, forwarded to `EmbeddedAdmin`; see `admin.ts`'s `StartAdminPlane`. */
  startAdminPlane?: StartAdminPlane;
}



/**
 * `native.buildInfo` is the FFI's build-info payload, JSON-encoded (`{version, commit?, builtAt?,
 * features[]}`) — distinct from the free-text handshake string `NativeEngine`'s own init log uses
 * internally (issue #8); this is the richer payload the version/feature preflight below needs.
 */
function parseBuildInfo(raw: string): BuildInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new NativeLibraryError(`embedded engine reported non-JSON build info: ${raw}`, { cause });
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new NativeLibraryError(`embedded engine reported malformed build info: ${raw}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['version'] !== 'string') {
    throw new NativeLibraryError(`embedded engine build info is missing "version": ${raw}`);
  }
  const features = obj['features'];
  const serveOptions = obj['serveOptions'];
  return {
    version: obj['version'],
    commit: typeof obj['commit'] === 'string' ? obj['commit'] : undefined,
    builtAt: typeof obj['builtAt'] === 'string' ? obj['builtAt'] : undefined,
    features: Array.isArray(features) ? features.filter((f): f is string => typeof f === 'string') : [],
    // Absent before engine 0.17.0; a serve option is feature-detected by presence in this list.
    serveOptions: Array.isArray(serveOptions) ? serveOptions.filter((k): k is string => typeof k === 'string') : [],
  };
}

function runVersionPreflight(buildInfo: BuildInfo, versionCheck: 'fail' | 'warn' | 'off'): void {
  if (versionCheck === 'off') return;
  const issue = versionIssue(buildInfo.version);
  if (issue === undefined) return;
  if (versionCheck === 'fail') {
    throw new EngineVersionError(buildInfo.version, MIN_ENGINE_VERSION, issue);
  }
  console.warn(`rift: ${issue}; skipping compatibility gate`);
}

function runFeaturePreflight(buildInfo: BuildInfo, requireFeatures: string[] | undefined): void {
  if (requireFeatures === undefined) return;
  const missing = requireFeatures.find((f) => !buildInfo.features.includes(f));
  if (missing === undefined) return;
  throw new EngineVersionError(
    buildInfo.version,
    MIN_ENGINE_VERSION,
    `this cdylib was built without '${missing}' — requireFeatures needs it. This is a build-variant ` +
      `property (rebuild or download a cdylib variant with '${missing}' enabled), not a version mismatch.`
  );
}

export async function createEmbeddedEngine(
  options: EmbeddedOptions = {},
  deps: EmbeddedDeps = {}
): Promise<Engine> {
  const loadNativeEngine =
    deps.loadNativeEngine ??
    ((p: string): Promise<NativeEngineLike> => NativeEngine.load(p, { keepAlive: options.keepAlive }));

  const libPath =
    deps.loadNativeEngine !== undefined
      ? (options.libPath ?? 'injected://native-engine')
      : await resolveCdylib({
          libPath: options.libPath,
          version: options.version,
          download: options.download,
          env: options.cacheDir !== undefined ? { ...process.env, RIFT_CACHE_DIR: options.cacheDir } : undefined,
        });

  const native = await loadNativeEngine(libPath);
  const buildInfo = parseBuildInfo(native.buildInfo);

  runVersionPreflight(buildInfo, options.versionCheck ?? 'fail');
  runFeaturePreflight(buildInfo, options.requireFeatures);

  const upstreamTrust = options.upstreamTrust;
  if (upstreamTrust !== undefined) {
    assertUpstreamTrust(upstreamTrust);
    // Presence, never version: an engine before 0.17.0 has no list and ignores an unknown key
    // instead of refusing it, and from 0.17.0 on the list is authoritative — so the key must be
    // advertised before it is sent.
    const key = upstreamTrustServeKey(upstreamTrust);
    const advertised = buildInfo.serveOptions ?? [];
    if (!advertised.includes(key)) {
      throw new EngineUnavailable(
        `${key} needs a rift engine >= 0.18.0; this engine advertises serveOptions [${advertised.join(', ')}]. ` +
          `Upgrade the engine, or drop upstreamTrust.`
      );
    }
    if ('skipVerify' in upstreamTrust) warnUpstreamTrustSkipVerify();
  }

  const admin = new EmbeddedAdmin({ native, buildInfo, startAdminPlane: deps.startAdminPlane, upstreamTrust });

  // The trust is installed by `rift_serve_admin` and read by an imposter's upstream client and by
  // the intercept listener when they are created — so with trust set the plane cannot stay lazy,
  // or an imposter created before the first bridge call would never see it.
  if (upstreamTrust !== undefined) {
    try {
      await admin.adminUrl();
    } catch (error) {
      // `rift_serve_admin` reads and checks the anchor during the call, so a bad path or PEM
      // fails HERE; no Engine is returned, so nothing else would ever close the native handle.
      await admin.close();
      throw error;
    }
  }

  // No `onClose` hook: `Engine.close()` already awaits `adminClient.close()` (== `admin.close()`)
  // unconditionally — there's no separate spawned process to tear down for the embedded transport.
  return new Engine(admin, 'embedded', {
    engineVersion: buildInfo.version,
    versionCheck: options.versionCheck ?? 'fail',
    buildInfo: async () => admin.buildInfo,
    adminUrl: () => admin.adminUrl(),
    interceptBackend: new EmbeddedInterceptBackend(native),
  });
}
