// SPDX-License-Identifier: AGPL-3.0-only
//
// The protobuf messages carried by Takion data messages of type 0 (TAKION_MESSAGE_DATA_TYPE.PROTOBUF), with a small
// hand-written encoder and decoder for the protobuf wire format. No library, no code generation.
//
// Derived from chiaki-ng (AGPL-3.0-only with an OpenSSL exception): lib/protobuf/takion.proto (commit 43728af), all of
// its messages and enums, with field names turned into camelCase. How the reference fills and encodes the messages it
// sends was read from lib/src/streamconnection.c, lib/src/senkusha.c and lib/src/pb_utils.h.
//
// The reference encodes with nanopb. What this encoder does to produce the same bytes:
//  - fields are written in ascending field number order (nanopb's order; the .proto also declares them that way);
//  - a `required` field is always written, a zero included (BIG is type 0 and is sent as `08 00`); here a missing
//    required field is an error rather than a silent zero, so pass the zero explicitly;
//  - an `optional` field is written exactly when it is present (nanopb's has_ flag), whatever its value;
//  - `repeated` scalars are written one tag and value per element, not packed (what chiaki_pb_encode_list does);
//  - int32 below zero takes ten bytes (sign extended to 64 bits), bool is 0 or 1, float and double are little endian.
// The decoder follows nanopb too: unknown fields are skipped, both packed and unpacked repeated scalars are accepted,
// a repeated occurrence of a sub-message is merged, and a message that lacks a required field is refused (unless
// `lenient`). Differences: a field with the wrong wire type is always an error here (nanopb hands such a string or
// bytes field to its callback), and absent optional fields are simply absent (the .proto's few explicit defaults are
// all false or 0).
//
// Representation: uint32, int32 and enums are numbers; int64 and uint64 are bigint; bytes are Uint8Array (Buffer when
// decoded, copied out of the input); strings are UTF-8; repeated fields are always arrays in decoded messages.
//
// STATUS: checked against encodings derived by hand from the wire format rules for the messages the reference sends
// (and against the sizes of the buffers the reference encodes them into), and by round trips of every message
// (test/takion-proto.test.ts). NOT compared with nanopb's output: there are no encoded examples in the reference's
// tests, and nanopb could not be run here. NOT run against a real console.

export class TakionProtoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TakionProtoError';
  }
}

// ------------------------------------------------------------------ enums

/** tkproto.TakionMessage.PayloadType */
export const TAKION_PAYLOAD_TYPE = {
  BIG: 0,
  BANG: 1,
  INFO: 2,
  HEARTBEAT: 3,
  PACKETLOSS: 4,
  CORRUPTFRAME: 5,
  CURSOR: 6,
  TIMER: 7,
  DISCONNECT: 8,
  LOG: 9,
  HEADERREQUEST: 10,
  DEBUG: 11,
  SENKUSHA: 12,
  STREAMINFO: 13,
  STREAMINFOACK: 14,
  XMBCOMMAND: 15,
  CONNECTIONQUALITY: 16,
  CLIENTMETRIC: 17,
  PLAYTIMELEFT: 18,
  SERVERMESSAGE: 19,
  FPSCHANGE: 20,
  CONTROLLERCONNECTION: 21,
  CLIENTINFO: 22,
  VIDEOCAPTURE: 23,
  AUDIOCAPTURE: 24,
  IDRREQUEST: 25,
  GKTRACE: 26,
  PERIODICTIMESTAMP: 27,
  SERVERSETTINGS: 28,
  DIRECTMESSAGE: 29,
  MICCONNECTION: 30,
  TAKIONPROTOCOLREQUEST: 31,
  TAKIONPROTOCOLREQUESTACK: 32,
} as const;

/** tkproto.LogMessage.LogLevel */
export const LOG_LEVEL = { CRITICAL: 0, ERROR: 1, WARNING: 2, INFO: 3, DEBUG: 4, TRACE: 5 } as const;

/** tkproto.ClientMetric.Category */
export const CLIENT_METRIC_CATEGORY = {
  VIDEO_FRAMELIFETIME: 0,
  VIDEO_FRAMENALUSCOMPLETE: 1,
  VIDEO_FECCORRECTION: 2,
  VIDEO_FRAMEQUEUE: 3,
  VIDEO_DECODERFRAMEQUEUE: 4,
  VIDEO_SUBMITTODECODER: 5,
  VIDEO_DECODE: 6,
  VIDEO_DECODEDPICTUREDROP: 7,
  VIDEO_YUVCOPY: 8,
  VIDEO_TEXTURECOPY: 9,
  VIDEO_RENDER: 10,
  GRAPHICS_PRERENDER: 11,
  GRAPHICS_PRESENT: 12,
  AUDIO_FRAMELIFETIME: 13,
  AUDIO_FRAMENALUSCOMPLETE: 14,
  AUDIO_FECCORRECTION: 15,
  AUDIO_FRAMEQUEUE: 16,
  AUDIO_SUBMITTODECODER: 17,
  AUDIO_DECODE: 18,
  AUDIO_BUFFERCOPY: 19,
  AUDIO_RENDER: 20,
} as const;

/** tkproto.HeaderRequestPayload.HeaderType */
export const HEADER_TYPE = { AUDIO: 0, VIDEO: 1 } as const;

/** tkproto.DebugOption.Type */
export const DEBUG_OPTION_TYPE = { OVERLAY: 0, BITRATE: 1 } as const;

/** tkproto.OverlayPayload.LogLocation */
export const OVERLAY_LOG_LOCATION = { TOP_LEFT: 0, TOP_RIGHT: 1, BOTTOM_LEFT: 2, BOTTOM_RIGHT: 3 } as const;

