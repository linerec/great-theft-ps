# Working on Great Theft P.S

A PlayStation Remote Play client (a TypeScript port of the console protocol, a Node "bridge", and a web page). People
play from any browser. Read `README.md` first, then `docs/status-and-next.md` (what is done, what was only tested
against a simulated console, and what to do next).

## Daily loop

- `npm run dev` starts the bridge and the page at http://127.0.0.1:8788 with **live reload**: save a file under
  `web/` or `src/` and the open page reloads (not while a game is running). Changes to the bridge itself (`src/bridge`,
  `src/console`) need a restart.
- `npm run preview` opens the page with a pretend console (`--accounts` for logins) to look at and try the interface without
  a PlayStation; `docs/player.md` says what the interface does and how far each part was checked.
- `npm test` must pass before every push (about 15 s). `npm run e2e` runs the page in a real browser (needs Chrome).
- Push to `main`. A server at home runs this repository (`docs/deploy-nas.md`): its supervisor takes each new commit
  within about a minute, **after starting it on the side and finding that nobody is playing**. So `main` must always
  start. The page shows the running commit in small print at the bottom.

## Conventions

- Node 24+ runs the TypeScript directly by stripping types: no enums, namespaces or constructor parameter properties
  (`constructor(private x)` fails), imports end in `.ts`. **No new dependencies** without asking: there are none.
- Every file starts with the SPDX line. Comments say why. A change comes with a test that would fail without it; no
  test that cannot fail.
- **Words for people are English in the code, Korean in a dictionary** (`src/i18n/index.ts`, `docs/i18n.md`): write
  `t('English sentence {value}', { value })` (or `N_('…')` in a table, `data-i18n` in `web/index.html`, `translate(lang, …)`
  on the bridge) and add the Korean to a part of `src/i18n/ko-*.ts`. No Hangul anywhere else, comments included;
  `test/i18n.test.ts` fails when a sentence has no Korean, when Korean is left for a sentence that is gone, and when a
  part of the dictionary contradicts another.
- Honest status: say what was checked on a real console and what only against the simulator. Do not call something
  verified that was not.

## This repository is public

Never commit: LAN or Tailscale addresses of a real home, console ids, host names, tokens, passphrases, e-mail
addresses, registration files. Examples use neutral values (`192.168.1.20`, `gtp.example.synology.me`). Accounts,
registrations and measurements live outside the repository (`GTP_HOME`, default `~/.gtp`).

## Things that need the owner's say first

Real console sessions (they press buttons on a real PS5), force pushes or history changes, new dependencies, changes
to who can reach the server from the internet (`src/bridge/accounts.ts`, `auth-api.ts`, the proxy and router rules),
and anything that weakens login, the minutes per day, or the owner-only API.
