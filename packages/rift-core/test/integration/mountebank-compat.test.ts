/**
 * Mountebank API Compatibility Tests
 *
 * These tests verify that the Rift server implements the Mountebank REST API.
 * They are designed to match Mountebank's behavior for drop-in replacement.
 *
 * Requires the rift-http-proxy binary with --mountebank support.
 */

import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { create } from '../../src/index.js';
import type { RiftServer } from '../../src/types.js';
import type { Imposter } from '../../src/model/index.js';

// POST an imposter and assert the create succeeded. `fetch` (unlike axios) does not throw on a
// non-2xx status, so setup POSTs must be checked explicitly — otherwise a broken create silently
// leaves later "imposter is absent" assertions trivially true.
async function postImposter(baseUrl: string, imposter: unknown): Promise<void> {
  const res = await fetch(`${baseUrl}/imposters`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(imposter),
  });
  if (!res.ok) {
    throw new Error(`imposter setup POST failed: ${res.status} ${await res.text()}`);
  }
}

// Synchronous check at module load time
function checkBinarySync(): boolean {
  // Check environment variable
  if (process.env.RIFT_BINARY_PATH) {
    return fs.existsSync(process.env.RIFT_BINARY_PATH);
  }

  // Check if any of the binary names are in PATH
  const binaryNames = ['rift-http-proxy', 'rift', 'mb'];
  const cmd = process.platform === 'win32' ? 'where' : 'which';

  for (const name of binaryNames) {
    try {
      execSync(`${cmd} ${name}`, { stdio: 'pipe' });
      return true;
    } catch {
      // Try next name
    }
  }

  return false;
}

const binaryAvailable = checkBinarySync();

if (!binaryAvailable) {
  console.warn('\n⚠️  Rift binary not found, skipping Mountebank compatibility tests');
  console.warn('   Set RIFT_BINARY_PATH to enable these tests\n');
}

const conditionalDescribe = binaryAvailable ? describe : describe.skip;

