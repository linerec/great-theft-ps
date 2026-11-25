# The player and the interface

What the page does around the picture, where it lives, and how far each part has been checked. Written 2026-11-24.

## What a person sees

**Before the stream.** The picture area shows the console (its name, "켜짐" or "대기 모드"), and one big button in the middle:
"연결" or "깨우고 연결". While it connects the icon breathes and a line says what is happening; when the stream ends the
reason is written in words and the button says "다시 연결". The cards beside it keep the list of consoles, the steps, the
connection options and the route.

**While it plays.** Over the picture, shown when the mouse moves and gone after about three seconds of quiet:

- top left: the console's name, a signal indicator (four bars: frame rate, round trip and stutter in one word) with the
  numbers, and a red mark while a clip is recording;
- a bar at the bottom: disconnect, sound, screenshot, clip, connection numbers with charts, key layout, options
  (quality, display mode, volume, lock, touch pad, how the picture looks), a wider picture, full screen.

While the game has the mouse (a click on the picture locks it) nothing is shown over the picture. **Esc** lets go of the
mouse and brings the bar back at once; after Esc the keyboard is not the game's any more, so the keys below work.

**Keys** (only when the mouse is not locked): `F` full screen, `T` a wider picture, `M` sound, `P` screenshot, `R` clip,
`S` connection, `K` key layout, `G` mouse feel, `O` options, `?` the list. Three keys work while the game has the mouse too
(no layout binds them): `PageUp` / `PageDown` raise and lower the mouse sensitivity by 6 % and say the new value in a toast,
`Home` goes to the next starting point of the mouse feel.

**Mouse feel** (the mouse button in the bar, or `G`). A panel with three starting points, a choice of how the picture is
shown with the delay it has now, and sliders, so that what a mouse feels like can be tried and compared in the game
instead of read about in the settings. The starting points differ in the low-pass filter only: "또렷하게" none, "균형" 12 ms
that fades out between 20 and 40 degrees a second (`mouse.smoothingFadeRate`), "부드럽게" 12 ms at every speed (what the
profile always had). The sliders are the sensitivity, the filter, where it fades out and the carry-over; the profile is what
they change, so the settings page and the saved profile show the same numbers. A profile that is already saved keeps its
values until a starting point is chosen. The panel also starts the measuring of the game's stick response ("게임에 맞게 자동
보정", see `status-and-next.md`) with the game in view, which is where a safe place for the 40 seconds of turning is chosen.

