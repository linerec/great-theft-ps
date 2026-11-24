// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { AccountError, AccountStore, hashPassword, verifyPassword } from '../src/bridge/accounts.ts';
import { Throttle } from '../src/bridge/auth-api.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'gtp-accounts-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const HOUR = 3600_000;
const CHEAP = { n: 1024, r: 8, p: 1 }; // the real cost is for servers; tests should not spend the machine on it
const make = (dir = tmp(), clock = { t: Date.UTC(2026, 10, 24, 15, 0, 0) }): { s: AccountStore; clock: { t: number }; dir: string } => ({ s: new AccountStore({ dir, now: () => clock.t, scryptCost: CHEAP }), clock, dir });

async function setUp(s: AccountStore): Promise<void> {
  const owner = s.invite('owner', { role: 'owner' });
  await s.acceptInvite(owner.code, 'correct horse');
  const kid = s.invite('kid', { dailyMinutes: 90 });
  await s.acceptInvite(kid.code, 'kid-password-1');
}

describe('passwords', () => {
  it('are kept as salted hashes that only the right password opens', async () => {
    const h = await hashPassword('hunter22');
    assert.match(h, /^scrypt\$\d+\$\d+\$\d+\$/);
    assert.notEqual(h, await hashPassword('hunter22'), 'a new salt each time');
    assert.equal(await verifyPassword('hunter22', h), true);
    assert.equal(await verifyPassword('hunter23', h), false);
    assert.equal(await verifyPassword('hunter22', 'garbage'), false);
  });
});

describe('inviting and logging in', () => {
  it('sets a password through a one-time invitation, and the files never hold the password or the codes', async () => {
    const { s, dir } = make();
    assert.equal(s.empty, true);
    const inv = s.invite('Owner', { role: 'owner' });
    assert.equal(s.inviteFor(inv.code), 'Owner');
    assert.equal(s.inviteFor('wrong'), null);
    await assert.rejects(s.acceptInvite(inv.code, 'short'), (e: AccountError) => e.code === 'bad-password');
    const ok = await s.acceptInvite(inv.code, 'correct horse');
    assert.equal(ok.user.role, 'owner');
    assert.equal(s.inviteFor(inv.code), null, 'a code works once');
    await assert.rejects(s.acceptInvite(inv.code, 'another pass'), (e: AccountError) => e.code === 'bad-invite');
    for (const f of ['accounts.json', 'invites.json', 'sessions.json']) {
      const text = readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!text.includes('correct horse'), `${f} holds no password`);
      assert.ok(!text.includes(inv.code) && !text.includes(ok.session), `${f} holds no code or session value`);
      assert.equal(statSync(path.join(dir, f)).mode & 0o077, 0, `${f} is private`);
    }
  });

  it('logs in with the right password, and a wrong name looks the same as a wrong password', async () => {
    const { s } = make();
    await setUp(s);
    assert.ok(await s.login('KID', 'kid-password-1'), 'names are not case sensitive');
    assert.equal(await s.login('kid', 'nope-nope-1'), null);
    assert.equal(await s.login('nobody', 'kid-password-1'), null);
    assert.equal(await s.login('kid', ''), null);
  });

  it('keeps a session for 30 days from the last use, and ends it at logout, when switched off, or with a new password', async () => {
    const { s, clock } = make();
    await setUp(s);
    const a = (await s.login('kid', 'kid-password-1'))!;
    assert.equal(s.userFor(a.session)?.name, 'kid');
    assert.equal(s.userFor('forged'), null);
    clock.t += 29 * 24 * HOUR;
    assert.equal(s.userFor(a.session)?.name, 'kid', 'still good, and renewed by this use');
    clock.t += 29 * 24 * HOUR;
    assert.equal(s.userFor(a.session)?.name, 'kid', '29 days after the renewal');
    clock.t += 31 * 24 * HOUR;
    assert.equal(s.userFor(a.session), null, 'idle for 31 days: over');
    const b = (await s.login('kid', 'kid-password-1'))!;
    s.logout(b.session);
    assert.equal(s.userFor(b.session), null);
    const c = (await s.login('kid', 'kid-password-1'))!;
    s.setDisabled('kid', true);
    assert.equal(s.userFor(c.session), null);
    assert.equal(await s.login('kid', 'kid-password-1'), null, 'a switched-off person cannot log in');
    s.setDisabled('kid', false);
    const d = (await s.login('kid', 'kid-password-1'))!;
    const again = s.invite('kid');
    assert.equal(s.userFor(d.session), null, 'a new invitation ends the old sessions');
    assert.equal(await s.login('kid', 'kid-password-1'), null, 'and the old password until a new one is set');
    await s.acceptInvite(again.code, 'second-password');
    assert.ok(await s.login('kid', 'second-password'));
  });

  it('lets an invitation lapse after 48 hours', async () => {
    const { s, clock } = make();
    const inv = s.invite('owner', { role: 'owner' });
    clock.t += 47 * HOUR;
    assert.equal(s.inviteFor(inv.code), 'owner');
    clock.t += 2 * HOUR;
    assert.equal(s.inviteFor(inv.code), null);
  });

  it('refuses odd names and keeps the last owner', async () => {
    const { s } = make();
    for (const bad of ['', 'a b', 'x'.repeat(25), '../etc']) assert.throws(() => s.invite(bad), (e: AccountError) => e.code === 'bad-name');
    await setUp(s);
    assert.throws(() => s.remove('owner'), (e: AccountError) => e.code === 'last-owner');
    assert.throws(() => s.setDisabled('owner', true), (e: AccountError) => e.code === 'last-owner');
    s.remove('kid');
    assert.equal(s.get('kid'), null);
  });

  it('keeps everything across a restart', async () => {
    const { s, dir, clock } = make();
    await setUp(s);
    const a = (await s.login('kid', 'kid-password-1'))!;
    s.addUsage('kid', 600);
    const again = new AccountStore({ dir, now: () => clock.t, scryptCost: CHEAP });
    assert.equal(again.userFor(a.session)?.name, 'kid');
    assert.equal(again.usedSeconds('kid'), 600);
    assert.ok(await again.login('owner', 'correct horse'));
  });
});

