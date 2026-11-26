// SPDX-License-Identifier: AGPL-3.0-only
//
// The PS5 page: which console, is it ready, the route to it, and the one button that moves things forward.
// Talks to the bridge's /api/ only. Never sees a key: the bridge keeps them.

import { getBridgeToken, setConsoleMac, whyNoApi } from './tester.ts';
import { describeClosed } from './player-logic.ts';
import { save, saved } from './ui.ts';
import { N_, onLang, t } from '../src/i18n/index.ts';
import { detectRoute, PATHS, pathById, STEPS, VERDICTS, type PathId, type RoutePath, type StepId, type Zone } from './routes.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

interface ConsoleInfo {
  mac: string;
  nickname: string;
  target: string;
  host: string;
  registeredAt: string;
  verifiedAt?: string;
  /** The PSN accounts this console is registered for (the bridge keeps one registration per account). */
  profiles?: PsnProfile[];
  /** The one this person plays as. */
  profile?: string;
}
interface PsnProfile {
  id: string;
  label: string;
  hint: string;
}
type Presence = 'checking' | 'ready' | 'standby' | 'absent';
interface ApiReply {
  ok: boolean;
  status: number;
  data: Record<string, any>;
}

async function api(method: string, path: string, body?: unknown): Promise<ApiReply> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getBridgeToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
}

const S = {
  apiOk: false,
  /** The last answer from /api/consoles (null: no answer), to explain why the bridge is not usable. */
  lastApi: null as { status: number; data: Record<string, any> } | null,
  consoles: [] as ConsoleInfo[],
  presence: {} as Record<string, Presence>,
  selected: '',
  /** May this person name the PSN accounts (the owner, or anyone on a bridge without logins)? */
  owner: false,
  /** The PSN account being renamed: `mac/profile`, or '' when none is. */
  renaming: '',
  interfaces: [] as Array<{ address: string; netmask: string }>,
  link: { state: 'idle', detail: '', name: '' },
  busy: false,
  message: '' as string,
  messageKind: '' as '' | 'ok' | 'err',
};

const selectedConsole = (): ConsoleInfo | undefined => S.consoles.find((c) => c.mac === S.selected) ?? S.consoles[0];
/** The name of the console the page is set to connect to, for the bar over the picture. */
export const consoleName = (): string => selectedConsole()?.nickname || 'PS5';

// ------------------------------------------------------------------ loading

async function probe(c: ConsoleInfo): Promise<void> {
  S.presence[c.mac] = 'checking';
  render();
  // A direct question to the console's address: no broadcast.
  const r = await api('GET', `/api/discover?host=${encodeURIComponent(c.host)}`).catch(() => null);
  const h = (r?.data.hosts as Array<{ state: string; id: string }> | undefined)?.find((x) => !x.id || x.id === c.mac) ?? (r?.data.hosts as Array<{ state: string }> | undefined)?.[0];
  S.presence[c.mac] = !h ? 'absent' : h.state === 'ready' ? 'ready' : 'standby';
  render();
}

async function load(): Promise<void> {
  const r = await api('GET', '/api/consoles').catch(() => null);
  S.apiOk = !!r?.ok;
  S.lastApi = r;
  S.consoles = (r?.data.consoles ?? []) as ConsoleInfo[];
  S.owner = r?.data.owner === true;
  if (!S.consoles.some((c) => c.mac === S.selected)) S.selected = S.consoles[0]?.mac ?? '';
  const n = await api('GET', '/api/network').catch(() => null);
  S.interfaces = (n?.data.interfaces ?? []) as Array<{ address: string; netmask: string }>;
  render();
  await Promise.all(S.consoles.map(probe));
  autoConnect();
}

// "Open the page and it connects" (settings, General): once per page load, only when asked for, only from the PS5 page, and only
// when the one button says "Connect" or "Wake and connect" (so never over a stream, never without a registered console).
let autoTried = false;
function autoConnect(): void {
  if (autoTried) return;
  autoTried = true;
  if (saved('gtp.autoconnect') !== '1') return;
  const hash = location.hash.slice(1);
  if (hash === 'lab' || hash === 'settings' || new URLSearchParams(location.search).has('mode')) return;
  if (S.link.state !== 'idle') return;
  const c = cta();
  if (c.disabled || !c.kind || c.kind !== 'primary') return;
  if (c.label === t('Connect') || c.label === t('Wake and connect')) void c.run();
}

// ------------------------------------------------------------------ the one button

type Cta = { label: string; note: string; disabled?: boolean; kind?: 'primary' | 'quiet'; run: () => void | Promise<void> };

