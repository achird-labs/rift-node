/**
 * Typed chaos faults (`_rift.fault`).
 *
 * `Fault.latency` / `Fault.error` / `Fault.tcp` each build a {@link RiftFault} — a tagged value
 * naming which `_rift.fault` sub-key it targets. `ResponseBuilder.withFault` merges these by
 * `kind` into a single `_rift.fault` block and rejects a second fault of the same kind (a stub
 * can inject latency AND drop the connection, but not two conflicting latency profiles).
 *
 * This is distinct from the native Mountebank `fault` field (top-level, engine-recognized TCP
 * fault kinds only — see `fault()` in `response.ts`), which `_rift.fault.tcp` complements for
 * fault identifiers the engine's native field does not accept.
 */

import type { JsonValue } from '../model/index.js';
import { assertSingleValuedHeaderNames } from './header-names.js';

export type TcpFaultKind =
  | 'CONNECTION_RESET_BY_PEER'
  | 'EMPTY_RESPONSE'
  | 'RANDOM_DATA_THEN_CLOSE'
  | 'MALFORMED_RESPONSE_CHUNK';

/** A single `_rift.fault` contribution, merged by `kind` in `ResponseBuilder.withFault`. */
export interface RiftFault {
  readonly kind: 'latency' | 'error' | 'tcp';
  readonly value: JsonValue;
}

export interface FaultErrorSpec {
  status?: number;
  body?: JsonValue;
  headers?: { [name: string]: string };
}

export interface FaultOptions {
  probability?: number;
}

export const Fault = {
  CONNECTION_RESET: 'CONNECTION_RESET_BY_PEER' as const,
  EMPTY_RESPONSE: 'EMPTY_RESPONSE' as const,
  RANDOM_DATA: 'RANDOM_DATA_THEN_CLOSE' as const,
  MALFORMED_CHUNK: 'MALFORMED_RESPONSE_CHUNK' as const,

  /** Injects latency before the response — a fixed delay (ms) or a `{min,max}` random range. */
  latency(ms: number | { min: number; max: number }, opts?: FaultOptions): RiftFault {
    const probability = opts?.probability ?? 1.0;
    const value: { [key: string]: JsonValue } =
      typeof ms === 'number' ? { probability, ms } : { probability, minMs: ms.min, maxMs: ms.max };
    return { kind: 'latency', value };
  },

  /** Returns an error response instead of `is`, with the given probability (default 1.0). */
  error(spec: FaultErrorSpec, opts?: FaultOptions): RiftFault {
    const value: { [key: string]: JsonValue } = { probability: opts?.probability ?? 1.0 };
    if (spec.status !== undefined) value.status = spec.status;
    if (spec.body !== undefined) value.body = spec.body;
    if (spec.headers !== undefined) {
      assertSingleValuedHeaderNames(spec.headers, '_rift.fault.error.headers', 'Fault.error()');
      value.headers = spec.headers;
    }
    return { kind: 'error', value };
  },

  /** A raw TCP-level fault (connection reset, malformed chunk, ...). */
  tcp(kind: TcpFaultKind): RiftFault {
    return { kind: 'tcp', value: kind };
  },
} as const;
