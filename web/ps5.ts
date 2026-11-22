// SPDX-License-Identifier: AGPL-3.0-only
//
// The PS5 page: which console, is it ready, the route to it, and the one button that moves things forward.
// Talks to the bridge's /api/ only. Never sees a key: the bridge keeps them.

import { getBridgeToken, setConsoleMac, whyNoApi } from './tester.ts';
import { detectRoute, PATHS, pathById, STEPS, VERDICTS, type PathId, type RoutePath, type StepId } from './routes.ts';

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
  interfaces: [] as Array<{ address: string; netmask: string }>,
  link: { state: 'idle', detail: '', name: '' },
  busy: false,
  message: '' as string,
  messageKind: '' as '' | 'ok' | 'err',
};

const selectedConsole = (): ConsoleInfo | undefined => S.consoles.find((c) => c.mac === S.selected) ?? S.consoles[0];

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
  if (!S.consoles.some((c) => c.mac === S.selected)) S.selected = S.consoles[0]?.mac ?? '';
  const n = await api('GET', '/api/network').catch(() => null);
  S.interfaces = (n?.data.interfaces ?? []) as Array<{ address: string; netmask: string }>;
  render();
  await Promise.all(S.consoles.map(probe));
}

// ------------------------------------------------------------------ the one button

type Cta = { label: string; note: string; disabled?: boolean; kind?: 'primary' | 'quiet'; run: () => void | Promise<void> };

function cta(): Cta {
  const c = selectedConsole();
  if (!S.apiOk) return { label: '브리지에 연결할 수 없음', note: whyNoApi(S.lastApi), disabled: true, run: () => {} };
  if (!c) return { label: '콘솔 등록하기', note: '처음 한 번만 합니다. 콘솔의 기기 연결 화면과 8자리 코드가 필요합니다.', run: () => $<HTMLDialogElement>('addDialog').showModal() };
  const p = S.presence[c.mac] ?? 'checking';
  if (S.link.state === 'ready' || S.link.state === 'connecting') {
    return { label: '연결 끊기', note: S.link.state === 'connecting' ? '연결하는 중…' : '연결됨', kind: 'quiet', run: () => $<HTMLButtonElement>('bridgeDisconnect').click() };
  }
  if (p === 'checking') return { label: '콘솔을 찾는 중…', note: '', disabled: true, run: () => {} };
  if (p === 'absent') return { label: '다시 찾기', note: '그 주소에서 PS5가 응답하지 않습니다. 켜져 있는지, 같은 네트워크인지 확인하세요.', kind: 'quiet', run: () => probe(c) };
  const connect = (): void => {
    setConsoleMac(c.mac);
    $<HTMLButtonElement>('bridgeConnect').click();
  };
  // In rest mode the bridge wakes the console itself when the connection starts (src/console/wake.ts), so away from
  // home too it is one press: it wakes it, waits until it answers, and connects.
  if (p === 'standby') {
    return {
      label: '깨우고 연결', kind: 'primary',
      note: 'PS5가 대기 모드입니다. 누르면 깨운 뒤 연결합니다. 켜지는 데 잠시 걸립니다. PS5 설정의 "네트워크에서 PS5 켜기"가 켜져 있어야 합니다.',
      run: connect,
    };
  }
  // No separate "check" step: connecting is the check, and a session request that is not followed up keeps the console
  // "in use" for half a minute (measured on a real PS5).
  return {
    label: '연결', kind: 'primary',
    note: 'PS5 화면을 띄웁니다. 화면을 클릭하면 키보드와 마우스가 PS5로 전달됩니다 (Esc로 해제). 음성은 아직 없습니다.',
    run: connect,
  };
}

// ------------------------------------------------------------------ rendering

const PRESENCE: Record<Presence, { text: string; kind: string }> = {
  checking: { text: '확인 중', kind: 'wait' },
  ready: { text: '켜짐', kind: 'on' },
  standby: { text: '대기 모드', kind: 'idle' },
  absent: { text: '응답 없음', kind: 'off' },
};

