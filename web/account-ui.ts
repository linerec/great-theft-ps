// SPDX-License-Identifier: AGPL-3.0-only
//
// Logging in (see src/bridge/accounts.ts), the time left today, and the owner's list of people.
//
// On a bridge without accounts this does nothing. On one with accounts the page cannot be used before logging in: a
// window the person cannot close asks for name and password (or, from an invitation link, for a new password).
// What a person sees afterwards: their name, the time left today (counted down here between the bridge's messages),
// log out, and for the owner a window to invite people and set their minutes per day.

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
export function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** What a person is told about minutes: "제한 없음" or "하루 90분". */
export const describeLimit = (minutes: number | null): string => (minutes === null ? '제한 없음' : `하루 ${minutes}분`);

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

function say(text: string, kind: 'err' | 'ok' = 'err'): void {
  const el = $<HTMLElement>('loginMsg');
  el.textContent = text;
  el.hidden = !text;
  el.dataset.kind = kind;
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
  $('loginTitle').textContent = '비밀번호 정하기';
  $('loginNameRow').hidden = true;
  $('loginPass2Row').hidden = false;
  $<HTMLInputElement>('loginPass').autocomplete = 'new-password';
  $<HTMLButtonElement>('loginGo').textContent = '비밀번호 저장하고 시작';
  if (info.status === 200) {
    $('loginNote').textContent = `${info.data.name} 님, 이 기기에서 쓸 비밀번호를 정하세요 (8자 이상).`;
  } else {
    $('loginNote').textContent = '이 초대 링크는 더 이상 쓸 수 없습니다. 링크는 한 번만, 48시간 안에 쓸 수 있습니다. 새 링크를 받으세요.';
    $<HTMLButtonElement>('loginGo').disabled = true;
  }
  showLogin();
}

function startLogin(needsSetup: boolean): void {
  loginMode = 'login';
  $('loginTitle').textContent = '로그인';
  $('loginNote').textContent = needsSetup ? '아직 아무도 등록되지 않았습니다. 서버를 처음 켤 때 출력된 초대 링크로 들어와 주인 비밀번호를 정하세요.' : '';
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
      if (password !== $<HTMLInputElement>('loginPass2').value) return say('두 번 입력한 비밀번호가 다릅니다.');
      const r = await call('POST', '/api/accept-invite', { code: inviteCode, password });
      if (r.status !== 200) return say(r.data?.error === 'bad-password' ? '비밀번호는 8자 이상이어야 합니다.' : '이 초대 링크는 더 이상 쓸 수 없습니다.');
      history.replaceState(null, '', location.pathname + location.search);
    } else {
      const r = await call('POST', '/api/login', { name: $<HTMLInputElement>('loginName').value.trim(), password });
      if (r.status === 429) return say(`시도가 너무 많습니다. ${r.data?.retryAfterSeconds ?? 30}초 뒤에 다시 하세요.`);
      if (r.status !== 200) return say('이름이나 비밀번호가 맞지 않습니다.');
    }
    location.reload();
  } catch {
    say('서버에 연결하지 못했습니다.');
  } finally {
    $<HTMLInputElement>('loginPass').value = '';
    $<HTMLInputElement>('loginPass2').value = '';
    button.disabled = false;
  }
});

// ---------------------------------------------------------------- who is logged in, and the time left

let remaining: number | null = null;
let remainingAt = 0;

function paintTime(): void {
  const el = $<HTMLElement>('acctTime');
  if (!me) return;
  if (remaining === null) {
    el.textContent = describeLimit(me.dailyMinutes);
    el.className = 'chip';
    return;
  }
  const left = remaining - (Date.now() - remainingAt) / 1000;
  el.textContent = `오늘 남은 시간 ${formatRemaining(left)}`;
  el.className = left <= 60 ? 'chip off' : left <= 300 ? 'chip wait' : 'chip good';
}

function setRemaining(seconds: number | null): void {
  remaining = seconds;
  remainingAt = Date.now();
  paintTime();
}

