/**
 * Spawn transport (issue #5): launches a Rift engine as a child process and hands back a
 * connected {@link RemoteClient} bound to its (ephemeral, by default) admin port.
 *
 * Mirrors the lifecycle of `create()` in ../index.ts (resolve binary, spawn, poll until ready,
 * SIGTERM-then-SIGKILL on close) but talks to the engine over the fetch-based remote client
 * instead of the legacy axios-based `RiftServerImpl`.
 */

import { type ChildProcess, spawn as spawnProcess } from 'child_process';
import net from 'net';
import { RemoteClient } from '../remote/index.js';
import { InvalidDefinition } from '../errors.js';
import { assertApiKeyNotBlank } from '../apikey.js';
import type { InterceptOptions } from '../intercept/types.js';
import { resolveBinary, type EnvRecord } from './resolve.js';

// Must be an IP literal: the engine parses `--host` into a socket address, so a hostname
// (e.g. `localhost`) aborts startup with "invalid socket address syntax".
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const HEALTH_CHECK_INTERVAL_MS = 100;

/** Builds the Rift engine CLI args for a given admin port. */
export function buildSpawnArgs(
  port: number,
  opts: {
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
    intercept?: boolean | InterceptOptions;
  } = {}
): string[] {
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
   * The engine also honours an `MB_APIKEY` env var, which the child inherits from *this* process
   * (`opts.env` below is consumed by binary resolution only and is not passed to the child). That
   * door is not guarded here; on engine v0.17.0+ a blank value there fails the engine's own
   * startup validation. */
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
export async function spawn(opts: SpawnOptions = {}): Promise<SpawnedEngine> {
  const host = opts.host ?? DEFAULT_HOST;
  const startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const shutdownTimeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  // Ahead of resolveBinary: a blank key is a caller mistake, so it should not cost a binary
  // download to discover, and the engine would only report it as an opaque child-process exit.
  assertApiKeyNotBlank(opts.apiKey);

  const binaryPath = await resolveBinary({
    version: opts.version,
    binaryPath: opts.binaryPath,
    env: opts.env,
    mirror: opts.mirror,
  });

  const port = opts.port ?? (await findFreePort());
  const interceptPort = await resolveInterceptPort(opts.intercept);
  const intercept: SpawnOptions['intercept'] =
    interceptPort === undefined
      ? opts.intercept
      : { ...(typeof opts.intercept === 'object' ? opts.intercept : {}), port: interceptPort };
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

  const proc = spawnProcess(binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
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

  return {
    url,
    port,
    ...(interceptPort !== undefined ? { interceptPort } : {}),
    client: new RemoteClient(url, opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    close,
    async [Symbol.asyncDispose](): Promise<void> {
      await close();
    },
  };
}