/** tkproto.XmbCommandPayload.XmbCommand */
export const XMB_COMMAND = { OFF: 0, ON: 1, TOGGLE: 2 } as const;

/** tkproto.ControllerConnectionPayload.ControllerType */
export const CONTROLLER_TYPE = {
  NOTSET: 0,
  DUALSHOCK3: 1,
  DUALSHOCK4: 2,
  VITA: 3,
  XINPUT: 4,
  MOBILE: 5,
  DUALSENSE: 6,
  VR2SENSE: 7,
} as const;

/** tkproto.DeepLinkPayload.DeepLinkType */
export const DEEP_LINK_TYPE = { SAVE_DATA: 0, INVITE: 1, GAME_ALERT: 2, SYSTEM_SERVICE_STATUS: 3, DEBUG_VSH_MENU: 4, RAW: 5 } as const;

/** tkproto.MicInfoPayload.MicInfoType */
export const MIC_INFO_TYPE = { MIC_CONNECT: 0, MIC_MUTE: 1 } as const;

/** tkproto.DirectMessagePayload.DirectMessageType */
export const DIRECT_MESSAGE_TYPE = { DEEPLINK: 0, MICINFO: 1 } as const;

/** tkproto.DirectMessagePayload.Destination */
export const DIRECT_MESSAGE_DESTINATION = { GAIKAI_CONTROLLER: 1000, CLIENT: 1001 } as const;

/** tkproto.SenkushaPayload.Command */
export const SENKUSHA_COMMAND = { ECHO_COMMAND: 0, MTU_COMMAND: 1, BANDWIDTH_COMMAND: 3, CLIENT_MTU_COMMAND: 4 } as const;

// ------------------------------------------------------------------ messages
// One interface per message of takion.proto. `?` marks the .proto's `optional`; everything else is `required`, or
// `repeated` (an array). The number after each field is its field number.

export interface TakionMessage {
  /** One of TAKION_PAYLOAD_TYPE. */
  type: number; // 1
  bigPayload?: BigPayload; // 2
  bangPayload?: BangPayload; // 3
  infoPayload?: InfoPayload; // 4
  lossPayload?: PacketLossPayload; // 5
  corruptPayload?: CorruptFramePayload; // 6
  cursorPayload?: CursorPayload; // 8
  timerPayload?: TimerPayload; // 9
  disconnectPayload?: DisconnectPayload; // 10
  logPayload?: LogPayload; // 11
  headerPayload?: HeaderRequestPayload; // 12
  debugPayload?: DebugOption; // 13
  senkushaPayload?: SenkushaPayload; // 14
  streamInfoPayload?: StreamInfoPayload; // 15
  xmbCommandPayload?: XmbCommandPayload; // 16
  connectionQualityPayload?: ConnectionQualityPayload; // 17
  clientMetricPayload?: ClientMetricPayload; // 18
  playTimeLeftPayload?: PlayTimeLeftPayload; // 19
  serverMessagePayload?: ServerMessagePayload; // 20
  fpsChangePayload?: FpsChangePayload; // 21
  controllerConnectionPayload?: ControllerConnectionPayload; // 22
  clientInfoPayload?: ClientInfoPayload; // 23
  videoCapturePayload?: VideoCapturePayload; // 24
  audioCapturePayload?: AudioCapturePayload; // 25
  gkTracePayload?: GkTracePayload; // 26
  periodicTimestampPayload?: PeriodicTimestampPayload; // 27
  serverSettingsPayload?: ServerSettingsPayload; // 28
  directMessagePayload?: DirectMessagePayload; // 29
  micConnectionPayload?: MicConnectionPayload; // 30
  takionProtocolRequest?: TakionProtocolRequestPayload; // 31
  takionProtocolRequestAck?: TakionProtocolRequestAckPayload; // 32
}

export interface EventCode {
  eventCode: string; // 1
  name?: string; // 2
  description?: string; // 3
}

export interface BigPayload {
  clientVersion: number; // 1
  sessionKey: string; // 2
  launchSpec: string; // 3
  encryptedKey: Uint8Array; // 4
  ecdhPubKey?: Uint8Array; // 5
  ecdhSig?: Uint8Array; // 6
}

export interface BangPayload {
  serverVersion: number; // 1
  token: number; // 2
  encryptedKeyAccepted: boolean; // 3
  versionAccepted: boolean; // 4
  sessionKey: string; // 5
  extendedInfo?: EventCode; // 6
  serverVersionString?: string; // 7
  ecdhPubKey?: Uint8Array; // 8
  ecdhSig?: Uint8Array; // 9
}

export interface InfoPayload {
  effectiveBw: number; // 1
  bitrate: number; // 2
  minBitrate: number; // 3
  targetBitrate: number; // 4
  corruptFrameFreq: number; // 5
  mtu: number; // 6
  fps: number; // 7
  monitorInterval: number; // 8
  extOverhead: number; // 9
  intOverhead: number; // 10
  timeoutInterval: number; // 11
  minResumeQuality: number; // 12
  minFps: number; // 13
}

export interface CursorPayload {
  id: number; // 1
  width: number; // 2
  height: number; // 3
  hotspotX: number; // 4
  hotspotY: number; // 5
  pixels?: Uint8Array; // 6
}

export interface TimerPayload {
  secondsLeft: number; // 1
  totalSeconds: number; // 2
}

export interface CorruptFramePayload {
  start: number; // 1
  end: number; // 2
}

