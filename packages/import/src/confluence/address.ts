/**
 * Which addresses an import may talk to. Shared by the check made before a
 * request and by the one made as the socket connects.
 */

import { isIP } from 'node:net';

function ipv4Octets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet <= 255) ? octets : null;
}

/**
 * True for an address a request from this process has no business reaching on
 * behalf of something a person typed: unspecified, loopback, private,
 * carrier-grade NAT, link-local (which is where cloud metadata lives),
 * multicast, reserved, and the IPv6 equivalents, including an IPv4 address
 * wrapped in IPv6.
 */
export function isNonPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = ipv4Octets(address);
    if (!octets) return true;
    const [a, b] = octets as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase().split('%')[0] ?? '';
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isNonPublicAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    // Hex-form IPv4-mapped addresses, unique local, link-local, multicast.
    return /^(?:::ffff:|f[cd]|fe[89ab]|ff)/.test(lower);
  }
  return true;
}
