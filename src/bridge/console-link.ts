// SPDX-License-Identifier: AGPL-3.0-only
//
// The one seam between the client/bridge and a console. A link produces video frames and consumes pad state.
// Two implementations: MockConsole (a simulated console, for development and tests) and CoreLink
// (the native gtp-core process built on libchiaki, for a real PlayStation).

import type { VirtualPadState } from '../engine/types.ts';
import type { QualityRequest } from './quality.ts';
import type { VideoHeader } from './protocol.ts';

export interface LinkFrame {
  header: VideoHeader;
  data: Uint8Array;
}

export interface LinkStatus {
  state: 'connecting' | 'streaming' | 'closed' | 'error';
  detail?: string;
}

export interface LinkHandlers {
  onVideo(frame: LinkFrame): void;
  onStatus(status: LinkStatus): void;
}

export interface ConsoleLink {
  readonly name: string;
  start(handlers: LinkHandlers, quality: QualityRequest): Promise<void>;
  /** `seq` is the client's PAD sequence number, echoed back in video headers where the source can tell. */
  sendPad(seq: number, state: VirtualPadState): void;
  setQuality(quality: QualityRequest): void;
  requestKeyframe(): void;
  stop(): Promise<void>;
}
