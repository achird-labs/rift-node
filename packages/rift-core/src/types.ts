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
 * Represents a running Rift server instance
 */
export interface RiftServer {
  /** The port the server is listening on */
  readonly port: number;
  /** The host the server is bound to */
  readonly host: string;
  /** Gracefully close the server */
  close(): Promise<void>;
}

/**
 * Mountebank imposter stub predicate
 */
export interface Predicate {
  equals?: Record<string, unknown>;
  deepEquals?: Record<string, unknown>;
  contains?: Record<string, unknown>;
  startsWith?: Record<string, unknown>;
  endsWith?: Record<string, unknown>;
  matches?: Record<string, unknown>;
  exists?: Record<string, unknown>;
  not?: Predicate;
  or?: Predicate[];
  and?: Predicate[];
  inject?: string;
}

/**
 * Mountebank imposter stub response
 */
export interface Response {
  is?: {
    statusCode?: number;
    headers?: Record<string, string>;
    body?: string | Record<string, unknown>;
  };
  proxy?: {
    to: string;
    mode?: 'proxyOnce' | 'proxyAlways' | 'proxyTransparent';
    predicateGenerators?: Array<{
      matches: Record<string, unknown>;
    }>;
  };
  inject?: string;
  _behaviors?: {
    wait?: number;
    repeat?: number;
    copy?: Array<{
      from: string;
      into: string;
      using: { method: string; selector: string };
    }>;
    decorate?: string;
  };
}

/**
 * Mountebank imposter stub
 */
export interface Stub {
  predicates?: Predicate[];
  responses: Response[];
}

/**
 * Mountebank imposter configuration
 */
export interface ImposterConfig {
  port: number;
  protocol: 'http' | 'https' | 'tcp' | 'smtp';
  name?: string;
  stubs?: Stub[];
  defaultResponse?: Response;
  allowCORS?: boolean;
  recordRequests?: boolean;
}

/**
 * Mountebank imposter with runtime state
 */
export interface Imposter extends ImposterConfig {
  numberOfRequests?: number;
  requests?: unknown[];
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
