// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTPS for the bridge itself. This project's own.
//
// Why: a browser decodes video only on a secure page, and only localhost counts as one without HTTPS. A phone that
// reaches the bridge over a private network (Tailscale) therefore needs an HTTPS address. The bridge can serve that
// itself with a certificate made by `tailscale cert <name>` (a certificate and a key file), and bind to the Tailscale
// address only. Nothing here talks to the network; it reads two files and says what is wrong with them.

import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
  /** Until when the certificate is valid. */
  notAfter: Date;
  /** The DNS names the certificate is for. */
  names: string[];
}

export class TlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TlsError';
  }
}

const read = (file: string, what: string): Buffer => {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new TlsError(`cannot read the ${what} ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
};

/** The DNS names in a certificate's subject alternative names. */
export function certificateNames(cert: X509Certificate): string[] {
  return (cert.subjectAltName ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('DNS:'))
    .map((s) => s.slice(4).toLowerCase());
}

/** Read a certificate and its private key and check that they belong together. */
export function loadTls(certFile: string, keyFile: string): TlsMaterial {
  const cert = read(certFile, 'certificate');
  const key = read(keyFile, 'private key');
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(cert);
  } catch {
    throw new TlsError(`${certFile} is not a certificate in PEM form`);
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(key);
  } catch {
    throw new TlsError(`${keyFile} is not a private key in PEM form`);
  }
  if (!x509.checkPrivateKey(privateKey)) throw new TlsError('the private key does not belong to the certificate (are they from the same `tailscale cert` run?)');
  return { cert, key, notAfter: x509.validToDate, names: certificateNames(x509) };
}

export interface ExpiryReport {
  days: number;
  level: 'ok' | 'soon' | 'expired';
  text: string;
}

/** How long the certificate still lasts, in words, and whether that is a problem. */
export function describeExpiry(notAfter: Date, now: Date = new Date(), warnDays = 14): ExpiryReport {
  const days = Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000);
  const when = notAfter.toISOString().slice(0, 10);
  if (notAfter.getTime() <= now.getTime()) return { days, level: 'expired', text: `the certificate expired on ${when}` };
  if (days <= warnDays) return { days, level: 'soon', text: `the certificate is valid until ${when}, only ${days} day${days === 1 ? '' : 's'} more` };
  return { days, level: 'ok', text: `the certificate is valid until ${when} (${days} days)` };
}

/** Does a certificate name (possibly "*.example.com", which stands for exactly one label) cover this host name? */
const covers = (pattern: string, name: string): boolean => {
  if (pattern === name) return true;
  if (!pattern.startsWith('*.') || !name.includes('.')) return false;
  return name.slice(name.indexOf('.') + 1) === pattern.slice(2);
};

/** Trusted names the certificate is not for: a browser would refuse the connection under such a name. */
export function namesNotCovered(names: readonly string[], trusted: readonly string[]): string[] {
  return trusted.filter((t) => !names.some((n) => covers(n, t)));
}

/** A readable reason for a failure to listen, with what to try for the usual causes. */
export function explainListenError(error: NodeJS.ErrnoException, host: string, port: number): Error {
  if (error.code === 'EADDRNOTAVAIL') {
    return new Error(`cannot listen on ${host}: that address does not belong to this computer. If it is the Tailscale address, is Tailscale running and connected? (\`tailscale ip -4\` shows it)`);
  }
  if (error.code === 'EADDRINUSE') return new Error(`port ${port} on ${host} is already in use by another program. Choose another one with --port.`);
  if (error.code === 'EACCES') return new Error(`not allowed to listen on ${host}:${port}${port < 1024 ? ' (ports below 1024 need special rights)' : ''}`);
  return error;
}
