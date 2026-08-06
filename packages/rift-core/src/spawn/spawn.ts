/**
 * Spawn transport (issue #5): launches a Rift engine as a child process and hands back a
 * connected {@link RemoteClient} bound to its (ephemeral, by default) admin port.
 *
 * Mirrors the lifecycle of `create()` in ../index.ts (resolve binary, spawn, poll until ready,
 * SIGTERM-then-SIGKILL on close) but talks to the engine over the fetch-based remote client
 * instead of the legacy axios-based `RiftServerImpl`.
 */

import { type ChildProcess, execFileSync, spawn as spawnProcess } from 'child_process';
import net from 'net';
import { RemoteClient } from '../remote/index.js';
import { EngineVersionError, InvalidDefinition } from '../errors.js';
import {
  assertApiKeyNotBlank,
  assertInterceptAuthOption,
  assertInterceptAuthValid,
  MIN_INTERCEPT_AUTH_ENGINE,
} from '../apikey.js';
import type { InterceptOptions } from '../intercept/types.js';
import { isAtLeastVersion } from '../version.js';
import { resolveBinary, type EnvRecord } from './resolve.js';

// Must be an IP literal: the engine parses `--host` into a socket address, so a hostname
// (e.g. `localhost`) aborts startup with "invalid socket address syntax".
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const HEALTH_CHECK_INTERVAL_MS = 100;

/** The subset of {@link SpawnOptions} that shapes the engine's command line. */
export interface SpawnArgsOptions {
  host?: string;
  loglevel?: string;
  allowInjection?: boolean;
  apiKey?: string;
  localOnly?: boolean;
  ipWhitelist?: string[];
  origin?: string;
  datadir?: string;
  configfile?: string;
  defaultTls?: { cert: string; key: string };
  metricsPort?: number;
  /** `auth` is deliberately absent: the credential travels on the child's ENVIRONMENT, never argv
   * (see `spawn()`), so a `buildSpawnArgs` that silently dropped it would be an
   * open-proxy-believed-guarded hazard. Making it unrepresentable beats documenting it. */
  intercept?: boolean | Omit<InterceptOptions, 'auth'>;
}

/** Builds the Rift engine CLI args for a given admin port. */
export function buildSpawnArgs(port: number, opts: SpawnArgsOptions = {}): string[] {
  assertApiKeyNotBlank(opts.apiKey);
  const args = ['--port', String(port)];
  if (opts.host) {
    args.push('--host', opts.host);
  }
  if (opts.loglevel) {
    args.push('--loglevel', opts.loglevel);
  }
  if (opts.allowInjection) {
    args.push('--allow-injection');
  }
  if (opts.apiKey !== undefined) {
    args.push('--api-key', opts.apiKey);
  }
  if (opts.localOnly) {
    args.push('--local-only');
  }
  if (opts.ipWhitelist && opts.ipWhitelist.length > 0) {
    args.push('--ip-whitelist', opts.ipWhitelist.join(','));
  }
  if (opts.origin !== undefined) {
    args.push('--origin', opts.origin);
  }
  if (opts.datadir !== undefined) {
    args.push('--datadir', opts.datadir);
  }
  if (opts.configfile !== undefined) {
    args.push('--configfile', opts.configfile);
  }
  if (opts.defaultTls !== undefined) {
    args.push('--default-tls-cert', opts.defaultTls.cert, '--default-tls-key', opts.defaultTls.key);
  }
  if (opts.metricsPort !== undefined) {
    args.push('--metrics-port', String(opts.metricsPort));
  }
  if (opts.intercept === true) {
    args.push('--intercept-port', '0');
  } else if (typeof opts.intercept === 'object' && opts.intercept !== null) {
    // Any options object enables intercept; an unspecified port means "pick an ephemeral one" (0).
    args.push('--intercept-port', String(opts.intercept.port ?? 0));
    const { caCertPath, caKeyPath } = opts.intercept;
    // Both-or-neither: a lone CA path would otherwise be silently dropped and the engine would mint
    // its own CA, ignoring the caller's — a wrong-but-quiet failure on a TLS-MITM surface. Reject it
    // loudly, mirroring validateInterceptOptions on the intercept() path.
    if ((caCertPath === undefined) !== (caKeyPath === undefined)) {
      throw new InvalidDefinition('intercept CA requires both caCertPath and caKeyPath, or neither');
    }
    if (caCertPath !== undefined && caKeyPath !== undefined) {
      args.push('--intercept-ca-cert', caCertPath, '--intercept-ca-key', caKeyPath);
    }
  }
  return args;
}

