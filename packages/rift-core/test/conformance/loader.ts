/**
 * Conformance corpus loader (issue #7).
 *
 * A `Fixture` pairs one wire imposter with the interactions replayed against it. Two sources feed
 * `Fixture`s:
 *  - the shared `sdk-conformance-<version>` corpus (rift#460), published per engine release as a
 *    tarball asset and located via `RIFT_CORPUS_DIR` ({@link resolveCorpusDir}). Its `manifest.json`
 *    indexes one imposter config per fixture under `corpus/imposters/NN-name.json`, and the replay
 *    transcripts are inlined **per stub** as `_verify.sequence[]` rather than living in a side file.
 *    The tarball's own `README.md` is the normative replay contract.
 *  - the 6 local `test/fixtures/mb/*.json` files, loaded imposter-only (no interactions) via
 *    {@link loadMbFixture} for the DSL expressibility gate, which only needs the wire shape.
 *
 * `Fixture.imposterJson` is always a SINGLE imposter's JSON text (never the `{ imposters: [...] }`
 * envelope) — `driver.ts`'s `replayFixture` feeds it straight to `fromJson` and on to
 * `engine.create`, which takes one `Imposter`. A corpus/local file that uses the envelope form is
 * unwrapped at load time, requiring it to carry exactly one imposter.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { JsonValue } from '../../src/model/index.js';
import { isAirGapped, verifySha256, type EnvRecord } from '../../src/spawn/resolve.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The 6 fixtures the expressibility gate always accounts for, regardless of the corpus. */
export const MB_FIXTURES_DIR = path.join(here, '..', 'fixtures', 'mb');

export interface InteractionRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: JsonValue;
}

export interface InteractionExpectation {
  status: number;
  headers?: Record<string, string>;
  body?: JsonValue;
  bodyContains?: string;
}

export interface Interaction {
  request: InteractionRequest;
  expect: InteractionExpectation;
}

export interface Fixture {
  name: string;
  /** A single wire `Imposter`'s JSON text — never the `{ imposters: [...] }` envelope. */
  imposterJson: string;
  interactions: Interaction[];
  /** Capability gates from the manifest's closed set; empty for the local mb fixtures. A lane may
   * skip a fixture ONLY when it lacks a capability named here (corpus README, replay contract §4). */
  requires: string[];
}

/** One `manifest.json` fixture entry, exactly as rift#460 ships it. */
export interface CorpusFixtureEntry {
  /** Imposter config path, relative to the directory holding `manifest.json`. */
  file: string;
  port: number;
  name: string;
  requires: string[];
  hasVerify: boolean;
}

export interface CorpusManifest {
  schemaVersion: number;
  engineVersion: string;
  fixtures: CorpusFixtureEntry[];
}

/** The only `schemaVersion` this loader understands; a newer corpus must fail loudly, not be
 * guessed at. */
const SUPPORTED_CORPUS_SCHEMA_VERSION = 1;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Unwraps a parsed imposter.json body to a single imposter's JSON text. Accepts either a bare
 * imposter object or a `{ imposters: [...] }` envelope carrying exactly one entry — any other
 * shape (zero or multiple imposters in an envelope) is a fixture-authoring error, not a value to
 * silently pick from, so it throws naming the fixture.
 */
function toSingleImposterJson(fixtureName: string, parsed: unknown): string {
  if (isPlainRecord(parsed) && Array.isArray(parsed['imposters'])) {
    const imposters = parsed['imposters'];
    if (imposters.length !== 1) {
      throw new Error(
        `fixture "${fixtureName}": expected exactly one imposter in the envelope, found ${imposters.length}`
      );
    }
    return JSON.stringify(imposters[0]);
  }
  return JSON.stringify(parsed);
}

/**
 * Loads one of the 6 local `test/fixtures/mb/*.json` files as an imposter-only `Fixture` (no
 * interactions) for the DSL expressibility gate — those fixtures predate rift#460 and carry no
 * `interactions.jsonl`.
 */
export function loadMbFixture(fileName: string): Fixture {
  const raw = fs.readFileSync(path.join(MB_FIXTURES_DIR, fileName), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return {
    name: fileName,
    imposterJson: toSingleImposterJson(fileName, parsed),
    interactions: [],
    requires: [],
  };
}

/** Loads all 6 local mb fixtures, imposter-only (no interactions). */
export function loadAllMbFixtures(): Fixture[] {
  return fs
    .readdirSync(MB_FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map(loadMbFixture);
}

/** The raw parsed JSON of a local mb fixture file, envelope included — for comparing a DSL
 * reconstruction against the fixture exactly as authored (see `conformance.test.ts`'s gate). */
export function readMbFixtureJson(fileName: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(MB_FIXTURES_DIR, fileName), 'utf8'));
}

