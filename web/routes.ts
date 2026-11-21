// SPDX-License-Identifier: AGPL-3.0-only
//
// The ways a client can reach a PS5, and what works on each. Pure data and logic (no DOM), so it can be tested.
// Ports and order come from chiaki-ng (commit 43728af). "확인됨" (ok) means seen on a real console in this project;
// "코드 있음" (likely) means written and tested against a simulator and the reference's vectors only.

export type PathId = 'lan' | 'bridge' | 'vlan' | 'vpn' | 'rbridge' | 'psn' | 'fwd';
export type StepId = 'discover' | 'wake' | 'register' | 'session' | 'stream';
export type Verdict = 'ok' | 'likely' | 'direct' | 'plan' | 'no';
export type Zone = 'home' | 'away' | 'cloud';

export interface RouteNode {
  zone: Zone;
  title: string;
  sub: string;
  ps5?: boolean;
}
export interface StepInfo {
  v: Verdict;
  /** Protocol and port on this path, for this step. */
  proto: string;
  /** What flows over each link, one entry per link. */
  labels: string[];
  note: string;
}
export interface RoutePath {
  id: PathId;
  name: string;
  sub: string;
  tag: string;
  nodes: RouteNode[];
  steps: Record<StepId, StepInfo>;
  needs: string;
  watch: string;
  status: string;
}

export const STEPS: Array<{ id: StepId; title: string }> = [
  { id: 'discover', title: '발견' },
  { id: 'wake', title: '깨우기' },
  { id: 'register', title: '등록' },
  { id: 'session', title: '세션 시작' },
  { id: 'stream', title: '영상·입력' },
];

export const VERDICTS: Record<Verdict, { symbol: string; title: string; short: string }> = {
  ok: { symbol: '✔', title: '확인됨', short: '확인됨' },
  likely: { symbol: '◐', title: '코드 있음 · 실기 미확인', short: '코드 있음' },
  direct: { symbol: '△', title: '조건부', short: '조건부' },
  plan: { symbol: '○', title: '미구현', short: '미구현' },
  no: { symbol: '✕', title: '비권장 · 불가', short: '불가' },
};

const PS5: RouteNode = { zone: 'home', title: 'PS5', sub: '켜짐 또는 대기', ps5: true };

