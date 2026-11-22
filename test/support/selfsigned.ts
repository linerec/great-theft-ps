// SPDX-License-Identifier: AGPL-3.0-only
//
// A throwaway self-signed certificate for tests, made on the spot, so that no private key has to be kept in the
// repository. Node can read and use certificates but cannot create them, so the small DER structure (X.509 v3, an ECDSA
// P-256 key, ecdsa-with-SHA256, the names as subject alternative names) is written here by hand. Test use only.

import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const der = (tag: number, body: Buffer): Buffer => {
  const n = body.length;
  const length = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const seq = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => der(0x31, Buffer.concat(parts));
const integer = (bytes: Buffer): Buffer => der(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const oid = (bytes: number[]): Buffer => der(0x06, Buffer.from(bytes));
const utf8 = (text: string): Buffer => der(0x0c, Buffer.from(text, 'utf8'));
const octets = (bytes: Buffer): Buffer => der(0x04, bytes);
const bits = (bytes: Buffer): Buffer => der(0x03, Buffer.concat([Buffer.from([0]), bytes]));
const two = (n: number): string => String(n).padStart(2, '0');

/** UTCTime up to the year 2049, GeneralizedTime after that (what X.509 asks for). */
const time = (d: Date): Buffer => {
  const year = d.getUTCFullYear();
  const rest = `${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
  return year < 2050 ? der(0x17, Buffer.from(`${two(year % 100)}${rest}`)) : der(0x18, Buffer.from(`${year}${rest}`));
};

const pem = (label: string, body: Buffer): string => `-----BEGIN ${label}-----\n${body.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END ${label}-----\n`;

export interface SelfSigned {
  /** The certificate, PEM. */
  cert: string;
  /** Its private key, PEM. */
  key: string;
}

export function selfSigned(o: { names: string[]; notBefore?: Date; notAfter?: Date }): SelfSigned {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const notBefore = o.notBefore ?? new Date(Date.now() - 86_400_000);
  const notAfter = o.notAfter ?? new Date(Date.now() + 30 * 86_400_000);
  const algorithm = seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])); // ecdsa-with-SHA256
  const name = seq(set(seq(oid([0x55, 0x04, 0x03]), utf8(o.names[0] ?? 'test')))); // commonName
  const serial = randomBytes(8);
  serial[0] = serial[0]! & 0x7f;
  if (serial[0] === 0) serial[0] = 1;
  const alternativeNames = seq(oid([0x55, 0x1d, 0x11]), octets(seq(...o.names.map((n) => der(0x82, Buffer.from(n, 'ascii')))))); // subjectAltName, dNSName
  const toBeSigned = seq(
    der(0xa0, integer(Buffer.from([2]))), // version 3
    integer(serial),
    algorithm,
    name, // issuer
    seq(time(notBefore), time(notAfter)),
    name, // subject
    publicKey.export({ type: 'spki', format: 'der' }),
    ...(o.names.length > 0 ? [der(0xa3, seq(alternativeNames))] : []),
  );
  const signature = sign('sha256', toBeSigned, privateKey); // DER encoded for an EC key
  return { cert: pem('CERTIFICATE', seq(toBeSigned, algorithm, bits(signature))), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}
