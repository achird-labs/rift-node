/**
 * Validation for the credentials the engine reads from its own environment — the admin API key
 * (issue #96) and the intercept proxy's `RIFT_INTERCEPT_AUTH` (issue #115).
 *
 * Both are here for the same two reasons: a spawned child inherits them whether or not the caller
 * meant to configure the engine, and both are judged blank with the same Rust `str::trim` the engine
 * uses, so they share {@link isBlank}. Lives outside `spawn/` and `remote/` because both reach it and
 * neither should depend on the other.
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
 * "Blank" covers both trim dialects (issue #116) — see {@link isBlank}. What disagreement remains
 * runs one way only: a handful of exotic keys the engine would accept are refused here, which costs
 * the caller a respelling rather than an open admin plane.
 *
 * The engine's other door — an inherited `MB_APIKEY` environment variable — is guarded by
 * `resolveApiKey()` in `spawn/spawn.ts`, which resolves the effective key before calling this and
 * passes the matching `source` (issue #103). Both transports that spawn a child now route through
 * it: `rift.spawn()`, and the Mountebank-compat `create()`, which calls it with no option of its own
 * so the check reduces to the ambient variable (issue #108). `rift.connect()` reaches a process it
 * did not start and so has no inherited-env door to guard.
 */
export type ApiKeySource = 'apiKey option' | 'MB_APIKEY environment variable';

/** U+0085 (NEL). In Rust's `White_Space` set and so trimmed by the engine, but NOT in JavaScript's:
 * `'\u0085'.trim()` is still one character long. Written as an escape because the literal character
 * is invisible in an editor and survives copy-paste poorly. */
const NEL = '\u0085';

/**
 * Blank under EITHER trim dialect — JavaScript's `trim()` plus Rust's extra U+0085.
 *
 * Covering both is what makes the guard fail closed: judging by JS alone let a NEL-only key through
 * as if it were a credential, and the engine then refused to start on its own (>= 0.17.0) with the
 * opaque child-exit error this guard exists to replace. A key that merely *contains* a NEL among
 * real characters is still a real key.
 *
 * Slightly stricter than "blank to JS OR blank to Rust": a key mixing only U+FEFF and U+0085 is
 * refused here though neither dialect alone calls it blank. That and the U+FEFF-only case are the
 * only over-rejections, and both cost a respelling rather than an open admin plane.
 */
function isBlank(value: string): boolean {
  return value.replaceAll(NEL, '').trim() === '';
}

export function assertApiKeyNotBlank(apiKey: string | undefined, source: ApiKeySource = 'apiKey option'): void {
  if (apiKey === undefined || !isBlank(apiKey)) return;
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

/**
 * Rejects an ambient `RIFT_INTERCEPT_AUTH` the engine would refuse to start on (issue #115).
 *
 * The engine declares `--intercept-auth <USER:PASS>` with `env = "RIFT_INTERCEPT_AUTH"`, and a
 * spawned child inherits this process's environment — so the variable is engine configuration
 * whether the caller meant it as such or not, exactly the door `MB_APIKEY` came through in #103.
 * Since rift#885 (v0.17.0) the engine refuses to start on three shapes, and each one otherwise
 * surfaces here as an opaque child exit *after* a binary may have been downloaded:
 *
 * - no `:` at all — `parse_intercept_auth` cannot split it, and an operator who mistyped the
 *   credential must not end up running an open MITM proxy believing it is closed;
 * - a blank half — `InterceptAuth::validate` refuses it, because a blank secret switches the gate on
 *   and then admits everyone;
 * - a perfectly valid value with **no listener to guard** — the engine refuses that too, since a
 *   credential nothing uses reads as a protection that is not in force, and a later `POST /intercept`
 *   would bring up an *unauthenticated* proxy.
 *
 * Below v0.17.0 the flag does not exist, so clap never reads the variable and it is inert — there is
 * no version where this fails open. This guard is therefore about failing loudly and early, in the
 * SDK's own vocabulary, rather than closing a hole.
 *
 * That inertness makes the third case a deliberate over-rejection on old engines: pinning a pre-0.17
 * binary (`version`, `binaryPath`, or whatever `findBinary()` turns up for compat `create()`) and
 * spawning without a listener works today and is refused here. The check stays version-independent
 * anyway, because the alternative is to resolve a binary before validating — which is exactly the
 * download this guard exists to save, and `binaryPath` gives no version without probing it. The
 * default engine is >= 0.17.0, so the refusal is right for almost everyone; the message names the
 * escape for the rest. Contrast `assertApiKeyNotBlank`, which is version-independent because a blank
 * key is unsafe on *every* engine.
 *
 * A valid credential *with* a listener is passed through untouched: an ambient variable is currently
 * the only way to give a spawned engine an intercept credential, so over-rejecting would remove the
 * feature. Blankness matches {@link isBlank}, since the engine judges these halves with the same
 * Rust `str::trim` as the admin key.
 */
export function assertInterceptAuthValid(value: string | undefined, interceptEnabled: boolean): void {
  if (value === undefined) return;

  // Used by the two malformed-value throws; the no-listener throw below has two remedies of its
  // own and spells them out instead.
  const unsetRemedy = 'Unset RIFT_INTERCEPT_AUTH to run without it.';
  // `indexOf` + slice, not `split(':')`: the engine parses with `split_once(':')`, so the FIRST
  // colon separates and every later one belongs to the password. `split(':', 2)` looks equivalent
  // and is not — JavaScript's limit truncates rather than rejoining, so `a:b:c` would validate the
  // password as `b` and silently drop `:c`.
  const colon = value.indexOf(':');
  if (colon === -1) {
    throw new InvalidDefinition(
      `RIFT_INTERCEPT_AUTH must be "user:pass" (got a value with no ":"). It is the credential the ` +
        `engine's intercept proxy requires in Proxy-Authorization, and engine >= 0.17.0 refuses to ` +
        `start with a malformed one. ${unsetRemedy}`
    );
  }
  if (isBlank(value.slice(0, colon)) || isBlank(value.slice(colon + 1))) {
    throw new InvalidDefinition(
      `RIFT_INTERCEPT_AUTH needs a non-blank username and password: a blank half would enable the ` +
        `intercept gate and then accept every request, so engine >= 0.17.0 refuses to start with ` +
        `one. ${unsetRemedy}`
    );
  }
  if (!interceptEnabled) {
    throw new InvalidDefinition(
      `RIFT_INTERCEPT_AUTH is set but no intercept listener was requested, so engine >= 0.17.0 ` +
        `refuses to start: a credential with nothing to guard reads as a protection that is not in ` +
        `force. Pass intercept to rift.spawn() to start an authenticated listener, or unset ` +
        `RIFT_INTERCEPT_AUTH for this process. If the listener comes from a config file, or the ` +
        `engine you are pinning predates 0.17.0 and ignores this variable, unsetting it is the way ` +
        `through — the check cannot read the engine's version without first resolving the binary.`
    );
  }
}