// --- sdk-conformance-<version> corpus (rift#460) --------------------------------------------

function isCorpusFixtureEntry(value: unknown): value is CorpusFixtureEntry {
  return (
    isPlainRecord(value) &&
    typeof value['file'] === 'string' &&
    typeof value['port'] === 'number' &&
    typeof value['name'] === 'string' &&
    Array.isArray(value['requires']) &&
    value['requires'].every((r) => typeof r === 'string') &&
    typeof value['hasVerify'] === 'boolean'
  );
}

/**
 * Reads and validates `manifest.json` against the schema rift#460 actually ships.
 *
 * Every rejection throws. A corpus that is present but unreadable must never degrade into "no
 * corpus" — that is the silent-green failure this whole gate exists to remove.
 */
export function readCorpusManifest(corpusDir: string): CorpusManifest {
  const manifestPath = path.join(corpusDir, 'manifest.json');
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!isPlainRecord(parsed)) {
    throw new Error(`${manifestPath}: expected a JSON object`);
  }
  if (parsed['schemaVersion'] !== SUPPORTED_CORPUS_SCHEMA_VERSION) {
    throw new Error(
      `${manifestPath}: unsupported schemaVersion ${JSON.stringify(parsed['schemaVersion'])} ` +
        `(this loader understands ${SUPPORTED_CORPUS_SCHEMA_VERSION})`
    );
  }
  if (typeof parsed['engineVersion'] !== 'string') {
    throw new Error(`${manifestPath}: engineVersion must be a string`);
  }
  const fixtures: unknown = parsed['fixtures'];
  if (!Array.isArray(fixtures) || !fixtures.every(isCorpusFixtureEntry)) {
    throw new Error(
      `${manifestPath}: fixtures must be an array of ` +
        '{ file, port, name, requires, hasVerify } entries'
    );
  }
  return {
    schemaVersion: SUPPORTED_CORPUS_SCHEMA_VERSION,
    engineVersion: parsed['engineVersion'],
    fixtures,
  };
}

/**
 * Absolutizes data-file paths against the extracted `corpus/` root.
 *
 * The corpus contract resolves a fixture's relative paths (e.g. `data/products.csv`) with the
 * working directory set to `corpus/`, and explicitly sanctions absolutizing them at load time for
 * lanes that cannot set one — which is every lane here, since the embedded transport runs in-process
 * and the spawn transport's child inherits this process's cwd.
 *
 * Scoped deliberately to `fromDataSource.<format>.path` rather than "any string that looks like a
 * path": a blind rewrite would corrupt a response body that merely happens to start with `data/`.
 * A path-bearing key added upstream later is therefore missed here — but that surfaces as a loud
 * file-not-found from the engine, which is the right way to fail compared with silently rewriting
 * response payloads.
 */
function absolutizeDataPaths(value: unknown, corpusRoot: string): unknown {
  if (Array.isArray(value)) return value.map((v) => absolutizeDataPaths(v, corpusRoot));
  if (!isPlainRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === 'fromDataSource' && isPlainRecord(val)) {
      const sources: Record<string, unknown> = {};
      for (const [format, source] of Object.entries(val)) {
        if (isPlainRecord(source) && typeof source['path'] === 'string') {
          const p = source['path'];
          sources[format] = { ...source, path: path.isAbsolute(p) ? p : path.join(corpusRoot, p) };
        } else {
          sources[format] = absolutizeDataPaths(source, corpusRoot);
        }
      }
      out[key] = sources;
      continue;
    }
    out[key] = absolutizeDataPaths(val, corpusRoot);
  }
  return out;
}

/**
 * Flattens a fixture's per-stub `_verify.sequence` transcripts into the driver's `Interaction[]`,
 * in stub order then step order — the order the reference replayer drives them.
 *
 * Two shape adaptations, both 1:1: `request.method` defaults to GET when omitted (56 of the 63 steps
 * in the v0.17.0 corpus omit it), and the corpus's `expect.bodyEquals` is the driver's exact-body
 * `expect.body` (`bodyContains` already matches).
 */
