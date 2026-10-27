import { PingRoom } from '@pingroom/sdk';
import { setImmediate as yieldTurn } from 'node:timers/promises';

export const API = 'https://api.pingroom.io';
function interruptible(work, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Only pairing, room reads, and question endpoints; response bytes and elapsed time are bounded. */
export function makeClient({ token, fetchImpl = globalThis.fetch, signal, pairing = false, deadlineMs } = {}) {
  if (deadlineMs !== undefined && (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30000)) throw new Error('Invalid request deadline.');
  return new PingRoom({ token, baseUrl: API, timeoutMs: 5000, fetch: async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const allowedRead = /^\/api\/agent\/(?:rooms|questions(?:\/[0-9a-f-]{36})?)$/.test(url.pathname);
    const allowedAsk = init.method === 'POST' && /^\/api\/agent\/rooms\/[A-Z0-9]{12}\/questions$/.test(url.pathname);
    const allowedPair = pairing && ((init.method === 'POST' && ['/api/agent/auth', '/api/agent/auth/pair/start'].includes(url.pathname))
      || (init.method === 'GET' && url.pathname === '/api/agent/auth/pair/status'));
    if (url.origin !== API || url.username || url.password || !(init.method === 'GET' && allowedRead || allowedAsk || allowedPair)) throw new Error('Transport endpoint is not allowed.');
    const budget = deadlineMs ?? 5000;
    const deadline = new AbortController();
    const started = performance.now();
    const timer = setTimeout(() => deadline.abort(new Error('Request deadline exceeded.')), budget);
    const combined = AbortSignal.any([init.signal, signal, deadline.signal].filter(Boolean));
    const check = () => {
      if (performance.now() - started >= budget) deadline.abort(new Error('Request deadline exceeded.'));
      combined.throwIfAborted();
    };
    let reader;
    try {
      const response = await interruptible(() => fetchImpl(url.toString(), { ...init, redirect: 'manual', signal: combined }), combined);
      check();
      if (response.status >= 300 && response.status < 400) throw new Error('Redirect refused.');
      reader = response.body?.getReader();
      const chunks = []; let size = 0; let reads = 0;
      if (reader) for (;;) {
        check();
        const part = await interruptible(() => reader.read(), combined);
        check();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 512 * 1024) throw new Error('Response exceeds 512 KiB.');
        if (part.value.byteLength) chunks.push(part.value);
        if (++reads % 64 === 0) await yieldTurn(undefined, { signal: combined });
      }
      check();
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return new Response(response.status === 204 ? null : bytes, { status: response.status, headers: response.headers });
    } finally {
      clearTimeout(timer);
      if (reader) void reader.cancel().catch(() => {});
    }
  } });
}
