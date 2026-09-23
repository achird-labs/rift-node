/**
 * Fluent response builders that produce a wire {@link StubResponse}.
 *
 * `.build()` only emits `is` / `headers` / `_behaviors` / `_rift` when they actually carry
 * content — the engine (and the gate's `toEqual`) treats a stray empty object as a different
 * value from an absent key, so we never inject one. `is` / `proxy` / `inject` / a native `fault`
 * are mutually exclusive "primary content" — set by construction (`ok()`, `proxyTo()`,
 * `inject()`, `fault()`) — but `_behaviors` and `_rift` accumulate on top of any of them, so a
 * proxy or inject response can still carry latency, repeat, a fault, etc.
 */

import type {
  Behaviors,
  IsResponse,
  JsonValue,
  ProxyResponse,
  RiftResponseExtension,
  StubResponse,
} from '../model/index.js';
import { InvalidDefinition } from '../errors.js';
import type { RiftFault, TcpFaultKind } from './fault.js';
import type { ScriptSpec } from './script.js';

/** What the engine's `base64::STANDARD` decoder accepts: standard alphabet, `=` padding, no
 * whitespace, and zero trailing bits in the last symbol. `Buffer.from(s, 'base64')` is lenient on
 * every one of those, so the check is a round trip — a string is canonical iff re-encoding its
 * decode gives it back (`''`, an empty body, round-trips too). */
function isCanonicalBase64(s: string): boolean {
  return Buffer.from(s, 'base64').toString('base64') === s;
}

