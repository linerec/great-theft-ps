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
`S` connection, `K` key layout, `O` options, `?` the list.

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
| `web/tester.ts` | the input; exports `stage` (canvas, mouse lock, volume, the sound as a stream) for the player |
| `tools/preview.mjs` | `npm run preview`: the page with a pretend console (and `--accounts`), to look at and try the interface |
| `tools/make-icons.mjs` | `npm run icons`: the PNG icons from `web/icon.svg`, drawn by headless Chrome |

## How far it has been checked

- **Unit tests** (`test/player-logic.test.ts`, `audio-player.test.ts`, `static-files.test.ts`): the bar's timing, the
  signal word, formats and names, the look, the time left and its warnings, the sound as a stream, PNG icons arriving byte
  for byte.
- **A real browser against the test double** (`npm run e2e`): the bar is up while connected, its panels open and the options
  move into the player and back, the look reaches the picture, a screenshot and a clip are made, `M` mutes, the full screen
  button covers the page (in headless Chrome the browser's own full screen is refused, so this is the covering path), the
  colour button goes round. Also looked at by eye in Chrome on a Mac and in headless Chrome at phone size.
- **The browser's own full screen with the keyboard locked** was tried once in Chrome on a Mac (full screen, the bar, the
  panels, the toast about Esc). **Not** tried: holding Esc to leave, a real game under keyboard lock.
- **Not tried:** an iPhone (the covering full screen, the bar, "Add to Home Screen" with the manifest), an Android phone
  (landscape lock), a real DualSense, a clip with the sound of a real stream, the wake lock, any of it against the real
  console. The picture the checks used is the test double's.
