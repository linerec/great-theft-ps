// SPDX-License-Identifier: AGPL-3.0-only
//
// The ways a client can reach a PS5, and what works on each. Pure data and logic (no DOM), so it can be tested.
// Ports and order come from chiaki-ng (commit 43728af). "Confirmed" (ok) means seen on a real console in this project;
// "Code exists" (likely) means written and tested against a simulated console and the reference's vectors only.
//
// Every word the tables hold is a sentence marked with N_(): the page shows it through t(), in the language in use at that
// moment. Text that is the same in every language (WAKEUP, a port) is marked too and has the same Korean as English.

import { N_, t } from '../src/i18n/index.ts';

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
  { id: 'discover', title: N_('Discover') },
  { id: 'wake', title: N_('Wake') },
  { id: 'register', title: N_('Register') },
  { id: 'session', title: N_('Start session') },
  { id: 'stream', title: N_('Video and input') },
];

export const VERDICTS: Record<Verdict, { symbol: string; title: string; short: string }> = {
  ok: { symbol: '✔', title: N_('Confirmed'), short: N_('Confirmed') },
  likely: { symbol: '◐', title: N_('Code exists · not tried on a real console'), short: N_('Code exists') },
  direct: { symbol: '△', title: N_('Conditional'), short: N_('Conditional') },
  plan: { symbol: '○', title: N_('Not built'), short: N_('Not built') },
  no: { symbol: '✕', title: N_('Not recommended · impossible'), short: N_('Impossible') },
};

const PS5: RouteNode = { zone: 'home', title: N_('PS5'), sub: N_('On or in rest mode'), ps5: true };

