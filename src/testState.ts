// What integration tests can observe: the payloads webviews were sent and
// their handlers. activate() returns this only in extension test mode.

import type { InitPayload } from './shared/protocol';
import type { RevisionsViewProvider } from './views';
import type { Handlers } from './webview';

export const testState = {
  loaded: [] as { payload: InitPayload; handlers: Handlers }[],
  revisions: undefined as RevisionsViewProvider | undefined,
};

export type TestState = typeof testState;
