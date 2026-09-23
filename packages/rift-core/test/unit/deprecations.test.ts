/**
 * Gate for issue #139 — the builders whose keys no Rift engine acts on carry a `@deprecated` JSDoc
 * tag (editors and typescript-eslint surface it; nothing changes at runtime). Read off the source,
 * because the tag lives in the doc block and the compiled d.ts carries it verbatim.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { imposter, proxyTo } from '../../src/dsl/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string): string => fs.readFileSync(path.join(here, '..', '..', 'src', rel), 'utf8');

/** The JSDoc block that ends right above `signature`, or undefined when there is none. */
function docBlockAbove(text: string, signature: string): string | undefined {
  const at = text.indexOf(signature);
  if (at < 0) return undefined;
  const before = text.slice(0, at);
  const open = before.lastIndexOf('/**');
  const close = before.lastIndexOf('*/');
  if (open < 0 || close < open) return undefined;
  // Only whitespace may sit between the block's end and the signature.
  if (before.slice(close + 2).trim() !== '') return undefined;
  return before.slice(open, close + 2);
}

describe('issue #139 — inert builders are marked @deprecated', () => {
  const cases: Array<[file: string, signature: string, mustMention: RegExp[]]> = [
    ['dsl/imposter.ts', '  recordMatches(): this {', [/@deprecated/, /config_key_ignored/, /record\(\)/, /0\.18\.0/]],
    ['dsl/imposter.ts', '  metrics(port?: number): this {', [/@deprecated/, /config_key_ignored/, /metricsPort|--metrics-port/, /0\.18\.0/]],
    ['dsl/proxy.ts', '  clientCert(cert: { key: string; cert: string }): this {', [/@deprecated/, /dropped/i, /no client certificate|no replacement/]],
  ];

  it.each(cases)('%s: %s', (file, signature, mustMention) => {
    const block = docBlockAbove(src(file), signature);
    expect(block).toBeDefined();
    for (const re of mustMention) expect(block).toMatch(re);
  });

  it('still emits the keys byte-identically — deprecation is documentation, not a wire change', () => {
    expect(imposter('m').recordMatches().metrics(9091).build()).toEqual({ name: 'm', recordMatches: true, _rift: { metrics: { enabled: true, port: 9091 } } });
    expect(proxyTo('http://u').clientCert({ key: 'K', cert: 'C' }).build().proxy).toMatchObject({ to: 'http://u', key: 'K', cert: 'C' });
  });
});
