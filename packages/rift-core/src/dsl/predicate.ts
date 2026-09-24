/**
 * Field binders and composition helpers (issue #22, design §5.3).
 *
 * `req.*` binds a bare value or a field-agnostic {@link Matcher} (see `matcher.ts`) to a wire
 * field, producing a plain {@link Predicate}. A bare `string`/`number`/`object` means `equals`.
 * `and`/`or`/`not`/`injectPredicate` compose predicates — like matchers, predicates are already
 * flat immutable values, so plain functions are enough; no builder class needed.
 */

import type { JsonValue, Predicate } from '../model/index.js';
import { Matcher, equals } from './matcher.js';

function toMatcher(arg: JsonValue | Matcher): Matcher {
  return arg instanceof Matcher ? arg : equals(arg);
}

function bind(field: string, key: string | undefined, arg: JsonValue | Matcher): Predicate {
  return toMatcher(arg).compile(field, key);
}

export const req = {
  method(m: string | Matcher): Predicate {
    return bind('method', undefined, m);
  },
  path(m: string | Matcher): Predicate {
    return bind('path', undefined, m);
  },
  body(m: string | object | Matcher): Predicate {
    return bind('body', undefined, m as JsonValue | Matcher);
  },
  header(name: string, m: string | Matcher): Predicate {
    return bind('headers', name, m);
  },
  query(name: string, m: string | number | Matcher): Predicate {
    return bind('query', name, m);
  },
};

export function and(...predicates: Predicate[]): Predicate {
  return { and: predicates };
}

export function or(...predicates: Predicate[]): Predicate {
  return { or: predicates };
}

export function not(predicate: Predicate): Predicate {
  return { not: predicate };
}

/** An `inject` predicate running the given function body. Scripting surface: needs `allowInjection: true` on spawn (`--allow-injection` on a remote engine) or the engine answers 400 `invalid injection` — since 0.18.0 on a proxy, inject, fault or `_rift`-only response too (rift#1181); imposters created over the embedded FFI are not gated. */
export function injectPredicate(jsFn: string): Predicate {
  return { inject: jsFn };
}
