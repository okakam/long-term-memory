import { lookup } from 'node:dns';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { Readable, type Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { isPublicAddress } from '@/lib/maintenance/public-address';

const MAX_REDIRECTS = 3;
const TOTAL_TIMEOUT_MS = 10_000;
const MAX_DECODED_BYTES = 1_048_576;

export type FetchFailureCode =
  | 'unsupported_url'
  | 'blocked_address'
  | 'redirect_limit'
  | 'timeout'
  | 'size_limit'
  | 'content_type'
  | 'http_error'
  | 'network_error'
  | 'parse_error';

export type SourceFetchResult =
  | { status: 'ok'; text: string; content_hash: string; checked_at: string }
  | { status: 'failed'; reason_code: FetchFailureCode; checked_at: string };

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SourceFetchDependencies {
  now: () => number;
  resolve: (host: string) => Promise<ResolvedAddress[]>;
  request: (options: https.RequestOptions) => ClientRequest;
}

class FetchFailure extends Error {
  constructor(readonly code: FetchFailureCode) { super(code); }
}

const defaultDependencies: SourceFetchDependencies = {
  now: Date.now,
  resolve: (host) => new Promise((resolveAddresses, reject) => {
    lookup(host, { all: true, verbatim: true }, (error, addresses) => {
      if (error) { reject(error); return; }
      resolveAddresses(addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 })));
    });
  }),
  request: (options) => https.request(options),
};

function timestamp(now: () => number): string {
  const value = now();
  return Number.isFinite(value) ? new Date(value).toISOString() : new Date().toISOString();
}

function failed(reason_code: FetchFailureCode, now: () => number): SourceFetchResult {
  return { status: 'failed', reason_code, checked_at: timestamp(now) };
}

function remaining(deadline: number, now: () => number): number {
  const value = deadline - now();
  if (!Number.isFinite(value) || value <= 0) throw new FetchFailure('timeout');
  return Math.max(1, Math.ceil(value));
}

function deadlineRace<T>(promise: Promise<T>, deadline: number, now: () => number): Promise<T> {
  const milliseconds = remaining(deadline, now);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FetchFailure('timeout')), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function normalizedHost(url: URL): string {
  const hostname = url.hostname;
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function parseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new FetchFailure('unsupported_url'); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')) {
    throw new FetchFailure('unsupported_url');
  }
  const host = normalizedHost(url);
  if (host.length === 0) throw new FetchFailure('unsupported_url');
  // Even public IP literals are rejected: a DNS name is required for a stable
  // TLS identity and to keep every destination behind the same address policy.
  if (isIP(host) !== 0) throw new FetchFailure('blocked_address');
  return url;
}

function assertAddressSet(addresses: ResolvedAddress[]): ResolvedAddress {
  if (addresses.length === 0) throw new FetchFailure('network_error');
  for (const entry of addresses) {
    if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family || !isPublicAddress(entry.address)) {
      throw new FetchFailure('blocked_address');
    }
  }
  return addresses[0]!;
}

function pinnedLookup(address: ResolvedAddress): NonNullable<https.RequestOptions['lookup']> {
  return ((hostname, options, callback) => {
    void hostname;
    if (typeof options === 'function') {
      (options as (error: NodeJS.ErrnoException | null, address: string, family: number) => void)(null, address.address, address.family);
      return;
    }
    const done = callback as (error: NodeJS.ErrnoException | null, address: string | ResolvedAddress[], family?: number) => void;
    if (options.all) done(null, [address]);
    else done(null, address.address, address.family);
  }) as NonNullable<https.RequestOptions['lookup']>;
}

function contentEncoding(response: IncomingMessage): string[] {
  const raw = response.headers['content-encoding'];
  if (raw === undefined) return [];
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  return value.split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== '' && entry !== 'identity').reverse();
}

