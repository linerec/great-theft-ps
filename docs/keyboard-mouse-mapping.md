# Keyboard and mouse on a pad's game

This page says how a key press becomes a button press here, why the default is what it is, and what the established
tools do. It ends with the layout that comes built in.

## What the established tools do

Looked at: Steam Input and reWASD (the two most used remappers), XIM and GIMX (adapters that put a mouse on a console),
DS4Windows, and the keyboard layouts that the PC versions of pad games ship with. Sources are at the end.

**1. The plain press is the baseline everywhere.** A key held is a button held. A game that does one thing on a short
press and another on a long press decides that itself, exactly as it does with a pad, and nothing is added to the
delay. Every tool starts there.

**2. "Activators": different actions for different kinds of press of one input.** Steam Input has Regular, Long, Double,
Start, Release and Chorded press; reWASD has Single, Double, Triple, Long, Start and Release. Both document the same
cost: once an input has a long or a double press, the tool cannot know what a press is until it has seen how it ends,
so the plain action is delayed. reWASD's staff say so directly and recommend the Start press (which fires at once) where
that hurts. Default times: 300 ms for a long press in reWASD; Steam's documentation shows 150 ms in its example.
These features come from controllers, where buttons are few. A keyboard has a hundred keys, so the need is smaller.

**3. The reverse matters more on a keyboard: one pad button, two keys.** Console games often put two actions on one
button by press length (tap to reload, hold to pick up). PC players expect two keys. The tools do this with short
macros: a press of fixed length, or a press that is held for a set time. That is what `tap:` and `hold:` are here.

**4. Layers.** "Shift" layers in reWASD, action layers and mode shifts in Steam Input, an aim-down-sights sub-config
with its own sensitivity in XIM. Here: layers with a hold key, or switched on and off by a key.

**5. Mouse to stick.** XIM's guide asks for the game's look sensitivity at maximum and its other aim settings as the
translator expects, and does the rest in its own config; GIMX exposes dead zone, sensitivity and an acceleration
exponent per axis and has a calibration tool for the dead zone; emulators that map a mouse to a stick add dead zone
compensation so that small movements are not swallowed. A stick is a speed, a mouse is a distance, and games bend the
stick's response, so none of them gets an exact match without knowing the game's curve. This project's translation
(dead zone compensation, a response table per game that can be measured, a speed cap, separate scale while aiming) is
described in the README under "How mouse look works".

**6. Layouts.** There is no standard for "pad on a keyboard" (chiaki-ng's own default puts Cross on Enter and the
triggers on number keys, which is fine for menus and awkward in play). What is standard is how PC games lay out the
same actions: WASD to move, the mouse to look, left button to fire or attack, right button to aim, Space to jump or
dodge, Shift to sprint, R to reload, E or F to interact, Tab for the map. The PC versions of pad games follow it
(God of War on PC: left and right click for light and heavy attack, Space to evade, E to interact, Shift to sprint;
GTA V on PC: Shift sprint, Space jump, F enter vehicle, Q cover, R reload).

## What this project does

The default is the plain press for every key. On top of that, per key, and only where a game needs it:

How the button is pressed (the action text):

| Text | What it does | For |
|---|---|---|
| `btn:box`, `trigger:r2`, `stick:left:up` | down exactly as long as the key | everything, by default |
| `tap:box` (or `tap:box:60`) | a press of fixed length (default `keys.tapMs`, 80 ms) when the key goes down, however long the key is held | the "short" half of a button that also has a "long" meaning |
| `hold:box` (or `hold:box:800`) | down while the key is held and at least this long (default `keys.holdMs`, 600 ms) | the "long" half, with a quick key press |
| `latch:l2` | each key press switches it on or off | hold-to-aim as press-to-aim, and the like |
| `turbo:cross` (or `turbo:cross:12`) | pressed over and over while the key is held | games that want a button mashed |
| `toggle:<layer>` | switches a layer on or off | a different layout while driving |
| `a+b` | several of these on one key | |

On which kind of key press (a suffix on the key):

| Key | When | Note |
|---|---|---|
| `KeyG` | the plain press | alone on a key: no delay |
| `KeyG@long` | held for `keys.longPressMs` (300 ms), until let go | |
| `KeyG@double` | the second press within `keys.doublePressMs` (250 ms), while it is held | |
| `KeyG@start` | the moment the key goes down, as a tap | fires whatever follows |
| `KeyG@release` | when the key is let go, as a tap | |

