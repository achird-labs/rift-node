/**
 * Gate for issue #142 — `SpaceHandle.addStub()` over a live spawned engine. The space route takes
 * the stub object bare; the SDK used to send the `{ stub }` envelope, which engine 0.18.0 refuses
 * (400) and older engines read as an empty catch-all stub. Only a real engine can prove the stub
 * that lands is the one the caller built, so this self-skips without a Rift binary, like
 * requests.integration.test.ts.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import { rift, imposter } from '../../src/index.js';

function binaryAvailable(): boolean {
  if (process.env.RIFT_SKIP_BINARY_DOWNLOAD || process.env.RIFT_OFFLINE) {
    if (process.env.RIFT_BINARY_PATH) return fs.existsSync(process.env.RIFT_BINARY_PATH);
    return false;
  }
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

const describeOrSkip = binaryAvailable() ? describe : describe.skip;

describeOrSkip('issue #142 — space stubs over spawn', () => {
  it('a stub added via space().addStub() is listed back intact and answers only its flow', async () => {
    await using engine = await rift.spawn();
    const tenants = await engine.create(
      imposter('tenants').flowState({ backend: 'inmemory', flowIdSource: 'header:X-Mock-Space' })
    );

    const alice = tenants.space('alice');
    await alice.addStub({
      predicates: [{ equals: { path: '/data' } }],
      responses: [{ is: { statusCode: 200, body: { owner: 'alice' } } }],
    });

    const listed = await alice.stubs();
    expect(listed.space).toBe('alice');
    expect(listed.stubs).toHaveLength(1);
    // `statusCode` is deliberately not pinned here: the engine writes it back as a string on
    // every read path, which is unrelated to this route. The live fetch below proves the 200.
    expect(listed.stubs[0]).toMatchObject({
      space: 'alice',
      predicates: [{ equals: { path: '/data' } }],
      responses: [{ is: expect.objectContaining({ body: { owner: 'alice' } }) }],
    });

    const inFlow = await fetch(`${tenants.url}/data`, { headers: { 'X-Mock-Space': 'alice' } });
    expect(inFlow.status).toBe(200);
    expect(await inFlow.json()).toEqual({ owner: 'alice' });

    // Same path, no flow header: the request resolves to the port's shared space, where the
    // space-scoped stub must not leak.
    const outOfFlow = await fetch(`${tenants.url}/data`);
    expect(await outOfFlow.text()).not.toContain('alice');
  }, 45_000);
});