function decodeHtmlEntities(input: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"', copy: '©', reg: '®',
    ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  };
  return input.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);/gi, (entity, name: string) => {
    if (name[0] === '#') {
      const isHex = name[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(name.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\uFFFD';
      return String.fromCodePoint(codePoint);
    }
    return named[name.toLowerCase()] ?? entity;
  });
}

function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]!;
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return -1;
}

function htmlToText(html: string): string {
  const pieces: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const opening = html.indexOf('<', cursor);
    if (opening < 0) { pieces.push(html.slice(cursor)); break; }
    if (opening > cursor) pieces.push(html.slice(cursor, opening));
    if (html.startsWith('<!--', opening)) {
      const closingComment = html.indexOf('-->', opening + 4);
      if (closingComment < 0) break;
      cursor = closingComment + 3;
      continue;
    }
    const tagEnd = findTagEnd(html, opening + 1);
    if (tagEnd < 0) break;
    const tagContents = html.slice(opening + 1, tagEnd);
    const parsed = tagContents.match(/^\s*(\/?)\s*([a-z][a-z\d:-]*)/i);
    cursor = tagEnd + 1;
    if (!parsed) continue;
    const isClosing = parsed[1] === '/';
    const tagName = parsed[2]!.toLowerCase();
    if (!isClosing && ['script', 'style', 'template', 'noscript'].includes(tagName)) {
      const close = new RegExp(`<\\/\\s*${tagName}\\s*>`, 'ig');
      close.lastIndex = cursor;
      const match = close.exec(html);
      if (!match) break;
      cursor = match.index + match[0].length;
      continue;
    }
    if (['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
      'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
      'section', 'table', 'tr', 'ul'].includes(tagName)) pieces.push('\n');
  }
  return decodeHtmlEntities(pieces.join(''))
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeContentType(response: IncomingMessage): { mediaType: 'text/html' | 'text/plain'; charset: string } {
  const header = response.headers['content-type'] as string | string[] | undefined;
  const value: string | undefined = Array.isArray(header) ? header[0] : header;
  if (!value) throw new FetchFailure('content_type');
  const [rawType, ...parameters]: string[] = value.split(';');
  const type = rawType?.trim().toLowerCase();
  if (type !== 'text/html' && type !== 'text/plain') throw new FetchFailure('content_type');
  const charsetParameter = parameters.map((item) => item.trim()).find((item) => /^charset\s*=/i.test(item));
  const charset = charsetParameter?.slice(charsetParameter.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') || 'utf-8';
  return { mediaType: type, charset };
}

function decompressor(name: string): Transform {
  if (name === 'gzip' || name === 'x-gzip') return createGunzip();
  if (name === 'deflate') return createInflate();
  if (name === 'br') return createBrotliDecompress();
  throw new FetchFailure('parse_error');
}

type RequestResult = {
  kind: 'redirect';
  location: string;
} | {
  kind: 'text';
  text: string;
};

function requestOnce(
  url: URL,
  address: ResolvedAddress,
  deadline: number,
  dependencies: SourceFetchDependencies,
): Promise<RequestResult> {
  const hostname = normalizedHost(url);
  const path = url.pathname + url.search;
  const timeoutMs = remaining(deadline, dependencies.now);
  const requestOptions: https.RequestOptions = {
    protocol: 'https:',
    hostname,
    port: 443,
    path,
    method: 'GET',
    headers: {
      accept: 'text/html, text/plain;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'user-agent': 'long-term-memory-source-check/1.0',
    },
    servername: hostname,
    rejectUnauthorized: true,
    lookup: pinnedLookup(address),
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let activeResponse: IncomingMessage | undefined;
    let activeDecoded: Readable | undefined;
    const activeDecoders: Transform[] = [];
    const finish = (error?: unknown, result?: RequestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      if (error !== undefined) reject(error);
      else resolve(result!);
    };
    const request: ClientRequest = dependencies.request(requestOptions);
    const abort = (code: FetchFailureCode) => {
      if (settled) return;
      finish(new FetchFailure(code));
      for (const decoder of activeDecoders) decoder.destroy();
      activeDecoded?.destroy();
      activeResponse?.destroy();
      request.destroy();
    };
    const totalTimer = setTimeout(() => abort('timeout'), timeoutMs);
    request.setTimeout(timeoutMs, () => abort('timeout'));
    request.once('error', () => abort('network_error'));
    request.once('response', (response: IncomingMessage) => {
      activeResponse = response;
      const statusCode = response.statusCode ?? 0;
      response.once('error', () => abort('network_error'));
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        const location = response.headers.location;
        if (typeof location === 'string' && location.length > 0) finish(undefined, { kind: 'redirect', location });
        else finish(new FetchFailure('http_error'));
        response.destroy();
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        finish(new FetchFailure('http_error'));
        response.destroy();
        return;
      }

      let content: ReturnType<typeof decodeContentType>;
      let encodings: string[];
      try {
        content = decodeContentType(response);
        encodings = contentEncoding(response);
      } catch (error) {
        finish(error);
        response.destroy();
        return;
      }
      let decoded: Readable = response;
      try {
        for (const encoding of encodings) {
          const decoder = decompressor(encoding);
          decoder.once('error', () => abort('parse_error'));
          activeDecoders.push(decoder);
          decoded = decoded.pipe(decoder);
          activeDecoded = decoded;
        }
      } catch (error) {
        finish(error);
        for (const decoder of activeDecoders) decoder.destroy();
        response.destroy();
        return;
      }
      activeDecoded = decoded;

      const chunks: Buffer[] = [];
      let size = 0;
      decoded.on('data', (chunk: Buffer | Uint8Array | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > MAX_DECODED_BYTES) {
          abort('size_limit');
          return;
        }
        chunks.push(buffer);
      });
      decoded.once('error', () => abort('parse_error'));
      decoded.once('end', () => {
        if (settled) return;
        try {
          const bytes = Buffer.concat(chunks, size);
          const text = new TextDecoder(content.charset, { fatal: false }).decode(bytes);
          const normalized = content.mediaType === 'text/html' ? htmlToText(text) : text;
          finish(undefined, { kind: 'text', text: normalized });
        } catch {
          finish(new FetchFailure('parse_error'));
        }
      });
    });
    request.end();
  });
}

