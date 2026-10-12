import { isIP } from 'node:net';

const IPV4_BLOCKED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],  // this network
  [0x0a000000, 8],  // private
  [0x64400000, 10], // shared address space
  [0x7f000000, 8],  // loopback
  [0xa9fe0000, 16], // link local
  [0xac100000, 12], // private
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // documentation
  [0xc0586300, 24], // deprecated 6to4 relay anycast
  [0xc0a80000, 16], // private
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // documentation
  [0xcb007100, 24], // documentation
  [0xe0000000, 4],  // multicast
  [0xf0000000, 4],  // reserved and broadcast
];

function ipv4Value(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => /^\d{1,3}$/.test(part) ? Number(part) : -1);
  if (octets.some((part) => part < 0 || part > 255)) return null;
  return (((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!);
}

function inIpv4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((value & mask) >>> 0) === base;
}

function ipv6Value(address: string): bigint | null {
  let input = address.toLowerCase();
  if (input.includes('%')) return null;
  const embedded = input.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) {
    const value = ipv4Value(embedded[1]!);
    if (value === null) return null;
    const high = ((value >>> 16) & 0xffff).toString(16);
    const low = (value & 0xffff).toString(16);
    input = input.slice(0, -embedded[1]!.length) + high + ':' + low;
  }

  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0]!.split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << BigInt(16)) | BigInt(`0x${group}`), BigInt(0));
}

function inIpv6Range(value: bigint, base: bigint, prefix: number): boolean {
  const mask = ((BigInt(1) << BigInt(prefix)) - BigInt(1)) << BigInt(128 - prefix);
  return (value & mask) === base;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Value(address);
    return value !== null && !IPV4_BLOCKED_RANGES.some(([base, prefix]) => inIpv4Range(value, base, prefix));
  }
  if (family !== 6) return false;

  const value = ipv6Value(address);
  if (value === null) return false;
  // Only global unicast space is eligible. This excludes unspecified, loopback,
  // ULA, link-local, multicast, translation, and other special-purpose ranges.
  if (!inIpv6Range(value, BigInt('0x20000000000000000000000000000000'), 3)) return false;
  if (inIpv6Range(value, BigInt('0x20010db8000000000000000000000000'), 32)) return false; // documentation
  if (inIpv6Range(value, BigInt('0x20010000000000000000000000000000'), 23)) return false; // IETF protocol assignments
  if (inIpv6Range(value, BigInt('0x20020000000000000000000000000000'), 16)) return false; // 6to4
  if (inIpv6Range(value, BigInt('0x3fff0000000000000000000000000000'), 20)) return false; // documentation
  return true;
}
