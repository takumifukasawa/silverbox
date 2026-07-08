/**
 * Main-thread client for the decode worker.
 */
import type { DecodeRequest, DecodeResponse, PreparedImage } from './decodeWorker';

export const PREVIEW_LONG_EDGE = 2560;

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (r: PreparedImage) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./decodeWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<DecodeResponse>) => {
    const entry = pending.get(ev.data.id);
    if (!entry) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) entry.resolve(ev.data.result);
    else entry.reject(new Error(ev.data.error));
  };
  worker.onerror = (ev) => {
    const err = new Error(ev.message || 'decode worker crashed');
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  };
  return worker;
}

/**
 * Decode + prepare an image; transfers `bytes` to the worker (detached after
 * call). `longEdge` defaults to the preview size; pass Infinity-like values
 * (e.g. Number.MAX_SAFE_INTEGER) to keep full resolution for export.
 */
export function loadImage(bytes: ArrayBuffer, kind: 'raw' | 'jpg', longEdge = PREVIEW_LONG_EDGE): Promise<PreparedImage> {
  const id = nextId++;
  const req: DecodeRequest = { id, kind, bytes, previewLongEdge: longEdge };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage(req, [bytes]);
  });
}
