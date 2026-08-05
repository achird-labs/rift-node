/**
 * Gates for the compat `create()` layer:
 * - issue #25 AC2b — the readiness poll runs on `fetch` and treats ANY HTTP response (including an
 *   error status) as "server up", retrying only on a transport rejection.
 * - issue #28 — a spawn failure rejects `create()` catchably (never an uncaught throw inside the
 *   child's `'error'` listener), post-startup child errors reach `server.on('error', …)`, and a
 *   clean early exit (code 0) rejects promptly instead of waiting out the startup timeout.
 */

import { EventEmitter } from 'events';
import type { ChildProcess, spawn as spawnProcess } from 'child_process';
import { jest } from '@jest/globals';
import { create, waitForServer, type CreateDeps } from '../../src/compat/index.js';
import { InvalidDefinition, UnsupportedCreateOptionError } from '../../src/errors.js';

describe('issue #25 — compat waitForServer (fetch-based poll)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('AC2b: an error-status HTTP response counts as ready (resolves)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 503 } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(waitForServer('localhost', 12345, 5000)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AC2b: retries on transport rejection, then resolves once a response arrives', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({ status: 200 } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(waitForServer('localhost', 12345, 5000)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('AC2b: rejects when the server never responds within the timeout', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(waitForServer('localhost', 12345, 250)).rejects.toThrow(/did not start/);
  });
});