/**
 * Resolves the admin key exactly the way the engine's own clap does: an explicit `--api-key` wins,
 * and `MB_APIKEY` from the environment is the fallback
 * (`#[arg(long, value_name = "TOKEN", env = "MB_APIKEY")]`).
 *
 * The spawned child inherits this process's environment, so `MB_APIKEY` *is* engine configuration
 * whether or not the caller passed anything. Guarding only the option left two holes (issue #103):
 * a blank inherited value switched the auth gate on and then matched every unauthenticated request
 * on engines <= 0.16.x, and a non-blank one turned auth on engine-side while the SDK built its
 * client without a credential — 401ing every admin call, on every engine version.
 *
 * Because an explicit option always wins, adding the fallback cannot change behaviour for a caller
 * who passes `apiKey`.
 */
export function resolveApiKey(apiKey: string | undefined, env: EnvRecord = process.env): string | undefined {
  if (apiKey !== undefined) {
    assertApiKeyNotBlank(apiKey, 'apiKey option');
    return apiKey;
  }
  const inherited = env.MB_APIKEY;
  assertApiKeyNotBlank(inherited, 'MB_APIKEY environment variable');
  return inherited;
}

/** Injectable IO, mirroring `compat.create()`'s `CreateDeps`. It exists so the transport's own
 * wiring — that one resolved key reaches both the child and the admin client — is testable without
 * a real engine binary, in the unit lane CI actually runs. */
export interface SpawnDeps {
  spawn: typeof spawnProcess;
  resolveBinary: typeof resolveBinary;
  /** Reads a resolved binary's own version, for the intercept-auth gate below. Injectable so that
   * gate is testable without a real engine binary, in the unit lane CI actually runs. Optional so a
   * caller injecting only the other two keeps working; it defaults to {@link probeBinaryVersion}. */
  probeVersion?: (binaryPath: string) => string | undefined;
}

/**
 * `<binary> --version` prints `rift <version>`; the version is whatever semver-looking token follows.
 *
 * Returns `undefined` on any failure — not executable, no such file, a timeout, unrecognizable
 * output. Every caller treats that as "cannot confirm" and refuses, so a probe that cannot answer
 * never reads as a yes.
 */
