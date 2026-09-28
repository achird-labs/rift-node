/**
 * Real-engine integration test for the TLS-MITM intercept surface (issue #11).
 *
 * Two lanes:
 *  - embedded: self-skips unless BOTH `RIFT_FFI_LIB` (a real `librift_ffi` C-ABI v2 build with
 *    intercept support) is set AND `koffi` is resolvable.
 *  - spawn: self-skips unless a genuine Rift engine binary (`rift-http-proxy`/`rift`, NOT plain
 *    Mountebank's `mb` — `--intercept-port` is a Rift-only extension) is available.
 *
 * Neither lane runs in CI by default (no cdylib, no Rift binary, no undici in this worktree); both
 * self-skip cleanly so `npm test` stays green everywhere.
 */

import { execSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { rift, imposter, onGet, okJson } from '../../src/index.js';
import { interceptDispatcher } from '../../src/intercept-undici.js';

function koffiIsInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('koffi');
    return true;
  } catch {
    return false;
  }
}

function undiciIsInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('undici');
    return true;
  } catch {
    return false;
  }
}

const libPath = process.env.RIFT_FFI_LIB;
const embeddedRunnable = Boolean(libPath) && koffiIsInstalled();
const describeEmbeddedOrSkip = embeddedRunnable ? describe : describe.skip;

/** Deliberately excludes `mb` (plain Mountebank) — `--intercept-port`/`/intercept/*` are Rift-only
 * extensions a real Mountebank binary neither understands nor exposes. */
function riftBinaryAvailable(): boolean {
  if (process.env.RIFT_BINARY_PATH) return fs.existsSync(process.env.RIFT_BINARY_PATH);
  for (const name of ['rift-http-proxy', 'rift']) {
    try {
      execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${name}`, { stdio: 'pipe' });
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

const spawnRunnable = riftBinaryAvailable();
const describeSpawnOrSkip = spawnRunnable ? describe : describe.skip;

/** PKCS12 is DER (ASN.1 SEQUENCE, tag 0x30); JKS starts with the magic `0xFEEDFEED`. Full parsing
 * isn't available via `node:crypto` — this is the "where possible" best-effort artifact check. */
async function assertPkcs12Artifact(p: string): Promise<void> {
  const bytes = await fsp.readFile(p);
  expect(bytes.length).toBeGreaterThan(0);
  expect(bytes[0]).toBe(0x30);
}

async function assertJksArtifact(p: string): Promise<void> {
  const bytes = await fsp.readFile(p);
  expect(bytes.length).toBeGreaterThan(0);
  expect(bytes.readUInt32BE(0)).toBe(0xfeedfeed);
}

describeEmbeddedOrSkip('intercept — embedded lane (real cdylib)', () => {
  it('start → serve → fetch through the proxy → 200, no TLS errors', async () => {
    await using engine = await rift.embedded({ libPath });
    const icpt = await engine.intercept();

    await icpt.serve('api.example.com', okJson({ stub: true }));

    if (!undiciIsInstalled()) return;
    const dispatcher = await interceptDispatcher(icpt);
    const res = await fetch('https://api.example.com/anything', {
      dispatcher,
    } as unknown as RequestInit);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stub: true });
  }, 30_000);

  it('forward() routes to a real imposter; its verify() sees the request', async () => {
    await using engine = await rift.embedded({ libPath });
    const upstream = await engine.create(
      imposter('upstream').record().stub(onGet('/x').willReturn(okJson({ ok: true })))
    );
    const icpt = await engine.intercept();
    await icpt.forward('forward.example.com', upstream);

    if (undiciIsInstalled()) {
      const dispatcher = await interceptDispatcher(icpt);
      await fetch('https://forward.example.com/x', { dispatcher } as unknown as RequestInit);
      await upstream.verify(onGet('/x'));
    }
  }, 30_000);

  it('redirectTo() catch-all; rule listing/clearing round-trips; raw addRule works', async () => {
    await using engine = await rift.embedded({ libPath });
    const upstream = await engine.create(imposter('catchall'));
    const icpt = await engine.intercept();

    await icpt.redirectTo(upstream);
    expect(await icpt.rules()).toEqual([{ action: { forward: { port: upstream.port } } }]);

    await icpt.addRule({ host: 'raw.example.com', action: { serve: { statusCode: 204 } } });
    expect(await icpt.rules()).toHaveLength(2);

    await icpt.clearRules();
    expect(await icpt.rules()).toEqual([]);
  }, 30_000);

  it('caFile()/exportTruststore() produce real artifacts', async () => {
    await using engine = await rift.embedded({ libPath });
    const icpt = await engine.intercept();

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rift-intercept-'));
    try {
      const caFile = await icpt.caFile(dir);
      expect((await fsp.readFile(caFile, 'utf8')).trim()).toMatch(/-----BEGIN CERTIFICATE-----/);

      const p12 = path.join(dir, 'trust.p12');
      await icpt.exportTruststore({ format: 'pkcs12', path: p12 });
      await assertPkcs12Artifact(p12);

      const jks = path.join(dir, 'trust.jks');
      await icpt.exportTruststore({ format: 'jks', path: jks });
      await assertJksArtifact(jks);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('env() runs a child Node SUT through the proxy successfully', async () => {
    await using engine = await rift.embedded({ libPath });
    const icpt = await engine.intercept();
    await icpt.serve('child-sut.example.com', okJson({ fromChild: true }));

    const env = await icpt.env();
    const { execFileSync } = await import('child_process');
    const script =
      "fetch('https://child-sut.example.com/x').then(r => r.json()).then(b => { process.stdout.write(JSON.stringify(b)); });";
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(JSON.parse(out)).toEqual({ fromChild: true });
  }, 30_000);
});

describeSpawnOrSkip('intercept — spawn lane (real Rift engine binary)', () => {
  it('rift.spawn({ intercept: true }) → engine.intercept() attaches; serve()/forward() work', async () => {
    await using engine = await rift.spawn({ intercept: true });
    const icpt = await engine.intercept();
    expect(icpt.port).toBeGreaterThan(0);

    await icpt.serve('api.example.com', okJson({ stub: true }));
    expect(await icpt.rules()).toHaveLength(1);

    // Unlike imposter stubs, a rule's `statusCode` lists back as a number even when posted as a
    // numeric string: the rule store holds a u16 (issue #155). `addRule` sends it verbatim.
    await icpt.addRule({ host: 'teapot.example.com', action: { serve: { statusCode: '418' as unknown as number } } });
    const teapot = (await icpt.rules()).find((r) => r.host === 'teapot.example.com');
    expect(teapot).toMatchObject({ action: { serve: { statusCode: 418 } } });
  }, 45_000);

  it('rift.spawn({}) (no intercept) → engine.intercept() rejects with the documented guidance', async () => {
    await using engine = await rift.spawn();
    await expect(engine.intercept()).rejects.toThrow(/pass intercept: true to rift\.spawn/);
  }, 45_000);
});