function renderConsoles(): void {
  const box = $<HTMLElement>('ps5Consoles');
  box.textContent = '';
  if (S.consoles.length === 0) {
    const empty = el('div', 'empty');
    empty.append(
      el('strong', '', S.apiOk ? '등록된 PS5가 없습니다' : '브리지에 연결되지 않았습니다'),
      el('span', '', S.apiOk ? '아래 버튼으로 한 번만 등록하면 됩니다.' : '이 주소에서는 콘솔 목록을 가져올 수 없습니다.'),
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
    top.append(el('span', 'console-name', c.nickname || 'PS5'), el('span', `chip ${p.kind}`, p.text));
    const meta = el('span', 'console-meta');
    meta.append(el('span', '', `${c.target.toUpperCase().replace('-', ' ')} · ${c.host}`), el('span', `chip ${c.verifiedAt ? 'good' : 'idle'}`, c.verifiedAt ? '✔ 등록 확인됨' : '등록만 됨'));
    b.append(top, meta);
    b.addEventListener('click', () => {
      S.selected = c.mac;
      S.message = '';
      render();
    });
    box.append(b);
  }
}

type StepState = 'done' | 'now' | 'todo' | 'dev';
function renderSteps(): void {
  const c = selectedConsole();
  const p = c ? S.presence[c.mac] : undefined;
  const steps: Array<[string, StepState]> = [
    ['브리지', S.apiOk ? 'done' : 'now'],
    ['콘솔 발견', !c ? 'todo' : p === 'ready' || p === 'standby' ? 'done' : p === 'absent' ? 'now' : 'todo'],
    ['등록', c ? 'done' : S.apiOk ? 'now' : 'todo'],
    ['연결', S.link.state === 'ready' ? 'done' : c && (p === 'ready' || p === 'standby') ? 'now' : 'todo'],
    ['화면·입력', S.link.state === 'ready' ? 'done' : 'todo'],
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
  b.textContent = S.busy ? '확인하는 중…' : c.label;
  b.disabled = !!c.disabled || S.busy;
  b.className = `btn ${c.kind ?? 'primary'}`;
  b.onclick = () => void c.run();
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
    d.append(el('span', 'zone', n.zone === 'home' ? '집' : n.zone === 'away' ? '밖' : '인터넷'), el('span', 'ttl', n.title), el('span', 'sub', n.sub));
    box.append(d);
    if (i < path.nodes.length - 1) {
      const l = el('div', 'link');
      l.dataset.v = st.v;
      l.append(el('span', 'lab', st.labels[i] ?? ''), el('span', 'wire'), el('span', 'mark', VERDICTS[st.v].symbol));
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
  $<HTMLElement>('routeName').textContent = path.name;
  $<HTMLElement>('routeReason').textContent = `${g.reason} (추정입니다)`;
  drawRoute($<HTMLElement>('routeDiagram'), path, 'session', true); // the card is narrow: top to bottom
  $<HTMLElement>('routeStatus').textContent = path.status;
}

function renderStage(): void {
  const live = S.link.state === 'ready';
  $<HTMLElement>('ps5Overlay').hidden = live;
  $<HTMLElement>('ps5OverlayText').textContent =
    S.link.state === 'connecting' ? (S.link.detail.startsWith('connecting: ') ? S.link.detail.slice(12) : '연결하는 중…') : S.link.state === 'closed' ? `끊어짐${S.link.detail ? ` · ${S.link.detail}` : ''}` : '연결하면 여기에 화면이 나옵니다';
  $<HTMLElement>('ps5Badge').textContent = S.link.name === 'core' ? 'gtp-core' : '실제 PS5';
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
  picker.setAttribute('aria-label', '접속 경로');
  for (const p of PATHS) {
    const b = el('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(p.id === EX.path));
    b.append(el('span', 'tag', p.tag), el('span', 'name', p.name), el('small', '', p.sub));
    b.addEventListener('click', () => {
      EX.path = p.id;
      renderExplorer();
    });
    picker.append(b);
  }
  const main = el('div', 'explorer-main');
  const tabs = el('div', 'tabs');
  for (const s of STEPS) {
    const b = el('button', '', s.title);
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
  const pill = el('span', 'pill', `${VERDICTS[st.v].symbol} ${VERDICTS[st.v].title}`);
  pill.dataset.v = st.v;
  verdict.append(pill, el('span', 'proto', st.proto));
  const facts = el('div', 'facts');
  for (const [h, t] of [['필요한 것', path.needs], ['주의', path.watch], ['이 프로젝트 상태', path.status]] as const) {
    const d = el('div');
    d.append(el('h3', '', h), el('p', '', t));
    facts.append(d);
  }
  main.append(tabs, diagram, verdict, el('p', 'note', st.note), facts, matrix());
  layout.append(picker, main);
  root.append(layout);
}

function matrix(): HTMLElement {
  const wrap = el('div', 'matrixwrap');
  const t = el('table');
  const head = el('tr');
  head.append(el('th'));
  for (const s of STEPS) head.append(el('th', '', s.title));
  t.append(head);
  for (const p of PATHS) {
    const tr = el('tr');
    const rh = el('th', 'rowh', p.name);
    rh.scope = 'row';
    tr.append(rh);
    for (const s of STEPS) {
      const v = p.steps[s.id].v;
      const td = el('td');
      const b = el('button', '', `${VERDICTS[v].symbol} ${VERDICTS[v].short}`);
      b.type = 'button';
      b.dataset.v = v;
      b.title = `${p.name} · ${s.title}: ${VERDICTS[v].title}`;
      if (p.id === EX.path && s.id === EX.step) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => {
        EX.path = p.id;
        EX.step = s.id;
        renderExplorer();
      });
      td.append(b);
      tr.append(td);
    }
    t.append(tr);
  }
  wrap.append(t);
  const legend = el('div', 'legend');
  for (const v of Object.values(VERDICTS)) legend.append(el('span', '', `${v.symbol} ${v.title}`));
  wrap.append(legend);
  return wrap;
}

// ------------------------------------------------------------------ wiring

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

render();
void load();
