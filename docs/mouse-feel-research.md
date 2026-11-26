# Mouse on a pad's game: what the literature and the tools say

Written 2026-11-25, after the owner said that playing GTA V with the mouse "is far from the feel of a real keyboard and
mouse". A web search over papers and tools; each source is marked **V** (opened and read) or **U** (a search snippet or
second hand). Where something could not be found that is said too. The part about what this project took from it is at the end.

## The short version

- There is **no academic literature on converting a mouse to a stick**. What exists is practitioners' documentation and
  the source of emulators.
- **Mean delay matters more than jitter.** Every study found says so; a stick-based mouse adds delay in three places
  (the smoothing filter, the picture's display delay, and turning that is paid back after the hand has stopped).
- **Everyone who does this compensates for the dead zone**, and the **game's own top turn speed is a hard ceiling** (Valve's
  and GIMX's documentation both say it outright). That is the reason a stick mouse can never be exactly a mouse.
- GTA V's look is **not a static table**: it has an acceleration setting that makes the speed ramp up while the stick is held.

## Papers

| Source | What it says | What it means here |
|---|---|---|
| Casiez, Roussel, Vogel: **1 euro filter**, CHI 2012. gery.casiez.net/1euro (V) | A first-order low-pass filter whose cutoff rises with speed: low cutoff at low speed removes jitter, high cutoff at high speed removes lag. Reference code is BSD. | Taken in spirit: `mouse.smoothingFadeRate` (smoothing that fades with speed). |
| Casiez, Roussel: **libpointing**, UIST 2011. github.com/INRIA/libpointing (V) | Replicates the operating systems' pointer transfer functions; GPL-2.0-or-later. | Not used: it is about cursor gain, not stick output. |
| Casiez et al., Human-Computer Interaction 2008 (V) | Pointer acceleration beat constant gain by only 3.3 % overall and 5.6 % on small targets. | Gain shaping (our `curve`) is a small lever. |
| Long, Gutwin: local latency and pointing devices in games, CHI 2019, read in Long's thesis, harvest.usask.ca (V) | Latency became significant at 110 ms for static targets and 60 ms for moving ones. The mouse degraded much more steeply than the controller. | The extra 20 to 80 ms of a stream hits a mouse hardest: every local millisecond counts. |
| Liu et al., CHI 2021 (CS:GO, 43 players), web.cs.wpi.edu/~claypool/papers/csgo-lag-21 (V, abstract) | Even small reductions below 125 ms improved accuracy and score. | Same. |
| Spjut et al., 2021, arxiv.org/abs/2105.10498 (V) | Aiming keeps improving below 20 ms of local delay. | Same. |
| Schmid et al., CHI PLAY 2023, doi.org/10.1145/3611027 (V) | A base delay of 50 against 150 ms mattered; a variation of ±50 ms did not significantly affect FPS performance. | The mean matters more than how even the sending is. |
| Pavlovych, Stuerzlinger, EICS 2009 (V, abstract) | Delay hurts pointing more than low jitter; stronger spatial filtering adds delay. | Same. |
| Zhai: rate control against position control, Buxton's summary page (V) | A free-moving device pairs with position control; with rate control performance is poor, and the self-centring stick automates the return to null. | When the hand stops the stick must return to zero at once. |
| Ramcharitar, Teather, CHI 2017 LBW (V) | Throughput: mouse 4.73 bit/s, touchpad 2.98, gyro 2.85, thumbstick 2.39. | Part of the gap cannot be removed. |
| Cheng et al. 2024, arxiv.org/abs/2411.15538 (V) | 11 people: aim precision mouse, then Xbox controller, then gyro controller. | Same. |

Not found: a paper on mouse-to-stick transfer functions or dead-zone compensation. Aim assist research (Vicencio-Moreira,
CHI 2015) was only seen as a snippet (U).

## Tools and what they do

| Tool | What it does | Licence | For us |
|---|---|---|---|
| JoyShockMapper (V) | **Tiered smoothing**: none on anything faster than a small threshold, full below half of it. `GYRO_SMOOTH_TIME` 0.125 s by default. Flick Stick turns the view by an angle over about 0.1 s. Says the DualSense's stick resolution makes small turns jittery. `REAL_WORLD_CALIBRATION` is our per-game table. | MIT | Taken: the tiering. |
| GyroWiki, Jibb Smart (V) | Displacement is velocity times the measured elapsed time; tightening scales small inputs toward zero rather than cutting them. | text | Ideas. |
| Steam Input, "Mouse Joystick" (V) | The result is "limited by the game's gamepad sensitivity settings": set the in-game camera sensitivity to maximum. "Minimum Joystick Output Value" is an anti-dead-zone; a "Minimum Movement Threshold" collects movement before sending. | proprietary | Matches what we do. |
| GIMX (V) | A developer's words: there is a maximum turning speed in the mouse to stick translation, and nearly every game has its own dead zone and acceleration. Per-game dead zone calibration, circle or rectangle. | GPL-3.0 | Ideas. |
| XIM MATRIX guide (V) | Smoothing that adapts to aim speed; sensitivity in cm per 360; inner, outer and axial dead zones. | proprietary | Ideas. |
| reWASD (V) | Mouse to stick with a response curve, a range, smoothing and a noise filter. | proprietary | Ideas. |
| PCSX2 pull request 7885, closed (V) | The stick position is accumulated and limited to ±1, the overflow is kept and multiplied by an "inertia", a dead zone offset is added. | GPL | The closest to our carried-over angle. |
| yuzu mouse panning (V, from a mirror of the source) | A fixed 10 ms tick; the deltas are collected into a vector limited to 1.5, and it decays every tick (faster the longer it is); small vectors are lifted to a "dead zone counterweight". | GPL-2.0+ | Ideas. |
| input-remapper (V) | Mouse-relative to axis with a cutoff, a release timeout of 0.05 s, dead zone, gain, exponent, 60 Hz output. | GPL-3.0 | Ideas. |
| chiaki-ng (source V) | The mouse only drives the touchpad; the keyboard sets the right stick to full. No mouse look. | AGPL-3.0 | Nothing to take. |
| Cronus Zen (U, the page returned 404) | A dead zone compensation setting and a shape setting with a "circle test", snippet values about 9 to 10 %. | proprietary | Ideas. |

## GTA V

- **Look acceleration:** the 2014 title update notes say it "controls how quickly speed is increased until the player reaches
  maximum turn speed" (V, quoted on gtabase.com; Rockstar's own page did not load). So the turn speed for a held stick is not a
  fixed number: it ramps up with time. A table made from a steady push is right in the end and wrong on the way.
- **Dead zone:** the same notes say the first-person aim/look dead zone slider "reduces right stick deadzone" (V). No source
  gives the number. The often repeated "25 %" is a forum claim (U).
- **Aim assist:** Rockstar says Free Aim still gives "help with reticule speeds near targets" and that hard lock is gone
  (V, gameinformer.com). A magazine quoting Rockstar says plain Free Aim has no lock-on (V).
- **Auto centring:** a first-person "Auto Level Camera" toggle exists (V). Third person auto centring is described only by a
  modder (U).
- **Gyro:** no source says GTA V on the PS5 aims with gyro; Sony's store page lists vibration and trigger effects only (V).
  That is why the virtual gyro is not recommended for this game.

## What this project took, and what it did not

Taken (2026-11-25):

1. **Input on its own fixed timer**, not inside the 60 Hz drawing, and raw mouse updates where the browser has them. The
   evidence for it is thin (Schmid: even delay hardly matters; the mean does), so it is probably the smallest of the changes.
2. **Smoothing that fades with speed** (`mouse.smoothingFadeRate`; JoyShockMapper's tiers, Casiez's idea). In the engine
   alone (`node tools/research/feel-sim.mjs`) it keeps a slow pan as even as the old fixed 12 ms (the angle per frame varies
   7 %, against 18 % with no smoothing) and takes the delay away from a real turn (a start 24 ms late and 92 ms of running on
   after the hand stops, with the old setting, become none).
3. **The picture's display delay and the starting points beside each other**, with the numbers (the panel over the picture):
   delay is what the studies point at, and the picture's display delay is the part of it that can be changed in a click.

Not taken, and why:

- **libpointing-style acceleration**: the gain from it is small (3 to 6 %), and the game already has its own.
- **Virtual gyro for GTA V**: no source says the game aims with it.
- **Shortening the carried-over angle**: Zhai and Flick Stick argue for it, but nothing measures what is lost; the carry-over
  only acts on a swipe faster than the game can turn, so its length is a slider to try, not a thing to decide here.
- **A shape-aware dead zone beyond what the calibration has** (radial or axial, a per-game table): it exists
  (`inGame.deadzoneShape`, the measuring in the settings); what is missing is a measurement on the real game.

## What to set in the game, and what is still open

The sources agree on this for a stick that is driven by a mouse: **look sensitivity high, dead zone at its lowest, look and
aim acceleration at the highest setting** (by the quoted definition it makes the speed reach its maximum sooner, so the
stick answers more like a fixed table; to be checked by eye in the game's menu), and Free Aim if the reticle slow-down near
targets is in the way. After changing any of
them the measuring in the panel ("Auto-calibrate to the game") should be run again.

Open: the measuring tool has never been run on a real game, and it measures a steady push; GTA V's ramp-up is not in it. A
step response (how the speed grows over the first half second of a held stick) would show how much the acceleration setting
leaves. That needs the real game, so it waits for the owner.
