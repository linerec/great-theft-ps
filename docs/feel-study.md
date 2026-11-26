# The study of the mouse feel

Written 2026-11-25. The owner said the mouse in GTA V is far from a real keyboard and mouse, asked for many candidate settings
to be made, each to be scored by playing with it, and for the scores to be collected and analysed: "not just a key mapping, a
solution at the level of how the movement behaves in each situation". This is that: a panel to try the candidates and score
them, a server file that keeps the scores, and an analysis that says what the scores point at.

## Doing it

1. In the player press **L** (or the star button in the bar). Optionally pick what you will be doing (on foot, gun aiming,
   sniping, driving). Press **Start**: the mouse locks at once, the panel goes away, and the first candidate is in force.
2. Only its number (`#07`) is shown; the values are behind "Show the values" in the panel, because seeing a number first
   colours the feel. The first three candidates are the old starting points (they teach your own scale), then the rest in a
   fixed shuffled order.
3. Play (turn slowly, snap-turn, aim at something, stop, follow something) for 15 to 30 seconds. Tune the sensitivity with
   `PageUp`/`PageDown` as you like: it is yours, and is recorded with the score.
4. A strip over the picture (visible while the game has the mouse) says which candidate this is, how far along you are, and
   when there has been enough time with the mouse to score it. Then, still with the mouse locked:

   | Key | Does |
   |---|---|
   | `1`–`9`, `0` (or the numpad) | scores the candidate, 1 to 10 (`0` = 10: "1 unusable", "10 as good as a real mouse") **and moves on to the next one** |
   | `Y` `U` `I` `H` `J` `K` | marks what felt off before you score: slow aiming, a fast flick, tracking, stopping, starting, smooth motion (again = take back). Optional |
   | `[` or `Backspace` | undoes the last thing: the score is dropped and that candidate is back |
   | `]` | skips this candidate (it comes back later) |

   A score pressed before there has been 8 s with the mouse is remembered and saved by itself once there has been. With the
   mouse free the panel has the same things as buttons (and a list of what you scored, each can be deleted).
5. Every eighth rating, a candidate already rated comes back (you are not told). The same setting scored twice shows how much
   the scores themselves move; the analysis needs that number to know what a difference means.
6. "Finish" puts the settings you had back (the sensitivity stays). "See the analysis" runs the analysis on what you have so
   far, in the language of the page.

Ten ratings are enough for the first look at the effects, twenty for a model of the best setting. More is better; fifty to a
hundred is a good first round. A rating needs 8 s of the mouse in the game's hands: less is not kept.

## What a rating holds

The score; the situations marked good or bad; what was being played; the values in force (sensitivity, smoothing, fade rate,
carry-over, curve); whether the candidate's values were changed by hand; the picture's playout mode, its delay and the
input-to-picture time; what the engine believed about the game's response (dead zone, full-stick turn rate, curve, and
whether it was a measured table); and how the hand moved during the try (seconds with the mouse locked, and the share of that
time in each hand speed: under 0.5, 5, 20, 60, 150, 400 deg/s and above). Nothing about who you are beyond your account name.

Ratings are kept in the browser (`gtp.study.*`) and sent to the bridge, which keeps them in `<GTP_HOME>/study/feel-ratings.jsonl`
(readable by its user only; at most 2000 per person). Each is checked again by the server (`parseRating`); one that is sent
twice is kept once. The owner can read everybody's (`GET /api/study/ratings?user=all`), a member only their own.
"Copy my scores" puts all of yours on the clipboard as JSON.

## The candidates

The first round (`ROUND_1` in `src/engine/feel-study.ts`, fixed: a rating names its candidate) has 48 settings of four knobs:
smoothing (0–30 ms), the speed at which the smoothing has faded out (15–160 deg/s, or "off"), the carry-over of a swipe the
game cannot turn as fast as (0–600 ms), and the response curve (0.8–1.5). The sensitivity is yours. They are:

- 3 starting points: the three the panel has always offered;
- 8 one-knob-at-a-time variations of the middle one ("Balanced"), each knob lowered and raised: the cleanest way to read what one
  knob does;
- 37 points spread over the rest of the space (a shifted Halton sequence, the farthest from everything chosen so far each time).

## The analysis

`node tools/research/feel-report.mjs <file>` (or "See the analysis" in the panel, which runs it in a worker) prints (`--lang ko` for Korean):

- the candidates, best first, with the situations marked;
- **the noise**: how much the same setting's scores differ (from the repeats). A difference smaller than that is luck;
- **drift**: whether the scores creep up or down as the session goes on (a person's scale moves);
- **effects**: what each knob does to the score over its range, with a 90 % interval from resampling the ratings; an interval
  that does not cross 0 is a real effect;
- **what the filter does against the score**: the engine is run for every setting (`behaviorMetrics`): how late a turn starts
  (at 45 and 120 deg/s), how long the camera runs on after the hand stops, how even a slow pan is, how much of a 90° swipe
  turns, the gain at 15, 45 and 250 deg/s. Two settings with different knobs but the same behaviour get the same explanation,
  which a straight line in the knobs cannot give (smoothing hardly matters where the fade has already taken it away);
- the situations: which way each knob moves "good minus bad" for slow aiming, swipes, following, stopping, starting, evenness;
- two models of the score (by the knobs, and by the behaviours), each scored by how well it predicts ratings it was not fitted
  on (leave-one-out R²); the better one names a best setting, says how much the resamples agree on it, and proposes settings
  for the next round: its best guess, then the ones the data are least sure about among those that could be good.

It says "not enough" instead of guessing: under 10 ratings no effects, under 20 no best setting, and a model that cannot
predict unseen ratings (R² under 0.1) says its best setting should not be trusted.

## What is known and what is not

Tested: the design (48 distinct, in range, deterministic, spread), the rules of the session (score, skip, undo, retest, the 8 s rule), the
check of a rating, the server file and API (whose ratings are whose, limits, damaged lines), the meter of the hand, and the
analysis against a made-up person with a known taste and a little inconsistency (it finds the effects with the right sign, the
right behaviours, a best setting about as good as the best there is, and finds nothing in random scores): 83 unit tests, and the
panel in a real Chrome with a pretend console (`npm run e2e`: the loop, the keys, the server copy, the worker).

**Not known:** whether anyone can tell these candidates apart in GTA V (the whole point); what the scores will look like; the
locked-mouse path (a script cannot give the page a locked mouse, so the number keys and the meter of the hand were exercised
by calling the page's own functions, and the meter by unit tests); a measured game table (the behaviours are computed against
the model the profile has, so with a measured table they are approximate). The round is a first look: the analysis proposes the
second.

## What it can lead to

If the scores say different situations want different things (slow aiming likes smoothing, a swipe likes none, driving likes
more carry-over), the answer is not one setting but a rule: smoothing that depends on speed (the fade rate is the first step of
that), or a feel per layer (aiming, driving, walking), which the profile's layers already allow for the turn rate
(`lookScale`) but not yet for the filter. The situation marks and the scene on each rating are there to show whether that is
needed.