function cta(): Cta {
  const c = selectedConsole();
  if (!S.apiOk) return { label: t('Cannot reach the bridge'), note: whyNoApi(S.lastApi), disabled: true, run: () => {} };
  if (!c) return { label: t('Register a console'), note: t('You only do this once. You need the "Link Device" screen on the console and its 8-digit code.'), run: () => $<HTMLDialogElement>('addDialog').showModal() };
  const p = S.presence[c.mac] ?? 'checking';
  if (S.link.state === 'ready' || S.link.state === 'connecting') {
    return { label: t('Disconnect'), note: S.link.state === 'connecting' ? t('Connecting…') : t('Connected'), kind: 'quiet', run: () => $<HTMLButtonElement>('bridgeDisconnect').click() };
  }
  if (p === 'checking') return { label: t('Looking for the console…'), note: '', disabled: true, run: () => {} };
  if (p === 'absent') return { label: t('Search again'), note: t('The PS5 does not answer at that address. Check that it is on and on the same network.'), kind: 'quiet', run: () => probe(c) };
  const connect = (): void => {
    setConsoleMac(c.mac);
    $<HTMLButtonElement>('bridgeConnect').click();
  };
  // In rest mode the bridge wakes the console itself when the connection starts (src/console/wake.ts), so away from
  // home too it is one press: it wakes it, waits until it answers, and connects.
  if (p === 'standby') {
    return {
      label: t('Wake and connect'), kind: 'primary',
      note: t('The PS5 is in rest mode. Pressing this wakes it and then connects. It takes a moment to turn on. "Enable Turning On PS5 from Network" must be on in the PS5 settings.'),
      run: connect,
    };
  }
  // No separate "check" step: connecting is the check, and a session request that is not followed up keeps the console
  // "in use" for half a minute (measured on a real PS5).
  return {
    label: t('Connect'), kind: 'primary',
    note: t('Shows the PS5 screen. Click the screen and the keyboard and mouse go to the PS5 (Esc lets go). There is no sound yet.'),
    run: connect,
  };
}

// ------------------------------------------------------------------ rendering

/** `text` is a sentence for t(). */
const PRESENCE: Record<Presence, { text: string; kind: string }> = {
  checking: { text: N_('Checking'), kind: 'wait' },
  ready: { text: N_('On'), kind: 'on' },
  standby: { text: N_('Rest mode'), kind: 'idle' },
  absent: { text: N_('No answer'), kind: 'off' },
};

/** The zones of a route, for t(). */
const ZONE_NAMES: Record<Zone, string> = { home: N_('At home'), away: N_('Outside'), cloud: N_('Internet') };

function renderConsoles(): void {
  const box = $<HTMLElement>('ps5Consoles');
  box.textContent = '';
  if (S.consoles.length === 0) {
    const empty = el('div', 'empty');
    empty.append(
      el('strong', '', S.apiOk ? t('No PS5 registered') : t('Not connected to the bridge')),
      el('span', '', S.apiOk ? t('Register it once with the button below.') : t('The console list cannot be loaded from this address.')),
    );
    box.append(empty);
    return;
  }
  for (const c of S.consoles) {
    const p = PRESENCE[S.presence[c.mac] ?? 'checking'];
    const b = el('button', 'console');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(c.mac === (selectedConsole()?.mac ?? '')));
    const top = el('span', 'console-top');
    top.append(el('span', 'console-name', c.nickname || 'PS5'), el('span', `chip ${p.kind}`, t(p.text)));
    const meta = el('span', 'console-meta');
    meta.append(el('span', '', `${c.target.toUpperCase().replace('-', ' ')} · ${c.host}`), el('span', `chip ${c.verifiedAt ? 'good' : 'idle'}`, c.verifiedAt ? t('✔ Registration confirmed') : t('Registered only')));
    b.append(top, meta);
    b.addEventListener('click', () => {
      S.selected = c.mac;
      S.message = '';
      render();
    });
    box.append(b);
    if (c.mac === (selectedConsole()?.mac ?? '')) {
      const row = profileRow(c);
      if (row) box.append(row);
    }
  }
}

const profileName = (p: PsnProfile): string => p.label || (p.hint ? t('Account ending in {hint}', { hint: p.hint }) : t('Unnamed account'));

/**
 * Which PSN account this person plays as on the console, when it is registered for more than one. The bridge logs in
 * as that one at the next connection; a stream that is running stays as it is.
 */
