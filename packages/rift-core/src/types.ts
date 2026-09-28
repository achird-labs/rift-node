/**
 * TypeScript types for Rift Node.js bindings
 * Provides Mountebank-compatible API types
 */

/**
 * Redis connection options for distributed state management
 */
export interface RedisOptions {
  /** Redis server hostname */
  host: string;
  /** Redis server port */
  port: number;
  /** Redis password (optional) */
  password?: string;
  /** Enable TLS for Redis connection */
  tls_enabled?: boolean;
}

/**
 * Options for creating a Rift server instance
 * Compatible with Mountebank's mb.create() options
 */
export interface CreateOptions {
  /** Admin API port (default: 2525) */
  port?: number;
  /** Bind address (default: localhost) */
  host?: string;
  /** Log level: trace, debug, info, warn (or warning), error — engine 0.18.0 aborts startup on any
   * other value; a `RUST_LOG` in the environment supersedes it. */
  loglevel?: 'trace' | 'debug' | 'info' | 'warn' | 'warning' | 'error';
  /** Path to log file */
  logfile?: string;
  /** Accepted for Mountebank compatibility and NOT enforced by the engine (it only logs a WARN);
   * use `localOnly` / `apiKey` or a network policy to restrict access. */
  ipWhitelist?: string[];
  /**
   * Directory for imposter persistence (Mountebank `--datadir` parity). Imposters created or
   * mutated through the admin API are written as `{port}.json` under this directory and reloaded
   * when a server is started against the same `datadir`.
   */
  datadir?: string;
  /** Enable JavaScript injection via Rhai scripts */
  allowInjection?: boolean;
  /**
   * Mountebank custom imposters-repository module path. **Not supported** — Rift's engine is a
   * native binary and cannot load an in-process Node module, so `create()` throws
   * {@link UnsupportedCreateOptionError} rather than silently running in-memory. Use {@link datadir}
   * for persistence; see `docs/migration.md`.
   */
  impostersRepository?: string;
  /**
   * Mountebank custom-repository Redis config. **Not supported** — only a custom
   * {@link impostersRepository} consumes it, which Rift does not support, so `create()` throws
   * {@link UnsupportedCreateOptionError}. For distributed scenario state use per-imposter
   * `flowState()`; see `docs/migration.md`.
   */
  redis?: RedisOptions;
}

/**
 * Events a compat {@link RiftServer} re-emits from the engine child process once `create()` has
 * resolved. Startup failures reject `create()` instead.
 */
export interface RiftServerEvents {
  /** The engine process errored after startup. Node's rule for `'error'` applies: emitted with no
   * listener it throws `ERR_UNHANDLED_ERROR` and takes the host down, so subscribe when a
   * post-startup engine failure must not be fatal. */
  error: [error: Error];
  /** The engine process exited: its exit code, or the signal that ended it. */
  exit: [code: number | null, signal: NodeJS.Signals | null];
  /** A chunk of the engine's stdout. */
  stdout: [chunk: string];
  /** A chunk of the engine's stderr. */
  stderr: [chunk: string];
}

/**
 * Represents a running Rift server instance
 */
export interface RiftServer {
  /** The port the server is listening on */
  readonly port: number;
  /** The host the server is bound to */
  readonly host: string;
  /** Gracefully close the server */
  close(): Promise<void>;
  /** Subscribe to an engine process event; see {@link RiftServerEvents}. */
  on<E extends keyof RiftServerEvents>(event: E, listener: (...args: RiftServerEvents[E]) => void): this;
  /** Subscribe for the next occurrence only. */
  once<E extends keyof RiftServerEvents>(event: E, listener: (...args: RiftServerEvents[E]) => void): this;
  /** Remove a listener added with `on()` / `once()`. */
  off<E extends keyof RiftServerEvents>(event: E, listener: (...args: RiftServerEvents[E]) => void): this;
}

/**
 * Server information returned by GET /
 */
export interface ServerInfo {
  version: string;
  imposters: Array<{
    port: number;
    protocol: string;
    numberOfRequests?: number;
  }>;
}
