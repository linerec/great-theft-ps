// SPDX-License-Identifier: AGPL-3.0-only
//
// Zero-dependency development server for the mapping test beds (no console needed).
// Serves web/ and src/ on the loopback interface only. For the console client use `npm run bridge`.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleStatic, isLoopbackHost, send } from './bridge/static.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 5173);

const server = http.createServer((req, res) => {
  // Guard against DNS rebinding: only accept loopback host names.
  if (!isLoopbackHost(req.headers.host, port)) return send(res, 421, { 'Content-Type': 'text/plain' }, 'Misdirected request');
  void handleStatic(req, res, root);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Test bed: http://127.0.0.1:${port}/`);
});
