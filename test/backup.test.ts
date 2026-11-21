// SPDX-License-Identifier: AGPL-3.0-only
//
// Moving a registration between computers: the encrypted copy, merging it into a store, and the real command line tool
// run end to end between two separate "computers" (two GTP_HOME folders).

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BackupError, decryptBackup, encryptBackup } from '../src/console/backup.ts';
import type { RegisteredConsole } from '../src/console/regist.ts';
import { ConsoleStore } from '../src/console/store.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'gtp-backup-'));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const RP_KEY = '00112233445566778899aabbccddeeff';
const reg = (over: Partial<RegisteredConsole> = {}): RegisteredConsole => ({
  target: 'ps5-1', mac: '0123456789ab', nickname: 'Living room', registKey: Buffer.from('61626364656667680000000000000000', 'hex'), rpKeyType: 2, rpKey: Buffer.from(RP_KEY, 'hex'), ...over,
});
const PASS = 'correct horse battery';

describe('encrypted copy', () => {
  it('round-trips, and the file shows none of what it protects', () => {
    const data = { consoles: [{ mac: '0123456789ab', rpKey: RP_KEY }], accountId: 'AgEAAAAAAAA=' };
    const text = encryptBackup(data, PASS);
    for (const secret of [RP_KEY, '0123456789ab', 'AgEAAAAAAAA=']) assert.ok(!text.includes(secret), `no ${secret.slice(0, 6)}... in the file`);
    assert.deepEqual(decryptBackup(text, PASS), data);
  });

  it('refuses a short passphrase, a wrong one, a damaged file and a stranger\'s file', () => {
    assert.throws(() => encryptBackup({}, 'short'), (e: unknown) => e instanceof BackupError && e.code === 'weak-passphrase');
    const text = encryptBackup({ a: 1 }, PASS);
    assert.throws(() => decryptBackup(text, 'another passphrase'), (e: unknown) => e instanceof BackupError && e.code === 'wrong-passphrase');
    const file = JSON.parse(text);
    const bytes = Buffer.from(file.data, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    assert.throws(() => decryptBackup(JSON.stringify({ ...file, data: bytes.toString('base64') }), PASS), (e: unknown) => e instanceof BackupError && e.code === 'wrong-passphrase', 'a flipped bit is caught');
    assert.throws(() => decryptBackup('{"hello":1}', PASS), (e: unknown) => e instanceof BackupError && e.code === 'not-a-backup');
    assert.throws(() => decryptBackup('not json', PASS), (e: unknown) => e instanceof BackupError && e.code === 'not-a-backup');
    assert.throws(() => decryptBackup(JSON.stringify({ ...file, kdf: { ...file.kdf, N: 2 } }), PASS), (e: unknown) => e instanceof BackupError && e.code === 'not-a-backup', 'weakened KDF settings are refused');
  });

  it('each copy is different (fresh salt and IV)', () => {
    assert.notEqual(encryptBackup({ a: 1 }, PASS), encryptBackup({ a: 1 }, PASS));
  });
});

describe('merging into a store', () => {
  it('adds a console that is new, brings the account id, and does not mark it verified', () => {
    const from = new ConsoleStore(path.join(tmp(), 'a.json'));
    from.put(reg(), '192.168.1.50');
    from.markVerified('0123456789ab', '192.168.1.50');
    from.setAccountId('AgEAAAAAAAA=');
    const to = new ConsoleStore(path.join(tmp(), 'b.json'));
    const r = to.merge(from.snapshot());
    assert.equal(r.added.length, 1);
    assert.equal(r.accountId, 'taken');
    assert.equal(to.get('0123456789ab')?.rpKey, RP_KEY);
    assert.equal(to.accountId, 'AgEAAAAAAAA=');
    assert.equal(to.list()[0]!.verifiedAt, undefined, 'it has to be checked again from this computer');
    assert.equal(new ConsoleStore(to.file).list().length, 1, 'saved to disk');
  });

  it('the newer registration wins, an older one is kept out, and a local account id is not overwritten', () => {
    const older = new ConsoleStore(path.join(tmp(), 'old.json'));
    older.put(reg({ nickname: 'Old' }), '192.168.1.10');
    const snapshotOld = older.snapshot();
    snapshotOld.consoles[0]!.registeredAt = '2026-01-01T00:00:00.000Z';
    snapshotOld.accountId = 'AQIDBAUGBwg=';

    const mine = new ConsoleStore(path.join(tmp(), 'mine.json'));
    mine.put(reg({ nickname: 'Mine' }), '192.168.1.50');
    mine.setAccountId('AgEAAAAAAAA=');
    const r1 = mine.merge(snapshotOld);
    assert.deepEqual([r1.added.length, r1.updated.length, r1.kept.length, r1.accountId], [0, 0, 1, 'kept']);
    assert.equal(mine.list()[0]!.nickname, 'Mine');
    assert.equal(mine.accountId, 'AgEAAAAAAAA=');

    const newer = older.snapshot();
    newer.consoles[0]!.registeredAt = '2099-01-01T00:00:00.000Z';
    const r2 = mine.merge(newer);
    assert.equal(r2.updated.length, 1);
    assert.equal(mine.list()[0]!.nickname, 'Old');
  });

  it('ignores garbage in the copy', () => {
    const to = new ConsoleStore(path.join(tmp(), 'c.json'));
    const r = to.merge({ consoles: [{ mac: 'zz' }, null, 7, { mac: '0123456789ab', target: 'ps9', rpKey: 'x' }], accountId: 'nonsense' });
    assert.deepEqual([r.added.length, r.accountId], [0, 'none']);
    assert.deepEqual(to.list(), []);
  });
});

describe('the command line tool, between two computers', () => {
  const run = (home: string, args: string[], env: Record<string, string> = {}): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'consoles.mjs'), ...args], { env: { ...process.env, GTP_HOME: home, ...env }, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('exports on one, imports on the other, and lists without secrets', () => {
    const macHome = tmp();
    const pcHome = tmp();
    const copy = path.join(tmp(), 'gtp-consoles.gtpbackup');
    const mac = new ConsoleStore(path.join(macHome, 'consoles.json'));
    mac.put(reg(), '192.168.1.50');
    mac.setAccountId('AgEAAAAAAAA=');

    const exported = run(macHome, ['export', copy], { GTP_PASSPHRASE: PASS });
    assert.equal(exported.status, 0, exported.out);
    assert.match(exported.out, /Wrote 1 console\(s\) and the PSN account id/);
    if (process.platform !== 'win32') assert.equal(statSync(copy).mode & 0o777, 0o600);
    assert.ok(!readFileSync(copy, 'utf8').includes(RP_KEY));
    assert.notEqual(run(macHome, ['export', copy], { GTP_PASSPHRASE: PASS }).status, 0, 'does not overwrite without --force');
    assert.equal(run(macHome, ['export', copy, '--force'], { GTP_PASSPHRASE: PASS }).status, 0);

    const wrong = run(pcHome, ['import', copy], { GTP_PASSPHRASE: 'not the passphrase' });
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.out, /Wrong passphrase/);
    assert.deepEqual(new ConsoleStore(path.join(pcHome, 'consoles.json')).list(), [], 'a failed import changes nothing');

    const imported = run(pcHome, ['import', copy], { GTP_PASSPHRASE: PASS });
    assert.equal(imported.status, 0, imported.out);
    assert.match(imported.out, /added\s+Living room/);
    assert.match(imported.out, /connect|연결 확인/);

    const listed = run(pcHome, ['list']);
    assert.match(listed.out, /1 registered/);
    assert.match(listed.out, /PSN account id saved: yes/);
    for (const secret of [RP_KEY, '6162636465666768', 'AgEAAAAAAAA=']) assert.ok(!listed.out.includes(secret), 'list shows no secret');
    assert.equal(new ConsoleStore(path.join(pcHome, 'consoles.json')).get('0123456789ab')?.rpKey, RP_KEY);

    const again = run(pcHome, ['import', copy], { GTP_PASSPHRASE: PASS });
    assert.match(again.out, /Nothing new|kept/);
  });

  it('refuses to export when nothing is registered, and a short passphrase', () => {
    const home = tmp();
    assert.notEqual(run(home, ['export', path.join(home, 'x')], { GTP_PASSPHRASE: PASS }).status, 0);
    new ConsoleStore(path.join(home, 'consoles.json')).put(reg(), '192.168.1.50');
    const short = run(home, ['export', path.join(home, 'y')], { GTP_PASSPHRASE: 'short' });
    assert.notEqual(short.status, 0);
    assert.match(short.out, /at least 10/);
    writeFileSync(path.join(home, 'notes.txt'), 'x');
    assert.equal(execFileSync(process.execPath, [path.join(root, 'tools', 'consoles.mjs'), 'path'], { env: { ...process.env, GTP_HOME: home }, encoding: 'utf8' }).trim(), path.join(home, 'consoles.json'));
  });
});
