/**
 * Gate for issue #25 AC4 (built-output arm) — after `tsc`, every path declared in the package
 * `exports` map resolves to a real emitted file, and the package's own exports map resolves
 * end-to-end via Node self-referencing. This catches an `exports`/`dist` mismatch (wrong path,
 * missing emit, tsconfig not covering a subdir) that a src-only import test would miss.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

describe('issue #25 — exports map resolves to built output (AC4)', () => {
  beforeAll(() => {
    execSync('npm run build', { cwd: repoRoot, stdio: 'pipe' });
  }, 120_000);

  it('every exports subpath points to an emitted .js and .d.ts under dist/', () => {
    for (const entry of Object.values<Record<string, string>>(pkg.exports)) {
      expect(existsSync(join(repoRoot, entry.import))).toBe(true);
      expect(existsSync(join(repoRoot, entry.types))).toBe(true);
    }
  });

  it('the package resolves every subpath through its own exports map (self-reference import)', () => {
    const specifiers = Object.keys(pkg.exports)
      // `./testkit/vitest` hard-requires the optional `vitest` peer dependency (issue #12), which
      // isn't installed here — covered separately below instead of lumped into this all-resolve check.
      .filter((s) => s !== './testkit/vitest')
      .map((s) => (s === '.' ? pkg.name : `${pkg.name}/${s.replace(/^\.\//, '')}`));
    const script = specifiers.map((s) => `await import(${JSON.stringify(s)});`).join('\n');
    // Runs in a child node process with cwd at the package root so Node self-references `pkg.name`
    // via the exports map. Throws (non-zero exit) if any subpath fails to resolve or load.
    execSync(`node --input-type=module -e "${script.replace(/"/g, '\\"')}"`, { cwd: repoRoot, stdio: 'pipe' });
  }, 30_000);

  it('./testkit/vitest resolves through the exports map to dist, failing only on the missing `vitest` peer', () => {
    const specifier = `${pkg.name}/testkit/vitest`;
    const script = `await import(${JSON.stringify(specifier)});`;
    expect(() =>
      execSync(`node --input-type=module -e "${script.replace(/"/g, '\\"')}"`, {
        cwd: repoRoot,
        stdio: 'pipe',
      })
    ).toThrow(/Cannot find package 'vitest'/);
  }, 30_000);
});
