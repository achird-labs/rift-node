/**
 * Mountebank-compatible `create()` layer — a permanent, first-class compat surface.
 *
 * This is a drop-in replacement for Mountebank's `mb.create()`: it spawns the Rift binary as a
 * child process and returns a {@link RiftServer} handle. It deliberately preserves the historical
 * contract — including its quirks — so existing `@rift-vs/rift` and Mountebank users upgrade without
 * rewrites. New code should prefer the typed DSL + transports (`rift.spawn()` / `rift.connect()` /
 * `rift.embedded()`).
 *
 * @example
 * ```ts
 * import { create } from '@rift-vs/rift/compat';
 * const server = await create({ port: 2525 });
 * await server.close();
 * ```
 */

import { spawn as spawnProcess, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { findBinary } from '../binary.js';
import { resolveBinary } from '../spawn/resolve.js';
import { resolveApiKey } from '../spawn/spawn.js';
import { UnsupportedCreateOptionError } from '../errors.js';
import type { CreateOptions, RiftServer } from '../types.js';

const DEFAULT_PORT = 2525;
const DEFAULT_HOST = 'localhost';
const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 100;
const SHUTDOWN_TIMEOUT_MS = 5000;

/** Internal implementation of {@link RiftServer}. */
class RiftServerImpl extends EventEmitter implements RiftServer {
  public readonly port: number;
  public readonly host: string;
  private process: ChildProcess | null;
  private isClosed = false;

  constructor(port: number, host: string, process: ChildProcess) {
    super();
    this.port = port;
    this.host = host;
    this.process = process;

    process.on('exit', (code, signal) => this.emit('exit', code, signal));
    process.on('error', (error) => this.emit('error', error));
    process.stdout?.on('data', (data) => this.emit('stdout', data.toString()));
    process.stderr?.on('data', (data) => this.emit('stderr', data.toString()));
  }

  /** Gracefully close the server (SIGTERM, then SIGKILL after a timeout). Idempotent. */
  async close(): Promise<void> {
    if (this.isClosed || !this.process) {
      return;
    }
    this.isClosed = true;
    const proc = this.process;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill('SIGTERM');
    });
  }
}

/** Build CLI arguments from {@link CreateOptions}. */
function buildCliArgs(options: CreateOptions): string[] {
  const args: string[] = [];
  args.push('--port', String(options.port || DEFAULT_PORT));
  if (options.host) {
    args.push('--host', options.host);
  }
  if (options.loglevel) {
    args.push('--loglevel', options.loglevel);
  }
  if (options.logfile) {
    args.push('--log', options.logfile);
  }
  if (options.datadir) {
    args.push('--datadir', options.datadir);
  }
  if (options.allowInjection) {
    args.push('--allow-injection');
  }
  if (options.ipWhitelist && options.ipWhitelist.length > 0) {
    args.push('--ip-whitelist', options.ipWhitelist.join(','));
  }
  return args;
}

/**
 * Reject {@link CreateOptions} that Rift's engine cannot honor, before any process is spawned.
 * `impostersRepository` is a Node in-process module the native engine cannot load; `redis` is
 * meaningful only to such a module. Silently ignoring either would run an in-memory, single-process
 * server while the caller believed persistence/topology were configured — a wrong-but-quiet result.
 */