What the starting points do to the stick, in the engine alone (`node tools/research/feel-sim.mjs`; a simulated hand that
makes whole counts, and the profile's own model of the game; no console): at a turn of 120 degrees a second the stick starts
0, 0 and 24 ms after the hand and runs on 0, 0 and 92 ms after it stops; at a slow pan of 3 degrees a second the angle the
game would turn per 16 ms frame varies by 18, 7 and 7 % (it is the fade that gives "균형" the evenness of "부드럽게" and the
speed of "또렷하게"). The carry-over (300 ms in all three) does nothing to a turn the game can follow; it only matters for a
swipe faster than the game turns, where without it a 90 degree swipe turns 55 to 60 degrees and with it about 90.
`mouse-feel-research.md` has the papers and tools this came from.

**Full screen** is the player alone (picture, bar and panels). Where the browser lets a page ask for it, it is the browser's
full screen, with the keyboard locked on Chromium so that Esc only lets go of the mouse (hold it to leave) and Ctrl+W,
Ctrl+R and friends reach the game instead of closing the tab. On a phone it also asks for landscape. Where there is no
full screen for a page (an iPhone), the player covers the window; "Add to Home Screen" is the only real full screen there.

**Other things.** Screenshots (PNG) and clips (WebM, or MP4 where that is all the browser has; up to five minutes; with the
page's sound when it can be taken) are saved to the downloads folder. The picture can be made brighter, more contrasty,
more or less saturated, and fitted by keeping its shape, filling, or stretching. The screen is kept awake while it plays.
A toast says what happened (controller found, screenshot saved, five minutes left). Light, dark or the device's choice
(the button in the header; the page does not flash the other theme on load). A member sees the time left as a bar in the
account menu and gets a word at five minutes and at one. "페이지를 열면 바로 연결" (settings, off by default) connects
by itself when the address is opened. A web app manifest and icons make "Add to Home Screen" / "Install" give an app.

## Where it is

| File | What |
|---|---|
| `web/player-logic.ts` | the decisions, with no DOM: when the bar hides (`HudVisibility`), the signal word (`rateConnection`), clip format, file names, picture look, time left and warnings |
| `web/player-ui.ts` | the part that needs a browser: full screen, the bar and panels, charts, screenshot and clip, sound, the look, hotkeys, wake lock |
| `web/ui.ts` | toasts, settings kept in the browser, the theme |
| `web/ps5.ts` | the console cards, the big button, the text before and after the stream, connecting on open |
| `web/account-ui.ts` | login, the account menu, the time left (counted down only while a stream runs) |
| `web/mouse-feel.ts` | the starting points for the mouse feel, the sensitivity step, and the rule that keeps a movement from being counted twice (`RawMouseGate`) |
| `web/study-ui.ts`, `web/study-session.ts`, `web/study-worker.ts` | the study of the mouse feel (`L`): the panel, the rules of one person's way through it, the analysis off the page's thread (`docs/feel-study.md`) |
| `src/engine/feel-study.ts` | the candidates, the check of a rating, the meter of the hand, what a setting does (by running the engine), the analysis |
| `src/bridge/study-store.ts` | the file of ratings (`GET/POST/DELETE /api/study/ratings`) |
| `tools/research/feel-report.mjs` | the analysis of a file of ratings, in the terminal |
| `web/tester.ts` | the input; exports `stage` (canvas, mouse lock, volume, the sound as a stream) and `mouseFeel` for the player |
| `tools/preview.mjs` | `npm run preview`: the page with a pretend console (and `--accounts`), to look at and try the interface |
| `tools/make-icons.mjs` | `npm run icons`: the PNG icons from `web/icon.svg`, drawn by headless Chrome |

## How far it has been checked

- **Unit tests** (`test/player-logic.test.ts`, `audio-player.test.ts`, `static-files.test.ts`): the bar's timing, the
  signal word, formats and names, the look, the time left and its warnings, the sound as a stream, PNG icons arriving byte
  for byte.
- **The input path** (written 2026-11-25): the mapping engine is stepped by its own 4 ms timer (about 250 a second, checked
  in `npm run e2e`) and no longer inside the 60 Hz drawing, where it was sent in bursts of four ticks a frame apart; mouse
  movement is taken from `pointerrawupdate` where the browser has it (up to a frame sooner than `mousemove`) and from
  `mousemove` otherwise. Checked: the timer's rate and the once-only rule (unit tests), and in headless Chrome that both
  events arrive with the same total for the same movement. **Not checked:** a locked mouse (a browser refuses the lock to
  a script, so it needs a hand), and whether any of this can be felt. The lab's drawing is skipped while the lab is not on
  the page.
- **A real browser against the test double** (`npm run e2e`): the bar is up while connected, its panels open and the options
  move into the player and back, the look reaches the picture, a screenshot and a clip are made, `M` mutes, the full screen
  button covers the page (in headless Chrome the browser's own full screen is refused, so this is the covering path), the
  colour button goes round. Also looked at by eye in Chrome on a Mac and in headless Chrome at phone size.
- **The browser's own full screen with the keyboard locked** was tried once in Chrome on a Mac (full screen, the bar, the
  panels, the toast about Esc). **Not** tried: holding Esc to leave, a real game under keyboard lock.
- **Not tried:** an iPhone (the covering full screen, the bar, "Add to Home Screen" with the manifest), an Android phone
  (landscape lock), a real DualSense, a clip with the sound of a real stream, the wake lock, any of it against the real
  console. The picture the checks used is the test double's.