export interface PacketLossPayload {
  start: number; // 1
  end: number; // 2
  packetsReceived: number; // 3
}

export interface FpsChangePayload {
  fps: number; // 1
}

export interface DisconnectPayload {
  reason: string; // 1
  extendedInfo?: EventCode; // 2
}

export interface LogMessage {
  timestamp: bigint; // 1, int64
  /** One of LOG_LEVEL. */
  level: number; // 2
  component: string; // 3
  message: string; // 4
  timestampdouble?: number; // 5, double
}

export interface LogPayload {
  messages: LogMessage[]; // 1
}

export interface ClientMetric {
  /** One of CLIENT_METRIC_CATEGORY. */
  category: number; // 1
  startFrame: number; // 2, int32
  endFrame: number; // 3, int32
  count: number; // 5, int32
  average: number; // 6, float
  stdDev: number; // 7, float
  minVal: number; // 8, float
  maxVal: number; // 9, float
}

export interface ClientMetricPayload {
  messages: ClientMetric[]; // 1
}

export interface HeaderRequestPayload {
  /** One of HEADER_TYPE. */
  type: number; // 1
}

export interface DebugOption {
  /** One of DEBUG_OPTION_TYPE. */
  type: number; // 1
  overlay?: OverlayPayload; // 2
  bitrate?: BitratePayload; // 3
}

export interface OverlayPayload {
  enable?: boolean; // 1
  toggle?: boolean; // 2
  /** One of OVERLAY_LOG_LOCATION. */
  location?: number; // 3
  level?: number; // 4
}

export interface BitratePayload {
  toggle?: boolean; // 1
  bitrateChange?: number; // 2, float
}

export interface ResolutionPayload {
  width: number; // 1
  height: number; // 2
  videoHeader: Uint8Array; // 3
}

export interface AudioChannelPayload {
  audioChannelType: number; // 1
  audioHeader: Uint8Array; // 2
  isRawPcm?: boolean; // 3
}

export interface StreamInfoPayload {
  resolution: ResolutionPayload[]; // 1
  audioHeader: Uint8Array; // 2
  startTimeout?: number; // 3
  afkTimeout?: number; // 4
  afkTimeoutDisconnect?: number; // 5
  congestionControlInterval?: number; // 6
  audioChannel: AudioChannelPayload[]; // 7
}

export interface XmbCommandPayload {
  /** One of XMB_COMMAND. */
  command: number; // 1
  playerId?: number; // 2
}

export interface ConnectionQualityPayload {
  targetBitrate?: number; // 1
  upstreamBitrate?: number; // 2
  upstreamLoss?: number; // 3, float
  disableUpstreamAudio?: boolean; // 4
  rtt?: number; // 5, double
  loss?: bigint; // 6, uint64
}

export interface PlayTimeLeftPayload {
  timeLeft?: number; // 1
  reason?: string; // 2
}

export interface ServerMessagePayload {
  payload?: string; // 1
}

export interface ControllerConnectionPayload {
  controllerId?: number; // 1, int32
  connected?: boolean; // 2
  /** One of CONTROLLER_TYPE. */
  controllerType?: number; // 3
}

export interface ClientInfoPayload {
  sessionKey: string; // 1
  gcmTag?: number; // 2
  keyPos?: number; // 3
}

export interface VideoCapturePayload {
  serverSide?: boolean; // 1, default false
  idrPeriod?: number; // 2, default 0
}

export interface AudioCapturePayload {
  serverSide?: boolean; // 1, default false
}

export interface ServerSettingsPayload {
  idrPeriod?: number; // 1, default 0
  sendPeriodicTimestamp?: boolean; // 2, default false
}

export interface GkTracePayload {
  seqNo: number; // 1
  gcmTag: number; // 2
  keyPos: number; // 3
}

export interface PeriodicTimestampPayload {
  periodicTsInfo: Uint8Array; // 1
  version: number; // 2
}

/** Not a field of TakionMessage: travels as the `data` bytes of a DirectMessagePayload. */
export interface DeepLinkPayload {
  /** One of DEEP_LINK_TYPE. */
  deepLinkType: number; // 1
  requestId?: number; // 2
  padUniqueId?: number; // 3
  invitationId?: string; // 4
  sessionId?: string; // 5
  itemId?: string; // 6
  isSystemUiOverlaid?: string; // 7
  result?: number; // 8
  shouldShow?: boolean; // 9
  rawData?: string; // 10
}

/** Not a field of TakionMessage: travels as the `data` bytes of a DirectMessagePayload. */
export interface MicInfoPayload {
  /** One of MIC_INFO_TYPE. */
  micInfoType: number; // 1
  controllerId?: number; // 2
  connected?: boolean; // 3
  muted?: boolean; // 4
  result?: boolean; // 5
}

export interface DirectMessagePayload {
  /** One of DIRECT_MESSAGE_TYPE. */
  directMessageType: number; // 1
  /** One of DIRECT_MESSAGE_DESTINATION. */
  destination: number; // 2
  data?: Uint8Array; // 3
}

export interface MicConnectionPayload {
  controllerId: number; // 1, int32
  connected: boolean; // 2
  result?: boolean; // 3
}

export interface TakionProtocolRequestPayload {
  supportedTakionVersions: number[]; // 1
}

export interface TakionProtocolRequestAckPayload {
  takionProtocolVersion?: number; // 1
}

export interface SenkushaPayload {
  /** One of SENKUSHA_COMMAND. */
  command: number; // 1
  echoCommand?: SenkushaEchoCommand; // 2
  mtuCommand?: SenkushaMtuCommand; // 3
  bandwidthCommand?: SenkushaBandwidthCommand; // 4
  clientMtuCommand?: SenkushaClientMtuCommand; // 5
}

