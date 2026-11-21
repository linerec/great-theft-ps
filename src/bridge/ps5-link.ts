// SPDX-License-Identifier: AGPL-3.0-only
//
// The console link for a real PS5, built on this project's TypeScript port of Remote Play (src/console/).
//
// What is real today, step by step, in the order a connection goes:
//   1. pick the registered console,
//   2. session request over TCP 9295 (src/console/session.ts)      done, accepted by a real PS5,
//   3. control connection (ctrl)                                    NOT YET
//   4. Takion transport, then video and audio                       NOT YET
//   5. sending pad state                                            NOT YET
// Each step reports what it is doing to the page. When it reaches a step that is not built, it stops and says so in plain
// words, instead of showing a picture that is not the console's.

import { requestSession, SessionError, type SessionGrant, type SessionRequestOptions } from '../console/session.ts';
import type { ConsoleStore } from '../console/store.ts';
import type { VirtualPadState } from '../engine/types.ts';
import type { ConsoleLink, LinkHandlers, LinkStartOptions } from './console-link.ts';
import type { QualityRequest } from './quality.ts';

export interface Ps5LinkOptions {
  store: ConsoleStore;
  log?: (line: string) => void;
  /** Replaced by tests. */
  session?: (opts: SessionRequestOptions) => Promise<SessionGrant>;
}

export class Ps5Link implements ConsoleLink {
  readonly name = 'ps5';
  #opts: Ps5LinkOptions;
  #stopped = false;

  constructor(opts: Ps5LinkOptions) {
    this.#opts = opts;
  }

  async start(handlers: LinkHandlers, _quality: QualityRequest, options: LinkStartOptions = {}): Promise<void> {
    const log = this.#opts.log ?? (() => {});
    const store = this.#opts.store;
    const list = store.list();
    const chosen = options.mac ? list.find((c) => c.mac === options.mac) : list[0];
    if (!chosen) throw new Error(list.length === 0 ? '등록된 PS5가 없습니다. 먼저 콘솔을 등록하세요.' : '선택한 콘솔의 등록 정보가 이 컴퓨터에 없습니다.');
    const record = store.get(chosen.mac);
    if (!record) throw new Error('등록 정보를 읽지 못했습니다.');
    const name = chosen.nickname || 'PS5';

    handlers.onStatus({ state: 'connecting', detail: `${name}에 세션을 요청하는 중` });
    let grant: SessionGrant;
    try {
      grant = await (this.#opts.session ?? requestSession)({
        host: record.host,
        target: record.target,
        registKey: Buffer.from(record.registKey, 'hex'),
        rpKey: Buffer.from(record.rpKey, 'hex'),
        log,
      });
    } catch (e) {
      if (e instanceof SessionError) throw new Error(`${name}이(가) 세션을 받아들이지 않았습니다. ${e.message}`);
      throw e;
    }
    if (this.#stopped) return;
    store.markVerified(record.mac, record.host);
    handlers.onStatus({ state: 'connecting', detail: `${name}이(가) 세션 요청을 받아들였습니다. 제어 연결을 여는 중` });
    void grant; // the session keys are used by the control connection, the next step

    // The control connection, the transport and the video are not built yet. Say so instead of faking a picture.
    throw new Error(`${name}이(가) 세션 요청을 받아들였습니다. 제어 연결과 영상 수신은 아직 구현 중이라 화면은 나오지 않습니다.`);
  }

  sendPad(_seq: number, _state: VirtualPadState): void {
    /* nothing can be sent before the control connection exists */
  }

  setQuality(_quality: QualityRequest): void {
    /* applied when the stream is set up */
  }

  requestKeyframe(): void {
    /* no stream yet */
  }

  async stop(): Promise<void> {
    this.#stopped = true;
  }
}
