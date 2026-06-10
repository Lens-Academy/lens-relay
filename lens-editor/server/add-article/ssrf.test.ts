import { describe, it, expect } from 'vitest';
import { isPrivateAddress, assertPublicUrl, SsrfError } from './ssrf';

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
