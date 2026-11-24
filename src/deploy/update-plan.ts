// SPDX-License-Identifier: AGPL-3.0-only
//
// When the bridge that runs on a server (the NAS) takes a newer version of itself from git. This project's own.
//
// The rule, in one place so that it can be tested: a new commit on the branch is taken when
//  - nobody is playing (a stream is never cut for an update; it waits),
//  - it is not one that already failed its start-up check (it is not tried again until the branch moves on), and
//  - it passed that check: the new version was started on the side, on another port with an empty home folder, and
//    answered. Only then is the running copy replaced.
// Anything else leaves the running version alone and says why.

export type UpdateDecision =
  | { action: 'none'; why: 'up-to-date' | 'unknown-remote' }
  | { action: 'wait'; why: 'someone-is-playing' }
  | { action: 'skip'; why: 'known-bad' }
  | { action: 'try'; commit: string };

export interface UpdateState {
  /** The commit that runs now. */
  local: string;
  /** The commit at the head of the branch, or null when git could not say (no network). */
  remote: string | null;
  /** Commits that failed the start-up check. */
  bad: ReadonlySet<string>;
  /** Is a stream running? null when that could not be asked (then nothing is replaced). */
  busy: boolean | null;
}

export function planUpdate(s: UpdateState): UpdateDecision {
  if (!s.remote) return { action: 'none', why: 'unknown-remote' };
  if (s.remote === s.local) return { action: 'none', why: 'up-to-date' };
  if (s.bad.has(s.remote)) return { action: 'skip', why: 'known-bad' };
  if (s.busy !== false) return { action: 'wait', why: 'someone-is-playing' };
  return { action: 'try', commit: s.remote };
}

/** Arguments for the bridge from one line of text (GTP_ARGS): split at spaces; quotes are not needed for the values used. */
export function splitArgs(line: string | undefined): string[] {
  return (line ?? '').split(/\s+/).filter(Boolean);
}

/** A child that keeps dying is given up on (and the container restarts it) instead of being restarted every few seconds forever. */
export function crashLoop(deaths: readonly number[], now: number, windowMs = 60_000, limit = 5): boolean {
  return deaths.filter((t) => now - t < windowMs).length >= limit;
}
