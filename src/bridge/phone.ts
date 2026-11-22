// SPDX-License-Identifier: AGPL-3.0-only
//
// Phone access for `npm run dev`: the same bridge also answers on this computer's tailnet address, over HTTPS, so that a
// phone can use it. This project's own.
//
// planPhone() works out what the long command line used to ask for (see the README, "From another device"): this
// computer's tailnet address, the HTTPS name it has in the tailnet and the certificate for that name. The certificate
// comes from `tailscale cert`. Two modes:
//  - 'auto' (what `npm run dev` does): phone access is switched on when Tailscale is running and there already is a
//    certificate for this computer's name; a certificate that is nearly out is renewed by itself. A first certificate
//    is not asked for without being told to: that is `npm run dev -- --phone`, once.
//  - 'on' (`--phone`): gets the certificate when there is none, when it is for another name or when it is nearly out,
//    and stops with an explanation if it cannot.
// Either way it only reads `tailscale status` and asks `tailscale cert` for the certificate: no Tailscale setting is
// changed. The tailnet side is bound to the tailnet address only, so it is not reachable from the home network or the
// internet. In 'auto' mode, whatever is missing is reported (as the reason phone access is off), not an error.

import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { describeExpiry, loadTls, namesNotCovered, type TlsMaterial } from './tls.ts';

export interface PhoneDeps {
  /** Run a command and give its output; reject with an error (message = what went wrong) if it fails or takes too long. */
  run(command: string, args: string[], timeoutMs: number): Promise<string>;
  /** Where the certificate and its key are kept. */
  tlsDir: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export const realPhoneDeps = (tlsDir: string, log?: (line: string) => void): PhoneDeps => ({
  tlsDir,
  ...(log ? { log } : {}),
  run: (command, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return reject(new Error(`\`${command}\` was not found`));
        reject(new Error(String(stderr || error.message).trim().split('\n').slice(-3).join(' ')));
      });
    }),
});

export interface PhonePlan {
  /** This computer's tailnet IPv4 address: where the phone side listens. */
  host: string;
  /** The HTTPS name this computer has in the tailnet. */
  name: string;
  tls: TlsMaterial;
  certFile: string;
  keyFile: string;
}

/** Fixed, so that the address on a phone's home screen keeps working. */
export const PHONE_PORT = 8788;

/** Work out phone access. Throws an Error whose message says what is missing and what to do about it. */
export async function planPhone(mode: 'auto' | 'on', deps: PhoneDeps): Promise<PhonePlan> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());

  let status: { BackendState?: unknown; Self?: { DNSName?: unknown; TailscaleIPs?: unknown } };
  try {
    status = JSON.parse(await deps.run('tailscale', ['status', '--json'], 8000));
  } catch (error) {
    const message = (error as Error).message;
    if (/was not found/.test(message)) throw new Error('Tailscale is not installed here, or its command `tailscale` is not on the PATH. Install the Tailscale app and sign in, then try again.');
    throw new Error(`could not ask Tailscale about itself (${message}). Is the Tailscale app running?`);
  }
  if (status.BackendState !== 'Running') {
    throw new Error(`Tailscale is not connected (it says "${String(status.BackendState)}"). Open the Tailscale app and sign in or turn it on, then try again.`);
  }
  const name = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '').toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+$/.test(name)) {
    throw new Error('this computer has no name in the tailnet. In the Tailscale admin console, turn on MagicDNS and HTTPS certificates (the DNS page), then try again.');
  }
  const ips = Array.isArray(status.Self?.TailscaleIPs) ? (status.Self.TailscaleIPs as unknown[]) : [];
  const host = ips.find((a): a is string => typeof a === 'string' && /^100\.\d+\.\d+\.\d+$/.test(a));
  if (!host) throw new Error('this computer has no Tailscale IPv4 address yet. Wait a moment and try again.');

  const certFile = path.join(deps.tlsDir, 'bridge.crt');
  const keyFile = path.join(deps.tlsDir, 'bridge.key');
  const usable = (): TlsMaterial | null => {
    try {
      const t = loadTls(certFile, keyFile);
      return namesNotCovered(t.names, [name]).length === 0 && t.notAfter.getTime() > now().getTime() ? t : null;
    } catch {
      return null;
    }
  };
  /** What is wrong with the certificate there: nothing, or one of three things. */
  const state = ((): { kind: 'ok' | 'missing' | 'other-name' | 'ending'; text: string } => {
    try {
      const t = loadTls(certFile, keyFile);
      if (namesNotCovered(t.names, [name]).length > 0) return { kind: 'other-name', text: 'the one there is for another name' };
      const expiry = describeExpiry(t.notAfter, now());
      return expiry.level === 'ok' ? { kind: 'ok', text: '' } : { kind: 'ending', text: expiry.text };
    } catch {
      return { kind: 'missing', text: 'there is none yet' };
    }
  })();

  if (state.kind !== 'ok') {
    if (mode === 'auto' && (state.kind === 'missing' || state.kind === 'other-name')) {
      throw new Error(`there is no certificate for ${name} yet (${state.text}). Run \`npm run dev -- --phone\` once: it asks Tailscale for one.`);
    }
    log(`Getting a certificate for ${name} from Tailscale (${state.text}) ...`);
    mkdirSync(deps.tlsDir, { recursive: true, mode: 0o700 });
    try {
      await deps.run('tailscale', ['cert', '--cert-file', certFile, '--key-file', keyFile, name], 90_000);
      log(`Certificate ready: ${describeExpiry(loadTls(certFile, keyFile).notAfter, now()).text}.`);
    } catch (error) {
      const message = (error as Error).message;
      if (usable()) {
        log(`Could not renew the certificate (${message}); the one in use still works, so going on. Try again before it ends.`);
      } else {
        throw new Error(`could not get a certificate for ${name} (${message}). In the Tailscale admin console, HTTPS certificates must be turned on (the DNS page).`);
      }
    }
  }
  const tls = usable();
  if (!tls) throw new Error(`the certificate for ${name} cannot be used (see above).`);
  return { host, name, tls, certFile, keyFile };
}