export interface SenkushaEchoCommand {
  state: boolean; // 1
}

export interface SenkushaMtuCommand {
  id: number; // 1
  mtuReq: number; // 2
  mtuSent?: number; // 3
  num?: number; // 4
  sendDelay?: number; // 5
  delta?: number; // 6
}

export interface SenkushaBandwidthCommand {
  id: number; // 1
  time: number; // 2
  bandwidth?: number; // 3
  fps?: number; // 4
  mtu?: number; // 5
  naluCount?: number; // 6
  totalSent?: number; // 7
  upstream?: boolean; // 8
  loss?: number; // 9, double
}

export interface SenkushaClientMtuCommand {
  id: number; // 1
  mtuReq: number; // 2
  state: boolean; // 3
  mtuDown?: number; // 4
}

/** Every message of takion.proto by its name there. */
export interface TakionProtoMessages {
  TakionMessage: TakionMessage;
  EventCode: EventCode;
  BigPayload: BigPayload;
  BangPayload: BangPayload;
  InfoPayload: InfoPayload;
  CursorPayload: CursorPayload;
  TimerPayload: TimerPayload;
  CorruptFramePayload: CorruptFramePayload;
  PacketLossPayload: PacketLossPayload;
  FpsChangePayload: FpsChangePayload;
  DisconnectPayload: DisconnectPayload;
  LogMessage: LogMessage;
  LogPayload: LogPayload;
  ClientMetric: ClientMetric;
  ClientMetricPayload: ClientMetricPayload;
  HeaderRequestPayload: HeaderRequestPayload;
  DebugOption: DebugOption;
  OverlayPayload: OverlayPayload;
  BitratePayload: BitratePayload;
  ResolutionPayload: ResolutionPayload;
  AudioChannelPayload: AudioChannelPayload;
  StreamInfoPayload: StreamInfoPayload;
  XmbCommandPayload: XmbCommandPayload;
  ConnectionQualityPayload: ConnectionQualityPayload;
  PlayTimeLeftPayload: PlayTimeLeftPayload;
  ServerMessagePayload: ServerMessagePayload;
  ControllerConnectionPayload: ControllerConnectionPayload;
  ClientInfoPayload: ClientInfoPayload;
  VideoCapturePayload: VideoCapturePayload;
  AudioCapturePayload: AudioCapturePayload;
  ServerSettingsPayload: ServerSettingsPayload;
  GkTracePayload: GkTracePayload;
  PeriodicTimestampPayload: PeriodicTimestampPayload;
  DeepLinkPayload: DeepLinkPayload;
  MicInfoPayload: MicInfoPayload;
  DirectMessagePayload: DirectMessagePayload;
  MicConnectionPayload: MicConnectionPayload;
  TakionProtocolRequestPayload: TakionProtocolRequestPayload;
  TakionProtocolRequestAckPayload: TakionProtocolRequestAckPayload;
  SenkushaPayload: SenkushaPayload;
  SenkushaEchoCommand: SenkushaEchoCommand;
  SenkushaMtuCommand: SenkushaMtuCommand;
  SenkushaBandwidthCommand: SenkushaBandwidthCommand;
  SenkushaClientMtuCommand: SenkushaClientMtuCommand;
}

export type TakionProtoMessageName = keyof TakionProtoMessages;

// ------------------------------------------------------------------ schema

export type TakionProtoScalarType = 'uint32' | 'int32' | 'int64' | 'uint64' | 'bool' | 'enum' | 'float' | 'double' | 'string' | 'bytes';
export type TakionProtoFieldLabel = 'required' | 'optional' | 'repeated';

export interface TakionProtoField {
  /** Field number on the wire. */
  number: number;
  /** Property name in the TypeScript object (the .proto name in camelCase). */
  name: string;
  label: TakionProtoFieldLabel;
  /** A scalar type, or the name of a message. */
  type: TakionProtoScalarType | TakionProtoMessageName;
}

const req = (number: number, name: string, type: TakionProtoField['type']): TakionProtoField => ({ number, name, label: 'required', type });
const opt = (number: number, name: string, type: TakionProtoField['type']): TakionProtoField => ({ number, name, label: 'optional', type });
const rep = (number: number, name: string, type: TakionProtoField['type']): TakionProtoField => ({ number, name, label: 'repeated', type });

