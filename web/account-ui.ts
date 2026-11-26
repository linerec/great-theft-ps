// SPDX-License-Identifier: AGPL-3.0-only
//
// Logging in (see src/bridge/accounts.ts), the time left today, and the owner's list of people.
//
// On a bridge without accounts this does nothing. On one with accounts the page cannot be used before logging in: a
// window the person cannot close asks for name and password (or, from an invitation link, for a new password).
// What a person sees afterwards: their name, the time left today (counted down here between the bridge's messages),
// log out, and for the owner a window to invite people and set their minutes per day.

import { N_, onLang, t, type Vars } from '../src/i18n/index.ts';
import { formatClock, initialOf, timeLeft, warningsCrossed, warningText } from './player-logic.ts';
import { dismissOnOutside, toast } from './ui.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface PublicUser {
  name: string;
  role: 'owner' | 'member';
  dailyMinutes: number | null;
  disabled: boolean;
  active: boolean;
  usedSecondsToday: number;
}

/** "1:05:09" or "5:09". */
export const formatRemaining = formatClock;

/** What a person is told about minutes: "No limit" or "90 min per day", in the language in use. */
export const describeLimit = (minutes: number | null): string => (minutes === null ? t('No limit') : t('{minutes} min per day', { minutes }));

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data };
}

let accountsOn = false;
let me: PublicUser | null = null;

// ---------------------------------------------------------------- the login window

const loginDialog = $<HTMLDialogElement>('loginDialog');
let loginMode: 'login' | 'invite' = 'login';
let inviteCode = '';
/** Has the window been asked for (startLogin, startInvite)? Until then its words are the page's own. */
let loginShown = false;
/** The note under the title, as a way to say it: it is said again when the language changes. */
let loginNote: () => string = () => '';
/** What the window said last about a mistake (a sentence for t(), and its values), for the same reason. */
let loginSaid: { en: string; vars: Vars | undefined; kind: 'err' | 'ok' } | null = null;

function paintLogin(): void {
  if (!loginShown) return;
  $('loginTitle').textContent = loginMode === 'invite' ? t('Choose a password') : t('Log in');
  $<HTMLButtonElement>('loginGo').textContent = loginMode === 'invite' ? t('Save password and start') : t('Log in');
  $('loginNote').textContent = loginNote();
  paintSaid();
}

function paintSaid(): void {
  const el = $<HTMLElement>('loginMsg');
  el.textContent = loginSaid ? t(loginSaid.en, loginSaid.vars) : '';
  el.hidden = !loginSaid;
  el.dataset.kind = loginSaid?.kind ?? 'err';
}

/** `en` is a sentence marked with N_ (or nothing, to clear the message). */
function say(en = '', vars?: Vars, kind: 'err' | 'ok' = 'err'): void {
  loginSaid = en ? { en, vars, kind } : null;
  paintSaid();
}

function showLogin(): void {
  if (loginDialog.open) return;
  loginDialog.addEventListener('cancel', (e) => e.preventDefault()); // there is nothing behind it to go back to
  loginDialog.showModal();
}

async function startInvite(code: string): Promise<void> {
  inviteCode = code;
  const info = await call('POST', '/api/invite-info', { code });
  loginMode = 'invite';
  $('loginNameRow').hidden = true;
  $('loginPass2Row').hidden = false;
  $<HTMLInputElement>('loginPass').autocomplete = 'new-password';
  if (info.status === 200) {
    const name = String(info.data.name);
    loginNote = () => t('{name}, choose a password for this device (at least 8 characters).', { name });
  } else {
    loginNote = () => t('This invitation link can no longer be used. A link works once, within 48 hours. Ask for a new one.');
    $<HTMLButtonElement>('loginGo').disabled = true;
  }
  loginShown = true;
  paintLogin();
  showLogin();
}

function startLogin(needsSetup: boolean): void {
  loginMode = 'login';
  loginNote = () => (needsSetup ? t('Nobody is registered yet. Open the invitation link printed when the server was first started and set the owner password.') : '');
  loginShown = true;
  paintLogin();
  showLogin();
  $<HTMLInputElement>('loginName').focus();
}

$<HTMLFormElement>('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $<HTMLButtonElement>('loginGo');
  const password = $<HTMLInputElement>('loginPass').value;
  say('');
  button.disabled = true;
  try {
    if (loginMode === 'invite') {
      if (password !== $<HTMLInputElement>('loginPass2').value) return say(N_('The two passwords do not match.'));
      const r = await call('POST', '/api/accept-invite', { code: inviteCode, password });
      if (r.status !== 200) return say(r.data?.error === 'bad-password' ? N_('The password must be at least 8 characters.') : N_('This invitation link can no longer be used.'));
      history.replaceState(null, '', location.pathname + location.search);
    } else {
      const r = await call('POST', '/api/login', { name: $<HTMLInputElement>('loginName').value.trim(), password });
      if (r.status === 429) return say(N_('Too many attempts. Try again in {seconds} seconds.'), { seconds: r.data?.retryAfterSeconds ?? 30 });
      if (r.status !== 200) return say(N_('The name or password is wrong.'));
    }
    location.reload();
  } catch {
    say(N_('Could not connect to the server.'));
  } finally {
    $<HTMLInputElement>('loginPass').value = '';
    $<HTMLInputElement>('loginPass2').value = '';
    button.disabled = false;
  }
});

