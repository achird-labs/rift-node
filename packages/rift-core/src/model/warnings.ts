/**
 * Validation of the engine's `_rift.warnings` block (issue #170). Shared by every transport that
 * reads it — the remote client off `GET /imposters/:port`, the embedded admin off
 * `rift_stub_warnings` — so a malformed block fails the same way everywhere.
 */

import { RiftError } from '../errors.js';
import type { EngineWarning } from './types.js';

/**
 * `undefined` is "no warnings": the engine omits the block when it is empty. Anything else that is
 * not a list of `{ warningType: string, message: string }` throws — version skew or an engine bug
 * must surface, not read as a clean imposter. `where` names the source in the error.
 */
export function parseEngineWarnings(value: unknown, where: string): EngineWarning[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new RiftError(`${where}: _rift.warnings is not a list (got ${describe(value)})`);
  }
  return value.map((entry: unknown, index) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { warningType?: unknown }).warningType !== 'string' ||
      typeof (entry as { message?: unknown }).message !== 'string'
    ) {
      throw new RiftError(
        `${where}: _rift.warnings[${index}] is not a { warningType, message } entry (got ${describe(entry)})`
      );
    }
    return entry as EngineWarning;
  });
}

/** The `_rift.warnings` of an imposter body (`POST` reply, `GET /imposters/:port`). An absent
 * `_rift` is "no warnings"; a `_rift` that is not an object throws like a malformed list does. */
export function parseImposterWarnings(imposter: { _rift?: unknown }, where: string): EngineWarning[] {
  const rift = imposter._rift;
  if (rift === undefined) return [];
  if (typeof rift !== 'object' || rift === null || Array.isArray(rift)) {
    throw new RiftError(`${where}: _rift is not an object (got ${describe(rift)})`);
  }
  return parseEngineWarnings((rift as { warnings?: unknown }).warnings, where);
}

function describe(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? typeof value : text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
