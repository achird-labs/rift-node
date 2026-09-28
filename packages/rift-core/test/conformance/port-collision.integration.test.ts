/**
 * Gate for #72 — a fixture pinned to a port that another host process ALREADY serves must still
 * replay against the real imposter, not the squatter. Before the fix the engine bound the fixture's
 * verbatim port and `handle.url` pointed at the contested port, so `fetch` could hit the foreign
 * listener and fail with a maximally-confusing right-status/empty-body mismatch. The driver now
 * strips the port so the engine auto-assigns a free one.
 *
 * Deterministic: the test stands up its OWN squatter on an OS-assigned ephemeral port and pins the
 * fixture to that same port — no reliance on any well-known number. Self-skips without RIFT_FFI_LIB
 * + koffi (same convention as the other embedded lanes).
 */
import { createServer, type Server } from 'http';
import { createRequire } from 'module';
import { rift } from '../../src/index.js';
import { replayFixture } from './driver.js';
import type { Fixture } from './loader.js';

function koffiIsInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('koffi');
    return true;
  } catch {
    return false;
  }
}

const embeddedRunnable = Boolean(process.env.RIFT_FFI_LIB) && koffiIsInstalled();
const describeEmbeddedOrSkip = embeddedRunnable ? describe : describe.skip;

/** A foreign server that answers 200 with a distinct body on any path — the "squatter". */
function startSquatter(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ served_by: 'squatter' }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('squatter did not get a TCP port'));
        return;
      }
      resolve({ port: addr.port, server });
    });
  });
}

describeEmbeddedOrSkip('#72 — replay survives a host port collision (real cdylib)', () => {
  it('replays against the real imposter even when its pinned port is already taken', async () => {
    const { port, server } = await startSquatter();
    try {
      await using engine = await rift.embedded();
      const fixture: Fixture = {
        name: 'collision',
        requires: [],
        imposterJson: JSON.stringify({
          port, // deliberately collides with the squatter above
          protocol: 'http',
          stubs: [
            {
              predicates: [{ equals: { method: 'GET', path: '/probe' } }],
              responses: [{ is: { statusCode: 200, body: JSON.stringify({ served_by: 'imposter' }) } }],
            },
          ],
        }),
        interactions: [
          {
            request: { method: 'GET', path: '/probe' },
            expect: { status: 200, bodyContains: '"served_by":"imposter"' },
          },
        ],
      };
      // Passes ONLY if the engine bound a free port (not the squatted one) and the driver fetched
      // that imposter — pre-fix this either threw (port in use) or hit the squatter (wrong body).
      await replayFixture(engine, fixture);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});