describe('issue #28 — create() spawn-failure and child-error delivery', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  type FakeChild = EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
  };

  function fakeChildDeps(): { child: FakeChild; deps: CreateDeps } {
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: jest.fn(() => true),
    });
    const deps: CreateDeps = {
      spawn: (() => child as unknown as ChildProcess) as unknown as typeof spawnProcess,
      resolveEngineBinary: async () => '/fake/rift-binary',
    };
    return { child, deps };
  }

  function serverNeverUp(): void {
    globalThis.fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
  }

  function serverUpImmediately(): void {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue({ status: 200 } as Response) as unknown as typeof fetch;
  }

  it("AC1: spawn failure rejects create() instead of crashing the host", async () => {
    serverNeverUp();
    const { child, deps } = fakeChildDeps();

    const pending = create({ port: 45700 }, deps);
    setImmediate(() => child.emit('error', new Error('spawn ENOENT')));

    await expect(pending).rejects.toThrow('Failed to start Rift: spawn ENOENT');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it("AC2: post-startup child error reaches server.on('error') without throwing", async () => {
    serverUpImmediately();
    const { child, deps } = fakeChildDeps();

    const server = await create({ port: 45701 }, deps);
    const seen: Error[] = [];
    server.on('error', (err: Error) => seen.push(err));

    child.emit('error', new Error('engine hiccup'));

    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe('engine hiccup');
  });

  it('AC3: clean early exit (code 0) during startup rejects promptly with a code-0 message', async () => {
    serverNeverUp();
    const { child, deps } = fakeChildDeps();

    const pending = create({ port: 45702 }, deps);
    setImmediate(() => child.emit('exit', 0, null));

    await expect(pending).rejects.toThrow(/exited with code 0 during startup/);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('regression: signal-kill during startup rejects with the signal message', async () => {
    serverNeverUp();
    const { child, deps } = fakeChildDeps();

    const pending = create({ port: 45704 }, deps);
    setImmediate(() => child.emit('exit', null, 'SIGTERM'));

    await expect(pending).rejects.toThrow(/killed by signal SIGTERM/);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('regression: nonzero early exit still rejects with the stderr detail', async () => {
    serverNeverUp();
    const { child, deps } = fakeChildDeps();

    const pending = create({ port: 45703 }, deps);
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('bad config'));
      child.emit('exit', 1, null);
    });

    await expect(pending).rejects.toThrow(/exited with code 1[\s\S]*bad config/);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('issue #77 — create() maps datadir to --datadir (Mountebank persistence parity)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  type FakeChild = EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
  };

  /** A fake spawn seam that records the argv every `create()` hands the child process. */
  function capturingDeps(): { deps: CreateDeps; calls: string[][] } {
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: jest.fn(() => true),
    });
    const calls: string[][] = [];
    const deps: CreateDeps = {
      spawn: ((_bin: string, args: string[]) => {
        calls.push(args);
        return child as unknown as ChildProcess;
      }) as unknown as typeof spawnProcess,
      resolveEngineBinary: async () => '/fake/rift-binary',
    };
    return { deps, calls };
  }

  function serverUpImmediately(): void {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue({ status: 200 } as Response) as unknown as typeof fetch;
  }

  it('passes --datadir <path> when datadir is set', async () => {
    serverUpImmediately();
    const { deps, calls } = capturingDeps();

    await create({ port: 45710, datadir: '/var/lib/rift-data' }, deps);

    const args = calls[0];
    const i = args.indexOf('--datadir');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('/var/lib/rift-data');
  });

  it('omits --datadir when datadir is not set', async () => {
    serverUpImmediately();
    const { deps, calls } = capturingDeps();

    await create({ port: 45711 }, deps);

    expect(calls[0]).not.toContain('--datadir');
  });
});

describe('issue #76 — create() fails loud on options it cannot honor (no silent in-memory fallback)', () => {
  /** Spy deps: fails the test if the process is ever spawned or the binary resolved. */
  function spyDeps(): { deps: CreateDeps; spawn: jest.Mock; resolve: jest.Mock } {
    const spawn = jest.fn(() => {
      throw new Error('spawn must not be called — create() should reject before spawning');
    });
    const resolve = jest.fn(async () => '/fake/rift-binary');
    const deps: CreateDeps = {
      spawn: spawn as unknown as typeof spawnProcess,
      resolveEngineBinary: resolve as unknown as () => Promise<string>,
    };
    return { deps, spawn, resolve };
  }

  it('rejects impostersRepository before spawning, naming the option and the alternatives', async () => {
    const { deps, spawn, resolve } = spyDeps();

    const err = await create({ port: 2525, impostersRepository: './repo.cjs' }, deps).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(UnsupportedCreateOptionError);
    expect((err as Error).message).toMatch(/impostersRepository/);
    expect((err as Error).message).toMatch(/datadir/);
    expect((err as Error).message).toMatch(/flowState/i);
    expect(spawn).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects redis before spawning, pointing at per-imposter flowState', async () => {
    const { deps, spawn } = spyDeps();

    const err = await create(
      { port: 2525, redis: { host: 'localhost', port: 6379 } },
      deps
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnsupportedCreateOptionError);
    expect((err as Error).message).toMatch(/redis/);
    expect((err as Error).message).toMatch(/flowState/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('leaves a normal create() (no rejected options) untouched — it proceeds to spawn', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue({ status: 200 } as Response) as unknown as typeof fetch;
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: jest.fn(() => true),
    });
    const spawn = jest.fn(() => child as unknown as ChildProcess);
    const deps: CreateDeps = {
      spawn: spawn as unknown as typeof spawnProcess,
      resolveEngineBinary: async () => '/fake/rift-binary',
    };
    try {
      await create({ port: 45720, datadir: '/tmp/ok' }, deps);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('issue #108 — create() guards the ambient MB_APIKEY it hands the child', () => {
  const saved = process.env.MB_APIKEY;

  afterEach(() => {
    if (saved === undefined) delete process.env.MB_APIKEY;
    else process.env.MB_APIKEY = saved;
  });

  /** Fails the test if the binary is ever resolved or the process spawned. */
  function spyDeps(): { deps: CreateDeps; spawn: jest.Mock; resolve: jest.Mock } {
    const spawn = jest.fn(() => {
      throw new Error('spawn must not be called — create() should reject before spawning');
    });
    const resolve = jest.fn(async () => '/fake/rift-binary');
    return {
      deps: {
        spawn: spawn as unknown as typeof spawnProcess,
        resolveEngineBinary: resolve as unknown as () => Promise<string>,
      },
      spawn,
      resolve,
    };
  }

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('rejects an inherited MB_APIKEY that is %s, before resolving a binary', async (_label, value) => {
    process.env.MB_APIKEY = value;
    const { deps, spawn, resolve } = spyDeps();

    const err = await create({ port: 2525 }, deps).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvalidDefinition);
    expect((err as Error).message).toMatch(/MB_APIKEY environment variable/);
    // The whole point of validating at entry: a caller mistake must not cost a binary download
    // (resolveEngineBinary may fetch one) before it is reported.
    expect(resolve).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['unset', undefined],
    ['a real key', 'real-key'],
  ])('leaves an MB_APIKEY that is %s alone and proceeds to spawn', async (_label, value) => {
    if (value === undefined) delete process.env.MB_APIKEY;
    else process.env.MB_APIKEY = value;

    const realFetch = globalThis.fetch;
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue({ status: 200 } as Response) as unknown as typeof fetch;
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: jest.fn(() => true),
    });
    const spawn = jest.fn(() => child as unknown as ChildProcess);
    const deps: CreateDeps = {
      spawn: spawn as unknown as typeof spawnProcess,
      resolveEngineBinary: async () => '/fake/rift-binary',
    };

    try {
      await create({ port: 45721 }, deps);
      expect(spawn).toHaveBeenCalledTimes(1);
      // A real inherited key is legitimate engine config — create() must not strip it or refuse it,
      // and it passes no `env`, so the child keeps inheriting it.
      expect(spawn.mock.calls[0][2]).not.toHaveProperty('env');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// Issue #116 gap 2. create() validated the ambient MB_APIKEY at entry, then awaited
// resolveEngineBinary() - which can run a real download - and only then spawned. deps.spawn() reads
// process.env fresh at exec, so a value blanked inside that window reached the child unchecked,
// after create() had already told the caller the key checked out.

describe('issue #116 — create() re-checks MB_APIKEY after binary resolution', () => {
  const saved = process.env.MB_APIKEY;

  afterEach(() => {
    if (saved === undefined) delete process.env.MB_APIKEY;
    else process.env.MB_APIKEY = saved;
  });

  /** Mutates MB_APIKEY *during* binary resolution — the window the second check exists to close. */
  function depsMutatingDuringResolve(mutate: () => void): { deps: CreateDeps; spawn: jest.Mock } {
    const spawn = jest.fn(() => {
      throw new Error('spawn must not be called — create() should reject after re-checking');
    });
    return {
      deps: {
        spawn: spawn as unknown as typeof spawnProcess,
        resolveEngineBinary: async () => {
          mutate();
          return '/fake/rift-binary';
        },
      },
      spawn,
    };
  }

  it.each([
    ['emptied', ''],
    ['blanked to whitespace', '   '],
  ])('rejects an MB_APIKEY %s while the binary was being resolved', async (_label, value) => {
    process.env.MB_APIKEY = 'real-key';
    const { deps, spawn } = depsMutatingDuringResolve(() => {
      process.env.MB_APIKEY = value;
    });

    const err = await create({ port: 2525 }, deps).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvalidDefinition);
    expect((err as Error).message).toMatch(/MB_APIKEY environment variable/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['changed to a different real key', 'other-key'],
    ['deleted outright', undefined],
  ])('allows an MB_APIKEY %s mid-resolution — only a blank one matters here', async (_label, value) => {
    // Deliberately NOT spawn()'s stricter exact-value re-check: that one exists to keep the engine
    // and the SDK-built admin client on one key, and create() builds no admin client. A changed or
    // absent key is legitimate here; a blank one is what the engine refuses.
    process.env.MB_APIKEY = 'real-key';
    const realFetch = globalThis.fetch;
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue({ status: 200 } as Response) as unknown as typeof fetch;
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: jest.fn(() => true),
    });
    const spawn = jest.fn(() => child as unknown as ChildProcess);
    const deps: CreateDeps = {
      spawn: spawn as unknown as typeof spawnProcess,
      resolveEngineBinary: async () => {
        if (value === undefined) delete process.env.MB_APIKEY;
        else process.env.MB_APIKEY = value;
        return '/fake/rift-binary';
      },
    };

    try {
      await create({ port: 45722 }, deps);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('rejects a key blanked to a NEL, which the engine trims but JavaScript does not', async () => {
    process.env.MB_APIKEY = 'real-key';
    const { deps, spawn } = depsMutatingDuringResolve(() => {
      process.env.MB_APIKEY = '\u0085';
    });

    await expect(create({ port: 2525 }, deps)).rejects.toThrow(InvalidDefinition);
    expect(spawn).not.toHaveBeenCalled();
  });
});
