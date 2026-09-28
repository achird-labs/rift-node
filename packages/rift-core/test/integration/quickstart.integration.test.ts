/**
 * Gate for issue #21 AC5 — the RFC-003 §12 quick-start runs end-to-end over the spawn transport.
 * Self-skips when no rift binary is available (same convention as the other integration suites).
 */

import { execSync } from 'child_process';
import fs from 'fs';
import { rift, imposter, onGet, onPost, okJson, created, status } from '../../src/index.js';

function binaryAvailable(): boolean {
  if (process.env.RIFT_SKIP_BINARY_DOWNLOAD || process.env.RIFT_OFFLINE) {
    if (process.env.RIFT_BINARY_PATH) return fs.existsSync(process.env.RIFT_BINARY_PATH);
    return false;
  }
  if (process.env.RIFT_BINARY_PATH) return fs.existsSync(process.env.RIFT_BINARY_PATH);
  for (const name of ['rift-http-proxy', 'rift', 'mb']) {
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

describeOrSkip('issue #21 — RFC quick-start over spawn', () => {
  it('create → handle.url → fetch returns the stubbed response; cycling advances', async () => {
    await using engine = await rift.spawn();
    const users = await engine.create(
      imposter('users')
        .record()
        .stub(onGet('/api/users/1').willReturn(okJson({ id: 1, name: 'Alice' })))
        .stub(onPost('/api/users').willReturn(created().latency(10), status(503)))
    );

    const res = await fetch(`${users.url}/api/users/1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, name: 'Alice' });

    // Response cycling: first POST 201, second POST 503.
    const first = await fetch(`${users.url}/api/users`, { method: 'POST' });
    const second = await fetch(`${users.url}/api/users`, { method: 'POST' });
    expect([first.status, second.status].sort()).toEqual([201, 503]);

    // Read back, `statusCode` is a string: the engine writes Mountebank's format (issue #155).
    const exported = await users.toJson();
    expect(exported.stubs?.[0]?.responses?.[0]?.is?.statusCode).toBe('200');
    expect(exported.stubs?.[1]?.responses?.map((r) => r.is?.statusCode)).toEqual(['201', '503']);
  }, 45_000);
});