export const PATHS: RoutePath[] = [
  {
    id: 'lan', name: N_('At home · same network'), sub: N_('Device → router → PS5'), tag: N_('Simplest'),
    nodes: [{ zone: 'home', title: N_('This PC · Mac'), sub: N_('Same Wi-Fi') }, { zone: 'home', title: N_('Router'), sub: N_('192.168.1.x') }, PS5],
    steps: {
      discover: { v: 'ok', proto: N_('UDP broadcast · 9302'), labels: [N_('SRCH broadcast'), N_('Reply: state · name · ID')], note: N_('A real PS5 answered from the Mac and from this PC. On the same subnet it is found even if you do not know its address.') },
      wake: { v: 'likely', proto: N_('UDP 9302 · WAKEUP + registration key'), labels: [N_('WAKEUP'), N_('Rest mode → on')], note: N_('The function exists, but it has not been tried on a real PS5 yet.') },
      register: { v: 'ok', proto: N_('UDP search + TCP 9295 · 8-digit code'), labels: [N_('Search + registration request'), N_('Key reply (encrypted)')], note: N_('Confirmed on a real PS5. You only do it once, and the result is saved on the computer.') },
      session: { v: 'ok', proto: N_('TCP 9295 · /sie/ps5/rp/sess/init, /ctrl'), labels: [N_('init + registration key'), N_('nonce · session ID')], note: N_('Confirmed on a real PS5. After the session request, an encrypted control connection is opened and the session ID is received.') },
      stream: { v: 'ok', proto: N_('UDP 9296 Takion'), labels: [N_('Input · receive report'), N_('Video (H.264)')], note: N_('Confirmed up to receiving the picture of a real PS5 and sending input. Sound and the RTT/MTU measurement (9297) are not there yet.') },
    },
    needs: N_('The PC and the PS5 on the same router (same subnet). Remote Play turned on in the PS5.'),
    watch: N_('If “client isolation” is on in the router, every method is blocked.'),
    status: N_('Discovery, registration, session, video and input confirmed on a real PS5. Sound and waking are not done yet.'),
  },
  {
    id: 'bridge', name: N_('At home · browser + bridge'), sub: N_('Browser → bridge → PS5'), tag: N_('What is used now'),
    nodes: [{ zone: 'home', title: N_('Browser'), sub: N_('Mac · this PC · phone') }, { zone: 'home', title: N_('Bridge'), sub: N_('Node · the Mac at home, this PC') }, PS5],
    steps: {
      discover: { v: 'ok', proto: N_('HTTP /api/discover → UDP 9302'), labels: [N_('“Find console”'), N_('UDP broadcast')], note: N_('A browser cannot open UDP, so the bridge searches for it.') },
      wake: { v: 'likely', proto: N_('Bridge → UDP 9302 WAKEUP'), labels: [N_('(button planned)'), N_('WAKEUP')], note: N_('The wake function exists; the button on the screen does not yet.') },
      register: { v: 'ok', proto: N_('HTTP /api/register → TCP 9295'), labels: [N_('Enter code · account ID'), N_('Registration request')], note: N_('Confirmed on a real PS5. The key is stored only on the computer that has the bridge and never comes to the browser.') },
      session: { v: 'ok', proto: N_('WebSocket hello → TCP 9295'), labels: [N_('Connect'), N_('Session · control connection')], note: N_('Confirmed on a real PS5. The bridge asks for a session with the stored key and opens the control connection.') },
      stream: { v: 'ok', proto: N_('WebSocket(TCP) ↔ UDP 9296'), labels: [N_('Video · input (TCP)'), N_('Takion UDP')], note: N_('Confirmed: the picture of a real PS5 shows in the browser and key presses get through. WebSocket is TCP, so delay grows when packets are lost; WebRTC is planned for later. There is no sound yet.') },
    },
    needs: N_('npm run bridge on a computer on the same network as the PS5. A browser on the same computer needs no token; other devices need --host and a token.'),
    watch: N_('Between the browser and the bridge it is TCP. Delay is measured with the “input → picture delay” on the screen.'),
    status: N_('Real PS5 picture and input confirmed through the bridge on this PC. The measurements can be seen at /api/stream/stats.'),
  },
  {
    id: 'vlan', name: N_('At home · other subnet / guest'), sub: N_('IoT/guest network → router → PS5'), tag: N_('Conditional'),
    nodes: [{ zone: 'home', title: N_('Device'), sub: N_('Guest · IoT subnet') }, { zone: 'home', title: N_('Subnet border'), sub: N_('Router · firewall') }, PS5],
    steps: {
      discover: { v: 'direct', proto: N_('UDP 9302 · straight to the PS5 address'), labels: [N_('✕ broadcast'), N_('Direct query')], note: N_("A broadcast cannot cross subnets. If you know the PS5's IP, ask it directly with discover --host IP.") },
      wake: { v: 'direct', proto: N_('UDP 9302 · sent directly'), labels: [N_('WAKEUP direct'), N_('Rest mode → on')], note: N_('The router has to let UDP 9302 through.') },
      register: { v: 'direct', proto: N_('UDP·TCP 9295 · direct'), labels: [N_('Search + request'), N_('Reply')], note: N_('Sent straight to the PS5 address. The router has to let 9295 through.') },
      session: { v: 'direct', proto: N_('TCP 9295 · direct'), labels: [N_('init'), N_('nonce')], note: N_('The registration data is used as it is, whatever the subnet.') },
      stream: { v: 'direct', proto: N_('UDP 9296 · both ways through'), labels: [N_('Input'), N_('Video')], note: N_('UDP 9296 has to get through in both directions. AP isolation on a guest Wi-Fi blocks it completely.') },
    },
    needs: N_("The PS5's IP address. The router lets UDP·TCP 9295, UDP 9296, 9297 and 9302 through."),
    watch: N_('If AP isolation or client isolation is on, no route works. Then put the PC on the same subnet as the PS5.'),
    status: N_('discover has a --host option. The rest is the same code as the first route.'),
  },
  {
    id: 'vpn', name: N_('Away · into the home through a VPN'), sub: N_('Device away → VPN → home → PS5'), tag: N_('Next candidate'),
    nodes: [{ zone: 'away', title: N_('Device away from home'), sub: N_('Café · office · on the move') }, { zone: 'cloud', title: N_('VPN tunnel'), sub: N_('Tailscale · WireGuard') }, { zone: 'home', title: N_('Mac at home'), sub: N_('VPN node · subnet router') }, PS5],
    steps: {
      discover: { v: 'direct', proto: N_('UDP 9302 · straight to the home LAN address'), labels: [N_('✕ broadcast'), N_('VPN tunnel'), N_('Direct query')], note: N_('A broadcast cannot cross the tunnel. The PS5 is asked directly at its home IP (192.168.1.x).') },
      wake: { v: 'direct', proto: N_('UDP 9302 · through the tunnel'), labels: [N_('WAKEUP'), N_('Tunnel'), N_('Rest mode → on')], note: N_('A way to wake it from away with the key registered at home. Not confirmed on a real console yet.') },
      register: { v: 'direct', proto: N_('UDP·TCP 9295 · through the tunnel'), labels: [N_('Registration request'), N_('Tunnel'), N_('Key reply')], note: N_('Register once, at home. If the saved data is carried over, there is nothing to redo away from home.') },
      session: { v: 'direct', proto: N_('TCP 9295 · through the tunnel'), labels: [N_('init'), N_('Tunnel'), N_('nonce')], note: N_('The same request as on the home LAN goes through the tunnel.') },
      stream: { v: 'direct', proto: N_('UDP 9296 · through the tunnel'), labels: [N_('Input'), N_('Tunnel'), N_('Video')], note: N_('The tunnel delay and overhead (MTU) may make you lower the picture quality. This is where the low-bandwidth preset is needed.') },
    },
    needs: N_('The Mac and the device away on the same VPN. Either the Mac announces the home subnet or the protocol client runs on the Mac. A browser alone cannot open UDP to the PS5.'),
    watch: N_('Tunnel delay and MTU can cut the connection. Broadcast discovery does not work, so give the PS5 a fixed IP.'),
    status: N_('Both this PC and the Mac show a Tailscale adapter (a candidate if they are on the same tailnet). The subnet setup has not been tried yet.'),
  },
  {
    id: 'rbridge', name: N_('Away · browser to the bridge at home'), sub: N_('Browser away → bridge at home → PS5'), tag: N_('Next goal'),
    nodes: [{ zone: 'away', title: N_('Browser away from home'), sub: N_('Laptop · phone') }, { zone: 'cloud', title: N_('Internet · Tailscale'), sub: N_('Over TLS or inside the VPN') }, { zone: 'home', title: N_('Bridge at home'), sub: N_('Mac, on the same LAN as the PS5') }, PS5],
    steps: {
      discover: { v: 'likely', proto: N_('HTTPS /api/discover → home LAN UDP 9302'), labels: [N_('“Find console”'), N_('Away → home'), N_('UDP broadcast')], note: N_('The bridge inside the home does the searching. The device away never talks to the PS5 directly.') },
      wake: { v: 'likely', proto: N_('Bridge → UDP 9302'), labels: [N_('Wake request'), N_('Away → home'), N_('WAKEUP')], note: N_('The bridge at home wakes it instead.') },
      register: { v: 'likely', proto: N_('HTTPS /api/register → TCP 9295'), labels: [N_('Enter code'), N_('Away → home'), N_('Registration request')], note: N_('Register once, at home. The key is stored only on the Mac that has the bridge and never leaves it.') },
      session: { v: 'likely', proto: N_('HTTPS /api/session-check → TCP 9295'), labels: [N_('Connection check'), N_('Away → home'), N_('Session request')], note: N_('The device away does not need the key.') },
      stream: { v: 'plan', proto: N_('WebSocket(TCP) ↔ UDP 9296'), labels: [N_('Video · input (TCP)'), N_('Away → home'), N_('Takion UDP')], note: N_('WebSocket is TCP, so delay grows when packets are lost. The plan is to change to WebRTC later.') },
    },
    needs: N_('The bridge at home (--host and a token) and a safe way to it from away: inside a VPN such as Tailscale, or TLS + a token.'),
    watch: N_('If the bridge is simply opened to the internet, anyone can send input to the PS5. A token is a must; if you can, use it only inside a VPN.'),
    status: N_('The planned next goal. The bridge supports --host and a token. TLS and WebRTC are not there yet.'),
  },
  {
    id: 'psn', name: N_('Away · PSN remote play (internet, through Sony)'), sub: N_('Device away → Sony → home router → PS5'), tag: N_('Heaviest'),
    nodes: [{ zone: 'away', title: N_('Device away from home'), sub: N_('PSN login') }, { zone: 'cloud', title: N_('Sony PSN server'), sub: N_('Login · signal relay') }, { zone: 'home', title: N_('Home router (NAT)'), sub: N_('Hole punching') }, { ...PS5, sub: N_('Rest mode + internet kept on') }],
    steps: {
      discover: { v: 'plan', proto: N_('PSN device list'), labels: [N_('PSN login'), N_('Device lookup'), N_('PS5 state')], note: N_('A completely different way from LAN discovery.') },
      wake: { v: 'plan', proto: N_('Wake through PSN'), labels: [N_('Wake request'), N_('Signal relay'), N_('WAKEUP')], note: N_('The PS5 must stay connected to the internet even in rest mode.') },
      register: { v: 'plan', proto: N_('PSN registration path'), labels: [N_('Account token'), N_('Signal'), N_('Registration request')], note: N_('In the original it is built as a separate code path (lib/src/remote/).') },
      session: { v: 'plan', proto: N_('PSN signal + UDP hole punching'), labels: [N_('Session signal'), N_('Relay'), N_('Hole punching')], note: N_("The Sony server tells the two devices each other's addresses so that they try a direct connection.") },
      stream: { v: 'plan', proto: N_('Direct UDP (if hole punching works)'), labels: [N_('Input'), N_('Around Sony'), N_('Video')], note: N_('It can fail on an ISP-shared IP (CGNAT) or a strict NAT.') },
    },
    needs: N_('A PSN login and the account token kept. The PS5 must keep its internet connection in rest mode, with Remote Play turned on.'),
    watch: N_('The route that handles account credentials the most, and the networks where it connects are limited.'),
    status: N_('Phase 7; not started yet.'),
  },
  {
    id: 'fwd', name: N_('Away · router port forwarding'), sub: N_('Device away → internet → forwarding → PS5'), tag: N_('Do not use'),
    nodes: [{ zone: 'away', title: N_('Device away from home'), sub: N_('From anywhere') }, { zone: 'cloud', title: N_('Internet'), sub: N_('Public IP') }, { zone: 'home', title: N_('Router'), sub: N_('9295 · 9296 · 9302 forwarded') }, PS5],
    steps: {
      discover: { v: 'no', proto: N_('UDP 9302 · exposed to the internet'), labels: [N_('Anyone can ask'), N_('Public IP'), N_('Forwarded')], note: N_('The entrance of the PS5 is plainly visible from the internet.') },
      wake: { v: 'no', proto: N_('UDP 9302 · exposed to the internet'), labels: [N_('WAKEUP'), N_('Public IP'), N_('Forwarded')], note: N_('Anyone can also send the wake packet.') },
      register: { v: 'no', proto: N_('UDP·TCP 9295 · exposed to the internet'), labels: [N_('PIN attempts'), N_('Public IP'), N_('Forwarded')], note: N_('Anyone can try the registration PIN.') },
      session: { v: 'no', proto: N_('TCP 9295 · exposed to the internet'), labels: [N_('Session request'), N_('Public IP'), N_('Forwarded')], note: N_('Session requests are open to everyone.') },
      stream: { v: 'no', proto: N_('UDP 9296 · exposed to the internet'), labels: [N_('Input'), N_('Public IP'), N_('Video')], note: N_('With an ISP-shared IP (CGNAT) it is not possible at all.') },
    },
    needs: N_('Forward the ports in the table above (9295 · 9296 · 9297 · 9302) from the router to the PS5.'),
    watch: N_('The Remote Play entrance of the PS5 is left wide open to the internet. This project does not support this method and advises against it.'),
    status: N_('A route that will not be supported. Away from home, use a VPN or the bridge.'),
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
  /** One sentence for the person, saying why, in the language in use when it was asked for. */
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
  if (sameNet === false) return { id: 'vlan', reason: t('The PS5 ({host}) seems to be on a different subnet from the bridge computer.', { host: input.consoleHost! }) };
  if (away) {
    return { id: 'rbridge', reason: kind === 'vpn' ? t('This page was opened from a VPN (Tailscale) address.') : t('This page was opened from an address outside the home.') };
  }
  return {
    id: 'bridge',
    reason: sameNet === true
      ? t('The browser, the bridge and the PS5 are on the same home network.')
      : kind === 'local' ? t('The browser is open on the same computer as the bridge.') : t('This page was opened from an address inside the home.'),
  };
}