function isNonNegativeInteger(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

/** The engine reads `repeat` as a `u32`. */
const MAX_REPEAT = 0xffff_ffff;

const JSON_CONTENT_TYPE = 'application/json';
const TEXT_CONTENT_TYPE = 'text/plain';

/** The four Mountebank-native TCP fault kinds `fault()` recognizes as top-level `fault`. */
const NATIVE_FAULT_KINDS: ReadonlySet<string> = new Set<TcpFaultKind>([
  'CONNECTION_RESET_BY_PEER',
  'EMPTY_RESPONSE',
  'RANDOM_DATA_THEN_CLOSE',
  'MALFORMED_RESPONSE_CHUNK',
]);

export interface CopySpec {
  from: 'path' | 'method' | 'body' | { query: string } | { headers: string };
  into: string;
  using: {
    method: 'regex' | 'jsonpath' | 'xpath';
    selector: string;
    options?: { ignoreCase?: boolean; multiline?: boolean };
  };
  [key: string]: JsonValue;
}

export interface LookupSpec {
  key: { from: CopySpec['from']; using: CopySpec['using'] };
  fromDataSource: { csv: { path: string; keyColumn: string; delimiter?: string } };
  into: string;
  [key: string]: JsonValue;
}

export class ResponseBuilder {
  private statusCodeValue: number | undefined;
  private headerMap: Record<string, string | string[]> | undefined;
  private bodyValue: JsonValue | undefined;
  private hasBody = false;
  private binaryMode = false;
  private behaviors: Behaviors = {};
  private riftFault: Record<string, JsonValue> = {};
  private legacyTcpFault: string | undefined;
  private scriptSpec: ScriptSpec | undefined;
  private templatedFlag = false;
  private rawPatch: Partial<StubResponse> | undefined;
  /** Set by `ProxyBuilder`/`proxyTo()`; protected so the subclass can assign it directly. */
  protected proxyConfig: ProxyResponse | undefined;
  private injectFn: string | undefined;
  private nativeFaultType: string | undefined;

  /** Builds a response wrapping an `inject` script instead of `is`. */
  static injected(fn: string): ResponseBuilder {
    const builder = new ResponseBuilder();
    builder.injectFn = fn;
    return builder;
  }

  /** Builds a bare native-fault response (`fault: '<kind>'`), no `is` block. */
  static nativeFault(kind: string): ResponseBuilder {
    const builder = new ResponseBuilder();
    builder.nativeFaultType = kind;
    return builder;
  }

  /** Sets (or overrides) `is.statusCode`. */
  status(code: number): this {
    this.statusCodeValue = code;
    return this;
  }

  /** Merges a single header into `is.headers`. A string[] value emits a multi-value header. */
  header(name: string, value: string | string[]): this {
    this.headerMap = { ...this.headerMap, [name]: value };
    return this;
  }

  /** Merges multiple headers into `is.headers`. */
  headers(values: Record<string, string | string[]>): this {
    this.headerMap = { ...this.headerMap, ...values };
    return this;
  }

  /** Sets `is.body`. */
  body(value: JsonValue): this {
    this.bodyValue = value;
    this.hasBody = true;
    return this;
  }

  /**
   * Sets `is.body` to base64 and `is._mode = 'binary'`. A `Uint8Array` is encoded; a `string` must
   * already be canonical base64 (standard alphabet, `=` padding) — a body the engine cannot decode
   * is served with `x-rift-binary-error: true`, or a 500 under `strictBehaviors`, so it is refused
   * here instead.
   */
  binaryBody(data: Uint8Array | string): this {
    if (typeof data === 'string' && !isCanonicalBase64(data)) {
      throw new InvalidDefinition(
        `binaryBody(string) must be canonical base64 (standard alphabet, = padding, no whitespace), got ${JSON.stringify(data)}; pass a Uint8Array to have it encoded`
      );
    }
    this.bodyValue = typeof data === 'string' ? data : Buffer.from(data).toString('base64');
    this.hasBody = true;
    this.binaryMode = true;
    return this;
  }

  /** Sets `_behaviors.wait` — a fixed delay (ms), a `{min,max}` random range, or a bare fn-string.
   * A number must be a non-negative integer and a range must satisfy `0 <= min <= max`: the engine
   * refuses anything else at the config door (since 0.18.0; older engines dropped the block or, for
   * an inverted range, dropped every connection). The fn-string form is not inspected. */
  latency(ms: number | { min: number; max: number } | string): this {
    if (typeof ms === 'number' && !isNonNegativeInteger(ms)) {
      throw new InvalidDefinition(`latency(ms) must be a non-negative integer of milliseconds, got ${String(ms)}`);
    }
    if (typeof ms === 'object') {
      if (!isNonNegativeInteger(ms.min) || !isNonNegativeInteger(ms.max)) {
        throw new InvalidDefinition(
          `latency({min, max}) bounds must be non-negative integers of milliseconds, got {min: ${String(ms.min)}, max: ${String(ms.max)}}`
        );
      }
      if (ms.min > ms.max) {
        throw new InvalidDefinition(`latency({min, max}) has min ${ms.min} greater than max ${ms.max}`);
      }
    }
    this.behaviors = { ...this.behaviors, wait: ms };
    return this;
  }

  /** Sets `_behaviors.repeat` — a positive integer that fits a `u32`. The engine refuses a
   * negative or fractional value; it accepts `0` but silently serves it as `1`, so `0` is refused
   * here too — it can never mean what the author wrote. */
  repeat(n: number): this {
    if (!Number.isInteger(n) || n < 1 || n > MAX_REPEAT) {
      throw new InvalidDefinition(`repeat(n) must be a positive integer up to ${MAX_REPEAT}, got ${String(n)}`);
    }
    this.behaviors = { ...this.behaviors, repeat: n };
    return this;
  }

  /** Sets `_behaviors.decorate` to a JS decorator function body. */
  decorate(jsFn: string): this {
    this.behaviors = { ...this.behaviors, decorate: jsFn };
    return this;
  }

  /** Sets `_behaviors.shellTransform` — a single command (string) or several (array). No-op if none. */
  shellTransform(...cmds: string[]): this {
    if (cmds.length === 0) return this;
    const [only] = cmds;
    const value = cmds.length === 1 && only !== undefined ? only : cmds;
    this.behaviors = { ...this.behaviors, shellTransform: value };
    return this;
  }

  /** Sets `_behaviors.copy`, always an array even for a single spec. No-op if an empty array. */
  copy(spec: CopySpec | CopySpec[]): this {
    const specs = Array.isArray(spec) ? spec : [spec];
    if (specs.length === 0) return this;
    this.behaviors = { ...this.behaviors, copy: specs };
    return this;
  }

  /** Sets `_behaviors.lookup`, always an array even for a single spec. No-op if an empty array. */
  lookup(spec: LookupSpec | LookupSpec[]): this {
    const specs = Array.isArray(spec) ? spec : [spec];
    if (specs.length === 0) return this;
    this.behaviors = { ...this.behaviors, lookup: specs };
    return this;
  }

  /** Shallow-merges raw `_behaviors` keys — an escape hatch for behaviors with no dedicated method. */
  behavior(raw: Behaviors): this {
    this.behaviors = { ...this.behaviors, ...raw };
    return this;
  }

  /**
   * Merges a {@link RiftFault} into the single `_rift.fault` block, keyed by `fault.kind`.
   * Faults of different kinds (latency, error, tcp) coexist; a second fault of the SAME kind
   * throws — the caller almost certainly meant to replace the first, and silently overwriting
   * would hide that bug.
   */
  withFault(fault: RiftFault): this {
    if (fault.kind in this.riftFault) {
      throw new InvalidDefinition(
        `withFault: a '${fault.kind}' fault is already set on this response`
      );
    }
    this.riftFault = { ...this.riftFault, [fault.kind]: fault.value };
    return this;
  }

  /** Sets `_rift.fault.tcp` — the legacy Rift chaos extension, alongside any `is` already configured. */
  fault(type: string): this {
    this.legacyTcpFault = type;
    return this;
  }

  /** Wraps a {@link ScriptSpec} into `_rift.script`. Exactly one of code/file/ref must be present. */
  script(spec: ScriptSpec): this {
    const present = (['code', 'file', 'ref'] as const).filter((k) => k in spec);
    if (present.length !== 1) {
      throw new InvalidDefinition(
        `script spec must carry exactly one of code/file/ref, found: [${present.join(', ')}]`
      );
    }
    this.scriptSpec = spec;
    return this;
  }

  /** Sets `_rift.templated = true`. */
  templated(): this {
    this.templatedFlag = true;
    return this;
  }

  /** Last-wins shallow merge applied at the TOP level of the built response, after everything else. */
  raw(patch: Partial<StubResponse>): this {
    this.rawPatch = { ...this.rawPatch, ...patch };
    return this;
  }

  /** True when any `is`-block field (status/headers/body) has been set. */
  private hasIsContent(): boolean {
    return (
      this.statusCodeValue !== undefined ||
      (this.headerMap !== undefined && Object.keys(this.headerMap).length > 0) ||
      this.hasBody ||
      this.binaryMode
    );
  }

  build(): StubResponse {
    const out: StubResponse = {};

    // proxy / inject / native-fault are mutually exclusive with an `is` body: emitting the
    // response would silently discard whatever status/headers/body were also set. Fail loudly
    // rather than drop them (the same discipline `withFault` applies to duplicate faults).
    if (
      (this.proxyConfig !== undefined ||
        this.injectFn !== undefined ||
        this.nativeFaultType !== undefined) &&
      this.hasIsContent()
    ) {
      throw new InvalidDefinition(
        'a proxy, inject, or native-fault response cannot also carry an `is` body (status/headers/body)'
      );
    }
    if (this.legacyTcpFault !== undefined && 'tcp' in this.riftFault) {
      throw new InvalidDefinition(
        'tcp fault set via both fault() and withFault(Fault.tcp(...)) — set it once'
      );
    }

    if (this.proxyConfig !== undefined) {
      out.proxy = this.proxyConfig;
    } else if (this.injectFn !== undefined) {
      out.inject = this.injectFn;
    } else if (this.nativeFaultType !== undefined) {
      out.fault = this.nativeFaultType;
    } else {
      const is: IsResponse = {};
      if (this.statusCodeValue !== undefined) is.statusCode = this.statusCodeValue;
      if (this.headerMap !== undefined && Object.keys(this.headerMap).length > 0) {
        is.headers = this.headerMap;
      }
      if (this.hasBody) is.body = this.bodyValue;
      if (this.binaryMode) is._mode = 'binary';
      if (Object.keys(is).length > 0) out.is = is;
    }

    if (Object.keys(this.behaviors).length > 0) out._behaviors = this.behaviors;

    const rift: RiftResponseExtension = {};
    const faultBlock: Record<string, JsonValue> = { ...this.riftFault };
    if (this.legacyTcpFault !== undefined) faultBlock.tcp = this.legacyTcpFault;
    if (Object.keys(faultBlock).length > 0) rift.fault = faultBlock;
    if (this.scriptSpec !== undefined) rift.script = this.scriptSpec;
    if (this.templatedFlag) rift.templated = true;
    if (Object.keys(rift).length > 0) out._rift = rift;

    return this.rawPatch !== undefined ? { ...out, ...this.rawPatch } : out;
  }
}

/** 200 OK, optionally with a body. */
export function ok(body?: JsonValue): ResponseBuilder {
  const builder = new ResponseBuilder().status(200);
  if (body !== undefined) builder.body(body);
  return builder;
}

/** 200 OK with `Content-Type: application/json` and the given (required) body. */
export function okJson(body: JsonValue): ResponseBuilder {
  return new ResponseBuilder().status(200).header('Content-Type', JSON_CONTENT_TYPE).body(body);
}

/** 201 Created, optionally with a body. */
export function created(body?: JsonValue): ResponseBuilder {
  const builder = new ResponseBuilder().status(201);
  if (body !== undefined) builder.body(body);
  return builder;
}

/** Arbitrary status code, optionally with a body. */
export function status(code: number, body?: JsonValue): ResponseBuilder {
  const builder = new ResponseBuilder().status(code);
  if (body !== undefined) builder.body(body);
  return builder;
}

/** Arbitrary status code with `Content-Type: application/json` and the given body. */
export function json(code: number, body: JsonValue): ResponseBuilder {
  return new ResponseBuilder().status(code).header('Content-Type', JSON_CONTENT_TYPE).body(body);
}

/** Arbitrary status code with `Content-Type: text/plain` and the given body. */
export function text(code: number, body: JsonValue): ResponseBuilder {
  return new ResponseBuilder().status(code).header('Content-Type', TEXT_CONTENT_TYPE).body(body);
}

/** 400 Bad Request, optionally with a body. */
export function badRequest(body?: JsonValue): ResponseBuilder {
  const builder = new ResponseBuilder().status(400);
  if (body !== undefined) builder.body(body);
  return builder;
}

/** 404 Not Found, optionally with a body. */
export function notFound(body?: JsonValue): ResponseBuilder {
  const builder = new ResponseBuilder().status(404);
  if (body !== undefined) builder.body(body);
  return builder;
}

/** 204 No Content. */
export function noContent(): ResponseBuilder {
  return new ResponseBuilder().status(204);
}

/**
 * A bare fault response, no `is` block. `kind` values recognized by the engine as native TCP
 * fault kinds (see {@link TcpFaultKind}, e.g. `Fault.CONNECTION_RESET`) emit the wire-native
 * top-level `fault: '<kind>'`. Any other identifier (a caller-chosen string that predates the
 * native field, e.g. a raw Node error code) falls back to the legacy `_rift.fault.tcp` slot.
 */
export function fault(kind: TcpFaultKind | (string & NonNullable<unknown>)): ResponseBuilder {
  if (NATIVE_FAULT_KINDS.has(kind)) {
    return ResponseBuilder.nativeFault(kind);
  }
  // A case-variant of a native kind (e.g. 'connection_reset_by_peer') is a typo, not a legacy
  // identifier — route it to _rift.fault.tcp silently and the caller's intended native fault is
  // lost with no signal. Reject it loudly; genuine legacy strings (ECONNRESET, ...) fall through.
  const upper = kind.toUpperCase();
  if (upper !== kind && NATIVE_FAULT_KINDS.has(upper)) {
    throw new InvalidDefinition(`unknown fault kind '${kind}' — did you mean '${upper}'?`);
  }
  return new ResponseBuilder().fault(kind);
}

/** An `inject` response running the given script body. */
export function inject(fn: string): ResponseBuilder {
  return ResponseBuilder.injected(fn);
}

/** A response wrapping a {@link ScriptSpec} into `_rift.script`, with no `is` block. */
export function script(spec: ScriptSpec): ResponseBuilder {
  return new ResponseBuilder().script(spec);
}