/** The fields of every message, in field number order. Transcribed from takion.proto. */
export const TAKION_PROTO_SCHEMAS: Record<TakionProtoMessageName, readonly TakionProtoField[]> = {
  TakionMessage: [
    req(1, 'type', 'enum'),
    opt(2, 'bigPayload', 'BigPayload'),
    opt(3, 'bangPayload', 'BangPayload'),
    opt(4, 'infoPayload', 'InfoPayload'),
    opt(5, 'lossPayload', 'PacketLossPayload'),
    opt(6, 'corruptPayload', 'CorruptFramePayload'),
    opt(8, 'cursorPayload', 'CursorPayload'),
    opt(9, 'timerPayload', 'TimerPayload'),
    opt(10, 'disconnectPayload', 'DisconnectPayload'),
    opt(11, 'logPayload', 'LogPayload'),
    opt(12, 'headerPayload', 'HeaderRequestPayload'),
    opt(13, 'debugPayload', 'DebugOption'),
    opt(14, 'senkushaPayload', 'SenkushaPayload'),
    opt(15, 'streamInfoPayload', 'StreamInfoPayload'),
    opt(16, 'xmbCommandPayload', 'XmbCommandPayload'),
    opt(17, 'connectionQualityPayload', 'ConnectionQualityPayload'),
    opt(18, 'clientMetricPayload', 'ClientMetricPayload'),
    opt(19, 'playTimeLeftPayload', 'PlayTimeLeftPayload'),
    opt(20, 'serverMessagePayload', 'ServerMessagePayload'),
    opt(21, 'fpsChangePayload', 'FpsChangePayload'),
    opt(22, 'controllerConnectionPayload', 'ControllerConnectionPayload'),
    opt(23, 'clientInfoPayload', 'ClientInfoPayload'),
    opt(24, 'videoCapturePayload', 'VideoCapturePayload'),
    opt(25, 'audioCapturePayload', 'AudioCapturePayload'),
    opt(26, 'gkTracePayload', 'GkTracePayload'),
    opt(27, 'periodicTimestampPayload', 'PeriodicTimestampPayload'),
    opt(28, 'serverSettingsPayload', 'ServerSettingsPayload'),
    opt(29, 'directMessagePayload', 'DirectMessagePayload'),
    opt(30, 'micConnectionPayload', 'MicConnectionPayload'),
    opt(31, 'takionProtocolRequest', 'TakionProtocolRequestPayload'),
    opt(32, 'takionProtocolRequestAck', 'TakionProtocolRequestAckPayload'),
  ],
  EventCode: [req(1, 'eventCode', 'string'), opt(2, 'name', 'string'), opt(3, 'description', 'string')],
  BigPayload: [
    req(1, 'clientVersion', 'uint32'),
    req(2, 'sessionKey', 'string'),
    req(3, 'launchSpec', 'string'),
    req(4, 'encryptedKey', 'bytes'),
    opt(5, 'ecdhPubKey', 'bytes'),
    opt(6, 'ecdhSig', 'bytes'),
  ],
  BangPayload: [
    req(1, 'serverVersion', 'uint32'),
    req(2, 'token', 'uint32'),
    req(3, 'encryptedKeyAccepted', 'bool'),
    req(4, 'versionAccepted', 'bool'),
    req(5, 'sessionKey', 'string'),
    opt(6, 'extendedInfo', 'EventCode'),
    opt(7, 'serverVersionString', 'string'),
    opt(8, 'ecdhPubKey', 'bytes'),
    opt(9, 'ecdhSig', 'bytes'),
  ],
  InfoPayload: [
    req(1, 'effectiveBw', 'uint32'),
    req(2, 'bitrate', 'uint32'),
    req(3, 'minBitrate', 'uint32'),
    req(4, 'targetBitrate', 'uint32'),
    req(5, 'corruptFrameFreq', 'uint32'),
    req(6, 'mtu', 'uint32'),
    req(7, 'fps', 'uint32'),
    req(8, 'monitorInterval', 'uint32'),
    req(9, 'extOverhead', 'uint32'),
    req(10, 'intOverhead', 'uint32'),
    req(11, 'timeoutInterval', 'uint32'),
    req(12, 'minResumeQuality', 'uint32'),
    req(13, 'minFps', 'uint32'),
  ],
  CursorPayload: [
    req(1, 'id', 'uint32'),
    req(2, 'width', 'uint32'),
    req(3, 'height', 'uint32'),
    req(4, 'hotspotX', 'uint32'),
    req(5, 'hotspotY', 'uint32'),
    opt(6, 'pixels', 'bytes'),
  ],
  TimerPayload: [req(1, 'secondsLeft', 'uint32'), req(2, 'totalSeconds', 'uint32')],
  CorruptFramePayload: [req(1, 'start', 'uint32'), req(2, 'end', 'uint32')],
  PacketLossPayload: [req(1, 'start', 'uint32'), req(2, 'end', 'uint32'), req(3, 'packetsReceived', 'uint32')],
  FpsChangePayload: [req(1, 'fps', 'uint32')],
  DisconnectPayload: [req(1, 'reason', 'string'), opt(2, 'extendedInfo', 'EventCode')],
  LogMessage: [
    req(1, 'timestamp', 'int64'),
    req(2, 'level', 'enum'),
    req(3, 'component', 'string'),
    req(4, 'message', 'string'),
    opt(5, 'timestampdouble', 'double'),
  ],
  LogPayload: [rep(1, 'messages', 'LogMessage')],
  ClientMetric: [
    req(1, 'category', 'enum'),
    req(2, 'startFrame', 'int32'),
    req(3, 'endFrame', 'int32'),
    req(5, 'count', 'int32'),
    req(6, 'average', 'float'),
    req(7, 'stdDev', 'float'),
    req(8, 'minVal', 'float'),
    req(9, 'maxVal', 'float'),
  ],
  ClientMetricPayload: [rep(1, 'messages', 'ClientMetric')],
  HeaderRequestPayload: [req(1, 'type', 'enum')],
  DebugOption: [req(1, 'type', 'enum'), opt(2, 'overlay', 'OverlayPayload'), opt(3, 'bitrate', 'BitratePayload')],
  OverlayPayload: [opt(1, 'enable', 'bool'), opt(2, 'toggle', 'bool'), opt(3, 'location', 'enum'), opt(4, 'level', 'uint32')],
  BitratePayload: [opt(1, 'toggle', 'bool'), opt(2, 'bitrateChange', 'float')],
  ResolutionPayload: [req(1, 'width', 'uint32'), req(2, 'height', 'uint32'), req(3, 'videoHeader', 'bytes')],
  AudioChannelPayload: [req(1, 'audioChannelType', 'uint32'), req(2, 'audioHeader', 'bytes'), opt(3, 'isRawPcm', 'bool')],
  StreamInfoPayload: [
    rep(1, 'resolution', 'ResolutionPayload'),
    req(2, 'audioHeader', 'bytes'),
    opt(3, 'startTimeout', 'uint32'),
    opt(4, 'afkTimeout', 'uint32'),
    opt(5, 'afkTimeoutDisconnect', 'uint32'),
    opt(6, 'congestionControlInterval', 'uint32'),
    rep(7, 'audioChannel', 'AudioChannelPayload'),
  ],
  XmbCommandPayload: [req(1, 'command', 'enum'), opt(2, 'playerId', 'uint32')],
  ConnectionQualityPayload: [
    opt(1, 'targetBitrate', 'uint32'),
    opt(2, 'upstreamBitrate', 'uint32'),
    opt(3, 'upstreamLoss', 'float'),
    opt(4, 'disableUpstreamAudio', 'bool'),
    opt(5, 'rtt', 'double'),
    opt(6, 'loss', 'uint64'),
  ],
  PlayTimeLeftPayload: [opt(1, 'timeLeft', 'uint32'), opt(2, 'reason', 'string')],
  ServerMessagePayload: [opt(1, 'payload', 'string')],
  ControllerConnectionPayload: [opt(1, 'controllerId', 'int32'), opt(2, 'connected', 'bool'), opt(3, 'controllerType', 'enum')],
  ClientInfoPayload: [req(1, 'sessionKey', 'string'), opt(2, 'gcmTag', 'uint32'), opt(3, 'keyPos', 'uint32')],
  VideoCapturePayload: [opt(1, 'serverSide', 'bool'), opt(2, 'idrPeriod', 'uint32')],
  AudioCapturePayload: [opt(1, 'serverSide', 'bool')],
  ServerSettingsPayload: [opt(1, 'idrPeriod', 'uint32'), opt(2, 'sendPeriodicTimestamp', 'bool')],
  GkTracePayload: [req(1, 'seqNo', 'uint32'), req(2, 'gcmTag', 'uint32'), req(3, 'keyPos', 'uint32')],
  PeriodicTimestampPayload: [req(1, 'periodicTsInfo', 'bytes'), req(2, 'version', 'uint32')],
  DeepLinkPayload: [
    req(1, 'deepLinkType', 'enum'),
    opt(2, 'requestId', 'uint32'),
    opt(3, 'padUniqueId', 'uint32'),
    opt(4, 'invitationId', 'string'),
    opt(5, 'sessionId', 'string'),
    opt(6, 'itemId', 'string'),
    opt(7, 'isSystemUiOverlaid', 'string'),
    opt(8, 'result', 'uint32'),
    opt(9, 'shouldShow', 'bool'),
    opt(10, 'rawData', 'string'),
  ],
  MicInfoPayload: [
    req(1, 'micInfoType', 'enum'),
    opt(2, 'controllerId', 'uint32'),
    opt(3, 'connected', 'bool'),
    opt(4, 'muted', 'bool'),
    opt(5, 'result', 'bool'),
  ],
  DirectMessagePayload: [req(1, 'directMessageType', 'enum'), req(2, 'destination', 'enum'), opt(3, 'data', 'bytes')],
  MicConnectionPayload: [req(1, 'controllerId', 'int32'), req(2, 'connected', 'bool'), opt(3, 'result', 'bool')],
  TakionProtocolRequestPayload: [rep(1, 'supportedTakionVersions', 'uint32')],
  TakionProtocolRequestAckPayload: [opt(1, 'takionProtocolVersion', 'uint32')],
  SenkushaPayload: [
    req(1, 'command', 'enum'),
    opt(2, 'echoCommand', 'SenkushaEchoCommand'),
    opt(3, 'mtuCommand', 'SenkushaMtuCommand'),
    opt(4, 'bandwidthCommand', 'SenkushaBandwidthCommand'),
    opt(5, 'clientMtuCommand', 'SenkushaClientMtuCommand'),
  ],
  SenkushaEchoCommand: [req(1, 'state', 'bool')],
  SenkushaMtuCommand: [
    req(1, 'id', 'uint32'),
    req(2, 'mtuReq', 'uint32'),
    opt(3, 'mtuSent', 'uint32'),
    opt(4, 'num', 'uint32'),
    opt(5, 'sendDelay', 'uint32'),
    opt(6, 'delta', 'uint32'),
  ],
  SenkushaBandwidthCommand: [
    req(1, 'id', 'uint32'),
    req(2, 'time', 'uint32'),
    opt(3, 'bandwidth', 'uint32'),
    opt(4, 'fps', 'uint32'),
    opt(5, 'mtu', 'uint32'),
    opt(6, 'naluCount', 'uint32'),
    opt(7, 'totalSent', 'uint32'),
    opt(8, 'upstream', 'bool'),
    opt(9, 'loss', 'double'),
  ],
  SenkushaClientMtuCommand: [req(1, 'id', 'uint32'), req(2, 'mtuReq', 'uint32'), req(3, 'state', 'bool'), opt(4, 'mtuDown', 'uint32')],
};

