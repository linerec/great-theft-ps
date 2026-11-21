// SPDX-License-Identifier: AGPL-3.0-only
//
// Where registered consoles are kept: one JSON file on the computer that runs the bridge.
//
// The file holds secrets (the registration key and the key let a program control the console), so:
//  - it lives in the user's own folder, not in the project (default: ~/.gtp/consoles.json, or $GTP_HOME),
//  - it is written atomically with owner-only permissions (0600 file, 0700 folder; Windows ignores the mode bits, so
//    there it relies on the permissions of the user profile folder),
//  - the browser never receives the keys: list() returns only the public part.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isKnownTarget, type KnownTarget } from './rpcrypt.ts';
import type { RegisteredConsole } from './regist.ts';

export interface StoredConsole {
  mac: string;
  nickname: string;
  target: KnownTarget;
  /** Last address the console was registered from or seen at. A hint only; the address can change. */
  host: string;
  registKey: string; // hex
  rpKeyType: number;
  rpKey: string; // hex
  registeredAt: string;
}

export type PublicConsole = Pick<StoredConsole, 'mac' | 'nickname' | 'target' | 'host' | 'registeredAt'>;

interface FileShape {
  version: 1;
  /** The user's PSN account id as base64 of its 8 bytes. An identifier, not a credential. */
  accountId?: string;
  consoles: StoredConsole[];
}

export function defaultStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.GTP_HOME ?? path.join(os.homedir(), '.gtp'), 'consoles.json');
}

const isHex = (s: unknown, bytes: number): s is string => typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]+$/.test(s);

export class ConsoleStore {
  readonly file: string;
  #data: FileShape;

  constructor(file: string) {
    this.file = file;
    this.#data = this.#read();
  }

  #read(): FileShape {
    if (!existsSync(this.file)) return { version: 1, consoles: [] };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error(`${this.file} is not valid JSON. Move it away to start over (it holds your console registrations).`);
    }
    const obj = raw as Partial<FileShape>;
    const consoles = (Array.isArray(obj.consoles) ? obj.consoles : []).filter(
      (c): c is StoredConsole =>
        !!c && isHex((c as StoredConsole).mac, 6) && isKnownTarget((c as StoredConsole).target) && isHex((c as StoredConsole).rpKey, 16) && typeof (c as StoredConsole).registKey === 'string',
    );
    const out: FileShape = { version: 1, consoles };
    if (typeof obj.accountId === 'string' && /^[A-Za-z0-9+/]{11}=$/.test(obj.accountId)) out.accountId = obj.accountId;
    return out;
  }

  #write(): void {
    const dir = path.dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* not supported on this file system */
    }
  }

  list(): PublicConsole[] {
    return this.#data.consoles.map(({ mac, nickname, target, host, registeredAt }) => ({ mac, nickname, target, host, registeredAt }));
  }

  /** The full record including secrets. For the console link only; never sent to a browser. */
  get(mac: string): StoredConsole | undefined {
    return this.#data.consoles.find((c) => c.mac === mac.toLowerCase());
  }

  put(reg: RegisteredConsole, host: string): PublicConsole {
    const record: StoredConsole = {
      mac: reg.mac,
      nickname: reg.nickname,
      target: reg.target,
      host,
      registKey: Buffer.from(reg.registKey).toString('hex'),
      rpKeyType: reg.rpKeyType,
      rpKey: Buffer.from(reg.rpKey).toString('hex'),
      registeredAt: new Date().toISOString(),
    };
    this.#data.consoles = [...this.#data.consoles.filter((c) => c.mac !== record.mac), record];
    this.#write();
    const { mac, nickname, target, registeredAt } = record;
    return { mac, nickname, target, host, registeredAt };
  }

  remove(mac: string): boolean {
    const before = this.#data.consoles.length;
    this.#data.consoles = this.#data.consoles.filter((c) => c.mac !== mac.toLowerCase());
    if (this.#data.consoles.length === before) return false;
    this.#write();
    return true;
  }

  /** Base64 of the 8 account id bytes, or undefined. */
  get accountId(): string | undefined {
    return this.#data.accountId;
  }

  setAccountId(base64: string | undefined): void {
    if (base64 === undefined) delete this.#data.accountId;
    else this.#data.accountId = base64;
    this.#write();
  }
}
