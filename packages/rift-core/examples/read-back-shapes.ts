/**
 * The read-path shapes (issue #150): what `handle.toJson()` / `getImposter()` return since engine
 * 0.18.0 differs from what the DSL posts — behaviors come back as an ordered `behaviors` array with
 * `repeat` lifted to the response, and the `_rift.dataset` / `_rift.sequencing` carriers are
 * typed. Pure functions over the wire model, so this compiles unconditionally and doubles as the
 * `typecheck:examples` gate for those declarations.
 */
import type { wire } from '../src/index.js';

// docs:embed read-back-shapes
/** The engine's own count for a response, whichever spelling the document uses. */
export function repeatOf(response: wire.StubResponse): number {
  // A response-level `repeat` wins over `_behaviors.repeat`; the engine never writes `0`.
  return response.repeat ?? response._behaviors?.repeat ?? 1;
}

/** The steps a read-back response runs, in execution order. */
export function stepsOf(response: wire.StubResponse): string[] {
  return (response.behaviors ?? []).flatMap((step) => Object.keys(step));
}

/** Where a dataset-backed lookup stores its row, or `undefined` when the response has none. */
export function datasetTargetOf(response: wire.StubResponse): string | undefined {
  const binding = response._rift?.dataset;
  return binding === undefined ? undefined : `${binding.name}[${binding.keyColumn}] -> ${binding.into}`;
}

export function sequencingModeOf(imposter: wire.Imposter): string | undefined {
  return imposter._rift?.sequencing?.mode;
}
