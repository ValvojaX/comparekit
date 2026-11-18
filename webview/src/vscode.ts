// The webview's link to the extension host. In the browser test harness,
// window.__vscodeMock stands in for acquireVsCodeApi.

import type { HostMessage, WebviewMessage } from '../../src/shared/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    __vscodeMock?: VsCodeApi;
  }
}

const api: VsCodeApi = window.acquireVsCodeApi?.() ??
  window.__vscodeMock ?? {
    postMessage: (m) => console.log('postMessage', m),
    getState: () => undefined,
    setState: () => undefined,
  };

export function post(msg: WebviewMessage): void {
  api.postMessage(msg);
}

export function onHostMessage(fn: (msg: HostMessage) => void): () => void {
  const handler = (e: MessageEvent) => {
    const data = e.data as HostMessage;
    if (data && typeof data === 'object' && 'type' in data) fn(data);
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

let nextId = 1;
const pending = new Map<number, (data: string) => void>();
onHostMessage((msg) => {
  if (msg.type === 'bytes') {
    pending.get(msg.id)?.(msg.base64);
    pending.delete(msg.id);
  }
});

/** Asks the host for a slice of one side's bytes (hex view paging). */
export function requestBytes(side: 'left' | 'right', offset: number, length: number): Promise<string> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    post({ type: 'readBytes', id, side, offset, length });
  });
}