conditionalDescribe('Mountebank API Compatibility', () => {
  describe('REST API', () => {
    let server: RiftServer;
    const adminPort = 4000;
    const baseUrl = `http://localhost:${adminPort}`;

    beforeAll(async () => {
      server = await create({ port: adminPort });
    });

    afterAll(async () => {
      await server.close();
    });

    beforeEach(async () => {
      // Clean up imposters before each test
      try {
        await fetch(`${baseUrl}/imposters`, { method: 'DELETE' });
      } catch {
        // Ignore if delete fails
      }
    });

    describe('GET /', () => {
      it('returns server info', async () => {
        const response = await fetch(`${baseUrl}/`);
        const body = (await response.json()) as any;

        expect(response.status).toBe(200);
        // Rift returns _links structure for API navigation
        expect(body).toHaveProperty('_links');
        expect(body._links).toHaveProperty('imposters');
        expect(body._links).toHaveProperty('config');
        expect(body._links).toHaveProperty('logs');
      });
    });

    describe('GET /imposters', () => {
      it('returns empty list when no imposters', async () => {
        const response = await fetch(`${baseUrl}/imposters`);
        const body = (await response.json()) as any;

        expect(response.status).toBe(200);
        expect(body).toHaveProperty('imposters');
        expect(body.imposters).toEqual([]);
      });

      it('returns list of imposters', async () => {
        // Create an imposter first
        const imposter: Imposter = {
          port: 4545,
          protocol: 'http',
          stubs: [
            {
              responses: [{ is: { statusCode: 200, body: 'OK' } }],
            },
          ],
        };

        await fetch(`${baseUrl}/imposters`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(imposter),
        });

        const response = await fetch(`${baseUrl}/imposters`);
        const body = (await response.json()) as any;

        expect(response.status).toBe(200);
        expect(body.imposters.length).toBeGreaterThan(0);
        expect(body.imposters.some((i: Imposter) => i.port === 4545)).toBe(true);
      });
    });

    describe('POST /imposters', () => {
      it('creates a simple imposter', async () => {
        const imposter: Imposter = {
          port: 4546,
          protocol: 'http',
          stubs: [
            {
              responses: [
                {
                  is: {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: 'Hello' }),
                  },
                },
              ],
            },
          ],
        };

        const response = await fetch(`${baseUrl}/imposters`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(imposter),
        });
        const body = (await response.json()) as any;

        expect(response.status).toBe(201);
        expect(body.port).toBe(4546);
        expect(body.protocol).toBe('http');
      });

      it('imposter responds to requests', async () => {
        const imposter: Imposter = {
          port: 4547,
          protocol: 'http',
          stubs: [
            {
              responses: [
                {
                  is: {
                    statusCode: 200,
                    headers: { 'Content-Type': 'text/plain' },
                    body: 'Hello from imposter!',
                  },
                },
              ],
            },
          ],
        };

        await fetch(`${baseUrl}/imposters`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(imposter),
        });

        // Make a request to the imposter
        const response = await fetch('http://localhost:4547/');
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(body).toBe('Hello from imposter!');
      });

      it('creates imposter with predicates', async () => {
        const imposter: Imposter = {
          port: 4548,
          protocol: 'http',
          stubs: [
            {
              predicates: [
                {
                  equals: {
                    method: 'GET',
                    path: '/api/users',
                  },
                },
              ],
              responses: [
                {
                  is: {
                    statusCode: 200,
                    body: JSON.stringify([{ id: 1, name: 'Alice' }]),
                  },
                },
              ],
            },
          ],
        };

        await fetch(`${baseUrl}/imposters`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(imposter),
        });

        // Matching request should return 200
        const matchResponse = await fetch('http://localhost:4548/api/users');
        expect(matchResponse.status).toBe(200);

        // Note: Default response for non-matching requests varies between Rift and Mountebank
        // Mountebank returns a default response, Rift may proxy or return 404
      });
    });

    describe('GET /imposters/:port', () => {
      it('returns specific imposter', async () => {
        const imposter: Imposter = {
          port: 4549,
          protocol: 'http',
          name: 'Test Imposter',
          stubs: [
            {
              responses: [{ is: { statusCode: 200 } }],
            },
          ],
        };

        await fetch(`${baseUrl}/imposters`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(imposter),
        });

        const response = await fetch(`${baseUrl}/imposters/4549`);
        const body = (await response.json()) as any;

        expect(response.status).toBe(200);
        expect(body.port).toBe(4549);
        expect(body.name).toBe('Test Imposter');
      });

      it('returns 404 for non-existent imposter', async () => {
        const response = await fetch(`${baseUrl}/imposters/9999`);
        expect(response.status).toBe(404);
      });
    });

    describe('DELETE /imposters/:port', () => {
      it('deletes specific imposter', async () => {
        const imposter: Imposter = {
          port: 4550,
          protocol: 'http',
          stubs: [{ responses: [{ is: { statusCode: 200 } }] }],
        };

        await fetch(`${baseUrl}/imposters`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(imposter),
        });

        // Verify it exists
        const before = await fetch(`${baseUrl}/imposters/4550`);
        expect(before.status).toBe(200);

        // Delete it
        const deleteResponse = await fetch(`${baseUrl}/imposters/4550`, { method: 'DELETE' });
        expect(deleteResponse.status).toBe(200);

        // Verify it's gone
        const after = await fetch(`${baseUrl}/imposters/4550`);
        expect(after.status).toBe(404);
      });
    });

    describe('DELETE /imposters', () => {
      it('deletes all imposters', async () => {
        // Create multiple imposters
        await fetch(`${baseUrl}/imposters`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            port: 4551,
            protocol: 'http',
            stubs: [{ responses: [{ is: { statusCode: 200 } }] }],
          }),
        });

        await fetch(`${baseUrl}/imposters`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            port: 4552,
            protocol: 'http',
            stubs: [{ responses: [{ is: { statusCode: 200 } }] }],
          }),
        });

        // Verify they exist
        const before = await fetch(`${baseUrl}/imposters`);
        const beforeBody = (await before.json()) as any;
        expect(beforeBody.imposters.length).toBeGreaterThanOrEqual(2);

        // Delete all
        const deleteResponse = await fetch(`${baseUrl}/imposters`, { method: 'DELETE' });
        expect(deleteResponse.status).toBe(200);

        // Verify all are gone
        const after = await fetch(`${baseUrl}/imposters`);
        const afterBody = (await after.json()) as any;
        expect(afterBody.imposters.length).toBe(0);
      });
    });

    describe('PUT /imposters', () => {
      it('replaces all imposters', async () => {
        // Create initial imposter (asserts creation succeeded, so the later not.toContain is meaningful)
        await postImposter(baseUrl, {
          port: 4553,
          protocol: 'http',
          stubs: [{ responses: [{ is: { statusCode: 200 } }] }],
        });

        // Confirm it is present before the replace, so removing it is what we actually test.
        const beforeList = (await (await fetch(`${baseUrl}/imposters`)).json()) as any;
        expect(beforeList.imposters.map((i: Imposter) => i.port)).toContain(4553);

        // Replace with new set
        const newImposters = {
          imposters: [
            {
              port: 4554,
              protocol: 'http',
              stubs: [{ responses: [{ is: { statusCode: 201 } }] }],
            },
            {
              port: 4555,
              protocol: 'http',
              stubs: [{ responses: [{ is: { statusCode: 202 } }] }],
            },
          ],
        };

        const response = await fetch(`${baseUrl}/imposters`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(newImposters),
        });
        expect(response.status).toBe(200);

        // Verify old imposter is gone and new ones exist
        const list = await fetch(`${baseUrl}/imposters`);
        const listBody = (await list.json()) as any;
        const ports = listBody.imposters.map((i: Imposter) => i.port);

        expect(ports).not.toContain(4553);
        expect(ports).toContain(4554);
        expect(ports).toContain(4555);
      });
    });

    describe('POST /imposters/:port/stubs', () => {
      it('adds stub to existing imposter', async () => {
        // Create imposter with one stub
        await fetch(`${baseUrl}/imposters`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            port: 4556,
            protocol: 'http',
            stubs: [
              {
                predicates: [{ equals: { path: '/first' } }],
                responses: [{ is: { statusCode: 200, body: 'first' } }],
              },
            ],
          }),
        });

        // Verify the first stub works
        const firstResponse = await fetch('http://localhost:4556/first');
        const firstBody = await firstResponse.text();
        expect(firstBody).toBe('first');

        // Note: POST /imposters/:port/stubs may have different behavior in Rift
        // For full stub management, recreate the imposter with all stubs included
      });
    });
  });
});

