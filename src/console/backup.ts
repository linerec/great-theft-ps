// SPDX-License-Identifier: AGPL-3.0-only
//
// A passphrase-protected copy of the console store, so a registration can be moved to another computer (or kept as a
// backup) without registering again and without logging in to PSN again.
//
// The file is JSON with the metadata in the clear and the payload encrypted: scrypt (N=2^15, r=8, p=1) turns the
// passphrase into a key, AES-256-GCM encrypts and authenticates. A wrong passphrase and a damaged file both fail the
// authentication and are reported the same way. The passphrase is never stored.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const FORMAT = 'gtp-consoles-backup';
const VERSION = 1;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const AAD = Buffer.from(`${FORMAT}/v${VERSION}`);
export const MIN_PASSPHRASE = 10;

export class BackupError extends Error {
  code: 'weak-passphrase' | 'not-a-backup' | 'wrong-passphrase';
  constructor(code: BackupError['code'], message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

const key = (passphrase: string, salt: Buffer): Buffer => scryptSync(passphrase.normalize('NFC'), salt, 32, SCRYPT);

export function encryptBackup(data: unknown, passphrase: string): string {
  if ([...passphrase].length < MIN_PASSPHRASE) throw new BackupError('weak-passphrase', `Use a passphrase of at least ${MIN_PASSPHRASE} characters`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(passphrase, salt), iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return `${JSON.stringify(
    {
      format: FORMAT, version: VERSION,
      kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') },
      cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
      data: body.toString('base64'),
    },
    null,
    2,
  )}\n`;
}

export function decryptBackup(text: string, passphrase: string): unknown {
  let file: any;
  try {
    file = JSON.parse(text);
  } catch {
    throw new BackupError('not-a-backup', 'This is not a Great Theft P.S backup file');
  }
  const ok =
    file?.format === FORMAT && file?.version === VERSION && file?.kdf?.name === 'scrypt' && file?.cipher?.name === 'aes-256-gcm' &&
    file.kdf.N === SCRYPT.N && file.kdf.r === SCRYPT.r && file.kdf.p === SCRYPT.p &&
    typeof file.kdf.salt === 'string' && typeof file.cipher.iv === 'string' && typeof file.cipher.tag === 'string' && typeof file.data === 'string';
  if (!ok) throw new BackupError('not-a-backup', 'This is not a Great Theft P.S backup file, or it is from a version this program does not know');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(passphrase, Buffer.from(file.kdf.salt, 'base64')), Buffer.from(file.cipher.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(file.cipher.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    throw new BackupError('wrong-passphrase', 'Wrong passphrase, or the file is damaged');
  }
}