function interactionsFrom(fixtureName: string, imposter: unknown): Interaction[] {
  if (!isPlainRecord(imposter) || !Array.isArray(imposter['stubs'])) return [];
  const interactions: Interaction[] = [];

  for (const [stubIndex, stub] of imposter['stubs'].entries()) {
    if (!isPlainRecord(stub)) continue;
    const verify = stub['_verify'];
    if (verify === undefined) continue;

    // A `_verify` that is present but unreadable must NOT degrade to "this stub has no transcript".
    // That silent drop is what would let an upstream rename of `sequence` sail through as a green
    // run proving nothing — the same class of failure as the speculated schema this loader replaces.
    if (!isPlainRecord(verify) || !Array.isArray(verify['sequence']) || verify['sequence'].length === 0) {
      throw new Error(
        `fixture "${fixtureName}": stubs[${stubIndex}]._verify must carry a non-empty sequence array`
      );
    }

    for (const [index, step] of verify['sequence'].entries()) {
      const at = `stubs[${stubIndex}]._verify.sequence[${index}]`;
      if (!isPlainRecord(step) || !isPlainRecord(step['request']) || !isPlainRecord(step['expect'])) {
        throw new Error(`fixture "${fixtureName}": ${at} must be { request, expect }`);
      }
      const request = step['request'];
      const expectation = step['expect'];
      if (typeof request['path'] !== 'string' || typeof expectation['status'] !== 'number') {
        throw new Error(`fixture "${fixtureName}": ${at} needs request.path and expect.status`);
      }
      // The driver checks `bodyContains` OR an exact body, never both, so a step carrying both would
      // silently assert only the weaker one. No shipped fixture does — reject it rather than let a
      // future one quietly lose an assertion.
      if (expectation['bodyContains'] !== undefined && expectation['bodyEquals'] !== undefined) {
        throw new Error(
          `fixture "${fixtureName}": ${at} sets both bodyContains and bodyEquals; only one is asserted`
        );
      }

      const built: Interaction = {
        request: {
          method: typeof request['method'] === 'string' ? request['method'] : 'GET',
          path: request['path'],
        },
        expect: { status: expectation['status'] },
      };
      if (isPlainRecord(request['headers'])) {
        built.request.headers = request['headers'] as Record<string, string>;
      }
      if (request['body'] !== undefined) built.request.body = request['body'] as JsonValue;
      if (typeof expectation['bodyContains'] === 'string') {
        built.expect.bodyContains = expectation['bodyContains'];
      }
      if (expectation['bodyEquals'] !== undefined) {
        built.expect.body = expectation['bodyEquals'] as JsonValue;
      }
      interactions.push(built);
    }
  }
  return interactions;
}

/** Loads one manifest entry: its imposter config plus the transcripts inlined in its stubs. */
export function loadCorpusFixture(corpusDir: string, entry: CorpusFixtureEntry): Fixture {
  const filePath = path.join(corpusDir, entry.file);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (cause) {
    throw new Error(
      `fixture "${entry.name}": cannot read ${filePath} (from manifest entry "${entry.file}")`,
      { cause }
    );
  }
  const parsed: unknown = JSON.parse(raw);
  const single: unknown = JSON.parse(toSingleImposterJson(entry.name, parsed));
  const resolved = absolutizeDataPaths(single, path.join(corpusDir, 'corpus'));
  const interactions = interactionsFrom(entry.name, resolved);

  // The manifest already tells us whether transcripts exist, so disagreeing with it is a corpus or
  // loader defect either way. Without this check a fixture that lost its transcripts would quietly
  // fall through to the caller's no-interactions path and pass as a serve smoke test.
  if (entry.hasVerify !== interactions.length > 0) {
    throw new Error(
      `fixture "${entry.name}": manifest says hasVerify=${entry.hasVerify} but ` +
        `${interactions.length} interaction(s) were loaded from ${entry.file}`
    );
  }

  return {
    name: entry.name,
    imposterJson: JSON.stringify(resolved),
    interactions,
    requires: entry.requires,
  };
}

/**
 * Capabilities a fixture declares that the lane cannot provide. The corpus contract (README §4)
 * permits a skip for exactly this reason and no other, so this is the only thing a lane may consult
 * when deciding to skip.
 */
export function unmetRequirements(fixture: Fixture, laneCapabilities: ReadonlySet<string>): string[] {
  return fixture.requires.filter((capability) => !laneCapabilities.has(capability));
}

/** Loads every fixture the corpus manifest lists, in manifest order. */
export function loadCorpus(corpusDir: string): Fixture[] {
  return readCorpusManifest(corpusDir).fixtures.map((entry) => loadCorpusFixture(corpusDir, entry));
}

