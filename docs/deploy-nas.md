# Running the bridge on a server at home (a NAS or a small PC)

The bridge is the part that talks to the console. Run on a computer that is always on, in the same network as the
console, it lets the family open **one address from anywhere** (a phone on mobile data, a laptop at a hotel), log in, and
play. Nothing else has to be started.

What the server needs: Docker (on a Synology: *Container Manager*), a name that reaches it from outside with HTTPS
(a reverse proxy, see below), and the console in the same home network.

## What runs

`deploy/compose.yaml` runs the stock `node:24-bookworm` image. It builds nothing: it clones this repository into a
folder, and `tools/supervise.mjs` keeps the bridge running from it and takes new versions by itself:

- every minute it asks git for the head of `main`;
- a newer commit is checked out **on the side**, started on another port with an empty home folder, and its page is
  asked for. Only if that works, and **nobody is playing**, is the running copy moved to it and restarted (a few
  seconds). A stream is never cut for an update; it waits;
- a commit that does not start is written to `bad-commits.txt` and left alone until `main` moves on; the old version
  keeps running. `deploy.log` (next to it) says what happened and why.

So the way to work is: push to `main`, and about a minute later the server runs it.

## Setting it up

1. Copy `deploy/compose.yaml` to a folder on the server (it makes `data/` and `app/` next to itself), set `TZ`,
   `GTP_TIMEZONE` and the name after `--trust-host`, and start it. On a Synology: Container Manager → Project → Create,
   paste the file.
2. **First start.** With no people yet, the bridge invites the owner and prints the link in the container's log:
   `FIRST START: open one of these ...  https://<your name>/#invite=...`. Open it and choose the owner's password in
   the page. The link works once, for 48 hours. (Nobody ever types a password for somebody else.)
3. **Reverse proxy (HTTPS).** A browser decodes video only on a secure page, so the address must be `https://`. In
   Synology DSM: Control Panel → Login Portal → Advanced → Reverse Proxy → Create. Source: HTTPS, your name, port 443.
   Destination: HTTP, `localhost`, port 8788. In *Custom Header* add the WebSocket headers (the *WebSocket* preset), and
   `X-Real-IP` = `$remote_addr`. The name needs a certificate (DSM can get one from Let's Encrypt for a
   `synology.me` name). Open ports 80 and 443 on the router to the server.

   *A short address with no port.* A Synology DDNS name also answers to everything under it
   (`ps5.<name>.synology.me`). If DSM already holds the wildcard certificate for the name (*Control Panel → Security →
   Certificate*: its subject alternative names list `*.<name>.synology.me`), make the rule's source hostname that
   subdomain on port 443, then open *Certificate → Settings*, find the new rule in the list and give it the wildcard
   certificate (DSM restarts its web services for a few seconds). Add the subdomain to the container as a second
   `--trust-host` (the flag may be repeated; a port is ignored). Without the wildcard certificate a subdomain shows a
   certificate warning, and the same name on an odd port (for example 8788 with the base name) is the way around it.
4. **Move the console registration here** (once; never register twice): on a computer that has it,
   `GTP_PASSPHRASE=<a long random phrase> npm run consoles -- export consoles.gtpbackup`, serve the file for a minute
   on the home network (`python3 -m http.server 8099` in its folder), and give the container `GTP_IMPORT_URL` and the same
   `GTP_PASSPHRASE` for one start. It imports the copy, writes a marker so that it does not do it twice, and logs it.
   Remove both variables afterwards and delete the copy.
5. **Inside the house** the same address should not go out to the internet and back. In the router's local DNS
   (Verizon: Network settings → DNS server → Add DNS entry) make the name point at the server's address; the same
   HTTPS address then reaches it directly, which is steadier and faster. Some routers (the Verizon one included) keep
   **one name per IP address** in that table: a second entry for the same server address replaces the first, so give
   the name people actually use to play.

## People

Log in as the owner, then **사용자** (the button in the header): invite someone with a name and minutes per day; they get
a link and choose their own password. The owner has no limit. A member's play time is counted from the moment the
picture starts, shown in their header, and the stream ends when it runs out (a day ends at midnight in `GTP_TIMEZONE`).
Members cannot register consoles, change measurements or manage people. The files are in `data/accounts/` (hashes only).

Wrong logins are slowed down per address and per name. Behind the proxy the address is the one `X-Real-IP` gives.

## Rolling back, and looking

- `data/deploy.log`: every update, and why one was refused.
- To stay on an older version: `git -C app reset --hard <commit>` and add the newer commits to `data/bad-commits.txt`
  (one hash per line), or stop the project.
- To update by hand: restart the container; it keeps the code that is there.
- Back up `data/`: it holds the console registration and the accounts. Treat it as a secret.

## What this does to the network

Only HTTPS on the name you chose is reachable from outside (through the proxy). The bridge itself listens on the
server's loopback address; the proxy is what talks to it. The console is reached from the server on the home network
(UDP 9302 to wake, TCP 9295 and UDP 9296 for the session), and from nothing else.