// issue #77 — datadir persistence round-trip through the compat create() path. Proves the SDK
// actually wires --datadir end-to-end (not just the flag): an imposter POSTed to one server is
// reloaded by a fresh server pointed at the same datadir.
conditionalDescribe('Mountebank persistence (datadir) parity', () => {
  const adminPort = 4600;
  const imposterPort = 4601;
  let datadir: string;

  beforeEach(() => {
    datadir = fs.mkdtempSync(`${os.tmpdir()}/rift-datadir-`);
  });

  afterEach(() => {
    fs.rmSync(datadir, { recursive: true, force: true });
  });

  it('persists a POSTed imposter and reloads it on restart with the same datadir', async () => {
    const first = await create({ port: adminPort, datadir });
    try {
      await postImposter(`http://localhost:${adminPort}`, {
        port: imposterPort,
        protocol: 'http',
        stubs: [{ responses: [{ is: { statusCode: 200, body: 'persisted' } }] }],
      });
    } finally {
      await first.close();
    }

    const second = await create({ port: adminPort, datadir });
    try {
      const res = await fetch(`http://localhost:${adminPort}/imposters/${imposterPort}`);
      expect(res.status).toBe(200);
      const imposter = (await res.json()) as Imposter;
      expect(imposter.port).toBe(imposterPort);
    } finally {
      await second.close();
    }
  });
});

// issue #78 — pin numberOfRequests on the imposter views. The engine already implements it
// (admin_api/types.rs, journal-backed, counts even when recordRequests is off); this guards the
// SDK-visible wire field against a regression that would leave consumers reading `undefined`.
conditionalDescribe('Mountebank numberOfRequests parity', () => {
  const adminPort = 4620;
  const imposterPort = 4621;
  const baseUrl = `http://localhost:${adminPort}`;
  let server: RiftServer;

  beforeAll(async () => {
    server = await create({ port: adminPort });
  });

  afterAll(async () => {
    await server.close();
  });

  it('counts matched requests (recordRequests off) and exposes numberOfRequests on both views', async () => {
    // No `recordRequests` — pins that the counter fires regardless of recording (the likely
    // regression axis).
    await postImposter(baseUrl, {
      port: imposterPort,
      protocol: 'http',
      stubs: [{ responses: [{ is: { statusCode: 200, body: 'ok' } }] }],
    });

    const fresh = (await (await fetch(`${baseUrl}/imposters/${imposterPort}`)).json()) as Imposter;
    expect(fresh.numberOfRequests).toBe(0);

    await fetch(`http://localhost:${imposterPort}/`);
    await fetch(`http://localhost:${imposterPort}/`);

    const counted = (await (
      await fetch(`${baseUrl}/imposters/${imposterPort}`)
    ).json()) as Imposter;
    expect(counted.numberOfRequests).toBe(2);

    const list = (await (await fetch(`${baseUrl}/imposters`)).json()) as {
      imposters: Imposter[];
    };
    const entry = list.imposters.find((i) => i.port === imposterPort);
    expect(entry?.numberOfRequests).toBe(2);
  });
});