/**
 * Resolves the corpus directory (the one holding `manifest.json`) from `RIFT_CORPUS_DIR`, the
 * variable rift's `sdk-matrix.yml` already exports job-wide.
 *
 * Unset means "no corpus" and the caller falls back to the local mb fixtures. Set-but-invalid
 * THROWS: a CI lane that asked for corpus replay and silently got two local fixtures instead would
 * report green while proving nothing, which is exactly the asymmetry issue #98 closes.
 */
export function resolveCorpusDir(env: EnvRecord = process.env): string | undefined {
  const dir = env.RIFT_CORPUS_DIR;
  if (dir === undefined || dir === '') return undefined;
  if (!fs.existsSync(dir)) {
    throw new Error(`RIFT_CORPUS_DIR is set to "${dir}", which does not exist`);
  }
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    throw new Error(`RIFT_CORPUS_DIR is set to "${dir}", which has no manifest.json`);
  }
  return dir;
}

export interface FetchCorpusOptions {
  env?: EnvRecord;
  /** Release mirror base; defaults to the same base the engine binary is fetched from. */
  mirror?: string;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_CORPUS_MIRROR = 'https://github.com/achird-labs/rift/releases/download';

function defaultCorpusCacheDir(): string {
  return path.join(here, '..', '..', '.cache', 'conformance-corpus');
}

/**
 * Fetches and caches `sdk-conformance-<version>.tar.gz` (rift#460), verifying it against its
 * `.sha256` sidecar before extracting — mirrors `spawn/resolve.ts`'s binary download discipline
 * (mandatory checksum, injectable IO, air-gap aware). Honors `RIFT_OFFLINE` /
 * `RIFT_SKIP_BINARY_DOWNLOAD` by refusing the network rather than silently returning nothing, same
 * as `resolveBinary`.
 *
 * CI discovery is env-var driven ({@link resolveCorpusDir} / `RIFT_CORPUS_DIR`, which rift's
 * `sdk-matrix.yml` already exports job-wide), so this fetcher is the convenience path for replaying
 * the corpus locally without downloading and extracting it by hand — not the mechanism the matrix
 * depends on.
 */
export async function fetchCorpusTarball(
  version: string,
  opts: FetchCorpusOptions = {}
): Promise<string> {
  const env = opts.env ?? process.env;
  const cacheDir = opts.cacheDir ?? defaultCorpusCacheDir();
  const destDir = path.join(cacheDir, `sdk-conformance-${version}`);
  if (fs.existsSync(path.join(destDir, 'manifest.json'))) {
    return destDir;
  }

  if (isAirGapped(env)) {
    throw new Error(
      `sdk-conformance-${version} corpus not cached locally and downloads are disabled ` +
        '(RIFT_OFFLINE or RIFT_SKIP_BINARY_DOWNLOAD is set).'
    );
  }

  const base = opts.mirror ?? env.RIFT_DOWNLOAD_URL ?? env.RIFT_MIRROR_URL ?? DEFAULT_CORPUS_MIRROR;
  const archiveName = `sdk-conformance-${version}.tar.gz`;
  const url = `${base}/${version}/${archiveName}`;
  const doFetch = opts.fetchImpl ?? fetch;

  const response = await doFetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download conformance corpus from ${url}: HTTP ${response.status}`);
  }
  const data = Buffer.from(await response.arrayBuffer());

  const shaResponse = await doFetch(`${url}.sha256`);
  if (!shaResponse.ok) {
    throw new Error(`No SHA-256 checksum available for ${url}; refusing to use an unverified download.`);
  }
  const sha = (await shaResponse.text()).trim().split(/\s+/)[0];
  if (sha === undefined || !/^[0-9a-fA-F]{64}$/.test(sha) || !verifySha256(data, sha)) {
    throw new Error(`Checksum mismatch for conformance corpus downloaded from ${url}`);
  }

  fs.mkdirSync(destDir, { recursive: true });
  const archivePath = path.join(cacheDir, archiveName);
  fs.writeFileSync(archivePath, data);
  try {
    const { execSync } = await import('child_process');
    execSync(`tar -xzf "${archivePath}" -C "${destDir}" --strip-components=1`, { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(archivePath);
  }
  return destDir;
}

/** True when the corpus for `version` is already cached locally, without touching the network. */
export function corpusCached(version: string, cacheDir?: string): boolean {
  const dir = path.join(cacheDir ?? defaultCorpusCacheDir(), `sdk-conformance-${version}`);
  return fs.existsSync(path.join(dir, 'manifest.json'));
}
