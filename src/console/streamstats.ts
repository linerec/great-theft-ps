// SPDX-License-Identifier: AGPL-3.0-only
//
// Measurements of a running stream, kept so the delivery can be studied and compared: where frames are lost, how often
// forward error correction saves one, how evenly frames arrive, what is reported back to the console.
//
// This is this project's own instrumentation (it has no counterpart in the reference client). It is plain bookkeeping:
// counters for the whole session, one sample per second for the last ten minutes, and a list of notable events.
// Nothing here contains picture data, keys or identifiers.

export interface StreamTotals {
  frames: number;
  keyFrames: number;
  bytes: number;
  /** Frames the receiver gave up on (never delivered). */
  framesLost: number;
  /** Frames delivered only because FEC rebuilt missing units. */
  fecRecovered: number;
  /** Times a range of broken frames was reported to the console. */
  corruptReports: number;
  /** Times a key frame was asked for. */
  idrRequests: number;
  /** Media units counted by the receiver, as last reported to the console. */
  unitsReceived: number;
  unitsLost: number;
  /** Longest gap between two delivered frames, in ms. A long gap is a visible stutter. */
  maxFrameGapMs: number;
  /** Gaps longer than `stutterThresholdMs`. */
  stutters: number;
  /** The longest time from the first packet of a frame to the complete frame, in ms. */
  maxAssemblyMs: number;
}

export interface StreamSample {
  /** Seconds since the stream started (start of this one second window). */
  t: number;
  frames: number;
  keyFrames: number;
  bytes: number;
  framesLost: number;
  fecRecovered: number;
  corruptReports: number;
  idrRequests: number;
  unitsReceived: number;
  unitsLost: number;
  /** Loss ratio reported to the console in this window (after any clamp), 0..1. */
  lossReported: number;
  /** Mean and standard deviation of the gaps between delivered frames in this window, ms. The deviation is the jitter. */
  frameGapMeanMs: number;
  frameGapJitterMs: number;
  frameGapMaxMs: number;
  /** From the first packet of a frame to the complete frame: mean and longest in this window, in ms. Spread-out frames add delay before anything can be shown. */
  assemblyMeanMs: number;
  assemblyMaxMs: number;
  /** The longest time this process kept the event loop from running in this window, in ms (approximate). Tells a hitch made here from one that came from the network. */
  loopDelayMaxMs: number;
}

export interface StreamEvent {
  /** Milliseconds since the stream started. */
  t: number;
  kind: string;
  detail?: string;
}

const emptyTotals = (): StreamTotals => ({ frames: 0, keyFrames: 0, bytes: 0, framesLost: 0, fecRecovered: 0, corruptReports: 0, idrRequests: 0, unitsReceived: 0, unitsLost: 0, maxFrameGapMs: 0, stutters: 0, maxAssemblyMs: 0 });
const SAMPLES_KEPT = 600;
const EVENTS_KEPT = 500;

export class StreamStats {
  readonly startedAtMs: number;
  totals: StreamTotals = emptyTotals();
  /** How long each stage of setting the stream up took, in ms since the start. */
  stages: Record<string, number> = {};
  samples: StreamSample[] = [];
  events: StreamEvent[] = [];
  /** The sound: what the console announced, and how many Opus frames arrived or had to be given up as lost. */
  audio: { header: { channels: number; bits: number; rate: number; frameSize: number } | null; frames: number; concealed: number; bytes: number } = { header: null, frames: 0, concealed: 0, bytes: 0 };
  /** A gap between frames longer than this counts as a stutter. Default: 2.5 frame times at 60 fps; the stream connection sets it from the frame rate it asks for. */
  stutterThresholdMs = 42;
  /** Asked once per window for the longest event loop delay since the last call, in ms. Set by the owner of the stream. */
  loopDelayProbe: (() => number) | null = null;