function rejectUnsupportedOptions(options: CreateOptions): void {
  if (options.impostersRepository !== undefined) {
    throw new UnsupportedCreateOptionError(
      'impostersRepository',
      "create({ impostersRepository }) is not supported: Rift's engine is a native binary and " +
        'cannot load a Node repository module. Use `datadir` for imposter persistence and ' +
        'per-imposter `_rift.flowState` (the DSL `flowState()`) for distributed scenario state. ' +
        'See docs/migration.md "Persistence & distributed state".'
    );
  }
  if (options.redis !== undefined) {
    throw new UnsupportedCreateOptionError(
      'redis',
      'create({ redis }) is not supported: it only configures a custom impostersRepository, which ' +
        "Rift does not support. For distributed flow state use per-imposter " +
        "`_rift.flowState.backend: 'redis'` (the DSL `flowState()`). " +
        'See docs/migration.md "Persistence & distributed state".'
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll the server root until it responds, or the timeout elapses.
 *
 * @internal Exported for testing.
 *
 * Preserves the historical readiness semantics: **any** HTTP response — including an error status —
 * means the server is up. `fetch` only rejects on a transport failure (e.g. connection refused), so
 * a returned `Response` of any status resolves this immediately; a rejection means retry.
 */
export async function waitForServer(host: string, port: number, timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  const url = `http://${host}:${port}/`;
  let lastError: unknown;

  while (Date.now() - startTime < timeoutMs) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return;
    } catch (err) {
      // Any transport rejection means "not up yet" — retry. Retain the reason for the final throw so
      // a misconfigured host (e.g. ENOTFOUND) is diagnosable instead of a bare "did not start".
      lastError = err;
      await sleep(HEALTH_CHECK_INTERVAL_MS);
    }
  }

  const detail = lastError ? ` (last error: ${String(lastError)})` : '';
  throw new Error(`Rift server did not start within ${timeoutMs}ms${detail}`);
}

/**
 * Resolve the engine binary for `create()`.
 *
 * Preserves the legacy discovery order for any locally-present binary (`findBinary()`), then falls
 * through to the reworked resolver's version cache + on-demand download whose checksum/air-gap
 * errors propagate rather than being masked.
 */
async function resolveEngineBinary(): Promise<string> {
  try {
    return await findBinary();
  } catch {
    // Nothing found locally — fall through to the cache/download resolver.
  }
  return await resolveBinary();
}

/**
 * @internal Injectable so `create()`'s process spawn and binary resolution are unit-testable with
 * fakes (same seam pattern as `testkit/core.ts`'s `AcquireEngineDeps`) — no real binary involved.
 */
export interface CreateDeps {
  spawn: typeof spawnProcess;
  resolveEngineBinary: () => Promise<string>;
}

const defaultDeps: CreateDeps = { spawn: spawnProcess, resolveEngineBinary };

/**
 * Create a Rift server, Mountebank-`mb.create()`-compatibly.
 *
 * @param options Server configuration. `impostersRepository` and `redis` are rejected with
 *   {@link UnsupportedCreateOptionError} — Rift's native engine cannot load an in-process Node
 *   repository module; configure `datadir` for persistence and per-imposter `flowState()` for
 *   distributed scenario state (see `docs/migration.md`).
 * @returns A {@link RiftServer} handle.
 * @throws {UnsupportedCreateOptionError} when `impostersRepository` or `redis` is set.
 */
export async function create(
  options: CreateOptions = {},
  deps: CreateDeps = defaultDeps
): Promise<RiftServer> {
  rejectUnsupportedOptions(options);
  // The child inherits this process's environment wholesale (no `env` below), so an ambient
  // MB_APIKEY is engine configuration whether the caller meant it as such or not — and a blank one
  // opens the admin plane on engines <= 0.16.x. Checked before resolving a binary so a caller
  // mistake costs no download. The result is unused: create() builds no admin client.
  resolveApiKey(undefined);
  const port = options.port || DEFAULT_PORT;
  const host = options.host || DEFAULT_HOST;
  const args = buildCliArgs(options);

  const binaryPath = await deps.resolveEngineBinary();

  const proc = deps.spawn(binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let stderr = '';
  const onStderrData = (data: Buffer | string): void => {
    stderr += data.toString();
  };
  proc.stderr?.on('data', onStderrData);

  let onSpawnError!: (error: Error) => void;
  const spawnErrorPromise = new Promise<never>((_, reject) => {
    onSpawnError = (error: Error) => reject(new Error(`Failed to start Rift: ${error.message}`));
    proc.once('error', onSpawnError);
  });

  let onEarlyExit!: (code: number | null, signal: NodeJS.Signals | null) => void;
  const earlyExitPromise = new Promise<never>((_, reject) => {
    onEarlyExit = (code, signal) => {
      if (code !== null && code !== 0) {
        reject(new Error(`Rift process exited with code ${code}.\nStderr: ${stderr || 'none'}`));
      } else if (signal) {
        reject(
          new Error(`Rift process killed by signal ${signal}.\nStderr: ${stderr || 'none'}`)
        );
      } else {
        reject(
          new Error(`Rift process exited with code 0 during startup.\nStderr: ${stderr || 'none'}`)
        );
      }
    };
    proc.once('exit', onEarlyExit);
  });

  try {
    await Promise.race([
      waitForServer(host, port, STARTUP_TIMEOUT_MS),
      earlyExitPromise,
      spawnErrorPromise,
    ]);
  } catch (error) {
    proc.kill('SIGKILL');
    throw error;
  }

  // The startup-scoped listeners must not linger: after a successful startup, child 'error'/'exit'
  // events belong to RiftServerImpl's re-emitting handlers (`server.on('error' | 'exit', ...)`).
  // (`Promise.race` already subscribed to both promises, so a late rejection could never surface as
  // an unhandled rejection either way — removal just keeps the ownership handoff explicit.)
  proc.off('error', onSpawnError);
  proc.off('exit', onEarlyExit);
  proc.stderr?.off('data', onStderrData);

  return new RiftServerImpl(port, host, proc);
}

export type { CreateOptions, RedisOptions, RiftServer } from '../types.js';

export default { create };
