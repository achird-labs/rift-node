import { InvalidDefinition } from '../errors.js';

/** ASCII-only case fold, matching the engine's `eq_ignore_ascii_case` on header names. */
export function foldAsciiHeaderName(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Refuses a single-valued header map that names one header twice under ASCII case-folding.
 *
 * The engine reads `proxy.injectHeaders` and `_rift.fault.error.headers` as single-valued and,
 * since 0.18.0, refuses a second spelling of a name with a 400 (rift#1050) — the pre-0.18 engine
 * sent both as two header lines in hash order. Neither is what the caller meant, so it fails here
 * instead, naming the builder call. Deliberately not folded last-wins: the engine rejects folding
 * for these two fields, and picking a winner would hide which value the caller lost.
 *
 * Multi-valued `is.headers` is not checked: the engine merges case variants there (rift#1039),
 * which is how a stub sends two `Set-Cookie` lines.
 */
export function assertSingleValuedHeaderNames(
  headers: { readonly [name: string]: unknown },
  field: string,
  builder: string
): void {
  const seen = new Map<string, string>();
  for (const name of Object.keys(headers)) {
    const first = seen.get(foldAsciiHeaderName(name));
    if (first !== undefined && first !== name) {
      throw new InvalidDefinition(
        `header \`${name}\` is already given as \`${first}\`; ${field} is single-valued and names each header once ` +
          `(engine 0.18.0 refuses the second spelling with a 400). Use one spelling in ${builder}.`
      );
    }
    seen.set(foldAsciiHeaderName(name), name);
  }
}