  #now: () => number;
  #window: StreamSample;
  #gapSum = 0;
  #gapSumSq = 0;
  #gapCount = 0;
  #assemblySum = 0;
  #assemblyCount = 0;
  #lastFrameAt = 0;
  #lostReported = 0;
  #totalReported = 0;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.startedAtMs = now();
    this.#window = this.#blank(0);
  }

  #blank(t: number): StreamSample {
    return { t, frames: 0, keyFrames: 0, bytes: 0, framesLost: 0, fecRecovered: 0, corruptReports: 0, idrRequests: 0, unitsReceived: 0, unitsLost: 0, lossReported: 0, frameGapMeanMs: 0, frameGapJitterMs: 0, frameGapMaxMs: 0, assemblyMeanMs: 0, assemblyMaxMs: 0, loopDelayMaxMs: 0 };
  }

  #elapsed(): number {
    return this.#now() - this.startedAtMs;
  }

  /** Close every one second window that has ended. Called on every update and by the owner's timer. */
  tick(): void {
    const second = Math.floor(this.#elapsed() / 1000);
    while (this.#window.t < second) {
      const w = this.#window;
      if (this.#gapCount > 0) {
        const mean = this.#gapSum / this.#gapCount;
        w.frameGapMeanMs = round(mean);
        w.frameGapJitterMs = round(Math.sqrt(Math.max(0, this.#gapSumSq / this.#gapCount - mean * mean)));
      }
      if (this.#assemblyCount > 0) w.assemblyMeanMs = round(this.#assemblySum / this.#assemblyCount);
      if (this.loopDelayProbe) w.loopDelayMaxMs = round(this.loopDelayProbe());
      w.lossReported = this.#totalReported > 0 ? round(this.#lostReported / this.#totalReported, 4) : 0;
      this.samples.push(w);
      if (this.samples.length > SAMPLES_KEPT) this.samples.shift();
      this.#window = this.#blank(w.t + 1);
      this.#gapSum = this.#gapSumSq = this.#gapCount = 0;
      this.#assemblySum = this.#assemblyCount = 0;
      this.#lostReported = this.#totalReported = 0;
    }
  }

  stage(name: string): void {
    this.stages[name] = Math.round(this.#elapsed());
    this.event('stage', name);
  }

  event(kind: string, detail?: string): void {
    this.events.push({ t: Math.round(this.#elapsed()), kind, ...(detail !== undefined ? { detail } : {}) });
    if (this.events.length > EVENTS_KEPT) this.events.shift();
  }

  frame(bytes: number, info: { keyFrame: boolean; fecRecovered: boolean; framesLost: number; assemblyMs?: number }): void {
    this.tick();
    const now = this.#now();
    const w = this.#window;
    if (this.totals.frames === 0) this.stage('first-frame');
    if (this.#lastFrameAt > 0) {
      const gap = now - this.#lastFrameAt;
      this.#gapSum += gap;
      this.#gapSumSq += gap * gap;
      this.#gapCount++;
      if (gap > w.frameGapMaxMs) w.frameGapMaxMs = round(gap);
      if (gap > this.totals.maxFrameGapMs) this.totals.maxFrameGapMs = round(gap);
      if (gap > this.stutterThresholdMs) {
        this.totals.stutters++;
        this.event('stutter', `${Math.round(gap)} ms between frames`);
      }
    }
    this.#lastFrameAt = now;
    if (info.assemblyMs !== undefined && info.assemblyMs >= 0) {
      this.#assemblySum += info.assemblyMs;
      this.#assemblyCount++;
      if (info.assemblyMs > w.assemblyMaxMs) w.assemblyMaxMs = round(info.assemblyMs);
      if (info.assemblyMs > this.totals.maxAssemblyMs) this.totals.maxAssemblyMs = round(info.assemblyMs);
    }
    for (const t of [this.totals, w]) {
      t.frames++;
      t.bytes += bytes;
      if (info.keyFrame) t.keyFrames++;
      if (info.fecRecovered) t.fecRecovered++;
      t.framesLost += Math.max(0, info.framesLost); // the reference's value can go negative across the 16 bit wrap
    }
    if (info.framesLost > 0) this.event('frames-lost', String(info.framesLost));
  }

  corruptReport(start: number, end: number): void {
    this.tick();
    this.totals.corruptReports++;
    this.#window.corruptReports++;
    this.event('corrupt-report', `${start}..${end}`);
  }

  idrRequest(): void {
    this.tick();
    this.totals.idrRequests++;
    this.#window.idrRequests++;
    this.event('idr-request');
  }

  /** What was counted in one congestion interval, and what was reported to the console after the clamp. */
  congestion(received: number, lost: number, reportedLost: number): void {
    this.tick();
    for (const t of [this.totals, this.#window]) {
      t.unitsReceived += received;
      t.unitsLost += lost;
    }
    this.#lostReported += reportedLost;
    this.#totalReported += received + lost;
    if (lost > 0) this.event('units-lost', `${lost} of ${received + lost}${reportedLost !== lost ? `, reported ${reportedLost}` : ''}`);
  }

  /** Everything, as plain data. `sampleCount` limits the series to the most recent windows. */
  snapshot(sampleCount = SAMPLES_KEPT): { elapsedMs: number; totals: StreamTotals; audio: StreamStats['audio']; stages: Record<string, number>; samples: StreamSample[]; events: StreamEvent[]; stutterThresholdMs: number } {
    this.tick();
    return {
      elapsedMs: Math.round(this.#elapsed()),
      totals: { ...this.totals },
      audio: { ...this.audio, header: this.audio.header ? { ...this.audio.header } : null },
      stages: { ...this.stages },
      samples: sampleCount > 0 ? this.samples.slice(-sampleCount) : [],
      events: [...this.events],
      stutterThresholdMs: this.stutterThresholdMs,
    };
  }
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
