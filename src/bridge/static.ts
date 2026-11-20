// SPDX-License-Identifier: AGPL-3.0-only
//
// Static file serving for the web client, shared by the dev server and the bridge.
// Only web/ and src/ are served. TypeScript is served as JavaScript with its types stripped on the fly.

import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'",
};

export function send(res: ServerResponse, status: number, headers: Record<string, string>, body?: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

/** True if `host` (a Host header) is a loopback name on this port. */
export function isLoopbackHost(host: string | undefined, port: number): boolean {
  const h = (host ?? '').toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

export async function handleStatic(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' }, 'Method not allowed');
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/web/index.html';

    const file = path.resolve(root, `.${pathname}`);
    const rel = path.relative(root, file);
    const allowed = rel.startsWith(`web${path.sep}`) || rel.startsWith(`src${path.sep}`);
    if (!allowed || rel.startsWith('..') || path.isAbsolute(rel)) {
      return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
    }
    const ext = path.extname(file).toLowerCase();
    const type = CONTENT_TYPES[ext];
    if (!type) return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');

    const source = await readFile(file, 'utf8');
    const body = ext === '.ts' ? stripTypeScriptTypes(source, { mode: 'strip' }) : source;
    send(res, 200, { 'Content-Type': type }, req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
    console.error(error);
    send(res, 500, { 'Content-Type': 'text/plain' }, `Server error: ${(error as Error)?.message ?? error}`);
  }
}
