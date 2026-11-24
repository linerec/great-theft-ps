// SPDX-License-Identifier: AGPL-3.0-only
//
// Browser side of the bridge connection: authentication, pad sending (only when something changed, plus a
// keepalive), ping/RTT, and input-to-picture latency where the source echoes the input sequence.

import { decodeAudio, decodePong, decodeVideo, encodePad, encodePing, MSG, type VideoHeader } from '../src/bridge/protocol.ts';
import type { VirtualPadState } from '../src/engine/types.ts';

export type BridgeState = 'idle' | 'connecting' | 'ready' | 'closed';

const KEEPALIVE_MS = 100;

export class BridgeClient {
  state: BridgeState = 'idle';
  detail = '';
  rttMs = 0;
  /** Median time from sending a pad to seeing the first frame that reflects it. 0 = not measured. */
  inputLatencyMs = 0;
  fpsIn = 0;
  kbpsIn = 0;
  serverStats: Record<string, unknown> = {};
  link = '';

  onVideo: (header: VideoHeader, payload: Uint8Array) => void = () => {};
  /** The console's sound is Opus: the format, once, before the first frame. */
  onAudioInfo: (info: { channels: number; bits: number; rate: number; frameSize: number }) => void = () => {};
  /** One Opus frame, or (lost) news that a frame never came. */
  onAudio: (lost: boolean, payload: Uint8Array) => void = () => {};
  onChange: () => void = () => {};

  #ws: WebSocket | null = null;
  #seq = 0;
  #sentAt = new Map<number, number>();
  #measuredSeq = 0;
  #latencies: number[] = [];
  #last = new Uint8Array(0);
  #lastSendAt = 0;
  #frames = 0;
  #bytes = 0;
  #timer: ReturnType<typeof setInterval> | null = null;

  /**
   * `token` is only needed when the bridge listens beyond its own computer. `quality` is what the stream starts with.
   * `lock`: do not hand this connection over when another of this person's clients asks for the console.
   */
  connect(url: string, token = '', consoleMac = '', quality?: { preset: string }, lock = false): void {
    this.disconnect();
    this.#set('connecting', url);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', ...(token ? { token } : {}), ...(consoleMac ? { console: consoleMac } : {}), ...(quality ? { quality } : {}), ...(lock ? { lock: true } : {}), client: 'gtp-web' }));
    ws.onmessage = (e) => this.#message(e.data as string | ArrayBuffer);
    ws.onclose = (e) => {
      if (this.#ws === ws) {
        this.#stopTimer();
        this.#set('closed', e.code === 4401 ? '로그인이 필요합니다. 페이지를 새로 고치면 로그인 창이 열립니다. (토큰이 필요한 브리지라면 브리지가 출력한 주소로 여세요)' : e.code === 4403 ? (this.detail.startsWith('error: ') ? this.detail.slice(7) : '오늘 사용할 수 있는 시간이 끝났습니다') : e.code === 4409 ? 'another client is connected' : this.detail.startsWith('error: ') ? this.detail.slice(7) : `closed (${e.code})`);
      }
    };
    ws.onerror = () => this.#set('closed', 'connection failed');
  }

  disconnect(): void {
    const ws = this.#ws;
    this.#ws = null;
    this.#stopTimer();
    if (ws && ws.readyState <= 1) {
      try {
        ws.send(JSON.stringify({ type: 'bye' }));
      } catch {
        /* not open yet */
      }
      ws.close();
    }
    if (this.state !== 'idle') this.#set('closed', 'disconnected');
  }

  sendJson(o: unknown): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(o));
  }

  requestKeyframe(): void {
    this.sendJson({ type: 'keyframe' });
  }

  /** Send the pad if it changed since the last send, or if the keepalive is due. */
  sendPad(state: VirtualPadState, withMotion: boolean, now: number): void {
    if (this.state !== 'ready' || this.#ws?.readyState !== WebSocket.OPEN) return;
    const bytes = encodePad(this.#seq + 1, state, withMotion);
    let same = bytes.length === this.#last.length;
    for (let i = 5; same && i < bytes.length; i++) if (bytes[i] !== this.#last[i]) same = false;
    if (same && now - this.#lastSendAt < KEEPALIVE_MS) return;
    this.#seq++;
    this.#last = bytes;
    this.#lastSendAt = now;
    this.#sentAt.set(this.#seq, now);
    if (this.#sentAt.size > 512) this.#sentAt.delete(this.#sentAt.keys().next().value as number);
    this.#ws.send(bytes);
  }

  #set(state: BridgeState, detail: string): void {
    this.state = state;
    this.detail = detail;
    this.onChange();
  }

  #stopTimer(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #message(data: string | ArrayBuffer): void {
    if (typeof data === 'string') {
      let m: { type?: string; [k: string]: unknown };
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      if (m.type === 'ready') {
        this.link = String(m.link ?? '');
        this.#set('ready', `link: ${this.link}`);
        this.#timer = setInterval(() => {
          this.fpsIn = this.#frames;
          this.kbpsIn = Math.round((this.#bytes * 8) / 1000);
          this.#frames = 0;
          this.#bytes = 0;
          this.sendPing();
          this.onChange();
        }, 1000);
      } else if (m.type === 'audio') {
        const n = (k: string): number => (typeof m[k] === 'number' ? (m[k] as number) : 0);
        this.onAudioInfo({ channels: n('channels'), bits: n('bits'), rate: n('rate'), frameSize: n('frameSize') });
      } else if (m.type === 'quota') {
        // Minutes per day (see accounts.ts): the account window shows how much is left.
        window.dispatchEvent(new CustomEvent('gtp:quota', { detail: { remainingSeconds: typeof m.remainingSeconds === 'number' ? m.remainingSeconds : null } }));
      } else if (m.type === 'stats') {
        this.serverStats = m;
      } else if (m.type === 'status' || m.type === 'error') {
        this.detail = `${m.type === 'error' ? 'error' : String(m.state)}: ${String(m.detail ?? m.message ?? '')}`;
        this.onChange();
      }
      return;
    }
    const bytes = new Uint8Array(data);
    if (bytes[0] === MSG.VIDEO) {
      const v = decodeVideo(bytes);
      if (!v) return;
      this.#frames++;
      this.#bytes += bytes.length;
      this.#noteLatency(v.header);
      this.onVideo(v.header, v.payload);
    } else if (bytes[0] === MSG.AUDIO) {
      const a = decodeAudio(bytes);
      if (a) this.onAudio(a.lost, a.payload);
    } else if (bytes[0] === MSG.PONG) {
      const p = decodePong(bytes);
      if (p) this.rttMs = this.rttMs === 0 ? performance.now() - p.clientTime : this.rttMs * 0.7 + (performance.now() - p.clientTime) * 0.3;
    }
  }

  sendPing(): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(encodePing(performance.now()));
  }

  #noteLatency(h: VideoHeader): void {
    if (h.inputSeq === 0 || h.inputSeq <= this.#measuredSeq) return;
    const sent = this.#sentAt.get(h.inputSeq);
    this.#measuredSeq = h.inputSeq;
    if (sent === undefined) return;
    this.#latencies.push(performance.now() - sent);
    if (this.#latencies.length > 30) this.#latencies.shift();
    const sorted = [...this.#latencies].sort((a, b) => a - b);
    this.inputLatencyMs = sorted[Math.floor(sorted.length / 2)]!;
  }
}
