# Contributing to `@rift-vs/rift`

This is the official Node.js / TypeScript SDK for [Rift](https://github.com/achird-labs/rift).
It was extracted (history-preserving) from `rift/packages/rift-node` and now versions
independently.

## Toolchain

- **Node.js 20, 22, or 24** (`engines.node >= 20`). CI runs the full matrix across
  linux / macOS / windows.
- **ESM only.** The package is `"type": "module"`; source is TypeScript compiled with `tsc`
  to `dist/` (ESM `.js` + `.d.ts` declarations).

## Local workflow

```sh
npm ci                 # install exact, locked dependencies
npm run build          # tsc -> dist/ (emits .d.ts)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint src test
npm test               # jest (unit + integration)
npm run test:unit      # unit tests only (no rift binary needed)
```

The unit tests are hermetic. The integration tests self-skip unless a rift binary is
discoverable (via `RIFT_BINARY_PATH`, `PATH`, or the downloaded `binaries/` copy). Set
`RIFT_SKIP_BINARY_DOWNLOAD=1` to skip the postinstall binary download (CI does this).

### Replaying the sdk-conformance corpus

`RIFT_CORPUS_DIR` points the conformance suite at an extracted
`sdk-conformance-<version>.tar.gz` (a per-release asset of the engine repo) — the same corpus the
java and go SDK lanes replay. Point it at the directory holding `manifest.json`:

```sh
gh release download v0.17.0 --repo achird-labs/rift --pattern 'sdk-conformance-*.tar.gz'
tar -xzf sdk-conformance-v0.17.0.tar.gz
RIFT_CORPUS_DIR=$PWD/sdk-conformance-v0.17.0 npm test -w @rift-vs/rift
```

Each manifest fixture then becomes its own spec in both transport lanes. Unset, the suite falls back
to the local `test/fixtures/mb` fixtures — but **set-but-invalid is a hard error, never a fallback**:
a lane that asked for corpus replay and quietly replayed two local fixtures instead would report
green having proved nothing. Fixtures are skipped only for a capability the lane lacks, per the
corpus's own contract; here that means the two `proxy` fixtures (no upstream is provisioned), so 13
of the 15 replay.

## Versioning

- The `package.json` version is the **next intended stable target** (currently `0.12.1`),
  strictly above the last monorepo publish (`0.12.0`). The monorepo still publishes
  `@rift-vs/rift` independently and may advance the line at any time, so this number is not
  reserved — the exact stable version is confirmed free and chosen when a **release** is cut.
- **CI never publishes a stable version.** On every push to `master` it publishes a snapshot
  prerelease `X.Y.Z-snapshot.<run>.g<sha>` under the `snapshot` dist-tag (`npm i @rift-vs/rift@snapshot`).
  Snapshot version strings are always unique, so they can never collide with a monorepo publish
  and the publish/dry-run jobs stay green regardless of what the monorepo ships. `latest` is only
  moved by a stable release.
- `package.json#minEngineVersion` records the **minimum Rift engine version** this SDK
  supports. It is decoupled from the SDK's own `version`: the SDK can ship patches without an
  engine bump, and raises `minEngineVersion` only when it depends on newer engine behavior.

## Branches & commits

- Branch prefixes: `feat/`, `fix/`, `refactor/`, `test/`, `build/`, `docs/`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat(core): …`, `fix(embedded): …`, `build: …`), imperative mood, explaining *why*.
- One logical change per PR; keep the public `create()` surface backward compatible.

## Publishing

- CI runs `npm publish --dry-run` on every push/PR (the `Publish / dry-run` job), so a broken
  publish surface fails fast.
- A real publish is gated on a **GitHub Release**: tag `vX.Y.Z` must match `package.json`
  version, and the `publish` job runs `npm publish` with the `NPM_TOKEN` secret.