// ------------------------------------------------------------------ wire format

const WT_VARINT = 0;
const WT_64BIT = 1;
const WT_LEN = 2;
const WT_32BIT = 5;

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

const isScalar = (type: TakionProtoField['type']): type is TakionProtoScalarType =>
  type === 'uint32' || type === 'int32' || type === 'int64' || type === 'uint64' || type === 'bool' || type === 'enum' ||
  type === 'float' || type === 'double' || type === 'string' || type === 'bytes';

function wireTypeOf(type: TakionProtoField['type']): number {
  switch (type) {
    case 'uint32':
    case 'int32':
    case 'int64':
    case 'uint64':
    case 'bool':
    case 'enum':
      return WT_VARINT;
    case 'double':
      return WT_64BIT;
    case 'float':
      return WT_32BIT;
    default:
      return WT_LEN; // string, bytes, messages
  }
}

/** A base 128 varint of an unsigned value below 2^64, least significant group first. */
function pushVarint(out: number[], value: bigint): void {
  let v = value;
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
}

function pushBytes(out: number[], bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]!);
}

function pushScalar(out: number[], where: string, type: TakionProtoScalarType, value: unknown): void {
  const bad = (expected: string): never => {
    throw new TakionProtoError(`${where}: expected ${expected}`);
  };
  switch (type) {
    case 'uint32':
    case 'enum': {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) bad('an integer from 0 to 4294967295');
      pushVarint(out, BigInt(value as number));
      return;
    }
    case 'int32': {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) bad('a 32 bit signed integer');
      pushVarint(out, BigInt.asUintN(64, BigInt(value as number))); // below zero: sign extended, ten bytes
      return;
    }
    case 'int64': {
      if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value))) bad('a bigint (or a safe integer)');
      const v = BigInt(value as bigint | number);
      if (v < I64_MIN || v > I64_MAX) bad('a 64 bit signed integer');
      pushVarint(out, BigInt.asUintN(64, v));
      return;
    }
    case 'uint64': {
      if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value))) bad('a bigint (or a safe integer)');
      const v = BigInt(value as bigint | number);
      if (v < 0n || v > U64_MAX) bad('a 64 bit unsigned integer');
      pushVarint(out, v);
      return;
    }
    case 'bool': {
      if (typeof value !== 'boolean') bad('a boolean');
      out.push(value ? 1 : 0);
      return;
    }
    case 'float': {
      if (typeof value !== 'number') bad('a number');
      const b = Buffer.alloc(4);
      b.writeFloatLE(value as number, 0);
      pushBytes(out, b);
      return;
    }
    case 'double': {
      if (typeof value !== 'number') bad('a number');
      const b = Buffer.alloc(8);
      b.writeDoubleLE(value as number, 0);
      pushBytes(out, b);
      return;
    }
    case 'string': {
      if (typeof value !== 'string') bad('a string');
      const b = Buffer.from(value as string, 'utf8');
      pushVarint(out, BigInt(b.length));
      pushBytes(out, b);
      return;
    }
    case 'bytes': {
      if (!(value instanceof Uint8Array)) bad('a Uint8Array');
      const b = value as Uint8Array;
      pushVarint(out, BigInt(b.length));
      pushBytes(out, b);
      return;
    }
  }
}