function profileRow(c: ConsoleInfo): HTMLElement | null {
  const profiles = c.profiles ?? [];
  if (profiles.length < 2) return null;
  const current = profiles.find((p) => p.id === c.profile) ?? profiles[0]!;
  const row = el('div', 'console-profile');
  const renaming = S.renaming === `${c.mac}/${current.id}`;
  if (renaming) {
    const input = el('input');
    input.type = 'text';
    input.maxLength = 40;
    input.value = current.label;
    input.setAttribute('aria-label', t('Name of this PSN account'));
    const saveName = async (): Promise<void> => {
      const r = await api('POST', '/api/consoles/profile-label', { mac: c.mac, profile: current.id, label: input.value }).catch(() => null);
      S.renaming = '';
      if (r?.ok) {
        c.profiles = r.data.profiles as PsnProfile[];
        S.message = '';
      } else {
        S.message = t('The name could not be saved.');
        S.messageKind = 'err';
      }
      render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void saveName();
      if (e.key === 'Escape') {
        S.renaming = '';
        render();
      }
    });
    const ok = el('button', 'btn small', t('Save'));
    ok.type = 'button';
    ok.addEventListener('click', () => void saveName());
    row.append(input, ok);
    queueMicrotask(() => input.focus());
    return row;
  }
  const label = el('label', 'inline');
  const select = el('select');
  for (const p of profiles) {
    const o = el('option', '', profileName(p));
    o.value = p.id;
    o.selected = p.id === current.id;
    select.append(o);
  }
  // The account is fixed when a connection starts, so it is not offered while one is running.
  select.disabled = S.link.state === 'ready' || S.link.state === 'connecting';
  select.addEventListener('change', async () => {
    const wanted = profiles.find((p) => p.id === select.value);
    if (!wanted) return;
    const r = await api('POST', '/api/consoles/profile', { mac: c.mac, profile: wanted.id }).catch(() => null);
    if (r?.ok) {
      c.profile = wanted.id;
      const name = profileName(wanted);
      S.message = t('You now play as {name}. It applies from the next connection.', { name });
      S.messageKind = 'ok';
    } else {
      S.message = t('The PSN account could not be changed.');
      S.messageKind = 'err';
    }
    render();
  });
  label.append(el('span', '', t('Play as')), select);
  row.append(label);
  if (S.owner) {
    const rename = el('button', 'btn ghost small', t('Rename'));
    rename.type = 'button';
    rename.addEventListener('click', () => {
      S.renaming = `${c.mac}/${current.id}`;
      render();
    });
    row.append(rename);
  }
  return row;
}

type StepState = 'done' | 'now' | 'todo' | 'dev';
function renderSteps(): void {
  const c = selectedConsole();
  const p = c ? S.presence[c.mac] : undefined;
  const steps: Array<[string, StepState]> = [
    [t('Bridge'), S.apiOk ? 'done' : 'now'],
    [t('Console discovery'), !c ? 'todo' : p === 'ready' || p === 'standby' ? 'done' : p === 'absent' ? 'now' : 'todo'],
    [t('Register'), c ? 'done' : S.apiOk ? 'now' : 'todo'],
    [t('Connect'), S.link.state === 'ready' ? 'done' : c && (p === 'ready' || p === 'standby') ? 'now' : 'todo'],
    [t('Picture and input'), S.link.state === 'ready' ? 'done' : 'todo'],
  ];
  const ol = $<HTMLElement>('ps5Steps');
  ol.textContent = '';
  for (const [name, state] of steps) {
    const li = el('li');
    li.dataset.state = state;
    li.append(el('span', 'dot', state === 'done' ? '✔' : state === 'dev' ? '…' : ''), el('span', 'lab', name));
    ol.append(li);
  }
}

function renderCta(): void {
  const c = cta();
  const b = $<HTMLButtonElement>('ps5Cta');
  b.textContent = S.busy ? t('Checking…') : c.label;
  b.disabled = !!c.disabled || S.busy;
  b.className = `btn ${c.kind ?? 'primary'}`;
  b.onclick = () => void c.run();
  // The same button, big, in the middle of the picture: before the stream there is one thing to do and it is there.
  const big = $<HTMLButtonElement>('ps5Cta2');
  const connecting = S.link.state === 'connecting';
  big.textContent = S.busy ? t('Checking…') : connecting ? t('Cancel') : S.link.state === 'closed' && c.label === t('Connect') ? t('Reconnect') : c.label;
  big.disabled = !!c.disabled || S.busy;
  big.className = `btn ${c.kind ?? 'primary'} big`;
  big.onclick = () => void c.run();
  // Before the stream the big button in the picture is the one to press; this one is for ending it.
  const streaming = S.link.state === 'ready' || connecting;
  b.hidden = !streaming;
  $<HTMLElement>('ps5CtaNote').hidden = !streaming;
  $<HTMLElement>('ps5CtaNote').textContent = c.note;
  const m = $<HTMLElement>('ps5Msg');
  m.textContent = S.message;
  m.dataset.kind = S.messageKind;
  m.hidden = !S.message;
}

