import { EventEmitter } from 'node:events';
import type { ClientRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import type * as https from 'node:https';
import { expect, test } from 'vitest';

import { fetchPublicSource, type SourceFetchDependencies } from '@/lib/maintenance/source-fetcher';
import { isPublicAddress } from '@/lib/maintenance/public-address';

interface ResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  location?: string;
  body?: Buffer | string;
  timeout?: boolean;
}

class FakeRequest extends EventEmitter {
  private onTimeout?: () => void;
  destroyed = false;
  constructor(private readonly spec: ResponseSpec) { super(); }
  setTimeout(_milliseconds: number, callback?: () => void): this { this.onTimeout = callback; return this; }
  end(): this {
    queueMicrotask(() => {
      if (this.spec.timeout) { this.onTimeout?.(); return; }
      const stream = Readable.from(this.spec.body === undefined ? [] : [this.spec.body]) as Readable & {
        statusCode?: number;
        headers: Record<string, string>;
      };
      stream.statusCode = this.spec.status ?? 200;
      stream.headers = { ...this.spec.headers };
      if (this.spec.location) stream.headers.location = this.spec.location;
      this.emit('response', stream);
    });
    return this;
  }
  destroy(error?: Error): this {
    this.destroyed = true;
    if (error) queueMicrotask(() => this.emit('error', error));
    return this;
  }
}

function dependencies(options: {
  responses?: ResponseSpec[];
  addresses?: Array<{ address: string; family: 4 | 6 }>;
  resolve?: SourceFetchDependencies['resolve'];
  now?: () => number;
} = {}) {
  const responses = [...(options.responses ?? [{ body: 'public text', headers: { 'content-type': 'text/plain; charset=utf-8' } }])];
  const requests: https.RequestOptions[] = [];
  const clientRequests: FakeRequest[] = [];
  const deps: SourceFetchDependencies = {
    now: options.now ?? (() => Date.parse('2026-10-12T00:00:00.000Z')),
    resolve: options.resolve ?? (async () => options.addresses ?? [{ address: '93.184.216.34', family: 4 }]),
    request: ((requestOptions: https.RequestOptions) => {
      requests.push(requestOptions);
      const request = new FakeRequest(responses.shift() ?? { body: '' });
      clientRequests.push(request);
      return request as unknown as ClientRequest;
    }),
  };
  return { deps, requests, clientRequests };
}

test('blocks_redirect_and_rebinding', async () => {
  const mixed = dependencies({ addresses: [
    { address: '93.184.216.34', family: 4 },
    { address: 'fd00::5', family: 6 },
  ] });
  const mixedResult = await fetchPublicSource('https://example.test/article', mixed.deps);
  expect(mixedResult).toMatchObject({ status: 'failed', reason_code: 'blocked_address' });
  expect(mixed.requests).toHaveLength(0);

  const privateRedirect = dependencies({
    responses: [{ status: 302, location: 'https://internal.test/secret' }],
    resolve: async (host) => host === 'internal.test'
      ? [{ address: '192.168.1.4', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }],
  });
  expect(await fetchPublicSource('https://example.test/start', privateRedirect.deps))
    .toMatchObject({ status: 'failed', reason_code: 'blocked_address' });
  expect(privateRedirect.requests).toHaveLength(1);

  const downgrade = dependencies({ responses: [{ status: 301, location: 'http://example.test/insecure' }] });
  expect(await fetchPublicSource('https://example.test/start', downgrade.deps))
    .toMatchObject({ status: 'failed', reason_code: 'unsupported_url' });

  const tooManyRedirects = dependencies({ responses: Array.from({ length: 4 }, (_, i) => ({
    status: 302, location: `/redirect-${i + 1}`,
  })) });
  expect(await fetchPublicSource('https://example.test/start', tooManyRedirects.deps))
    .toMatchObject({ status: 'failed', reason_code: 'redirect_limit' });
  expect(tooManyRedirects.requests).toHaveLength(4);

  for (const url of [
    'https://user:pass@example.test/article',
    'http://example.test/article',
    'https://example.test:8443/article',
    'https://127.0.0.1/article',
    'https://[::ffff:127.0.0.1]/article',
    'https://93.184.216.34/article',
  ]) {
    expect(await fetchPublicSource(url, dependencies().deps)).toMatchObject({ status: 'failed' });
  }
  expect(isPublicAddress('::ffff:93.184.216.34')).toBe(false);
  expect(isPublicAddress('2001:4860:4860::8888')).toBe(true);
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1',
    '172.31.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '3fff::1',
  ]) expect(isPublicAddress(address)).toBe(false);
  expect(isPublicAddress('8.8.8.8')).toBe(true);
});

test('limits_total_time_and_decoded_bytes', async () => {
  let clock = 0;
  const expired = dependencies({
    now: () => clock,
    resolve: async () => { clock = 10_001; return [{ address: '93.184.216.34', family: 4 }]; },
  });
  expect(await fetchPublicSource('https://example.test/slow-dns', expired.deps))
    .toMatchObject({ status: 'failed', reason_code: 'timeout' });
  expect(expired.requests).toHaveLength(0);

  const timedOut = dependencies({ responses: [{ timeout: true }] });
  expect(await fetchPublicSource('https://example.test/slow-response', timedOut.deps))
    .toMatchObject({ status: 'failed', reason_code: 'timeout' });
  expect(timedOut.clientRequests[0]?.destroyed).toBe(true);

  const compressed = gzipSync(Buffer.alloc(1_048_577, 97));
  const tooLarge = dependencies({ responses: [{
    headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' }, body: compressed,
  }] });
  expect(await fetchPublicSource('https://example.test/large', tooLarge.deps))
    .toMatchObject({ status: 'failed', reason_code: 'size_limit' });
  expect(tooLarge.clientRequests[0]?.destroyed).toBe(true);
});

test('HTMLのscript命令を実行も本文化もせず表示テキストだけを返す', async () => {
  const html = '<html><body><h1>public note</h1><script>fetch("https://attacker.test")</script><p>Safe text</p></body></html>';
  const fixture = dependencies({
    responses: [{ headers: { 'content-type': 'text/html; charset=UTF-8' }, body: html }],
  });
  const result = await fetchPublicSource('https://example.test/note', fixture.deps);
  expect(result).toMatchObject({ status: 'ok' });
  expect(fixture.requests[0]).toMatchObject({ hostname: 'example.test', servername: 'example.test', port: 443, rejectUnauthorized: true });
  expect(fixture.requests[0]?.lookup).toBeTypeOf('function');
  if (result.status === 'ok') {
    expect(result.text).toContain('public note');
    expect(result.text).toContain('Safe text');
    expect(result.text).not.toContain('fetch(');
    expect(result.text).not.toContain('attacker.test');
  }
});
