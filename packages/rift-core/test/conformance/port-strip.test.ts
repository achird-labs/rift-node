/**
 * Gate for #72 — the replay driver must NOT bind a fixture's explicit `port`. The step URLs come
 * from the created handle (`handle.url`), so the pinned port is incidental to behavioral replay;
 * binding it makes the lane fail (silently, with an empty body) whenever another host process
 * already serves that port. The driver strips the port so the engine auto-assigns an ephemeral one.
 *
 * Deterministic + koffi-free: a fake engine captures the imposter it is asked to create; the
 * fixture carries zero interactions, so nothing is fetched and no real server is needed.
 */
import { replayFixture } from './driver.js';
import type { Fixture } from './loader.js';
import type { RiftEngine } from '../../src/engine.js';

interface Created {
  imposter: { port?: number; protocol?: string; stubs?: unknown[] };
}

function fakeEngine(captured: Created[]): RiftEngine {
  const engine = {
    create(def: unknown): Promise<{ url: string; delete(): Promise<void> }> {
      captured.push({ imposter: def as Created['imposter'] });
      return Promise.resolve({ url: 'http://127.0.0.1:53999', delete: () => Promise.resolve() });
    },
  };
  return engine as unknown as RiftEngine;
}

function fixture(imposter: Record<string, unknown>): Fixture {
  return { name: 'port-strip', imposterJson: JSON.stringify(imposter), interactions: [], requires: [] };
}

const STUBS = [{ predicates: [{ equals: { path: '/x' } }], responses: [{ is: { statusCode: 200 } }] }];

describe('#72 — replay strips the fixture port before create', () => {
  it('drops an explicit port so the engine auto-assigns (no host-port collision)', async () => {
    const captured: Created[] = [];
    await replayFixture(fakeEngine(captured), fixture({ port: 4545, protocol: 'http', stubs: STUBS }));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.imposter.port).toBeUndefined();
    // everything else about the imposter is preserved
    expect(captured[0]!.imposter.protocol).toBe('http');
    expect(captured[0]!.imposter.stubs).toHaveLength(1);
  });

  it('leaves a port-less fixture untouched (still no port)', async () => {
    const captured: Created[] = [];
    await replayFixture(fakeEngine(captured), fixture({ protocol: 'http', stubs: STUBS }));
    expect(captured[0]!.imposter.port).toBeUndefined();
  });
});