export const PATHS: RoutePath[] = [
  {
    id: 'lan', name: '집 안 · 같은 네트워크', sub: '기기 → 공유기 → PS5', tag: '가장 단순',
    nodes: [{ zone: 'home', title: '이 PC · 맥', sub: '같은 Wi‑Fi' }, { zone: 'home', title: '공유기', sub: '192.168.1.x' }, PS5],
    steps: {
      discover: { v: 'ok', proto: 'UDP 브로드캐스트 · 9302', labels: ['SRCH 브로드캐스트', '응답: 상태·이름·ID'], note: '맥에서 실제 PS5가 응답했습니다(대기 모드). 같은 대역이면 주소를 몰라도 찾습니다.' },
      wake: { v: 'likely', proto: 'UDP 9302 · WAKEUP + 등록 키', labels: ['WAKEUP', '대기 → 켜짐'], note: '함수는 있지만 실제 PS5로는 아직 시험하지 않았습니다.' },
      register: { v: 'likely', proto: 'UDP 검색 + TCP 9295 · 8자리 코드', labels: ['검색 + 등록 요청', '키 응답(암호화)'], note: '한 번만 하면 됩니다. 결과는 컴퓨터에 저장됩니다.' },
      session: { v: 'likely', proto: 'TCP 9295 · /sie/ps5/rp/sess/init', labels: ['init + 등록 키', 'nonce 응답'], note: '“연결 확인” 버튼이 이 요청을 실제 PS5로 보냅니다.' },
      stream: { v: 'plan', proto: 'UDP 9296 Takion · 9297 RTT·MTU', labels: ['입력 8~200ms', '영상 · 음성'], note: '아직 만들지 않았습니다. 제어 연결, 전송 계층, 영상 수신 순서로 진행합니다.' },
    },
    needs: 'PC와 PS5가 같은 공유기(같은 대역). PS5에서 원격 플레이 켜기.',
    watch: '공유기의 “클라이언트 격리”가 켜져 있으면 어떤 방법도 막힙니다.',
    status: '발견은 실제 PS5로 확인. 등록과 세션 요청은 작성 끝. 영상은 아직.',
  },
  {
    id: 'bridge', name: '집 안 · 브라우저 + 브리지', sub: '브라우저 → 브리지 → PS5', tag: '지금 쓰는 구조',
    nodes: [{ zone: 'home', title: '브라우저', sub: '맥 · 이 PC · 폰' }, { zone: 'home', title: '브리지', sub: 'Node, 집의 맥' }, PS5],
    steps: {
      discover: { v: 'ok', proto: 'HTTP /api/discover → UDP 9302', labels: ['“콘솔 찾기”', 'UDP 브로드캐스트'], note: '브라우저는 UDP를 못 열어서, 브리지가 대신 찾아 줍니다.' },
      wake: { v: 'likely', proto: '브리지 → UDP 9302 WAKEUP', labels: ['(버튼 예정)', 'WAKEUP'], note: '깨우기 함수는 있고 화면 버튼은 아직 없습니다.' },
      register: { v: 'likely', proto: 'HTTP /api/register → TCP 9295', labels: ['코드 · 계정 ID 입력', '등록 요청'], note: '키는 브리지가 있는 컴퓨터에만 저장되고 브라우저로 오지 않습니다.' },
      session: { v: 'likely', proto: 'HTTP /api/session-check → TCP 9295', labels: ['연결 확인', '세션 요청'], note: '브리지가 저장된 키로 세션을 요청합니다. 연결 단계와 이어 붙이는 일은 아직입니다.' },
      stream: { v: 'plan', proto: 'WebSocket(TCP) ↔ UDP 9296', labels: ['영상 · 입력(TCP)', 'Takion UDP'], note: '영상 수신은 아직 구현 중입니다. WebSocket은 TCP라 손실 시 지연이 커서, 나중에 WebRTC를 계획합니다.' },
    },
    needs: '집의 컴퓨터에서 npm run bridge. 같은 컴퓨터의 브라우저는 토큰 없이, 다른 기기는 --host와 토큰.',
    watch: '브라우저와 브리지 사이는 TCP입니다. 지연은 화면의 “입력→화면 지연”으로 잽니다.',
    status: '맥 브리지에서 등록 폼과 계정 ID 가져오기를 쓸 수 있음. 실제 영상은 아직.',
  },
  {
    id: 'vlan', name: '집 안 · 다른 대역 / 게스트', sub: 'IoT·게스트 망 → 라우터 → PS5', tag: '조건부',
    nodes: [{ zone: 'home', title: '기기', sub: '게스트 · IoT 대역' }, { zone: 'home', title: '대역 경계', sub: '라우터 · 방화벽' }, PS5],
    steps: {
      discover: { v: 'direct', proto: 'UDP 9302 · PS5 주소로 직접', labels: ['✕ 브로드캐스트', '직접 질의'], note: '브로드캐스트는 대역을 넘지 못합니다. PS5의 IP를 알면 discover --host IP로 직접 묻습니다.' },
      wake: { v: 'direct', proto: 'UDP 9302 · 직접 전송', labels: ['WAKEUP 직접', '대기 → 켜짐'], note: '라우터가 UDP 9302를 통과시켜야 합니다.' },
      register: { v: 'direct', proto: 'UDP·TCP 9295 · 직접', labels: ['검색 + 요청', '응답'], note: 'PS5 주소로 직접 보냅니다. 라우터가 9295를 통과시켜야 합니다.' },
      session: { v: 'direct', proto: 'TCP 9295 · 직접', labels: ['init', 'nonce'], note: '등록 정보는 대역과 상관없이 그대로 씁니다.' },
      stream: { v: 'direct', proto: 'UDP 9296 · 양방향 통과', labels: ['입력', '영상'], note: 'UDP 9296이 양방향으로 통과해야 합니다. 게스트 Wi‑Fi의 AP 격리는 완전히 막습니다.' },
    },
    needs: 'PS5의 IP 주소. 라우터가 UDP·TCP 9295, UDP 9296, 9297, 9302를 통과.',
    watch: 'AP 격리나 클라이언트 격리가 켜져 있으면 어떤 경로도 안 됩니다. 그때는 PC를 PS5와 같은 대역에 두세요.',
    status: 'discover에 --host 옵션이 있음. 나머지는 첫 번째 경로와 같은 코드.',
  },
  {
    id: 'vpn', name: '밖 · VPN으로 집 안에 들어가기', sub: '밖의 기기 → VPN → 집 → PS5', tag: '다음 후보',
    nodes: [{ zone: 'away', title: '밖의 기기', sub: '카페 · 회사 · 이동 중' }, { zone: 'cloud', title: 'VPN 터널', sub: 'Tailscale · WireGuard' }, { zone: 'home', title: '집의 맥', sub: 'VPN 노드 · 서브넷 라우터' }, PS5],
    steps: {
      discover: { v: 'direct', proto: 'UDP 9302 · 집 LAN 주소로 직접', labels: ['✕ 브로드캐스트', 'VPN 터널', '직접 질의'], note: '브로드캐스트는 터널을 못 넘습니다. PS5의 집 IP(192.168.1.x)로 직접 묻습니다.' },
      wake: { v: 'direct', proto: 'UDP 9302 · 터널 통과', labels: ['WAKEUP', '터널', '대기 → 켜짐'], note: '집에서 등록해 둔 키로 밖에서도 깨울 수 있는 길입니다. 실기 확인 전.' },
      register: { v: 'direct', proto: 'UDP·TCP 9295 · 터널 통과', labels: ['등록 요청', '터널', '키 응답'], note: '등록은 집에서 한 번만 하세요. 저장한 정보를 옮겨 쓰면 밖에서 다시 할 일이 없습니다.' },
      session: { v: 'direct', proto: 'TCP 9295 · 터널 통과', labels: ['init', '터널', 'nonce'], note: '집 LAN과 똑같은 요청이 터널을 지나갑니다.' },
      stream: { v: 'direct', proto: 'UDP 9296 · 터널 통과', labels: ['입력', '터널', '영상'], note: '터널 지연과 오버헤드(MTU) 때문에 화질을 낮춰야 할 수 있습니다. 낮은 대역폭 프리셋이 필요한 곳입니다.' },
    },
    needs: '맥과 밖의 기기가 같은 VPN. 맥이 집 대역을 알려 주거나 프로토콜 클라이언트가 맥에서 돕니다. 브라우저만으로는 PS5에 UDP를 못 엽니다.',
    watch: '터널 지연과 MTU로 끊길 수 있습니다. 브로드캐스트 발견은 안 되니 PS5 IP를 고정해 두세요.',
    status: '이 PC와 맥 모두 Tailscale 어댑터가 보임(같은 tailnet이면 후보). 서브넷 설정은 아직 안 해봄.',
  },
  {
    id: 'rbridge', name: '밖 · 집의 브리지에 브라우저로', sub: '밖의 브라우저 → 집의 브리지 → PS5', tag: '다음 목표',
    nodes: [{ zone: 'away', title: '밖의 브라우저', sub: '노트북 · 폰' }, { zone: 'cloud', title: '인터넷 · Tailscale', sub: 'TLS 또는 VPN 안' }, { zone: 'home', title: '집의 브리지', sub: '맥, PS5와 같은 LAN' }, PS5],
    steps: {
      discover: { v: 'likely', proto: 'HTTPS /api/discover → 집 LAN UDP 9302', labels: ['“콘솔 찾기”', '밖 → 집', 'UDP 브로드캐스트'], note: '찾는 일은 집 안의 브리지가 합니다. 밖의 기기는 PS5와 직접 통신하지 않습니다.' },
      wake: { v: 'likely', proto: '브리지 → UDP 9302', labels: ['깨우기 요청', '밖 → 집', 'WAKEUP'], note: '집의 브리지가 대신 깨웁니다.' },
      register: { v: 'likely', proto: 'HTTPS /api/register → TCP 9295', labels: ['코드 입력', '밖 → 집', '등록 요청'], note: '등록은 집에서 한 번만. 키는 브리지가 있는 맥에만 저장되고 밖으로 나가지 않습니다.' },
      session: { v: 'likely', proto: 'HTTPS /api/session-check → TCP 9295', labels: ['연결 확인', '밖 → 집', '세션 요청'], note: '밖의 기기에는 키가 없어도 됩니다.' },
      stream: { v: 'plan', proto: 'WebSocket(TCP) ↔ UDP 9296', labels: ['영상 · 입력(TCP)', '밖 → 집', 'Takion UDP'], note: 'WebSocket은 TCP라 패킷 손실이 있으면 지연이 커집니다. 나중에 WebRTC로 바꿀 계획입니다.' },
    },
    needs: '집의 브리지(--host와 토큰)와 밖에서 브리지까지 가는 안전한 길: Tailscale 같은 VPN 안, 또는 TLS + 토큰.',
    watch: '브리지를 인터넷에 그냥 열면 누구나 PS5에 입력을 보낼 수 있습니다. 토큰은 필수이고, 가능하면 VPN 안에서만 쓰세요.',
    status: '계획된 다음 목표. 브리지는 --host와 토큰을 지원. TLS와 WebRTC는 아직.',
  },
  {
    id: 'psn', name: '밖 · PSN 원격(인터넷, Sony 경유)', sub: '밖의 기기 → Sony → 집 공유기 → PS5', tag: '가장 무거움',
    nodes: [{ zone: 'away', title: '밖의 기기', sub: 'PSN 로그인' }, { zone: 'cloud', title: 'Sony PSN 서버', sub: '로그인 · 신호 중계' }, { zone: 'home', title: '집 공유기(NAT)', sub: '홀펀칭' }, { ...PS5, sub: '대기 + 인터넷 유지' }],
    steps: {
      discover: { v: 'plan', proto: 'PSN 장치 목록', labels: ['PSN 로그인', '장치 조회', 'PS5 상태'], note: 'LAN 발견과 완전히 다른 방식입니다.' },
      wake: { v: 'plan', proto: 'PSN 경유 깨우기', labels: ['깨우기 요청', '신호 중계', 'WAKEUP'], note: 'PS5가 대기 중에도 인터넷에 연결돼 있어야 합니다.' },
      register: { v: 'plan', proto: 'PSN 등록 경로', labels: ['계정 토큰', '신호', '등록 요청'], note: '원본에서는 별도 코드 경로(lib/src/remote/)로 구현되어 있습니다.' },
      session: { v: 'plan', proto: 'PSN 신호 + UDP 홀펀칭', labels: ['세션 신호', '중계', '홀펀칭'], note: 'Sony 서버가 두 기기의 주소를 서로 알려 주어 직접 연결을 시도합니다.' },
      stream: { v: 'plan', proto: 'UDP 직접(홀펀칭 성공 시)', labels: ['입력', 'Sony 우회', '영상'], note: '통신사 공유 IP(CGNAT)나 엄격한 NAT에서는 실패할 수 있습니다.' },
    },
    needs: 'PSN 로그인과 계정 토큰 보관. PS5는 대기 중 인터넷 연결 유지와 원격 플레이 켜기.',
    watch: '계정 자격증명을 가장 많이 다루는 경로이고, 연결이 되는 망이 제한적입니다.',
    status: 'Phase 7로 아직 시작하지 않았습니다.',
  },
  {
    id: 'fwd', name: '밖 · 공유기 포트포워딩', sub: '밖의 기기 → 인터넷 → 포워딩 → PS5', tag: '쓰지 마세요',
    nodes: [{ zone: 'away', title: '밖의 기기', sub: '어디서든' }, { zone: 'cloud', title: '인터넷', sub: '공개 IP' }, { zone: 'home', title: '공유기', sub: '9295 · 9296 · 9302 전달' }, PS5],
    steps: {
      discover: { v: 'no', proto: 'UDP 9302 · 인터넷에 노출', labels: ['누구나 질의', '공개 IP', '전달'], note: 'PS5의 입구가 인터넷에 그대로 보입니다.' },
      wake: { v: 'no', proto: 'UDP 9302 · 인터넷에 노출', labels: ['WAKEUP', '공개 IP', '전달'], note: '깨우기 패킷도 아무나 보낼 수 있는 상태가 됩니다.' },
      register: { v: 'no', proto: 'UDP·TCP 9295 · 인터넷에 노출', labels: ['PIN 시도', '공개 IP', '전달'], note: '등록 PIN을 아무나 시도할 수 있는 상태가 됩니다.' },
      session: { v: 'no', proto: 'TCP 9295 · 인터넷에 노출', labels: ['세션 요청', '공개 IP', '전달'], note: '세션 요청이 누구에게나 열립니다.' },
      stream: { v: 'no', proto: 'UDP 9296 · 인터넷에 노출', labels: ['입력', '공개 IP', '영상'], note: '통신사 공유 IP(CGNAT)라면 아예 불가능합니다.' },
    },
    needs: '위 표의 포트(9295 · 9296 · 9297 · 9302)를 공유기에서 PS5로 전달.',
    watch: 'PS5의 원격 플레이 입구가 인터넷에 그대로 열립니다. 이 프로젝트는 이 방법을 지원하지 않고, 쓰지 않기를 권합니다.',
    status: '지원하지 않을 경로입니다. 밖에서는 VPN이나 브리지를 쓰세요.',
  },
];

