/**
 * Create pull request draft store (P22).
 *
 * The dialog is one form over one request, so the store owns exactly three things
 * the component must not: the loaded prepare result, the edited fields, and the
 * idempotency key. The key is minted once per dialog open, which is what makes a
 * retry after a transport error replay the first outcome instead of opening a
 * second pull request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridge } from '../src/webview/bridge';
import { usePrDraftStore, type PrDraftStatus } from '../src/webview/store';
import type { PrPrepareResult } from '../src/messages';

const PREPARE: PrPrepareResult = {
  head: 'feat/a',
  base: 'main',
  bases: ['main', 'release/1.4'],
  heads: ['feat/a', 'feat/b'],
  onRemote: false,
  ahead: 3,
  files: 4,
  commits: [
    { hash: 'a'.repeat(40), subject: 'one' },
    { hash: 'b'.repeat(40), subject: 'two' },
    { hash: 'c'.repeat(40), subject: 'three' },
  ],
  template: '## Summary',
  draft: { title: 'Feat a', body: '## Summary' },
  existing: null,
  connected: true,
  canWrite: 'yes',
  collaboratorsAvailable: true,
};

interface Call {
  kind: string;
  payload: Record<string, unknown>;
}

function stub(reply: (kind: string, payload: Record<string, unknown>) => unknown): {
  calls: Call[];
  restore(): void;
} {
  const calls: Call[] = [];
  const original = bridge.request;
  bridge.request = (async (kind: string, payload: Record<string, unknown>): Promise<unknown> => {
    calls.push({ kind, payload });
    return reply(kind, payload);
  }) as typeof bridge.request;
  return {
    calls,
    restore() {
      bridge.request = original;
    },
  };
}

function reset(): void {
  usePrDraftStore.getState().close();
}

test('opening loads the prepare result and seeds the fields from the draft', async () => {
  reset();
  const s = stub((kind) => (kind === 'github/prPrepare' ? PREPARE : { logins: [], available: true }));
  try {
    await usePrDraftStore.getState().open('o', 'r');
  } finally {
    s.restore();
  }
  const state = usePrDraftStore.getState();
  assert.equal(state.status, 'ready');
  assert.equal(state.base, 'main');
  assert.equal(state.head, 'feat/a');
  assert.equal(state.title, 'Feat a');
  assert.equal(state.body, '## Summary');
  assert.equal(state.onRemote, false);
  assert.deepEqual(state.bases, ['main', 'release/1.4']);
});

test('a prepare that finds an existing pull request lands in the exists state', async () => {
  reset();
  const s = stub(() => ({
    ...PREPARE,
    existing: { number: 154, url: 'https://github.com/o/r/pull/154', title: 'Old' },
  }));
  try {
    await usePrDraftStore.getState().open('o', 'r');
  } finally {
    s.restore();
  }
  const state = usePrDraftStore.getState();
  assert.equal(state.status, 'exists');
  assert.equal(state.existing?.number, 154);
});

test('a failed prepare lands in error and keeps the dialog open', async () => {
  reset();
  const s = stub(() => {
    throw new Error('boom');
  });
  try {
    await usePrDraftStore.getState().open('o', 'r');
  } finally {
    s.restore();
  }
  assert.equal(usePrDraftStore.getState().status, 'error');
});

test('editing a field never touches the other fields', async () => {
  reset();
  const s = stub(() => PREPARE);
  try {
    await usePrDraftStore.getState().open('o', 'r');
  } finally {
    s.restore();
  }
  usePrDraftStore.getState().setField('title', 'A new title');
  usePrDraftStore.getState().setField('body', 'A new body');
  usePrDraftStore.getState().setField('base', 'release/1.4');
  usePrDraftStore.getState().setField('head', 'feat/b');
  const state = usePrDraftStore.getState();
  assert.equal(state.title, 'A new title');
  assert.equal(state.body, 'A new body');
  assert.equal(state.base, 'release/1.4');
  assert.equal(state.head, 'feat/b');
  assert.equal(state.draft, false, 'the draft toggle was not touched');
});

test('the draft toggle and the reviewer list are separate edits', async () => {
  reset();
  const s = stub(() => PREPARE);
  try {
    await usePrDraftStore.getState().open('o', 'r');
  } finally {
    s.restore();
  }
  usePrDraftStore.getState().setDraft(true);
  usePrDraftStore.getState().addReviewer('ann');
  usePrDraftStore.getState().addReviewer('ann');
  usePrDraftStore.getState().addReviewer('bob');
  usePrDraftStore.getState().removeReviewer('bob');
  const state = usePrDraftStore.getState();
  assert.equal(state.draft, true);
  assert.deepEqual(state.reviewers, ['ann'], 'adding twice is one reviewer');
});

test('submitting publishes, creates, and reaches the done state', async () => {
  reset();
  const s = stub((kind) => {
    if (kind === 'github/prPrepare') return PREPARE;
    if (kind === 'github/createPullRequest') {
      return {
        number: 154,
        url: 'https://github.com/o/r/pull/154',
        published: true,
        reviewersFailed: [],
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
      };
    }
    return { logins: [], available: true };
  });
  try {
    await usePrDraftStore.getState().open('o', 'r');
    await usePrDraftStore.getState().submit();
  } finally {
    s.restore();
  }
  const state = usePrDraftStore.getState();
  assert.equal(state.status, 'done');
  assert.equal(state.created?.number, 154);
  assert.equal(state.created?.published, true);
});

test('the status walks through publishing and creating, in that order', async () => {
  reset();
  const seen: PrDraftStatus[] = [];
  const unsubscribe = usePrDraftStore.subscribe((state) => {
    if (seen[seen.length - 1] !== state.status) seen.push(state.status);
  });
  const s = stub((kind) => {
    if (kind === 'github/prPrepare') return PREPARE;
    return {
      number: 1,
      url: 'u',
      published: true,
      reviewersFailed: [],
      rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
    };
  });
  try {
    await usePrDraftStore.getState().open('o', 'r');
    await usePrDraftStore.getState().submit();
  } finally {
    s.restore();
    unsubscribe();
  }
  assert.ok(seen.includes('publishing'), `publishing is a state (saw ${seen.join(',')})`);
  assert.ok(seen.includes('creating'), `creating is a state (saw ${seen.join(',')})`);
  assert.equal(seen[seen.length - 1], 'done');
});

test('an already-on-remote branch skips the publishing state', async () => {
  reset();
  const seen: PrDraftStatus[] = [];
  const unsubscribe = usePrDraftStore.subscribe((state) => {
    if (seen[seen.length - 1] !== state.status) seen.push(state.status);
  });
  const s = stub((kind) => {
    if (kind === 'github/prPrepare') return { ...PREPARE, onRemote: true };
    return {
      number: 1,
      url: 'u',
      published: false,
      reviewersFailed: [],
      rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
    };
  });
  try {
    await usePrDraftStore.getState().open('o', 'r');
    await usePrDraftStore.getState().submit();
  } finally {
    s.restore();
    unsubscribe();
  }
  assert.ok(!seen.includes('publishing'), `no publish line when the branch is already there (saw ${seen.join(',')})`);
});

test('a CONFLICT answer lands in exists, not error', async () => {
  reset();
  const s = stub((kind) => {
    if (kind === 'github/prPrepare') return PREPARE;
    throw Object.assign(new Error('exists'), {
      body: {
        status: 409,
        code: 'CONFLICT',
        message: 'A pull request already exists for this branch.',
        detail: '154',
      },
    });
  });
  try {
    await usePrDraftStore.getState().open('o', 'r');
    await usePrDraftStore.getState().submit();
  } finally {
    s.restore();
  }
  const state = usePrDraftStore.getState();
  assert.equal(state.status, 'exists');
  assert.equal(state.existing?.number, 154, 'the number travels in detail');
});

test('every submit of one dialog open reuses one idempotency key', async () => {
  reset();
  const keys: string[] = [];
  let attempt = 0;
  const s = stub((kind, payload) => {
    if (kind === 'github/prPrepare') return PREPARE;
    keys.push(String(payload.idempotencyKey));
    attempt += 1;
    if (attempt === 1) throw new Error('transport');
    return {
      number: 7,
      url: 'u',
      published: false,
      reviewersFailed: [],
      rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
    };
  });
  try {
    await usePrDraftStore.getState().open('o', 'r');
    await usePrDraftStore.getState().submit();
    await usePrDraftStore.getState().submit();
  } finally {
    s.restore();
  }
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'a retry replays the first attempt');
  assert.ok((keys[0] ?? '').length > 0);
});

test('a fresh open mints a fresh key, so the next pull request is not a replay', async () => {
  reset();
  const keys: string[] = [];
  const s = stub((kind, payload) => {
    if (kind === 'github/prPrepare') return PREPARE;
    keys.push(String(payload.idempotencyKey));
    return {
      number: 7,
      url: 'u',
      published: false,
      reviewersFailed: [],
      rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
    };
  });
  try {
    await usePrDraftStore.getState().open('o', 'r');
    await usePrDraftStore.getState().submit();
    await usePrDraftStore.getState().open('o', 'r');
    await usePrDraftStore.getState().submit();
  } finally {
    s.restore();
  }
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test('a reviewer failure is reported without losing the creation', async () => {
  reset();
  const s = stub((kind) => {
    if (kind === 'github/prPrepare') return PREPARE;
    return {
      number: 9,
      url: 'u',
      published: false,
      reviewersFailed: ['bob'],
      rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
    };
  });
  try {
    await usePrDraftStore.getState().open('o', 'r');
    usePrDraftStore.getState().addReviewer('bob');
    await usePrDraftStore.getState().submit();
  } finally {
    s.restore();
  }
  const state = usePrDraftStore.getState();
  assert.equal(state.status, 'done');
  assert.deepEqual(state.created?.reviewersFailed, ['bob']);
});

test('closing resets every field and the key', async () => {
  reset();
  const s = stub(() => PREPARE);
  try {
    await usePrDraftStore.getState().open('o', 'r');
  } finally {
    s.restore();
  }
  usePrDraftStore.getState().setField('title', 'typed');
  usePrDraftStore.getState().close();
  const state = usePrDraftStore.getState();
  assert.equal(state.status, 'closed');
  assert.equal(state.title, '');
  assert.equal(state.key, null);
});
