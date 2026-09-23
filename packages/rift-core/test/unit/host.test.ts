/**
 * Gate for issue #143 — `hostForUrl` is the one place a host string becomes a URL authority.
 * A bare IPv6 literal is not a valid URL host (`http://::1:80` is `TypeError: Invalid URL`), so
 * every URL the SDK builds from a host goes through here.
 */

import { hostForUrl } from '../../src/host.js';

describe('issue #143 — hostForUrl', () => {
  it.each([
    ['::1', '[::1]'],
    ['[::1]', '[::1]'],
    ['::', '[::]'],
    ['fe80::1%2', '[fe80::1%2]'],
    ['::ffff:127.0.0.1', '[::ffff:127.0.0.1]'],
    ['2001:db8::1', '[2001:db8::1]'],
    ['127.0.0.1', '127.0.0.1'],
    ['0.0.0.0', '0.0.0.0'],
    ['localhost', 'localhost'],
    ['rift.internal', 'rift.internal'],
  ])('%s → %s', (input, expected) => {
    expect(hostForUrl(input)).toBe(expected);
  });

  it('produces a host Node\'s URL parser accepts for an unscoped literal', () => {
    expect(new URL(`http://${hostForUrl('::1')}:2525`).hostname).toBe('[::1]');
  });
});