export function probeBinaryVersion(binaryPath: string): string | undefined {
  try {
    const out = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return /(\d+\.\d+\.\d+[^\s]*)/.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

const defaultSpawnDeps: SpawnDeps = { spawn: spawnProcess, resolveBinary, probeVersion: probeBinaryVersion };

export interface SpawnOptions {
  /** Admin port to bind. Defaults to an OS-assigned ephemeral port. */
  port?: number;
  /** Bind address, passed to the engine's `--host`. Must be an IP literal (the engine rejects
   * hostnames with "invalid socket address syntax"). Default `127.0.0.1`. */
  host?: string;
  loglevel?: string;
  /** Engine version to resolve when the binary isn't already local. */
  version?: string;
  /** Explicit binary path override; beats `env.RIFT_BINARY_PATH`. */
  binaryPath?: string;
  env?: EnvRecord;
  mirror?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** --allow-injection */
  allowInjection?: boolean;
  /** --api-key (also used by the client for the Authorization header). A blank (empty or
   * whitespace-only) value throws {@link InvalidDefinition} before the binary is resolved — omit it
   * to run without admin auth.
   *
   * Omitting it falls back to the `MB_APIKEY` environment variable, mirroring the engine's own
   * precedence (this option wins, exactly as clap's flag beats its env var). That variable is read
   * from *this* process's environment, which the child inherits, and it is validated identically
   * and used for the client's `Authorization` header — so an ambient key produces a working client
   * rather than a spawn that 401s every call (issue #103). `opts.env` below is consumed by binary
   * resolution only and is never passed to the child. */
  apiKey?: string;
  /** --local-only */
  localOnly?: boolean;
  /** --ip-whitelist a,b,... */
  ipWhitelist?: string[];
  /** --origin */
  origin?: string;
  /** --datadir */
  datadir?: string;
  /** --configfile */
  configfile?: string;
  /** --default-tls-cert / --default-tls-key */
  defaultTls?: { cert: string; key: string };
  /** --metrics-port */
  metricsPort?: number;
  /** --intercept-port (+ CA paths). `true` requests an ephemeral port; `spawn()` pre-resolves it via
   * the same free-port allocator the admin port uses (see `resolveInterceptPort`), so
   * `SpawnedEngine.interceptPort` — and therefore `engine.intercept()`'s attach — always has a
   * concrete number. `buildSpawnArgs` itself still emits the engine-ephemeral literal `--intercept-port
   * 0` when called directly with no port (e.g. its own unit tests). */
  intercept?: boolean | InterceptOptions;
}

export interface SpawnedEngine {
  /** Base admin URL, e.g. `http://localhost:54321`. */
  readonly url: string;
  readonly port: number;
  /** The intercept listener's port, pre-resolved by `spawn()` — set only when `opts.intercept` was
   * truthy. */
  readonly interceptPort?: number;
  readonly client: RemoteClient;
  /** Gracefully stops the engine (SIGTERM, then SIGKILL after the shutdown timeout). */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type SpawnFn = (opts?: SpawnOptions) => Promise<SpawnedEngine>;

/** Asks the OS for a free TCP port by binding to port 0 and reading back what it chose. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate an ephemeral port'));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pre-resolves the intercept listener's port the same way the admin port is resolved above: an
 * explicit `intercept.port` wins, otherwise a free ephemeral port is allocated up front. This means
 * the SDK always knows the concrete intercept port before the child process even starts — no
 * after-the-fact discovery is needed for `engine.intercept()`'s spawn-transport attach. */
async function resolveInterceptPort(intercept: SpawnOptions['intercept']): Promise<number | undefined> {
  if (intercept === undefined || intercept === false) return undefined;
  if (intercept === true) return findFreePort();
  return intercept.port ?? findFreePort();
}

/** Polls the admin root endpoint until it responds (any response, including non-2xx, counts). */
async function waitForAdmin(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url, { method: 'GET' });
      return;
    } catch (error) {
      lastError = error;
      await sleep(HEALTH_CHECK_INTERVAL_MS);
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Rift engine did not become ready within ${timeoutMs}ms${detail}`);
}

/** Builds a promise that rejects if the child process exits (non-zero) or errors before startup completes. */
function watchForEarlyExit(proc: ChildProcess, stderr: () => string): Promise<never> {
  return new Promise<never>((_, reject) => {
    proc.once('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        reject(new Error(`Rift engine exited with code ${code}.\nStderr: ${stderr() || 'none'}`));
      } else if (signal) {
        reject(new Error(`Rift engine killed by signal ${signal}`));
      }
    });
    proc.once('error', (error) => {
      reject(new Error(`Failed to start Rift engine: ${error.message}`));
    });
  });
}

/**
 * Resolves the Rift engine binary, spawns it bound to an (ephemeral by default) admin port, and
 * waits until it responds before returning a connected client. Throws on resolution failure,
 * spawn failure, early exit, or startup timeout — never swallows.
 */
export async function spawn(opts: SpawnOptions = {}, deps: SpawnDeps = defaultSpawnDeps): Promise<SpawnedEngine> {
  const host = opts.host ?? DEFAULT_HOST;
  const startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const shutdownTimeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  // Ahead of resolveBinary: a blank key is a caller mistake, so it should not cost a binary
  // download to discover, and the engine would only report it as an opaque child-process exit.
  const apiKey = resolveApiKey(opts.apiKey);
  const interceptEnabled = opts.intercept === true || (typeof opts.intercept === 'object' && opts.intercept !== null);
  const interceptAuth = typeof opts.intercept === 'object' && opts.intercept !== null ? opts.intercept.auth : undefined;
  // Validate the option before anything is resolved, like the admin key: a credential that cannot
  // work is a caller mistake and should not cost a binary download to discover.
  assertInterceptAuthOption(interceptAuth, true);
  // Same door, same reasoning (issue #115): the child inherits RIFT_INTERCEPT_AUTH too, and the
  // engine refuses to start on a malformed one, a blank-halved one, or a valid one with no listener
  // to guard. `false` is "no listener" exactly as an absent option is.
  //
  // Skipped entirely when `auth` was passed: the option overwrites this variable on the child's
  // environment, so the ambient value is inert and refusing a spawn over it would be a false
  // positive (issue #124).
  //
  // Read once, unlike MB_APIKEY below: that one is re-checked after resolution because a value that
  // goes blank mid-download leaves the engine and the admin client disagreeing, silently. This one
  // has no such pair — the engine fails closed on it by itself, so a mid-download change costs the
  // opaque child exit this guard usually prevents rather than a wrong-but-quiet success.
  if (interceptAuth === undefined) {
    assertInterceptAuthValid(process.env.RIFT_INTERCEPT_AUTH, interceptEnabled);
  }

  const binaryPath = await deps.resolveBinary({
    version: opts.version,
    binaryPath: opts.binaryPath,
    env: opts.env,
    mirror: opts.mirror,
  });

  // A credential the engine is too old to enforce is worse than no credential: below v0.17.0 the
  // `--intercept-auth` flag does not exist, so clap never reads RIFT_INTERCEPT_AUTH and the listener
  // accepts everything while the caller believes it is guarded. The engine cannot report this — from
  // its side nothing happened.
  //
  // Probed from the BINARY, before the child is started, deliberately. Asking the running engine's
  // /config instead would be simpler, but the engine binds the intercept listener BEFORE its admin
  // plane, so by the time /config could answer, an unauthenticated MITM proxy has already been
  // accepting connections — a gate that can only shorten the exposure, not prevent it. Probing first
  // means no listener is ever started on an engine that cannot guard it.
  //
  // Only runs when `auth` was passed, so an ordinary spawn pays nothing.
  if (interceptAuth !== undefined) {
    const version = (deps.probeVersion ?? probeBinaryVersion)(binaryPath);
    // Unknown or unparseable counts as too old: a gate that cannot confirm the credential will be
    // enforced must not assume that it will.
    if (!isAtLeastVersion(version, MIN_INTERCEPT_AUTH_ENGINE)) {
      throw new EngineVersionError(
        version ?? 'unknown',
        MIN_INTERCEPT_AUTH_ENGINE,
        `intercept auth needs engine >= ${MIN_INTERCEPT_AUTH_ENGINE} (${binaryPath} reports ` +
          `${version ?? 'no recognizable version'}): older engines do not read RIFT_INTERCEPT_AUTH at ` +
          `all, so the listener would accept every request while appearing to be guarded. Pin a newer ` +
          `engine, or drop intercept.auth to start the listener explicitly unauthenticated.`
      );
    }
  }

  const port = opts.port ?? (await findFreePort());
  const interceptPort = await resolveInterceptPort(opts.intercept);
  const intercept: SpawnOptions['intercept'] =
    interceptPort === undefined
      ? opts.intercept
      : { ...(typeof opts.intercept === 'object' ? opts.intercept : {}), port: interceptPort };
  // A key that came from MB_APIKEY is deliberately NOT echoed onto the child's command line: the
  // child already inherits that variable, so `--api-key` would copy the secret into a strictly more
  // exposed channel (`/proc/<pid>/cmdline` is world-readable and argv is captured by `ps`, auditd
  // and container runtimes; the environment slot it already occupies is none of those) without
  // removing it from the original one. An explicitly-passed `apiKey` still goes on the command line
  // as it always has — and clap gives that flag precedence over the inherited variable, which is
  // what makes the option win engine-side too.
  const args = buildSpawnArgs(port, {
    host,
    loglevel: opts.loglevel,
    allowInjection: opts.allowInjection,
    apiKey: opts.apiKey,
    localOnly: opts.localOnly,
    ipWhitelist: opts.ipWhitelist,
    origin: opts.origin,
    datadir: opts.datadir,
    configfile: opts.configfile,
    defaultTls: opts.defaultTls,
    metricsPort: opts.metricsPort,
    intercept,
  });

  // The child re-reads MB_APIKEY from the environment when it execs, which is a different read from
  // the one resolveApiKey did — binary resolution can download in between. If the value moved, the
  // engine and the admin client would disagree, and a *deletion* would be worse than a mismatch: the
  // engine comes up keyless with an open admin plane while the client keeps sending the stale
  // credential, so every call succeeds and the operator believes a key is in force. Fail closed.
  if (opts.apiKey === undefined && process.env.MB_APIKEY !== apiKey) {
    throw new InvalidDefinition(
      'MB_APIKEY changed while the engine binary was being resolved, so the spawned engine and its ' +
        'admin client would not agree on the admin key. Retry the spawn.'
    );
  }

  // The intercept credential rides the child's ENVIRONMENT, not argv. Two reasons: argv is the
  // strictly more exposed channel (the same `/proc/<pid>/cmdline` reasoning as above), and unlike
  // `apiKey` this option has no historical command-line contract to preserve — so it takes the safer
  // door from the start. Overriding the inherited value here is also what makes the option beat an
  // ambient `RIFT_INTERCEPT_AUTH` without depending on clap's flag-over-env precedence.
  const childEnv =
    interceptAuth === undefined
      ? undefined
      : { ...process.env, RIFT_INTERCEPT_AUTH: `${interceptAuth.username}:${interceptAuth.password}` };

  const proc = deps.spawn(binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    ...(childEnv === undefined ? {} : { env: childEnv }),
  });

  let stderr = '';
  proc.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  const url = `http://${host}:${port}`;

  try {
    await Promise.race([waitForAdmin(url, startupTimeoutMs), watchForEarlyExit(proc, () => stderr)]);
  } catch (error) {
    proc.kill('SIGKILL');
    throw error;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Already exited (e.g. crashed after startup): nothing to signal, don't wait out the timeout.
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, shutdownTimeoutMs);
      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      proc.kill('SIGTERM');
    });
  };

  // The same resolved key the engine is running with — whether it arrived by option or by
  // inherited MB_APIKEY. Building this client without it was issue #103's second failure mode.
  const client = new RemoteClient(url, apiKey === undefined ? {} : { apiKey });

  return {
    url,
    port,
    ...(interceptPort !== undefined ? { interceptPort } : {}),
    client,
    close,
    async [Symbol.asyncDispose](): Promise<void> {
      await close();
    },
  };
}