function pushValue(out: number[], where: string, field: TakionProtoField, value: unknown): void {
  pushVarint(out, BigInt((field.number << 3) | wireTypeOf(field.type)));
  if (isScalar(field.type)) {
    pushScalar(out, where, field.type, value);
    return;
  }
  const inner: number[] = [];
  pushMessage(inner, field.type, value, where);
  pushVarint(out, BigInt(inner.length));
  for (let i = 0; i < inner.length; i++) out.push(inner[i]!);
}

function pushMessage(out: number[], name: TakionProtoMessageName, msg: unknown, where: string): void {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg) || msg instanceof Uint8Array) throw new TakionProtoError(`${where}: expected a ${name} object`);
  const schema = TAKION_PROTO_SCHEMAS[name];
  const obj = msg as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (obj[key] !== undefined && !schema.some((f) => f.name === key)) throw new TakionProtoError(`${where}: ${name} has no field "${key}"`);
  }
  for (const field of schema) {
    const value = obj[field.name];
    const at = `${where}.${field.name}`;
    if (field.label === 'repeated') {
      if (value === undefined) continue;
      if (!Array.isArray(value)) throw new TakionProtoError(`${at}: expected an array`);
      value.forEach((element, i) => pushValue(out, `${at}[${i}]`, field, element));
    } else if (value === undefined) {
      if (field.label === 'required') throw new TakionProtoError(`${at}: required field is missing`);
    } else {
      pushValue(out, at, field, value);
    }
  }
}

/** Encode any message of takion.proto. Throws TakionProtoError for a missing required field or a value that does not fit. */
export function encodeMessage<K extends TakionProtoMessageName>(name: K, msg: TakionProtoMessages[K]): Buffer {
  if (!Object.hasOwn(TAKION_PROTO_SCHEMAS, name)) throw new TakionProtoError(`unknown message ${String(name)}`);
  const out: number[] = [];
  pushMessage(out, name, msg, name);
  return Buffer.from(out);
}

export interface TakionProtoDecodeOptions {
  /** Accept a message that lacks required fields (nanopb, and so the reference, refuses it). Default false. */
  lenient?: boolean;
}

interface Reader {
  buf: Uint8Array;
  pos: number;
  end: number;
}

function readVarint(r: Reader): bigint {
  let result = 0n;
  for (let i = 0; i < 10; i++) {
    if (r.pos >= r.end) throw new TakionProtoError('truncated varint');
    const byte = r.buf[r.pos++]!;
    if (i === 9 && (byte & 0xfe) !== 0) throw new TakionProtoError('varint overflow');
    result |= BigInt(byte & 0x7f) << BigInt(7 * i);
    if ((byte & 0x80) === 0) return result;
  }
  throw new TakionProtoError('varint overflow');
}

