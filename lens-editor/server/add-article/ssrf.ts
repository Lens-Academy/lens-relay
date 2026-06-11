import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for server-side URL fetching. Editors can submit arbitrary URLs
 * that the server then fetches, so a bare scheme check is not enough — a URL
 * (or a redirect from one) could point at internal infrastructure
 * (relay-server:8080, localhost, docker services, cloud metadata endpoints).
 *
 * We resolve the hostname and reject any address in a private, loopback,
 * link-local, or otherwise non-public range before allowing the fetch.
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** Parse "a.b.c.d" into a 32-bit number, or null if not a dotted-quad IPv4. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → treat as unsafe
  const inRange = (start: string, bits: number) => {
    const base = ipv4ToInt(start)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (base & mask);
  };
  return (
    inRange('0.0.0.0', 8) || // "this" network
    inRange('10.0.0.0', 8) || // private
    inRange('100.64.0.0', 10) || // carrier-grade NAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local (incl. cloud metadata 169.254.169.254)
    inRange('172.16.0.0', 12) || // private
    inRange('192.0.0.0', 24) || // IETF protocol assignments
    inRange('192.168.0.0', 16) || // private
    inRange('198.18.0.0', 15) || // benchmarking
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved
  );
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]; // drop zone id
  if (addr === '::1' || addr === '::') return true;
  if (addr.startsWith('fe80')) return true; // link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique-local
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded IPv4
  const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  // 6to4 (2002:HHHH:HHHH::/16) wraps an IPv4 address in the next 32 bits —
  // reject if that embedded v4 is private (e.g. 2002:c0a8:0101:: → 192.168.1.1)
  if (addr.startsWith('2002:')) {
    const groups = addr.split(':');
    if (groups.length >= 3 && /^[0-9a-f]{1,4}$/.test(groups[1]) && /^[0-9a-f]{1,4}$/.test(groups[2])) {
      const hi = parseInt(groups[1].padStart(4, '0'), 16);
      const lo = parseInt(groups[2].padStart(4, '0'), 16);
      const v4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
      if (isPrivateIPv4(v4)) return true;
    }
  }
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true; // not a recognizable IP → unsafe
}

/**
 * Resolve a URL's hostname and throw SsrfError if it (or any of its addresses)
 * is non-public. Call before every fetch AND on every redirect hop.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError(`Disallowed protocol: ${parsed.protocol}`);
  }

  const host = parsed.hostname;
  // Literal IP host: check directly, no DNS.
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new SsrfError(`Refusing to fetch private address: ${host}`);
    }
    return;
  }

  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new SsrfError(`Could not resolve host: ${host}`);
  }
  if (addrs.length === 0) {
    throw new SsrfError(`Host did not resolve: ${host}`);
  }
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) {
      throw new SsrfError(`Host ${host} resolves to private address ${address}`);
    }
  }
}
