/**
 * Verification API types (issue #6, design §6.1).
 *
 * Rift has no server-side verify endpoint (upstream enhancement filed), so `verify`/`recorded`
 * fetch the imposter's recorded-request journal and evaluate predicates client-side — see `eval.ts`
 * for the evaluator and `render.ts` for the `VerificationError` renderer. This module only holds the
 * typed shapes (the ergonomic `RecordedRequest`, `CountMatcher`) and the small mapping/normalization
 * helpers shared by the handle implementations in `engine.ts`.
 */

import type { Predicate, RecordedRequest as WireRecordedRequest } from '../model/index.js';
import { StubBuilder, type AnyStubBuilder } from '../dsl/stub.js';

/** An ergonomic, already-mapped recorded request — `raw` keeps the untouched wire object. */
export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[]>;
  /** String, or parsed JSON when the engine recorded it as such. */
  body?: unknown;
  /** Wire: `request_from` — the client address. */
  from: string;
  /** RFC3339. */
  timestamp: string;
  /** The status code the request was answered with (engine >= 0.18.0). `undefined` when not
   * recorded: a request still in flight when the journal was read, one whose handling errored, or
   * an older engine. */
  status?: number;
  /** Time to answer, in ms (engine >= 0.18.0). `0` is a real reading; `undefined` means not recorded. */
  latencyMs?: number;
  /** The node that answered. Set only by a clustered journal — always `undefined` against a single
   * engine, including one the SDK spawns. */
  node?: string;
  /** The untouched wire object, for anything not lifted onto the typed shape above. */
  raw: WireRecordedRequest;
}

/** A `StubBuilder` used as a match contributes only its predicates — its responses are ignored. */
export type RequestMatch = AnyStubBuilder | Predicate | Predicate[];

export interface CountMatcher {
  readonly min: number;
  readonly max: number;
  describe(): string;
}

export interface RecordedFilter {
  match?: RequestMatch;
  flowId?: string;
}

class CountMatcherImpl implements CountMatcher {
  constructor(
    readonly min: number,
    readonly max: number,
    private readonly label: string
  ) {}

  describe(): string {
    return this.label;
  }
}

/** Matches exactly `n` requests. */
export function times(n: number): CountMatcher {
  return new CountMatcherImpl(n, n, `times(${n})`);
}

/** Matches `n` or more requests. */
export function atLeast(n: number): CountMatcher {
  return new CountMatcherImpl(n, Infinity, `atLeast(${n})`);
}

/** Matches `n` or fewer requests (including zero). */
export function atMost(n: number): CountMatcher {
  return new CountMatcherImpl(0, n, `atMost(${n})`);
}

/** Matches between `min` and `max` requests, inclusive. */
export function between(min: number, max: number): CountMatcher {
  return new CountMatcherImpl(min, max, `between(${min}, ${max})`);
}

/** Matches zero requests — equivalent to `times(0)`. */
export function never(): CountMatcher {
  return times(0);
}

/** Maps a raw wire recorded request onto the ergonomic shape (`request_from` → `from`). */
export function toRecordedRequest(raw: WireRecordedRequest): RecordedRequest {
  return {
    method: raw.method,
    path: raw.path,
    query: raw.query ?? {},
    headers: raw.headers ?? {},
    body: raw.body,
    from: raw.request_from ?? '',
    timestamp: raw.timestamp ?? '',
    status: raw.status,
    latencyMs: raw.latencyMs,
    node: raw.node,
    raw,
  };
}

/** Normalizes a `RequestMatch` down to the flat predicate list the evaluator operates on. */
export function predicatesOf(match: RequestMatch): Predicate[] {
  if (match instanceof StubBuilder) return match.build().predicates ?? [];
  return Array.isArray(match) ? match : [match];
}
