import { lookup } from 'node:dns/promises';
import * as dns from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';

/**
 * SSRF guard for server-side URL fetching. Editors can submit arbitrary URLs
 * that the server then fetches, so a bare scheme check is not enough — a URL
 * (or a redirect from one) could point at internal infrastructure
 * (relay-server:8080, localhost, docker services, cloud metadata endpoints).
 *
 * We resolve the hostname and reject any address in a private, loopback,
 * link-local, or otherwise non-public range before allowing the fetch, AND
 * check again inside the connection itself (`publicOnlyDispatcher`): the
 * address the socket connects to is the one checked, so a second DNS answer
 * (DNS rebinding) cannot swap in a private address after the first check.
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

/** Expand an IPv6 address into its eight 16-bit groups, or null. Handles
 *  "::" and a trailing dotted quad (::ffff:1.2.3.4). */
function ipv6Groups(ip: string): number[] | null {
  let addr = ip.toLowerCase().split('%')[0]; // drop zone id
  const dotted = addr.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = ipv4ToInt(dotted[2]);
    if (n === null) return null;
    addr = `${dotted[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateIPv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true; // unparseable → treat as unsafe
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true; // :: unspecified
  if (zeros(0, 7) && g[7] === 1) return true; // ::1 loopback
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x0100 && zeros(1, 4)) return true; // 100::/64 discard
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  // Teredo (2001::/32) tunnels to an obfuscated IPv4; not a fetch target.
  if (g[0] === 0x2001 && g[1] === 0) return true;
  // Forms that carry an IPv4 address in the last 32 bits: judge that address.
  //   ::ffff:a.b.c.d (IPv4-mapped), ::a.b.c.d (IPv4-compatible),
  //   ::ffff:0:a.b.c.d (SIIT), 64:ff9b::a.b.c.d (NAT64 well-known prefix).
  // new URL() writes these in hex (::ffff:7f00:1), so match on groups.
  const embedsV4 =
    (zeros(0, 5) && (g[5] === 0xffff || g[5] === 0)) ||
    (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) ||
    (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6));
  if (embedsV4) return isPrivateIPv4(v4FromGroups(g[6], g[7]));
  // 64:ff9b:1::/48 is the local-use NAT64 prefix (RFC 8215): a network's own
  // translator, which can reach whatever the network can.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
  // 6to4 (2002::/16) carries an IPv4 address in the next 32 bits.
  if (g[0] === 0x2002) return isPrivateIPv4(v4FromGroups(g[1], g[2]));
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

  // IPv6 literals come bracketed ("[::1]").
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
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

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * A `dns.lookup` for socket connections that refuses non-public addresses.
 * Used by `publicOnlyDispatcher`, so the address a connection actually uses
 * is checked, not just an earlier answer for the same name.
 */
export function publicOnlyLookup(
  hostname: string,
  options: dns.LookupOptions | number | LookupCallback,
  callback?: LookupCallback,
): void {
  const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
  const opts: dns.LookupOptions = typeof options === 'object' ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err, []);
    if (addresses.length === 0) {
      return cb(new SsrfError(`Host did not resolve: ${hostname}`), []);
    }
    const bad = addresses.find(({ address }) => isPrivateAddress(address));
    if (bad) {
      return cb(new SsrfError(`Host ${hostname} resolves to private address ${bad.address}`), []);
    }
    if (opts.all) return cb(null, addresses);
    cb(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * undici dispatcher whose connections resolve through `publicOnlyLookup`.
 * Pass it with every fetch of a user-supplied URL (and every redirect hop),
 * together with `assertPublicUrl`, which also covers literal-IP hosts.
 */
export const publicOnlyDispatcher = new Agent({
  connect: { lookup: publicOnlyLookup as never },
});
