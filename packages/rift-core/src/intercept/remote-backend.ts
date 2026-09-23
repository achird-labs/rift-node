/**
 * Remote/spawn `InterceptBackend` adapter (issue #11).
 *
 * Both transports ATTACH to an intercept listener started out-of-process (via the engine's
 * `--intercept-port` CLI flag) rather than starting one in-process — there is no runtime "start
 * intercept" HTTP endpoint yet (rift#493 tracks it upstream). So `startIntercept` here never starts
 * anything server-side: it confirms the admin API's `/intercept/*` routes are live — a 404 there is
 * the documented "not started with --intercept-port" signal, surfaced as `ImposterNotFound` by
 * `RemoteClient`'s generic 404 mapping, which `engine.ts`'s per-transport dispatch translates into
 * the exact `InterceptUnavailable` guidance string — and echoes back the `{host, port}` its caller
 * (`engine.ts`) already resolved, in the shared `{interceptPort, interceptUrl}` shape every
 * `InterceptBackend` returns.
 */

import { hostForUrl } from '../host.js';
import type { RemoteClient } from '../remote/client.js';
import type { InterceptBackend } from './types.js';

export class RemoteInterceptBackend implements InterceptBackend {
  constructor(private readonly client: RemoteClient) {}

  async startIntercept(optionsJson: string): Promise<{ interceptPort: number; interceptUrl: string }> {
    const { host, port } = JSON.parse(optionsJson) as { host: string; port: number };
    await this.client.interceptListRules();
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