describe('minutes per day', () => {
  it('counts played seconds against the day, and the owner has no limit', async () => {
    const { s } = make();
    await setUp(s);
    assert.equal(s.remainingSeconds('kid'), 90 * 60);
    s.addUsage('kid', 1000);
    s.addUsage('kid', 800);
    assert.equal(s.usedSeconds('kid'), 1800);
    assert.equal(s.remainingSeconds('kid'), 90 * 60 - 1800);
    assert.equal(s.remainingSeconds('owner'), null);
    s.addUsage('owner', 99999);
    assert.equal(s.remainingSeconds('owner'), null);
    s.addUsage('kid', 99999);
    assert.equal(s.remainingSeconds('kid'), 0, 'never below zero');
    assert.equal(s.setMinutes('kid', null).dailyMinutes, null);
    assert.equal(s.remainingSeconds('kid'), null);
    assert.equal(s.setMinutes('owner', 10).dailyMinutes, null, 'the owner stays unlimited');
    assert.throws(() => s.setMinutes('kid', -5), (e: AccountError) => e.code === 'bad-minutes');
    assert.throws(() => s.setMinutes('kid', 1.5), (e: AccountError) => e.code === 'bad-minutes');
  });

  it('starts a new day at midnight in the family time zone, not at midnight UTC', async () => {
    const { s, clock } = make(tmp(), { t: Date.UTC(2026, 10, 24, 20, 0, 0) }); // 15:00 in New York
    await setUp(s);
    s.addUsage('kid', 3000);
    clock.t = Date.UTC(2026, 10, 25, 3, 0, 0); // 22:00 in New York: still the 24th, though UTC has turned
    assert.equal(s.dayOf(), '2026-11-24');
    assert.equal(s.usedSeconds('kid'), 3000);
    clock.t = Date.UTC(2026, 10, 25, 5, 30, 0); // 00:30 on the 25th in New York
    assert.equal(s.dayOf(), '2026-11-25');
    assert.equal(s.usedSeconds('kid'), 0, 'a fresh day');
    assert.equal(s.remainingSeconds('kid'), 90 * 60);
    clock.t = Date.UTC(2026, 10, 25, 4, 59, 59);
    assert.equal(s.dayOf(), '2026-11-24', 'daylight saving is not in play in November: the day ends at 05:00 UTC');
  });

  it('can be set to another time zone', () => {
    const s = new AccountStore({ dir: tmp(), scryptCost: CHEAP, timeZone: 'Asia/Seoul', now: () => Date.UTC(2026, 10, 24, 16, 0, 0) });
    assert.equal(s.dayOf(), '2026-11-25');
  });
});

describe('slowing down guessing', () => {
  it('lets a few wrong tries through, then makes the wait grow, and forgives a success', () => {
    let now = 0;
    const t = new Throttle(() => now);
    for (let i = 0; i < 5; i++) {
      assert.equal(t.wait('a'), 0);
      t.fail('a');
    }
    assert.equal(t.wait('a'), 0, 'five failures are free');
    t.fail('a');
    assert.equal(t.wait('a'), 15_000);
    now += 15_000;
    assert.equal(t.wait('a'), 0);
    t.fail('a');
    assert.equal(t.wait('a'), 30_000);
    assert.equal(t.wait('b'), 0, 'others are not held up');
    t.ok('a');
    assert.equal(t.wait('a'), 0);
  });
});