async function fetchRedirectChain(
  value: string,
  redirectCount: number,
  deadline: number,
  dependencies: SourceFetchDependencies,
): Promise<string> {
  const url = parseUrl(value);
  const host = normalizedHost(url);
  let addresses: ResolvedAddress[];
  try {
    addresses = await deadlineRace(dependencies.resolve(host), deadline, dependencies.now);
  } catch (error) {
    if (error instanceof FetchFailure) throw error;
    throw new FetchFailure('network_error');
  }
  const address = assertAddressSet(addresses);
  const response = await requestOnce(url, address, deadline, dependencies);
  if (response.kind === 'text') return response.text;
  if (redirectCount >= MAX_REDIRECTS) throw new FetchFailure('redirect_limit');
  let next: URL;
  try { next = new URL(response.location, url); } catch { throw new FetchFailure('unsupported_url'); }
  return fetchRedirectChain(next.toString(), redirectCount + 1, deadline, dependencies);
}

export async function fetchPublicSource(
  url: string,
  deps: SourceFetchDependencies = defaultDependencies,
): Promise<SourceFetchResult> {
  const deadline = deps.now() + TOTAL_TIMEOUT_MS;
  try {
    const text = await fetchRedirectChain(url, 0, deadline, deps);
    if (deps.now() >= deadline) throw new FetchFailure('timeout');
    return {
      status: 'ok',
      text,
      content_hash: createHash('sha256').update(text, 'utf8').digest('hex'),
      checked_at: timestamp(deps.now),
    };
  } catch (error) {
    const reason = error instanceof FetchFailure ? error.code : 'network_error';
    return failed(reason, deps.now);
  }
}