/** One route as nodes joined by links. `step` decides what the links say and how they are coloured. */
export function drawRoute(box: HTMLElement, path: RoutePath, step: StepId, vertical = false): void {
  box.textContent = '';
  box.classList.add('route');
  box.classList.toggle('vertical', vertical);
  const st = path.steps[step];
  path.nodes.forEach((n, i) => {
    const d = el('div', `node${n.ps5 ? ' ps5' : ''}`);
    d.dataset.zone = n.zone;
    d.append(el('span', 'zone', t(ZONE_NAMES[n.zone])), el('span', 'ttl', t(n.title)), el('span', 'sub', t(n.sub)));
    box.append(d);
    if (i < path.nodes.length - 1) {
      const l = el('div', 'link');
      l.dataset.v = st.v;
      const label = st.labels[i];
      l.append(el('span', 'lab', label ? t(label) : ''), el('span', 'wire'), el('span', 'mark', VERDICTS[st.v].symbol));
      box.append(l);
    }
  });
}

function currentGuess(): { id: PathId; reason: string } {
  return detectRoute({ pageHost: location.hostname, ...(selectedConsole()?.host ? { consoleHost: selectedConsole()!.host } : {}), interfaces: S.interfaces });
}

function renderRouteCard(): void {
  const g = currentGuess();
  const path = pathById(g.id);
  $<HTMLElement>('routeName').textContent = t(path.name);
  $<HTMLElement>('routeReason').textContent = t('{reason} (this is a guess)', { reason: g.reason });
  drawRoute($<HTMLElement>('routeDiagram'), path, 'session', true); // the card is narrow: top to bottom
  $<HTMLElement>('routeStatus').textContent = t(path.status);
}

/** What the middle of the picture says before the stream, while it starts, and after it ends. */
function renderStage(): void {
  const live = S.link.state === 'ready';
  const overlay = $<HTMLElement>('ps5Overlay');
  overlay.hidden = live;
  const c = selectedConsole();
  const state = S.link.state === 'connecting' ? 'connecting' : S.link.state === 'closed' ? 'closed' : 'idle';
  overlay.dataset.state = state;
  const presence = c ? PRESENCE[S.presence[c.mac] ?? 'checking'] : null;
  $<HTMLElement>('heroTitle').textContent = !S.apiOk ? t('Not connected to the server') : !c ? t('Register your PS5') : state === 'connecting' ? t('Connecting to {name}', { name: c.nickname || 'PS5' }) : state === 'closed' ? t('The connection has ended') : c.nickname || 'PS5';
  $<HTMLElement>('heroSub').textContent =
    state === 'connecting' ? (S.link.detail.startsWith('connecting: ') ? S.link.detail.slice(12) : t('Please wait…'))
    : state === 'closed' ? describeClosed(S.link.detail)
    : c && presence ? `${t(presence.text)} · ${c.target.toUpperCase().replace('-', ' ')}`
    : '';
  $<HTMLElement>('heroNote').textContent = state === 'idle' ? cta().note : state === 'connecting' ? t('If it is in rest mode, waking it takes 10 to 20 seconds.') : '';
  $<HTMLElement>('ps5Badge').textContent = S.link.name === 'core' ? 'gtp-core' : t('Real PS5');
}

function render(): void {
  renderConsoles();
  renderSteps();
  renderCta();
  renderRouteCard();
  renderStage();
}

// ------------------------------------------------------------------ the full map of routes

const EX = { path: 'bridge' as PathId, step: 'session' as StepId };

