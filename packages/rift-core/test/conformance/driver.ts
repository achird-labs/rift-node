/**
 * Conformance replay driver (issue #7).
 *
 * Replays a `Fixture`'s interactions against a live engine using ONLY the `fromJson` escape
 * hatch — the DSL reconstruction axis (`dsl-coverage.ts` / `conformance.test.ts`) is deliberately
 * kept separate, so a replay failure can never be masked by a DSL builder quietly emitting
 * different wire than the fixture says.
 */

import type { RiftEngine } from '../../src/engine.js';
import { fromJson, type Imposter } from '../../src/model/index.js';
import type { Fixture, Interaction, InteractionExpectation, InteractionRequest } from './loader.js';

function buildUrl(base: string, request: InteractionRequest): URL {
  const url = new URL(request.path, base);
  if (request.query !== undefined) {
    for (const [key, value] of Object.entries(request.query)) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

/**
 * A STRING body is already the raw wire payload and is sent verbatim; any other JSON value is
 * serialized. Stringifying a string too would double-encode it — `{"type":"order"}` would go out as
 * the JSON string `"{\"type\":\"order\"}"`, so the engine's `jsonpath`/`xpath` predicates see a
 * quoted scalar instead of a document and silently fail to match. The sdk-conformance corpus authors
 * request bodies as raw strings (including XML, which is not JSON at all), so this distinction is
 * load-bearing there; the inline local fixtures send no request bodies.
 */
export function toFetchInit(request: InteractionRequest): RequestInit {
  const init: RequestInit = { method: request.method };
  if (request.headers !== undefined) init.headers = request.headers;
  if (request.body !== undefined) {
    init.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  }
  return init;
}

function formatDiff(label: string, expected: unknown, actual: unknown): string {
  return `  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

/**
 * Normalizes CRLF to LF (issue #13, Windows lane). The primary body comparison is already
 * JSON-structural (`deepEqual` over `JSON.parse`d values) and needs no help here — JSON.parse
 * resolves any escaped line endings inside a string value the same way regardless of the
 * surrounding transport. The two paths that ARE raw string comparisons — `bodyContains`'s
 * substring check, and the "response body isn't JSON" fallback that compares raw text — are the
 * ones a CRLF-vs-LF mismatch (e.g. a fixture authored with LF replayed against a Windows-built
 * engine emitting CRLF, or vice versa) could false-fail, so both sides are normalized before
 * comparing.
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Case-insensitive header lookup keyed by lowercase header name — HTTP header names are
 * case-insensitive, so a fixture's `Content-Type` must match a response's `content-type`. */
function lowerCaseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Asserts a single interaction's expectation against the actual response: status EXACT, headers a
 * SUBSET match (only the fixture's named headers are checked), body EXACT (deep JSON equality) or
 * `bodyContains` (substring). Collects every mismatch before throwing, so one failure doesn't hide
 * others in the same step.
 */
/** Order-independent structural deep equality for JSON values (objects compared key-set + value). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
    );
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    return ak.length === bk.length && ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
  }
  return false;
}

async function assertExpectation(
  fixtureName: string,
  stepIndex: number,
  expectation: InteractionExpectation,
  res: Response
): Promise<void> {
  const failures: string[] = [];

  if (res.status !== expectation.status) {
    failures.push(formatDiff('status', expectation.status, res.status));
  }

  if (expectation.headers !== undefined) {
    const actualHeaders = lowerCaseHeaders(res.headers);
    for (const [name, expected] of Object.entries(expectation.headers)) {
      const actual = actualHeaders[name.toLowerCase()];
      if (actual !== expected) failures.push(formatDiff(`header[${name}]`, expected, actual));
    }
  }

  const bodyText = normalizeLineEndings(await res.text());
  if (expectation.bodyContains !== undefined) {
    if (!bodyText.includes(normalizeLineEndings(expectation.bodyContains))) {
      failures.push(formatDiff('body (contains)', expectation.bodyContains, bodyText));
    }
  } else if (expectation.body !== undefined) {
    // The fixture's expected body is JSON; a non-JSON response body is itself a mismatch (compared
    // against the raw text) rather than a parse error — the failure message should show what came
    // back, not throw a SyntaxError that hides the real assertion failure.
    let actualBody: unknown = bodyText;
    try {
      actualBody = JSON.parse(bodyText);
    } catch {
      // actualBody stays the raw text; the structural comparison below surfaces the mismatch.
    }
    // A string expectation only arises from the same "non-JSON body" fallback (a JSON-typed
    // expectation.body, e.g. an array/object/number, can never CRLF-mismatch — JSON.parse already
    // normalized it); normalize it too so the raw-text comparison is CRLF-insensitive on both sides.
    const expectedBody = typeof expectation.body === 'string' ? normalizeLineEndings(expectation.body) : expectation.body;
    // Order-independent structural equality (not JSON.stringify, which is key-order sensitive) so a
    // differently-ordered but equal response body isn't a false failure — consistent with the pure gate.
    if (!deepEqual(actualBody, expectedBody)) {
      failures.push(formatDiff('body', expectation.body, actualBody));
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `conformance replay failed: fixture "${fixtureName}" step ${stepIndex}\n${failures.join('\n')}`
    );
  }
}

/**
 * Creates the fixture's imposter, replays every interaction against it in order, and deletes it
 * (even on failure). Every interaction is fetched via the created handle's `url`, so the fixture's
 * `port` is incidental to behavioral replay — and binding it verbatim makes the lane collide with,
 * and silently hit, any OTHER host process already serving that port (#72: a foreign listener
 * answers the fetch with a confusing right-status/empty-body mismatch). So the explicit port is
 * dropped here and the engine auto-assigns a free one. Port/wire fidelity is covered separately by
 * the DSL-coverage gate (`dsl-coverage.ts`/`conformance.test.ts`), which round-trips the field.
 */
export async function replayFixture(engine: RiftEngine, fixture: Fixture): Promise<void> {
  const imposter = fromJson<Imposter>(fixture.imposterJson);
  delete imposter.port;
  const handle = await engine.create(imposter);
  try {
    for (const [index, step] of fixture.interactions.entries()) {
      const res = await fetch(buildUrl(handle.url, step.request), toFetchInit(step.request));
      await assertExpectation(fixture.name, index, step.expect, res);
    }
  } finally {
    await handle.delete();
  }
}

export type { Fixture, Interaction, InteractionExpectation, InteractionRequest };
