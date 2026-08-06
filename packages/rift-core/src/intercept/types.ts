/**
 * Shared intercept (TLS-MITM) types (issue #11).
 *
 * `InterceptOptions` is the public `engine.intercept(options?)` input, shared by all three
 * transports. `InterceptBackend` is the transport-agnostic seam every transport adapts to (embedded
 * over FFI, remote/spawn over HTTP) so `InterceptHandle` (engine.ts) is implemented exactly once and
 * is fully testable against a fake backend with no cdylib/koffi/live engine involved.
 */

/**
 * The credential the intercept proxy demands in `Proxy-Authorization` on `CONNECT` (engine
 * >= 0.17.0, rift#878).
 *
 * Two fields rather than one `"user:pass"` string: this is the shape the engine's own
 * `InterceptStartOptions.auth` takes, so it needs no transformation on the way out, and it leaves no
 * ambiguity about a username containing a colon. (The spawn door, which must colon-join the two
 * halves into `RIFT_INTERCEPT_AUTH`, is the one place that cannot represent such a username, and
 * rejects it explicitly.)
 */
export interface InterceptAuth {
  username: string;
  password: string;
}

export interface InterceptOptions {
  host?: string;
  port?: number;
  /** Both-or-neither with `caKeyPath` — enforced by `engine.ts`'s `intercept()` dispatch. */
  caCertPath?: string;
  caKeyPath?: string;
  /** Require `Proxy-Authorization: Basic <base64(user:pass)>` on `CONNECT`. Omitted leaves the
   * listener open, which is what it has always been — auth is opt-in because the listener is off
   * unless asked for and most uses are loopback test rigs. Needs engine >= 0.17.0 (issue #124). */
  auth?: InterceptAuth;
}

export interface InterceptBackend {
  startIntercept(optionsJson: string): Promise<{ interceptPort: number; interceptUrl: string }>;
  addRules(rulesJson: string): Promise<void>;
  /** Returns the current rule list as a JSON array (string) — parsed by `InterceptHandle.rules()`. */
  listRules(): Promise<string>;
  clearRules(): Promise<void>;
  caPem(): Promise<string>;
  exportTruststore(format: string, password: string, outPath: string): Promise<void>;
}