// ---------------------------------------------------------------- who is logged in, and the time left

let remaining: number | null = null;
let remainingAt = 0;
/** Is a stream running? The time left is counted down here only then (see timeLeft). */
let streaming = false;
/** The time left at the last look, to see which warning point was passed since. */
let lastLeft: number | null = null;

function paintTime(): void {
  if (!me) return;
  const el = $<HTMLElement>('acctTime');
  const quota = $<HTMLElement>('acctQuota');
  if (remaining === null) {
    el.textContent = describeLimit(me.dailyMinutes);
    el.className = 'chip';
    quota.hidden = true;
    lastLeft = null;
    return;
  }
  const left = timeLeft({ remaining, heardAt: remainingAt, now: Date.now(), streaming }) ?? 0;
  el.textContent = t('Time left {time}', { time: formatRemaining(left) });
  el.className = left <= 60 ? 'chip off' : left <= 300 ? 'chip wait' : 'chip good';
  // The menu shows it as a bar of the day's minutes.
  quota.hidden = false;
  $('acctQuotaText').textContent = formatRemaining(left);
  const total = (me.dailyMinutes ?? 0) * 60;
  const bar = $<HTMLElement>('acctQuotaBar');
  bar.style.width = `${total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : 0}%`;
  bar.dataset.level = left <= 60 ? 'critical' : left <= 300 ? 'low' : 'ok';
  // A word at five minutes and at one: a stream that ends with no warning is the worst way to find out.
  if (lastLeft !== null) for (const point of warningsCrossed(lastLeft, left)) toast(warningText(point), point <= 60 ? 'err' : 'warn', 8000);
  lastLeft = left;
}

// A stream starts or ends: take what has been counted so far as the new starting point, and count from here only while it runs.
document.addEventListener('gtp:link', (e) => {
  const on = (e as CustomEvent<{ state: string }>).detail.state === 'ready';
  if (on === streaming) return;
  const left = timeLeft({ remaining, heardAt: remainingAt, now: Date.now(), streaming });
  streaming = on;
  if (left !== null) {
    remaining = left;
    remainingAt = Date.now();
  }
  paintTime();
});

function setRemaining(seconds: number | null): void {
  remaining = seconds;
  remainingAt = Date.now();
  paintTime();
}

const acctMenu = $<HTMLElement>('acctMenu');
const acctBtn = $<HTMLButtonElement>('acctBtn');
function openMenu(open: boolean): void {
  acctMenu.hidden = !open;
  acctBtn.setAttribute('aria-expanded', String(open));
}
let stopDismiss: (() => void) | null = null;
acctBtn.addEventListener('click', () => {
  const open = acctMenu.hidden;
  openMenu(open);
  stopDismiss?.();
  stopDismiss = open ? dismissOnOutside(acctMenu, acctBtn, () => openMenu(false)) : null;
});

function paintRole(): void {
  if (me) $('acctRole').textContent = me.role === 'owner' ? t('Owner · no time limit') : describeLimit(me.dailyMinutes);
}

function showMe(user: PublicUser, remainingSeconds: number | null): void {
  me = user;
  $('acct').hidden = false;
  $('acctName').textContent = user.name;
  $('acctMenuName').textContent = user.name;
  paintRole();
  $('acctAvatar').textContent = $('acctAvatar2').textContent = initialOf(user.name);
  $<HTMLButtonElement>('acctUsers').hidden = user.role !== 'owner';
  setRemaining(remainingSeconds);
  setInterval(paintTime, 1000);
}

// The bridge tells the page how much is left (see server.ts): the number it sends wins over what was counted down here.
window.addEventListener('gtp:quota', (e) => {
  const d = (e as CustomEvent<{ remainingSeconds: number | null }>).detail;
  setRemaining(typeof d.remainingSeconds === 'number' ? d.remainingSeconds : null);
});

$<HTMLButtonElement>('acctOut').addEventListener('click', async () => {
  await call('POST', '/api/logout', {});
  location.reload();
});

// ---------------------------------------------------------------- the owner's people

const usersDialog = $<HTMLDialogElement>('usersDialog');

