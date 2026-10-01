// @vitest-environment node -- real Node fetch/undici; the config's environmentMatchGlobs is ignored by vitest 4, so server tests otherwise run in happy-dom, whose fetch ignores `dispatcher`.
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  isPrivateAddress,
  assertPublicUrl,
  SsrfError,
  publicOnlyLookup,
  publicOnlyDispatcher,
} from './ssrf';

describe('isPrivateAddress', () => {
  it('flags loopback, private, link-local, and CGNAT IPv4 ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata endpoint
      '100.64.0.1',
      '0.0.0.0',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4 addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('flags IPv6 loopback, link-local, unique-local, and mapped private v4', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  // Prevents: SSRF via 6to4 address wrapping a private IPv4 (2002:c0a8:0101:: → 192.168.1.1)
  it('flags 6to4 addresses embedding a private IPv4', () => {
    expect(isPrivateAddress('2002:c0a8:0101::1')).toBe(true); // 192.168.1.1
    expect(isPrivateAddress('2002:7f00:0001::')).toBe(true); // 127.0.0.1
    expect(isPrivateAddress('2002:0808:0808::')).toBe(false); // 8.8.8.8 — public
  });

  it('allows public IPv6', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  // Prevents: garbage that isn't an IP slipping through as "public"
  it('treats unparseable input as unsafe', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('ftp://example.com')).rejects.toBeInstanceOf(SsrfError);
  });

  // Prevents: SSRF against internal services via literal-IP URLs
  it('rejects literal private-IP hosts without DNS', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('http://[::1]:8080/')).rejects.toBeInstanceOf(SsrfError);
  });

  // Prevents: hitting the relay's own hostname on the docker network
  it('rejects hosts that do not resolve (e.g. internal-only names)', async () => {
    await expect(
      assertPublicUrl('http://relay-server.invalid-tld-xyz/')
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('allows a normal public hostname', async () => {
    // example.com is a stable public IANA-reserved demo domain
    await expect(assertPublicUrl('https://example.com/article')).resolves.toBeUndefined();
  });
});

describe('IPv4 embedded in IPv6', () => {
  // Prevents: new URL() spelling ::ffff:127.0.0.1 as ::ffff:7f00:1 (hex),
  // which the dotted-only check let through as public
  it('flags hex-form IPv4-mapped, compatible and SIIT addresses of private v4', () => {
    for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:c0a8:101', '::7f00:1', '::127.0.0.1', '::ffff:0:7f00:1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress('::ffff:808:808')).toBe(false); // 8.8.8.8
  });

  // Prevents: reaching 127.0.0.1 / metadata through a NAT64 translator
  it('flags NAT64 addresses of private v4 and the local-use NAT64 prefix', () => {
    for (const ip of ['64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::a00:1', '64:ff9b:1::808:808']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress('64:ff9b::808:808')).toBe(false); // 8.8.8.8 via well-known NAT64
  });

  it('flags other non-public IPv6 ranges and unparseable addresses', () => {
    for (const ip of ['ff02::1', 'fec0::1', '2001:db8::1', '2001::1', '100::1', '1::2::3', '::']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('rejects bracketed IPv6 literals that embed a private v4', async () => {
    for (const url of ['http://[::ffff:127.0.0.1]/', 'http://[64:ff9b::169.254.169.254]/', 'http://[::1]:8080/']) {
      await expect(assertPublicUrl(url), url).rejects.toBeInstanceOf(SsrfError);
    }
  });
});

describe('connect-time check (DNS rebinding)', () => {
  it('publicOnlyLookup refuses a name that resolves to loopback', async () => {
    for (const options of [{}, { all: true }]) {
      const err = await new Promise<unknown>((resolve) =>
        publicOnlyLookup('localhost', options, (e) => resolve(e)),
      );
      expect(err).toBeInstanceOf(SsrfError);
    }
  });

  // Prevents: a host that answered DNS with a public address for the check
  // and a private one for the connection reaching internal services
  it('publicOnlyDispatcher never connects to a private address', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.end('internal');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      // Sanity: without the dispatcher this test can reach the server.
      expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe('internal');
      hits = 0;
      const err = await fetch(`http://localhost:${port}/`, {
        dispatcher: publicOnlyDispatcher,
      } as RequestInit).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error & { cause?: unknown }).cause)).toMatch(/private address/);
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  });
});
