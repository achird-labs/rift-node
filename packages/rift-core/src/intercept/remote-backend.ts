/**
 * Remote/spawn `InterceptBackend` adapter (issue #11).
 *
 * Both transports ATTACH to an intercept listener the engine's operator already started — at spawn
 * time through `--intercept-port` (+ CA/auth flags), or however a remote engine was launched. The
 * SDK does not start or reconfigure a TLS-intercepting listener on an engine it did not start; that
 * is a deployment decision (the engine models its exposure policy the same way — an operator flag,
 * not a request field). So `startIntercept` here never starts anything:
 * startup-only options (`auth`, `caCertPath`/`caKeyPath`) never reach it, because the guard in
 * `engine.ts` refuses them first, and what arrives is the attach point `{host, port}` `engine.ts`
 * resolved — from the spawn flags, from the caller's explicit `port`, or from `GET /intercept`.
 *
 * With `probe` on (the default) it confirms the listener through `GET /intercept/rules`, the one
 * route every engine at the 0.12.0 floor answers; a 404 surfaces as `ImposterNotFound` and
 * `engine.ts` maps it to the documented `InterceptUnavailable`. `engine.ts` turns the probe off when
 * it already proved liveness through `GET /intercept`, so an attach is one HTTP call, never two.
 */

import { hostForUrl } from '../host.js';
import type { RemoteClient } from '../remote/client.js';
import type { InterceptBackend } from './types.js';

export class RemoteInterceptBackend implements InterceptBackend {
  constructor(
    private readonly client: RemoteClient,
    private readonly opts: { probe?: boolean } = {}
  ) {}

  async startIntercept(optionsJson: string): Promise<{ interceptPort: number; interceptUrl: string }> {
    const { host, port } = JSON.parse(optionsJson) as { host: string; port: number };
    if (this.opts.probe !== false) await this.client.interceptListRules();
    return { interceptPort: port, interceptUrl: `http://${hostForUrl(host)}:${port}` };
  }

  async addRules(rulesJson: string): Promise<void> {
    await this.client.interceptAddRules(rulesJson);
  }

  async listRules(): Promise<string> {
    return this.client.interceptListRules();
  }

  async clearRules(): Promise<void> {
    await this.client.interceptClearRules();
  }

  async caPem(): Promise<string> {
    return this.client.interceptCaPem();
  }

  /** `'pkcs12'` maps to the `.p12` route extension; other formats (`'jks'`) pass through verbatim. */
  async exportTruststore(format: string, password: string, outPath: string): Promise<void> {
    const ext = format === 'pkcs12' ? 'p12' : format;
    await this.client.interceptExportTruststore(ext, password, outPath);
  }
}