function cell(text: string, className = ''): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function button(label: string, onClick: () => void, cls = 'btn small'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** The invitation link on show, to be shown again when the language changes. */
let invited: { name: string; code: string } | null = null;

function showInviteLink(name: string, code: string): void {
  invited = { name, code };
  const url = `${location.origin}/#invite=${code}`;
  const box = $<HTMLElement>('usersInvite');
  box.hidden = false;
  box.replaceChildren();
  const p = document.createElement('p');
  p.textContent = t('Send this link to {name}. It works once, within 48 hours, and opening it lets them choose their own password.', { name });
  const input = document.createElement('input');
  input.type = 'text';
  input.readOnly = true;
  input.value = url;
  input.addEventListener('focus', () => input.select());
  const copy = button(t('Copy'), () => void navigator.clipboard?.writeText(url).then(() => (copy.textContent = t('Copied'))));
  box.append(p, input, copy);
}

async function refreshUsers(): Promise<void> {
  const r = await call('GET', '/api/users');
  const body = $<HTMLTableSectionElement>('usersBody');
  body.replaceChildren();
  if (r.status !== 200) return void (body.append(cell(t('The list could not be loaded.'))));
  for (const u of r.data.users as PublicUser[]) {
    const tr = document.createElement('tr');
    tr.append(cell(u.role === 'owner' ? t('{name} (owner)', { name: u.name }) : u.name));
    const minutes = document.createElement('td');
    if (u.role === 'owner') {
      minutes.textContent = t('No limit');
    } else {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '1440';
      input.step = '5';
      input.value = u.dailyMinutes === null ? '' : String(u.dailyMinutes);
      input.placeholder = t('No limit');
      input.setAttribute('aria-label', t('Daily time for {name} (minutes)', { name: u.name }));
      const save = button(t('Save'), async () => {
        const v = input.value.trim();
        const res = await call('POST', '/api/users/minutes', { name: u.name, minutes: v === '' ? null : Number(v) });
        save.textContent = res.status === 200 ? t('Saved') : t('Failed');
        setTimeout(() => void refreshUsers(), 900);
      });
      minutes.append(input, document.createTextNode(` ${t('min')} `), save);
    }
    tr.append(minutes);
    tr.append(cell(u.usedSecondsToday > 0 ? t('{minutes} min', { minutes: Math.round(u.usedSecondsToday / 60) }) : '-'));
    tr.append(cell(u.disabled ? t('Suspended') : u.active ? t('Active') : t('Invite pending'), u.disabled ? 'bad' : ''));
    const actions = document.createElement('td');
    if (u.role !== 'owner') {
      actions.append(
        button(t('Invite link'), async () => {
          const res = await call('POST', '/api/users/invite', { name: u.name });
          if (res.status === 200) showInviteLink(u.name, res.data.code);
        }),
        document.createTextNode(' '),
        button(u.disabled ? t('Allow again') : t('Suspend'), async () => {
          await call('POST', '/api/users/disable', { name: u.name, disabled: !u.disabled });
          void refreshUsers();
        }),
        document.createTextNode(' '),
        button(t('Delete'), async () => {
          if (!confirm(t('Delete {name}?', { name: u.name }))) return;
          await call('POST', '/api/users/remove', { name: u.name });
          void refreshUsers();
        }, 'btn small ghost'),
      );
    }
    tr.append(actions);
    body.append(tr);
  }
}

$<HTMLButtonElement>('acctUsers').addEventListener('click', () => {
  openMenu(false);
  $<HTMLElement>('usersInvite').hidden = true;
  invited = null;
  usersDialog.showModal();
  void refreshUsers();
});
/** What the owner's window said last about a mistake (a sentence for t()), to say it again when the language changes. */
let usersSaid: string | null = null;
function paintUsersMsg(): void {
  const msg = $<HTMLElement>('usersMsg');
  if (usersSaid) msg.textContent = t(usersSaid);
  msg.hidden = !usersSaid;
}

$<HTMLButtonElement>('usersClose').addEventListener('click', () => usersDialog.close());
$<HTMLFormElement>('usersAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>('usersNewName').value.trim();
  const v = $<HTMLInputElement>('usersNewMinutes').value.trim();
  const r = await call('POST', '/api/users/invite', { name, minutes: v === '' ? null : Number(v) });
  if (r.status !== 200) {
    usersSaid = r.data?.error === 'bad-name' ? N_('A name can use letters, digits, - and _, up to 24 characters.') : N_('Could not create the invitation.');
    paintUsersMsg();
    return;
  }
  usersSaid = null;
  paintUsersMsg();
  $<HTMLInputElement>('usersNewName').value = '';
  showInviteLink(name, r.data.code);
  void refreshUsers();
});

// ---------------------------------------------------------------- start

// Anything that is answered "log in" (a session that ended while the page was open) brings the window back.
const realFetch = window.fetch.bind(window);
window.fetch = async (...args: Parameters<typeof fetch>) => {
  const res = await realFetch(...args);
  if (accountsOn && res.status === 401) {
    void res.clone().json().then((d: { login?: boolean }) => d?.login && showLogin()).catch(() => {});
  }
  return res;
};

// What was written once and kept (the person's role, the time left, the login window's note, the open list) is written again.
onLang(() => {
  paintLogin();
  paintRole();
  paintTime();
  if (usersDialog.open) {
    void refreshUsers();
    if (invited) showInviteLink(invited.name, invited.code);
    paintUsersMsg();
  }
});

void (async () => {
  const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  let r: { status: number; data: any };
  try {
    r = await realFetch('/api/me').then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }));
  } catch {
    return;
  }
  if (!r.data || r.data.accounts !== true) return; // no accounts here: nothing to log in to
  accountsOn = true;
  if (invite) return void startInvite(invite);
  if (r.status === 200) return void showMe(r.data.user as PublicUser, r.data.remainingSeconds ?? null);
  startLogin(!!r.data.needsSetup);
})();
