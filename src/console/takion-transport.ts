// SPDX-License-Identifier: AGPL-3.0-only
//
// Joins the stream connection (streamconnection.ts) to the Takion transport (takion.ts). The stream connection is
// written against a small interface so it can be tested without a network; this is the real thing behind it.

import { Takion, TAKION_MESSAGE_DATA_TYPE } from './takion.ts';
import { STREAM_PORT, type StreamTransport } from './streamconnection.ts';

export interface TakionTransportOptions {
  host: string;
  /** 12 for a PS5, 9 for a PS4. */
  protocolVersion: number;
  /** Default 9296. Changed only by tests. */
  port?: number;
  expectTimeoutMs?: number;
  /** Progress lines from the transport. Never contains keys or packet contents. */
  log?: (line: string) => void;
}

export function takionTransport(o: TakionTransportOptions): StreamTransport & { takion: Takion } {
  const takion = new Takion();
  const transport: StreamTransport & { takion: Takion } = {
    takion,
    version: o.protocolVersion,
    events: {},
    connect: () =>
      takion.connect({
        host: o.host, port: o.port ?? STREAM_PORT, protocolVersion: o.protocolVersion, enableCrypt: true,
        ...(o.expectTimeoutMs !== undefined ? { expectTimeoutMs: o.expectTimeoutMs } : {}),
        ...(o.log ? { log: o.log } : {}),
      }),
    sendMessageData: (chunkFlags, channel, payload) => void takion.sendMessageData(chunkFlags, channel, payload),
    sendMessageDataCont: (chunkFlags, channel, payload) => void takion.sendMessageDataCont(chunkFlags, channel, payload),
    setCrypt: (local, remote) => takion.setCrypt(local, remote),
    sendCongestion: (received, lost) => takion.sendCongestion({ word0: 0, received, lost }),
    sendFeedbackState: (seqNum, payload) => takion.sendFeedbackState(seqNum, payload),
    sendFeedbackHistory: (seqNum, payload, eventCount) => takion.sendFeedbackHistory(seqNum, eventCount, payload),
    close: () => void takion.close().catch(() => {}),
  };
  // The transport's callbacks must be in place before connect(): a message can arrive before the caller's next line runs.
  takion.events.onData = (dataType, payload) => {
    if (dataType === TAKION_MESSAGE_DATA_TYPE.PROTOBUF) transport.events.onProtobuf?.(payload);
    // Rumble, pad info and trigger effects are for a physical controller; nothing here uses them yet.
  };
  takion.events.onAv = (packet) => transport.events.onAv?.(packet);
  takion.events.onDisconnect = (reason) => transport.events.onClosed?.(reason?.message ?? 'the stream transport closed');
  return transport;
}
