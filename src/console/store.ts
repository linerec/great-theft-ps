// SPDX-License-Identifier: AGPL-3.0-only
//
// Where registered consoles are kept: one JSON file on the computer that runs the bridge.
//
// The file holds secrets (the registration key and the key let a program control the console), so:
//  - it lives in the user's own folder, not in the project (default: ~/.gtp/consoles.json, or $GTP_HOME),
//  - it is written atomically with owner-only permissions (0600 file, 0700 folder; Windows ignores the mode bits, so
//    there it relies on the permissions of the user profile folder),
//  - the browser never receives the keys: list() returns only the public part.
//
// A console keeps one registration PER PSN ACCOUNT (the registration decides which of the console's users a session
// logs in as), so a console can be here more than once: once for each account that was registered. The first one in the
// file is the one used when nobody chose. Each person who uses the bridge can choose theirs (`choose`).

import { createHash } from 'node:crypto';
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
  /**
   * The PSN account this registration logs in as: base64 of its 8 bytes. An identifier, not a credential. Absent only
   * when it is not known (a registration from before accounts were kept, in a file without an account id).
   */
  accountId?: string;
  /** What people call this account here ("Dad", "Kids"). */
  accountLabel?: string;
}

/**
 * One PSN account a console is registered for, as the browser sees it. The account id itself stays here: `id` is a short
 * hash of it (enough to say which one is meant) and `hint` its last four digits (enough for a person to recognise it).
 */
export interface PublicProfile {
  id: string;
  label: string;
  hint: string;
  registeredAt: string;
  verifiedAt?: string;
}

const ACCOUNT_RE = /^[A-Za-z0-9+/]{11}=$/;
/** The id of a registration whose account is not known. */
export const UNKNOWN_PROFILE = 'unknown';
export const MAX_LABEL = 40;

export function profileIdOf(accountId: string | undefined): string {
  return accountId ? createHash('sha256').update(accountId).digest('hex').slice(0, 8) : UNKNOWN_PROFILE;
}

/** The last four digits of the account number, or '' when the account is not known. */
export function accountHint(accountId: string | undefined): string {
  if (!accountId || !ACCOUNT_RE.test(accountId)) return '';
  return Buffer.from(accountId, 'base64').readBigUInt64LE().toString().slice(-4);
}

/** A label as it is kept: one line, no control characters, at most MAX_LABEL characters. */
export function cleanLabel(label: unknown): string {
  return typeof label === 'string' ? [...label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()].slice(0, MAX_LABEL).join('') : '';
}

const publicProfile = (c: StoredConsole): PublicProfile => ({
  id: profileIdOf(c.accountId),
  label: c.accountLabel ?? '',
  hint: accountHint(c.accountId),
  registeredAt: c.registeredAt,
  ...(c.verifiedAt ? { verifiedAt: c.verifiedAt } : {}),
});

export type PublicConsole = Pick<StoredConsole, 'mac' | 'nickname' | 'target' | 'host' | 'registeredAt' | 'verifiedAt'>;

interface FileShape {
  version: 1;
  /** The user's PSN account id as base64 of its 8 bytes. An identifier, not a credential. */
  accountId?: string;
  consoles: StoredConsole[];
  /** Which account each person plays as: person -> console (mac) -> profile id. Absent means the first registration. */
  choices?: Record<string, Record<string, string>>;
}