function showMe(user: PublicUser, remainingSeconds: number | null): void {
  me = user;
  $('acct').hidden = false;
  $('acctName').textContent = user.role === 'owner' ? `${user.name} (주인)` : user.name;
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

function showInviteLink(name: string, code: string): void {
  const url = `${location.origin}/#invite=${code}`;
  const box = $<HTMLElement>('usersInvite');
  box.hidden = false;
  box.replaceChildren();
  const p = document.createElement('p');
  p.textContent = `${name} 님에게 이 링크를 보내세요. 한 번만, 48시간 안에 쓸 수 있고, 열면 비밀번호를 직접 정합니다.`;
  const input = document.createElement('input');
  input.type = 'text';
  input.readOnly = true;
  input.value = url;
  input.addEventListener('focus', () => input.select());
  const copy = button('복사', () => void navigator.clipboard?.writeText(url).then(() => (copy.textContent = '복사했습니다')));
  box.append(p, input, copy);
}

async function refreshUsers(): Promise<void> {
  const r = await call('GET', '/api/users');
  const body = $<HTMLTableSectionElement>('usersBody');
  body.replaceChildren();
  if (r.status !== 200) return void (body.append(cell('목록을 불러오지 못했습니다.')));
  for (const u of r.data.users as PublicUser[]) {
    const tr = document.createElement('tr');
    tr.append(cell(u.role === 'owner' ? `${u.name} (주인)` : u.name));
    const minutes = document.createElement('td');
    if (u.role === 'owner') {
      minutes.textContent = '제한 없음';
    } else {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '1440';
      input.step = '5';
      input.value = u.dailyMinutes === null ? '' : String(u.dailyMinutes);
      input.placeholder = '제한 없음';
      input.setAttribute('aria-label', `${u.name} 하루 사용 시간(분)`);
      const save = button('저장', async () => {
        const v = input.value.trim();
        const res = await call('POST', '/api/users/minutes', { name: u.name, minutes: v === '' ? null : Number(v) });
        save.textContent = res.status === 200 ? '저장했습니다' : '실패';
        setTimeout(() => void refreshUsers(), 900);
      });
      minutes.append(input, document.createTextNode(' 분 '), save);
    }
    tr.append(minutes);
    tr.append(cell(u.usedSecondsToday > 0 ? `${Math.round(u.usedSecondsToday / 60)}분` : '-'));
    tr.append(cell(u.disabled ? '정지됨' : u.active ? '사용 중' : '초대 대기', u.disabled ? 'bad' : ''));
    const actions = document.createElement('td');
    if (u.role !== 'owner') {
      actions.append(
        button('초대 링크', async () => {
          const res = await call('POST', '/api/users/invite', { name: u.name });
          if (res.status === 200) showInviteLink(u.name, res.data.code);
        }),
        document.createTextNode(' '),
        button(u.disabled ? '다시 허용' : '정지', async () => {
          await call('POST', '/api/users/disable', { name: u.name, disabled: !u.disabled });
          void refreshUsers();
        }),
        document.createTextNode(' '),
        button('삭제', async () => {
          if (!confirm(`${u.name} 님을 삭제할까요?`)) return;
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
  $<HTMLElement>('usersInvite').hidden = true;
  usersDialog.showModal();
  void refreshUsers();
});
$<HTMLButtonElement>('usersClose').addEventListener('click', () => usersDialog.close());
$<HTMLFormElement>('usersAdd').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>('usersNewName').value.trim();
  const v = $<HTMLInputElement>('usersNewMinutes').value.trim();
  const r = await call('POST', '/api/users/invite', { name, minutes: v === '' ? null : Number(v) });
  const msg = $<HTMLElement>('usersMsg');
  if (r.status !== 200) {
    msg.textContent = r.data?.error === 'bad-name' ? '이름은 글자·숫자·-·_ 로 24자까지입니다.' : '초대하지 못했습니다.';
    msg.hidden = false;
    return;
  }
  msg.hidden = true;
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
