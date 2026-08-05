/**
 * Admin API key validation, shared by every transport that accepts one (issue #96).
 *
 * Lives outside `spawn/` and `remote/` because both reach it and neither should depend on the
 * other.
 */

import { InvalidDefinition } from './errors.js';

/**
 * Rejects a blank (empty or whitespace-only) admin API key.
 *
 * A blank key is never a usable credential, and treating it as "no auth" would be a silent
 * downgrade — the caller believes a key is in force while the admin plane is open. The engine
 * refuses one at every door since rift#862 (shipped in v0.17.0); on older engines a blank key
 * switched the auth gate ON and then matched every unauthenticated request, so guarding here
 * gives the same fail-closed answer regardless of which engine version is in play.
 *
 * `undefined` means "no key configured" and is left alone. A key that merely *contains* spaces is
 * valid and is never trimmed here — the engine compares the configured key byte for byte.
 *
 * "Blank" is JavaScript's `String.prototype.trim`, which is close to but not identical with the
 * engine's Rust `str::trim`: JS also strips U+FEFF, Rust also strips U+0085. Both disagreements are
 * on absurd inputs and both resolve safely — a key the engine would call blank is refused at its own
 * startup, and one this guard over-rejects simply has to be spelled without the stray code point.
 *
 * The engine's other door — an inherited `MB_APIKEY` environment variable — is guarded by
 * `resolveApiKey()` in `spawn/spawn.ts`, which resolves the effective key before calling this and
 * passes the matching `source` (issue #103). Both transports that spawn a child now route through
 * it: `rift.spawn()`, and the Mountebank-compat `create()`, which calls it with no option of its own
 * so the check reduces to the ambient variable (issue #108). `rift.connect()` reaches a process it
 * did not start and so has no inherited-env door to guard.
 */
export type ApiKeySource = 'apiKey option' | 'MB_APIKEY environment variable';

export function assertApiKeyNotBlank(apiKey: string | undefined, source: ApiKeySource = 'apiKey option'): void {
  if (apiKey === undefined || apiKey.trim() !== '') return;
  // Name the door the key came through: the engine reads two, and only the caller knows which one
  // they meant to set.
  const remedy =
    source === 'apiKey option'
      ? 'Omit apiKey entirely to run without admin auth.'
      : 'Unset MB_APIKEY, or give it a real value, to run without admin auth.';
  throw new InvalidDefinition(
    `${source} must not be blank: engine >= 0.17.0 refuses to start with one (rift#862), and older ` +
      `engines enable the auth gate and then authenticate every request. ${remedy}`
  );
}
