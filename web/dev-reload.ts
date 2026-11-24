// SPDX-License-Identifier: AGPL-3.0-only
//
// When the bridge was started with --live (npm run dev), reload this page when a source file is saved. Nothing happens
// on any other bridge: the event stream is not there and this gives up quietly. A running game is never interrupted:
// the reload waits until the stream from the console has ended.

declare global {
  interface Window {
    /** Set by the page: is a stream from the console running? */
    gtpBusy?: () => boolean;
  }
}

if (typeof EventSource !== 'undefined' && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) {
  const es = new EventSource('/__dev/events');
  let pending = false;
  const tryReload = (): void => {
    if (window.gtpBusy?.()) return;
    location.reload();
  };
  es.onmessage = () => {
    pending = true;
    tryReload();
  };
  setInterval(() => pending && tryReload(), 2000);
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) es.close(); // not a --live bridge (or it ended): stop trying
  };
}

export {};
