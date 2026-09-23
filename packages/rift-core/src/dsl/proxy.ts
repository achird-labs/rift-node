/**
 * Fluent `proxy` response builder — extends {@link ResponseBuilder} so the shared behavior
 * chainers (`latency`, `repeat`, `decorate`, `withFault`, `raw`, ...) stay legal on a proxy
 * response, while adding the proxy-only wire fields (`mode`, `predicateGenerators`,
 * `injectHeaders`, `pathRewrite`, `key`/`cert`).
 */

import type { JsonValue, ProxyResponse, StubResponse } from '../model/index.js';
import { assertSingleValuedHeaderNames } from './header-names.js';
import { ResponseBuilder } from './response.js';

/** A `predicateGenerators` entry: which request fields seed predicates on a recorded match. */
export interface PredicateGenerator {
  matches: Record<string, boolean>;
  caseSensitive?: boolean;
  except?: string;
}

function toJsonGenerator(g: PredicateGenerator): JsonValue {
  const out: { [key: string]: JsonValue } = { matches: g.matches };
  if (g.caseSensitive !== undefined) out.caseSensitive = g.caseSensitive;
  if (g.except !== undefined) out.except = g.except;
  return out;
}

export class ProxyBuilder extends ResponseBuilder {
  private config: ProxyResponse;

  constructor(to: string, mode?: string) {
    super();
    this.config = mode !== undefined ? { to, mode } : { to };
  }

  /** Sets `proxy.mode = 'proxyOnce'` — the response is recorded and replayed thereafter. */
  proxyOnce(): this {
    return this.patch({ mode: 'proxyOnce' });
  }

  /** Sets `proxy.mode = 'proxyAlways'` — every matching call is forwarded upstream. */
  proxyAlways(): this {
    return this.patch({ mode: 'proxyAlways' });
  }

  /** Sets `proxy.mode = 'proxyTransparent'`. */
  proxyTransparent(): this {
    return this.patch({ mode: 'proxyTransparent' });
  }

  /** Sets `proxy.predicateGenerators`. */
  generatePredicates(...gens: PredicateGenerator[]): this {
    return this.patch({ predicateGenerators: gens.map(toJsonGenerator) });
  }

  /** Sets `proxy.addWaitBehavior`. */
  addWaitBehavior(on = true): this {
    return this.patch({ addWaitBehavior: on });
  }

  /** Sets `proxy.addDecorateBehavior`. */
  addDecorateBehavior(jsFn: string): this {
    return this.patch({ addDecorateBehavior: jsFn });
  }

  /** Accumulates a header into `proxy.injectHeaders`, sent upstream on every proxied call — one
   * entry per name, case-insensitive: the same spelling replaces, a second spelling throws
   * `InvalidDefinition` (the engine refuses it with a 400 since 0.18.0). */
  injectHeader(name: string, value: string): this {
    const injectHeaders = { ...this.config.injectHeaders, [name]: value };
    assertSingleValuedHeaderNames(injectHeaders, 'proxy.injectHeaders', 'injectHeader()');
    return this.patch({ injectHeaders });
  }

  /** Sets `proxy.pathRewrite`. */
  rewritePath(from: string, to: string): this {
    return this.patch({ pathRewrite: { from, to } });
  }

  /**
   * Sets a `key`/`cert` PEM pair inside `proxy`, which no Rift engine acts on: the engine's proxy
   * client sends no client certificate, and its `ProxyResponse` has no such fields — the keys are
   * dropped on parse without even a `config_key_ignored` warning (checked against 0.18.0). The
   * response is still created. The keys stay in the model for parse fidelity.
   *
   * @deprecated Has no effect, and there is no replacement: Rift's proxy does not present a client
   * certificate to the upstream. `upstreamTrust` covers the other direction (trusting the upstream).
   */
  clientCert(cert: { key: string; cert: string }): this {
    return this.patch({ key: cert.key, cert: cert.cert });
  }

  private patch(p: Partial<ProxyResponse>): this {
    this.config = { ...this.config, ...p };
    return this;
  }

  override build(): StubResponse {
    this.proxyConfig = this.config;
    return super.build();
  }
}

/** A `proxy` response forwarding to an upstream URL. */
export function proxyTo(to: string, opts?: { mode?: string }): ProxyBuilder {
  return new ProxyBuilder(to, opts?.mode);
}