function readLength(r: Reader): number {
  const len = readVarint(r);
  if (len > BigInt(r.end - r.pos)) throw new TakionProtoError('length runs past the end of the message');
  return Number(len);
}

function take(r: Reader, n: number): Uint8Array {
  if (n > r.end - r.pos) throw new TakionProtoError('truncated message');
  const bytes = r.buf.subarray(r.pos, r.pos + n);
  r.pos += n;
  return bytes;
}

function skipField(r: Reader, wireType: number): void {
  switch (wireType) {
    case WT_VARINT:
      readVarint(r);
      return;
    case WT_64BIT:
      take(r, 8);
      return;
    case WT_LEN:
      take(r, readLength(r));
      return;
    case WT_32BIT:
      take(r, 4);
      return;
    default:
      throw new TakionProtoError(`invalid wire type ${wireType}`);
  }
}

/** One value of a varint, fixed32 or fixed64 scalar (the reader is positioned on it). */
function readNumeric(r: Reader, where: string, type: TakionProtoScalarType): unknown {
  switch (type) {
    case 'uint32':
    case 'enum': {
      const v = readVarint(r);
      if (v > 0xffffffffn) throw new TakionProtoError(`${where}: integer too large`);
      return Number(v);
    }
    case 'int32':
      return Number(BigInt.asIntN(32, readVarint(r))); // nanopb: (int32_t)value
    case 'int64':
      return BigInt.asIntN(64, readVarint(r));
    case 'uint64':
      return readVarint(r);
    case 'bool':
      return readVarint(r) !== 0n;
    case 'float': {
      const b = take(r, 4);
      return Buffer.from(b.buffer, b.byteOffset, 4).readFloatLE(0);
    }
    case 'double': {
      const b = take(r, 8);
      return Buffer.from(b.buffer, b.byteOffset, 8).readDoubleLE(0);
    }
    default:
      throw new TakionProtoError(`${where}: not a numeric type`);
  }
}

function readMessage(r: Reader, name: TakionProtoMessageName, target: Record<string, unknown>, where: string, lenient: boolean): void {
  const schema = TAKION_PROTO_SCHEMAS[name];
  for (const field of schema) {
    if (field.label === 'repeated' && target[field.name] === undefined) target[field.name] = [];
  }
  const seen = new Set<number>();

  while (r.pos < r.end) {
    const tag = readVarint(r);
    if (tag > 0xffffffffn) throw new TakionProtoError(`${where}: tag too large`);
    const number = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (number === 0) throw new TakionProtoError(`${where}: zero tag`);

    const field = schema.find((f) => f.number === number);
    if (!field) {
      skipField(r, wireType);
      continue;
    }
    const at = `${where}.${field.name}`;
    seen.add(number);

    let value: unknown;
    if (!isScalar(field.type)) {
      if (wireType !== WT_LEN) throw new TakionProtoError(`${at}: wrong wire type`);
      const len = readLength(r);
      const sub: Reader = { buf: r.buf, pos: r.pos, end: r.pos + len };
      r.pos += len;
      // A second occurrence of a non-repeated sub-message is merged into the first, as protobuf (and nanopb) do.
      const existing = field.label === 'repeated' ? undefined : target[field.name];
      const obj = (existing as Record<string, unknown> | undefined) ?? {};
      readMessage(sub, field.type, obj, at, lenient);
      value = obj;
    } else if (field.type === 'string' || field.type === 'bytes') {
      if (wireType !== WT_LEN) throw new TakionProtoError(`${at}: wrong wire type`);
      const bytes = Buffer.from(take(r, readLength(r))); // a copy: it must outlive the datagram it came in
      value = field.type === 'string' ? bytes.toString('utf8') : bytes;
    } else if (wireType === WT_LEN && field.label === 'repeated') {
      // packed repeated scalars
      const len = readLength(r);
      const sub: Reader = { buf: r.buf, pos: r.pos, end: r.pos + len };
      r.pos += len;
      const list = target[field.name] as unknown[];
      while (sub.pos < sub.end) list.push(readNumeric(sub, at, field.type));
      continue;
    } else {
      if (wireType !== wireTypeOf(field.type)) throw new TakionProtoError(`${at}: wrong wire type`);
      value = readNumeric(r, at, field.type);
    }

    if (field.label === 'repeated') (target[field.name] as unknown[]).push(value);
    else target[field.name] = value;
  }

  if (!lenient) {
    for (const field of schema) {
      if (field.label === 'required' && !seen.has(field.number)) throw new TakionProtoError(`${where}.${field.name}: missing required field`);
    }
  }
}

/** Decode any message of takion.proto. Throws TakionProtoError for malformed input or a missing required field. */
export function decodeMessage<K extends TakionProtoMessageName>(name: K, buf: Uint8Array, opts: TakionProtoDecodeOptions = {}): TakionProtoMessages[K] {
  if (!Object.hasOwn(TAKION_PROTO_SCHEMAS, name)) throw new TakionProtoError(`unknown message ${String(name)}`);
  const target: Record<string, unknown> = {};
  readMessage({ buf, pos: 0, end: buf.length }, name, target, name, opts.lenient === true);
  return target as unknown as TakionProtoMessages[K];
}

/** Encode the envelope every Takion protobuf data message uses. */
export function encodeTakionMessage(msg: TakionMessage): Buffer {
  return encodeMessage('TakionMessage', msg);
}

/** Decode the envelope every Takion protobuf data message uses. */
export function decodeTakionMessage(buf: Uint8Array, opts: TakionProtoDecodeOptions = {}): TakionMessage {
  return decodeMessage('TakionMessage', buf, opts);
}