export const pathById = (id: PathId): RoutePath => PATHS.find((p) => p.id === id) ?? PATHS[1]!;

// ------------------------------------------------------------------ which route is this?

const toInt = (ip: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = [m[1], m[2], m[3], m[4]].map(Number);
  return p.some((n) => n > 255) ? null : ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
};

export function inSubnet(ip: string, network: string, netmask: string): boolean {
  const a = toInt(ip);
  const n = toInt(network);
  const m = toInt(netmask);
  return a !== null && n !== null && m !== null && ((a & m) >>> 0) === ((n & m) >>> 0);
}

export type BrowserKind = 'local' | 'lan' | 'vpn' | 'public';

/** Where the page was opened from, judged by the address in the browser's address bar. */
export function browserKind(pageHost: string): BrowserKind {
  const h = pageHost.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.startsWith('127.')) return 'local';
  if (h.endsWith('.ts.net') || inSubnet(h, '100.64.0.0', '255.192.0.0')) return 'vpn';
  if (h.endsWith('.local') || inSubnet(h, '10.0.0.0', '255.0.0.0') || inSubnet(h, '172.16.0.0', '255.240.0.0') || inSubnet(h, '192.168.0.0', '255.255.0.0')) return 'lan';
  return 'public';
}

export interface RouteGuess {
  id: PathId;
  /** One sentence for the person, saying why. */
  reason: string;
}