export function renderExplorer(): void {
  const root = $<HTMLElement>('routeExplorer');
  root.textContent = '';
  const layout = el('div', 'explorer');
  const picker = el('nav', 'picker');
  picker.setAttribute('aria-label', t('Connection routes'));
  for (const p of PATHS) {
    const b = el('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(p.id === EX.path));
    b.append(el('span', 'tag', t(p.tag)), el('span', 'name', t(p.name)), el('small', '', t(p.sub)));
    b.addEventListener('click', () => {
      EX.path = p.id;
      renderExplorer();
    });
    picker.append(b);
  }
  const main = el('div', 'explorer-main');
  const tabs = el('div', 'tabs');
  for (const s of STEPS) {
    const b = el('button', '', t(s.title));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(s.id === EX.step));
    b.addEventListener('click', () => {
      EX.step = s.id;
      renderExplorer();
    });
    tabs.append(b);
  }
  const path = pathById(EX.path);
  const st = path.steps[EX.step];
  const diagram = el('div');
  drawRoute(diagram, path, EX.step);
  const verdict = el('div', 'verdict');
  const pill = el('span', 'pill', `${VERDICTS[st.v].symbol} ${t(VERDICTS[st.v].title)}`);
  pill.dataset.v = st.v;
  verdict.append(pill, el('span', 'proto', t(st.proto)));
  const facts = el('div', 'facts');
  for (const [heading, text] of [[t('What it needs'), path.needs], [t('Watch out'), path.watch], [t('Status in this project'), path.status]] as const) {
    const d = el('div');
    d.append(el('h3', '', heading), el('p', '', t(text)));
    facts.append(d);
  }
  main.append(tabs, diagram, verdict, el('p', 'note', t(st.note)), facts, matrix());
  layout.append(picker, main);
  root.append(layout);
}

function matrix(): HTMLElement {
  const wrap = el('div', 'matrixwrap');
  const table = el('table');
  const head = el('tr');
  head.append(el('th'));
  for (const s of STEPS) head.append(el('th', '', t(s.title)));
  table.append(head);
  for (const p of PATHS) {
    const tr = el('tr');
    const rh = el('th', 'rowh', t(p.name));
    rh.scope = 'row';
    tr.append(rh);
    for (const s of STEPS) {
      const v = p.steps[s.id].v;
      const td = el('td');
      const b = el('button', '', `${VERDICTS[v].symbol} ${t(VERDICTS[v].short)}`);
      b.type = 'button';
      b.dataset.v = v;
      b.title = `${t(p.name)} · ${t(s.title)}: ${t(VERDICTS[v].title)}`;
      if (p.id === EX.path && s.id === EX.step) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => {
        EX.path = p.id;
        EX.step = s.id;
        renderExplorer();
      });
      td.append(b);
      tr.append(td);
    }
    table.append(tr);
  }
  wrap.append(table);
  const legend = el('div', 'legend');
  for (const v of Object.values(VERDICTS)) legend.append(el('span', '', `${v.symbol} ${t(v.title)}`));
  wrap.append(legend);
  return wrap;
}

// ------------------------------------------------------------------ wiring

{
  const box = $<HTMLInputElement>('autoConnect');
  box.checked = saved('gtp.autoconnect') === '1';
  box.addEventListener('change', () => save('gtp.autoconnect', box.checked ? '1' : '0'));
}
$<HTMLButtonElement>('ps5Refresh').addEventListener('click', () => void load());
$<HTMLButtonElement>('addConsole').addEventListener('click', () => $<HTMLDialogElement>('addDialog').showModal());
for (const id of ['addClose', 'addClose2']) $<HTMLButtonElement>(id).addEventListener('click', () => $<HTMLDialogElement>('addDialog').close());
$<HTMLButtonElement>('routeMore').addEventListener('click', () => {
  EX.path = currentGuess().id;
  renderExplorer();
  $<HTMLDialogElement>('routeDialog').showModal();
});
$<HTMLButtonElement>('routeClose').addEventListener('click', () => $<HTMLDialogElement>('routeDialog').close());
document.addEventListener('gtp:link', (e) => {
  const d = (e as CustomEvent<{ state: string; detail: string; link: string }>).detail;
  S.link = { state: d.state, detail: d.detail, name: d.link };
  render();
});
document.addEventListener('gtp:consoles', () => {
  void load();
  // After a successful registration the form has said so; give the person a moment to read it, then close it.
  if ($<HTMLDialogElement>('addDialog').open && $<HTMLElement>('regMsg').dataset.kind === 'ok') setTimeout(() => $<HTMLDialogElement>('addDialog').close(), 1600);
});
document.addEventListener('gtp:open-add', () => $<HTMLDialogElement>('addDialog').showModal());
document.addEventListener('gtp:open-routes', () => {
  renderExplorer();
  $<HTMLDialogElement>('routeDialog').showModal();
});

// The words on this page are drawn from the state each time, so drawing again is all it takes (and the map of routes, if it is open).
onLang(() => {
  render();
  if ($<HTMLDialogElement>('routeDialog').open) renderExplorer();
});

render();
void load();