/** Keeps what is well formed and drops the rest, so a damaged or foreign file cannot put garbage into the store. */
export function normalizeStoreData(raw: unknown): FileShape {
  const obj = (raw ?? {}) as Partial<FileShape>;
  const consoles = (Array.isArray(obj.consoles) ? obj.consoles : []).filter(
    (c): c is StoredConsole =>
      !!c && isHex((c as StoredConsole).mac, 6) && isKnownTarget((c as StoredConsole).target) && isHex((c as StoredConsole).rpKey, 16) && typeof (c as StoredConsole).registKey === 'string',
  );
  const out: FileShape = { version: 1, consoles };
  if (typeof obj.accountId === 'string' && ACCOUNT_RE.test(obj.accountId)) out.accountId = obj.accountId;
  // Registrations from before the account was kept with each one were made with the saved account id (registering
  // saved it), so they get it. Without a saved id the account stays unknown.
  out.consoles = consoles.map((c) => {
    const { accountId, accountLabel, ...rest } = c;
    const id = typeof accountId === 'string' && ACCOUNT_RE.test(accountId) ? accountId : out.accountId;
    const label = cleanLabel(accountLabel);
    return { ...rest, ...(id ? { accountId: id } : {}), ...(label ? { accountLabel: label } : {}) };
  });
  const choices: Record<string, Record<string, string>> = {};
  if (obj.choices && typeof obj.choices === 'object' && !Array.isArray(obj.choices)) {
    for (const [person, per] of Object.entries(obj.choices).slice(0, 200)) {
      if (!per || typeof per !== 'object' || Array.isArray(per)) continue;
      const kept = Object.entries(per).filter(([mac, profile]) => isHex(mac, 6) && typeof profile === 'string' && /^[0-9a-z]{1,16}$/.test(profile));
      if (kept.length) choices[person] = Object.fromEntries(kept) as Record<string, string>;
    }
  }
  if (Object.keys(choices).length) out.choices = choices;
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
   * Add what another copy of the store knows. A registration (a console and one PSN account) is added when new; when
   * both have it the newer one wins. Imported ones are not marked verified: that has to be shown again from this
   * computer. The account id is taken only if this computer has none. Who plays as which account is not taken: the
   * people of another computer are not the people of this one.
   */
  merge(incoming: unknown): { added: PublicConsole[]; updated: PublicConsole[]; kept: PublicConsole[]; accountId: 'taken' | 'kept' | 'none' } {
    const { choices: _theirs, ...other } = normalizeStoreData(incoming);
    const result = { added: [] as PublicConsole[], updated: [] as PublicConsole[], kept: [] as PublicConsole[], accountId: 'none' as 'taken' | 'kept' | 'none' };
    const pub = ({ mac, nickname, target, host, registeredAt }: StoredConsole): PublicConsole => ({ mac, nickname, target, host, registeredAt });
    for (const c of other.consoles) {
      const { verifiedAt: _dropped, ...fresh } = c;
      // A copy that does not say which account a registration is for means the one this computer has for that console.
      const mine = this.#data.consoles.find((x) => x.mac === c.mac && (!c.accountId || !x.accountId || x.accountId === c.accountId));
      if (!mine) {
        this.#data.consoles.push(fresh);
        result.added.push(pub(fresh));
      } else if (Date.parse(c.registeredAt) > Date.parse(mine.registeredAt)) {
        const kept: StoredConsole = { ...fresh };
        if (!kept.accountId && mine.accountId) kept.accountId = mine.accountId;
        if (!kept.accountLabel && mine.accountLabel) kept.accountLabel = mine.accountLabel;
        this.#data.consoles = this.#data.consoles.map((x) => (x === mine ? kept : x));
        result.updated.push(pub(kept));
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

  /** Each console once, however many accounts it is registered for (see profiles()). */
  list(): PublicConsole[] {
    const seen = new Set<string>();
    const out: PublicConsole[] = [];
    for (const { mac, nickname, target, host, registeredAt, verifiedAt } of this.#data.consoles) {
      if (seen.has(mac)) continue;
      seen.add(mac);
      out.push({ mac, nickname, target, host, registeredAt, ...(verifiedAt ? { verifiedAt } : {}) });
    }
    return out;
  }

  #find(mac: string, profile?: string): StoredConsole | undefined {
    const m = mac.toLowerCase();
    return this.#data.consoles.find((c) => c.mac === m && (profile === undefined || profileIdOf(c.accountId) === profile));
  }

  /** The PSN accounts a console is registered for, the default one first. No secrets. */
  profiles(mac: string): PublicProfile[] {
    const m = mac.toLowerCase();
    return this.#data.consoles.filter((c) => c.mac === m).map(publicProfile);
  }

  /**
   * The profile `person` plays as on a console: what they chose if that registration is still here, otherwise the
   * first one. Undefined when the console is not registered.
   */
  chosen(person: string, mac: string): string | undefined {
    const m = mac.toLowerCase();
    const choices = this.#data.choices;
    const wanted = choices && Object.hasOwn(choices, person) ? choices[person]![m] : undefined;
    const hit = (wanted !== undefined && this.#find(m, wanted)) || this.#find(m);
    return hit ? profileIdOf(hit.accountId) : undefined;
  }

  /** Remember which account `person` plays as on a console. False when there is no such registration. */
  choose(person: string, mac: string, profile: string): boolean {
    const m = mac.toLowerCase();
    if (!this.#find(m, profile)) return false;
    const choices = (this.#data.choices ??= {});
    if (!Object.hasOwn(choices, person)) choices[person] = {};
    const mine = choices[person]!;
    if (mine[m] === profile) return true;
    mine[m] = profile;
    this.#write();
    return true;
  }

  setLabel(mac: string, profile: string, label: string): boolean {
    const c = this.#find(mac, profile);
    if (!c) return false;
    const clean = cleanLabel(label);
    if (clean) c.accountLabel = clean;
    else delete c.accountLabel;
    this.#write();
    return true;
  }

  /** Remember that the console accepted a session request, and the address it answered at. */
  markVerified(mac: string, host: string, profile?: string): boolean {
    const c = this.#find(mac, profile);
    if (!c) return false;
    c.verifiedAt = new Date().toISOString();
    for (const x of this.#data.consoles) if (x.mac === c.mac) x.host = host;
    this.#write();
    return true;
  }

  /** The console was found at another address (see locate.ts). Nothing else about the registration changes. */
  setHost(mac: string, host: string): boolean {
    const all = this.#data.consoles.filter((x) => x.mac === mac.toLowerCase());
    if (all.length === 0) return false;
    if (all.every((c) => c.host === host)) return true;
    for (const c of all) c.host = host;
    this.#write();
    return true;
  }

  /**
   * The full record including secrets. For the console link only; never sent to a browser. Without `profile` it is
   * the console's first registration.
   */
  get(mac: string, profile?: string): StoredConsole | undefined {
    return this.#find(mac, profile);
  }

  /** The registration `person` plays with (see chosen()). */
  getFor(mac: string, person: string): StoredConsole | undefined {
    return this.#find(mac, this.chosen(person, mac));
  }

  /**
   * Keep a registration. It replaces the one this console already has for the same PSN account and is added next to
   * those for other accounts. Without `account` it is for the saved account id.
   */
  put(reg: RegisteredConsole, host: string, account: { accountId?: string; label?: string } = {}): PublicConsole {
    const accountId = account.accountId ?? this.#data.accountId;
    const old = this.#data.consoles.find((c) => c.mac === reg.mac && c.accountId === accountId);
    const label = cleanLabel(account.label) || old?.accountLabel || '';
    const record: StoredConsole = {
      mac: reg.mac,
      nickname: reg.nickname,
      target: reg.target,
      host,
      registKey: Buffer.from(reg.registKey).toString('hex'),
      rpKeyType: reg.rpKeyType,
      rpKey: Buffer.from(reg.rpKey).toString('hex'),
      registeredAt: new Date().toISOString(),
      ...(accountId ? { accountId } : {}),
      ...(label ? { accountLabel: label } : {}),
    };
    // In place, so that the console's first registration (the one used when nobody chose) stays the first.
    if (old) this.#data.consoles = this.#data.consoles.map((c) => (c === old ? record : c));
    else this.#data.consoles.push(record);
    for (const c of this.#data.consoles) if (c.mac === record.mac) c.host = host;
    this.#write();
    const { mac, nickname, target, registeredAt } = record;
    return { mac, nickname, target, host, registeredAt };
  }

  /** Forget a console, or with `profile` only its registration for that one account. */
  remove(mac: string, profile?: string): boolean {
    const m = mac.toLowerCase();
    const before = this.#data.consoles.length;
    this.#data.consoles = this.#data.consoles.filter((c) => !(c.mac === m && (profile === undefined || profileIdOf(c.accountId) === profile)));
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
