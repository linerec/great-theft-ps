// SPDX-License-Identifier: AGPL-3.0-only
//
// `npm run phone`: the bridge for a phone over Tailscale, started with one word. This project's own.
//
// It fills in what the long command line used to ask for (see the README, "From another device"): this computer's
// tailnet address (--host), the HTTPS name it has in the tailnet (--trust-host), and the certificate for that name
// (--tls-cert, --tls-key), getting a new one from `tailscale cert` when there is none, when it is for another name or
// when it has two weeks left. The port stays 8788 and does not move to another when it is taken: the address on the
// phone's home screen must keep working. Anything given by hand on the command line wins over what is worked out here.
//
// It does not change Tailscale's settings: it reads `tailscale status` and asks `tailscale cert` for the certificate,
// the same two commands the manual way used. The bridge is bound to the tailnet address only, so it is not reachable
// from the home network or the internet.

import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { describeExpiry, loadTls, namesNotCovered, type TlsMaterial } from './tls.ts';

export const PHONE_PORT = '8788';

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

const set = (args: Record<string, string[]>, key: string, value: string): void => {
  if (args[key] === undefined) args[key] = [value];
};

/**
 * Fill `args` (the bridge's command line, parsed) with what phone mode needs. Throws an Error whose message says what
 * is wrong and what to do about it.
 */
export async function preparePhone(args: Record<string, string[]>, deps: PhoneDeps): Promise<void> {
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
  const ip = ips.find((a): a is string => typeof a === 'string' && /^100\.\d+\.\d+\.\d+$/.test(a));
  if (!ip) throw new Error('this computer has no Tailscale IPv4 address yet. Wait a moment and try again.');

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
  const why = ((): string => {
    try {
      const t = loadTls(certFile, keyFile);
      if (namesNotCovered(t.names, [name]).length > 0) return `the one there is for another name`;
      const expiry = describeExpiry(t.notAfter, now());
      return expiry.level === 'ok' ? '' : expiry.text;
    } catch {
      return 'there is none yet';
    }
  })();
  if (why) {
    log(`Getting a certificate for ${name} from Tailscale (${why}) ...`);
    mkdirSync(deps.tlsDir, { recursive: true, mode: 0o700 });
    try {
      await deps.run('tailscale', ['cert', '--cert-file', certFile, '--key-file', keyFile, name], 90_000);
      const fresh = loadTls(certFile, keyFile);
      log(`Certificate ready: ${describeExpiry(fresh.notAfter, now()).text}.`);
    } catch (error) {
      const message = (error as Error).message;
      if (usable()) {
        log(`Could not renew the certificate (${message}); the one in use still works, so going on. Try again before it ends.`);
      } else {
        throw new Error(`could not get a certificate for ${name} (${message}). In the Tailscale admin console, HTTPS certificates must be turned on (the DNS page).`);
      }
    }
  }

  set(args, 'host', ip);
  set(args, 'port', PHONE_PORT);
  set(args, 'tls-cert', certFile);
  set(args, 'tls-key', keyFile);
  const trusted = (args['trust-host'] ??= []);
  if (!trusted.includes(name)) trusted.push(name);
  log(`Phone mode: the bridge listens on the tailnet address only, port ${args.port![0]}. After a stream, \`npm run runs\` shows how it went.`);
}