/**
 * Best guess of the route in use. `interfaces` are the bridge computer's own LAN addresses; `consoleHost` is the console's
 * address when known. A guess, not a measurement: the page says so.
 */
export function detectRoute(input: { pageHost: string; consoleHost?: string; interfaces: Array<{ address: string; netmask: string }> }): RouteGuess {
  const kind = browserKind(input.pageHost);
  const away = kind === 'vpn' || kind === 'public';
  const sameNet = input.consoleHost ? input.interfaces.some((i) => inSubnet(input.consoleHost!, i.address, i.netmask)) : undefined;
  if (sameNet === false) return { id: 'vlan', reason: `PS5(${input.consoleHost})가 브리지 컴퓨터와 다른 대역에 있어 보입니다.` };
  if (away) {
    return { id: 'rbridge', reason: kind === 'vpn' ? '이 페이지를 VPN(Tailscale) 주소로 열었습니다.' : '이 페이지를 집 밖의 주소로 열었습니다.' };
  }
  return {
    id: 'bridge',
    reason: sameNet === true
      ? `브라우저와 브리지, PS5가 같은 집 네트워크에 있습니다.`
      : kind === 'local' ? '브라우저가 브리지와 같은 컴퓨터에서 열려 있습니다.' : '이 페이지를 집 안의 주소로 열었습니다.',
  };
}
