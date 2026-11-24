// SPDX-License-Identifier: AGPL-3.0-only
//
// Where registered consoles are kept: one JSON file on the computer that runs the bridge.
//
// The file holds secrets (the registration key and the key let a program control the console), so:
//  - it lives in the user's own folder, not in the project (default: ~/.gtp/consoles.json, or $GTP_HOME),
//  - it is written atomically with owner-only permissions (0600 file, 0700 folder; Windows ignores the mode bits, so
//    there it relies on the permissions of the user profile folder),
//  - the browser never receives the keys: list() returns only the public part.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
  /** When the console last accepted a session request with this registration (proof that the registration works). */
  verifiedAt?: string;
}

export type PublicConsole = Pick<StoredConsole, 'mac' | 'nickname' | 'target' | 'host' | 'registeredAt' | 'verifiedAt'>;

interface FileShape {
  version: 1;
  /** The user's PSN account id as base64 of its 8 bytes. An identifier, not a credential. */
  accountId?: string;
  consoles: StoredConsole[];
}

/** Keeps what is well formed and drops the rest, so a damaged or foreign file cannot put garbage into the store. */
export function normalizeStoreData(raw: unknown): FileShape {
  const obj = (raw ?? {}) as Partial<FileShape>;
  const consoles = (Array.isArray(obj.consoles) ? obj.consoles : []).filter(
    (c): c is StoredConsole =>
      !!c && isHex((c as StoredConsole).mac, 6) && isKnownTarget((c as StoredConsole).target) && isHex((c as StoredConsole).rpKey, 16) && typeof (c as StoredConsole).registKey === 'string',
  );
  const out: FileShape = { version: 1, consoles };
  if (typeof obj.accountId === 'string' && /^[A-Za-z0-9+/]{11}=$/.test(obj.accountId)) out.accountId = obj.accountId;
  return out;
}

export function defaultStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.GTP_HOME ?? path.join(os.homedir(), '.gtp'), 'consoles.json');
}

const isHex = (s: unknown, bytes: number): s is string => typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]+$/.test(s);

export class ConsoleStore {
  readonly file: string;
  #cache: FileShape;
  #seen = 0;

  constructor(file: string) {
    this.file = file;
    this.#cache = this.#read();
    this.#seen = this.#mtime();
  }

  #mtime(): number {
    try {
      return statSync(this.file).mtimeMs;
    } catch {
      return 0; // no file yet
    }
  }

  /**
   * The data, re-read first if another program changed the file in the meantime (the command line tool importing a
   * backup, a second bridge). A long-running bridge therefore sees an import without a restart, and never writes its
   * old copy over it.
   */
  get #data(): FileShape {
    const now = this.#mtime();
    if (now !== this.#seen) {
      this.#cache = this.#read();
      this.#seen = now;
    }
    return this.#cache;
  }

  #read(): FileShape {
    if (!existsSync(this.file)) return { version: 1, consoles: [] };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      throw new Error(`${this.file} is not valid JSON. Move it away to start over (it holds your console registrations).`);
    }
    return normalizeStoreData(raw);
  }

  /** A copy of everything, secrets included. For exporting a backup only. */
  snapshot(): FileShape {
    return JSON.parse(JSON.stringify(this.#data)) as FileShape;
  }

  /**
   * Add what another copy of the store knows. A console is added when new; when both have it the newer registration
   * wins. Imported consoles are not marked verified: that has to be shown again from this computer. The account id is
   * taken only if this computer has none.
   */
  merge(incoming: unknown): { added: PublicConsole[]; updated: PublicConsole[]; kept: PublicConsole[]; accountId: 'taken' | 'kept' | 'none' } {
    const other = normalizeStoreData(incoming);
    const result = { added: [] as PublicConsole[], updated: [] as PublicConsole[], kept: [] as PublicConsole[], accountId: 'none' as 'taken' | 'kept' | 'none' };
    const pub = ({ mac, nickname, target, host, registeredAt }: StoredConsole): PublicConsole => ({ mac, nickname, target, host, registeredAt });
    for (const c of other.consoles) {
      const { verifiedAt: _dropped, ...fresh } = c;
      const mine = this.#data.consoles.find((x) => x.mac === c.mac);
      if (!mine) {
        this.#data.consoles.push(fresh);
        result.added.push(pub(fresh));
      } else if (Date.parse(c.registeredAt) > Date.parse(mine.registeredAt)) {
        this.#data.consoles = this.#data.consoles.map((x) => (x.mac === c.mac ? fresh : x));
        result.updated.push(pub(fresh));
      } else {
        result.kept.push(pub(mine));
      }
    }
    if (other.accountId) {
      if (this.#data.accountId) result.accountId = 'kept';
      else {
        this.#data.accountId = other.accountId;
        result.accountId = 'taken';
      }
    }
    if (result.added.length || result.updated.length || result.accountId === 'taken') this.#write();
    return result;
  }

  #write(): void {
    const dir = path.dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#cache, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* not supported on this file system */
    }
    this.#seen = this.#mtime(); // our own write is not "someone else's change"
  }

  list(): PublicConsole[] {
    return this.#data.consoles.map(({ mac, nickname, target, host, registeredAt, verifiedAt }) => ({ mac, nickname, target, host, registeredAt, ...(verifiedAt ? { verifiedAt } : {}) }));
  }

  /** Remember that the console accepted a session request, and the address it answered at. */
  markVerified(mac: string, host: string): boolean {
    const c = this.#data.consoles.find((x) => x.mac === mac.toLowerCase());
    if (!c) return false;
    c.verifiedAt = new Date().toISOString();
    c.host = host;
    this.#write();
    return true;
  }

  /** The console was found at another address (see locate.ts). Nothing else about the registration changes. */
  setHost(mac: string, host: string): boolean {
    const c = this.#data.consoles.find((x) => x.mac === mac.toLowerCase());
    if (!c) return false;
    if (c.host === host) return true;
    c.host = host;
    this.#write();
    return true;
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