When a key has a `@long` or `@double` binding, its plain binding fires as a tap when the key is let go early (and, with
`@double`, only after the double press time has passed). That is the cost described in point 2, and why the built-in
layout does not use it.

Example, one pad button on two keys:

```json
"KeyR": "tap:box",
"KeyE": "hold:box"
```

Example, one key for two buttons:

```json
"KeyF": "btn:pyramid",
"KeyF@long": "btn:dpad_left"
```

## The built-in layout

General purpose; every key is a plain press. Nothing needed in play makes the left hand leave the WASD area, the keys
are where PC games put the same actions, and keys a browser acts on by itself are left alone (Esc releases the mouse,
Ctrl with W closes the tab, F5 reloads, F11 is full screen).

| Pad | Keys |
|---|---|
| Left stick | W A S D (hold X to walk) |
| Right stick | mouse |
| R2 / L2 | left / right mouse button |
| R1 / L1 | E, mouse forward button / Q, mouse back button |
| Cross | Space, Enter |
| Circle | C, Backspace |
| Square | R |
| Triangle | F |
| L3 / R3 | left Shift / V, middle mouse button |
| D-pad | 1 2 3 4 (up, right, down, left), arrow keys |
| Touchpad button | Tab, M |
| Options | ` (backquote), O |
| Create | T |
| PS | P |

Unbound on purpose: the mouse wheel (what it should do differs too much between games) and G, Z, B, H and the rest of
the keyboard, free for a game's own extras.

Two more come with it: "Shooter example" shows the two-keys-for-one-button idea (R taps Square, E holds it, C taps Circle, Z
holds it), and "GTA V style" holds Shift to tap Cross repeatedly and switches to driving controls with F.

The page's editor (Settings → Input mapping) changes all of this by pressing keys, and saves one profile per game in the browser.
The text form is for sharing.

## In the game's own settings

For the mouse to feel right, set the game's look sensitivity to its maximum and its dead zone to its minimum, and switch
look acceleration or smoothing off where the game has such options. The first is XIM's stated requirement; the other
two follow from how the translation works (the dead zone is compensated here, and acceleration that depends on time
cannot be undone by any translator). Then set the sensitivity in this program.

## Mouse look: distance against speed

A mouse says how far to turn; a stick can only say how fast. When the hand moves faster than the camera may turn (the
profile's speed limit, or the game's own turn rate at full stick), something has to give. This project used to throw
the excess away, as the usual advice for console adapters implies ("you cannot turn faster than the game does"). The
effect, reported from a real game and reproduced in `tools/research/swipe-sim.mjs`: a long quick swipe turns the view a
little and then it stands still. 10 cm in 0.3 s at 1600 DPI asked for 315 degrees and got 116 (37%) even if the game
matched the profile exactly.

Now the excess is carried over (`mouse.carryMs`, default 300): the camera goes on turning at its top speed after the
hand has slowed or stopped, until what was asked has been turned, for at most that long. The same swipe gets 224
degrees (71%), a 5 cm flick 98% instead of 29%. The price is that the camera moves for up to 0.3 s after the hand has
stopped. Turning the hand back cancels what is owed. 0 restores the old behaviour.

Two things make it better still, and neither is done by the program:

- Raise the game's own look sensitivity to its maximum. That raises the ceiling itself, and it is what XIM requires.
- Tell the profile what the game really does (`inGame.maxTurnRateAtFullStick`, `innerDeadzone`). The defaults (360
  deg/s, 10%) are guesses. If the game turns 150 deg/s at full stick, the same mouse movement turns the camera 2.4
  times less than the profile promises, and slow movements may sit inside the game's dead zone and do nothing.
  Steam's documentation names the same two problems for its mouse-as-joystick mode (a minimum output, and "if the game
  has no stick sensitivity settings, there is not much you can do").

**Not built, and the next thing to build for this:** measuring those two numbers on a real console, with the player's
eyes as the sensor. Design: (1) the program holds the right stick fully to one side and the player presses a key
each time the view has gone round once; two or three rounds give the turn rate with the game's own ramp-up averaged
out. (2) The program raises the stick slowly from zero and the player presses a key when the view starts to move: the
dead zone. (3) Optionally the same as (1) at half stick, which gives the response curve. The test beds can already
measure themselves (`src/testbed/measure.ts`); a real game cannot be read, so it has to be done this way.

## Analog values from keys

A pad's sticks and triggers are analog; a key is on or off. What can stand in for depth:

| Way | What it gives | Cost |
|---|---|---|
| A modifier key (hold it: everything is scaled down) | exact, instant levels (walk at 45%) | one more key to hold; a few fixed levels only |
| Time (the value grows while the key is held) | any level, with one key | needs timing; delays the full value |
| Tapping (press and release quickly, repeatedly) | an average level | uneven; depends on how the game smooths |
| An analog keyboard (Hall-effect or optical switches) | real depth per key | special hardware; Chrome and Edge only |
| The mouse as an axis (position, or the wheel as a level) | a real analog axis | the mouse is then not the camera |

What exists elsewhere: emulators use the modifier key (Dolphin's halves the stick), because keyboard keys are "a flat
on/off check". PC versions of pad games add a walk key. Analog keyboards exist (Wooting and others), and a browser can
read their key depth through WebHID (0 to 255 per key), in Chrome and Edge only.

What this project has: the modifier (a layer with `leftStickScale`, the X key by default), fixed amounts per binding
(`stick:left:up:0.5`, `trigger:r2:0.5`), and a short linear ramp on stick keys (`keys.rampUpMs`, 30 ms) that only
smooths. Triggers from keys are all or nothing.

Recommended, in this order (none of it built yet):

1. **Modifier for triggers too** (a layer property like `triggerScale`), so that a held key gives a light pull.
   Exact and instant: the right tool where a game has a half-press.
2. **Time as depth, for a layer** (driving): the trigger value grows while the key is held, over about 250 ms, and
   falls quickly on release. Not linearly: with a linear ramp a 50 ms tap is already 20%, so the low end, where
   control matters, has only a few steps a hand can hit. With the value growing as the square of the time, the same
   taps give 4%, 16%, 36%: fine at the low end, and full value at the same moment. Never as a default for shooters,
   where a trigger must act at once.
3. **The mouse as the steering axis while driving** (a layer where the mouse drives the left stick with a return to
   centre). It is the one analog device a desk has.
4. **Analog keyboards through WebHID**, as an optional input source, for those who have one.

On a touch screen none of this is needed: the stick is a real distance already (see `src/engine/touchpad.ts`).

## Not built

- The mouse wheel as a pulse to a button works (bind `WheelUp`), but there is no default for it.
- Triple press, chorded press (two keys together) other than through layers.
- A full-screen mode with the browser's keyboard lock, which would free Esc and the Ctrl combinations.
- Per-game dead zone and response curve measured on a real console (the test beds can measure their own).

## Sources

- reWASD, Activators: https://help.rewasd.com/basic-functions/activators.html and Press Time: https://help.rewasd.com/preferences/press-time.html
- reWASD forum, delay of the single press when other activators share the button: https://forum.rewasd.com/forum/rewasd/technical-questions-aa/230040-singe-press-input-lag-when-button-have-assigned-a-long-press-double-press
- Steam Input, Activators: https://partner.steamgames.com/doc/features/steam_controller/activators
- XIM guide, Game Settings: https://guide.xim.tech/Game-Settings/ and Aim Settings: https://guide.xim.tech/Aim-Settings/
- GIMX forum, mouse to stick parameters and calibration: https://forum.gimx.fr/viewtopic.php?p=18341
- PCSX2, dead zone compensation for mouse to stick: https://github.com/PCSX2/pcsx2/pull/7885
- reWASD, Advanced Mouse settings: https://help.rewasd.com/basic-functions/advanced-mouse-settings.html
- God of War on PC, default keys: https://shacknews.com/article/128344/god-of-war-pc-keybindings-controls
- GTA V on PC, default keys: https://defkey.com/nl/grand-theft-auto-v-gta-5-shortcuts and https://www.bisecthosting.com/blog/gta-v-controls-guide-pc-playstation-xbox-keyboard-mouse-gamepad
- chiaki-ng's default keyboard map: `gui/src/settings.cpp` in its source
- Dolphin, the modifier key for keyboard-bound sticks: https://bugs.dolphin-emu.org/issues/9218 and https://forums.dolphin-emu.org/Thread-dolphin-gamepad-configuration?pid=241575
- Analog key depth in a browser (WebHID): https://developer.chrome.com/docs/capabilities/hid and https://www.npmjs.com/package/wooting-js
- Steam Input, mouse as joystick and its limits: https://www.pcgamer.com/steam-controller-setup-guide/3/ and https://partner.steamgames.com/doc/features/steam_controller/input_source_modes
