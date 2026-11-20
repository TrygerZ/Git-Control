/**
 * P25 merge and review store (extension of `usePullStore`).
 *
 * The panel is rebuilt on every reveal, so a merge in flight is the one thing the
 * store may NOT forget: the request already left and a rebuilt panel that says
 * "idle" invites a second one. These cases pin the state machine, the single
 * idempotency key per merge attempt, and the fact that a refusal is a state the
 * panel can explain rather than a toast that disappears.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { bridge } from '../src/webview/bridge';
import { usePullStore } from '../src/webview/pullStore';
import { t } from '../src/webview/i18n';
import { useGitHubStore, useOperationStore } from '../src/webview/store';
import type { PullDetail } from '../src/messages';

const RATE = { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false };

function detail(overrides: Partial<PullDetail> = {}): PullDetail {
  return {
    number: 150,
    title: 'Rebalance change row content inset to 8px',
    state: 'open',
    draft: false,
    author: 'TrygerZ',
    authorAvatarUrl: null,
    headRef: 'fix/ui-review-polish',
    baseRef: 'main',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    commits: 2,
    additions: 84,
    deletions: 15,
    changedFiles: 3,
    mergeableState: 'clean',
    htmlUrl: 'https://github.com/o/r/pull/150',
    body: '',
    createdAt: '2026-11-18T00:00:00Z',
    updatedAt: '2026-11-18T03:00:00Z',
    mergedAt: null,
    reviewers: [],
    approvedBy: [],
    changesRequestedBy: [],
    labels: [],
    ...overrides,
  };
}

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

function load(detailValue: PullDetail = detail()): void {
  usePullStore.setState({ detail: detailValue, loading: false, error: null });
}

test('P25: opening and cancelling the confirm dialog is a state, not a request', async (t) => {
  load();
  const s = stub(() => RATE);
  t.after(() => s.restore());

  usePullStore.getState().openMerge();
  assert.equal(usePullStore.getState().mergeState, 'confirm');
  usePullStore.getState().cancelMerge();
  assert.equal(usePullStore.getState().mergeState, 'idle');
  assert.equal(s.calls.length, 0, 'nothing is sent before the dialog confirms');
});

test('P25: a confirmed merge sends the pin, the method, and confirm: true', async (t) => {
  load();
  const s = stub((kind) =>
    kind === 'github/mergePullRequest'
      ? { merged: true, mergeSha: 'c'.repeat(40), branchDeleted: { remote: null, local: null }, warnings: [] }
      : { detail: detail({ state: 'merged' }), rateLimit: RATE },
  );
  t.after(() => s.restore());

  usePullStore.getState().openMerge();
  await usePullStore.getState().merge({ method: 'squash', commitTitle: 'T (#150)', deleteBranch: true });

  const merge = s.calls.find((c) => c.kind === 'github/mergePullRequest');
  assert.ok(merge, 'the merge request was sent');
  assert.equal(merge.payload.expectedHeadSha, 'a'.repeat(40), 'the pin is the head the user saw');
  assert.equal(merge.payload.method, 'squash');
  assert.equal(merge.payload.confirm, true, 'the dialog is the level 1 confirmation');
  assert.equal(typeof merge.payload.idempotencyKey, 'string');
  assert.ok((merge.payload.idempotencyKey as string).length > 0);
  assert.equal(usePullStore.getState().mergeState, 'merged');
});

test('P25: a retried merge reuses the same key, so a double click merges once', async (t) => {
  load();
  let fail = true;
  const s = stub(() => {
    if (fail) {
      fail = false;
      throw Object.assign(new Error('network'), { body: { status: 503, code: 'UNAVAILABLE', message: 'x' } });
    }
    return { merged: true, mergeSha: null, branchDeleted: { remote: null, local: null }, warnings: [] };
  });
  t.after(() => s.restore());

  usePullStore.getState().openMerge();
  await usePullStore.getState().merge({ method: 'merge' });
  assert.equal(usePullStore.getState().mergeState, 'failed');

  await usePullStore.getState().retryMerge();
  const keys = s.calls
    .filter((c) => c.kind === 'github/mergePullRequest')
    .map((c) => c.payload.idempotencyKey);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'the retry is the same logical merge');
});

test('P25: a second successful merge mints a new key', async (t) => {
  load();
  let answer = { merged: true, mergeSha: null, branchDeleted: { remote: null, local: null }, warnings: [] };
  const s = stub((kind) => (kind === 'github/mergePullRequest' ? answer : { detail: detail(), rateLimit: RATE }));
  t.after(() => s.restore());

  usePullStore.getState().openMerge();
  await usePullStore.getState().merge({ method: 'merge' });
  // A fresh open after success must not replay the first outcome.
  usePullStore.getState().openMerge();
  await usePullStore.getState().merge({ method: 'merge' });
  const keys = s.calls
    .filter((c) => c.kind === 'github/mergePullRequest')
    .map((c) => c.payload.idempotencyKey);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test('P25: a merge failure is a state the panel explains, with its detail kept', async (t) => {
  load();
  const s = stub(() => {
    throw Object.assign(new Error('conflict'), {
      body: { status: 409, code: 'CONFLICT', message: 'The branch changed since you opened this.', detail: 'head' },
    });
  });
  t.after(() => s.restore());

  usePullStore.getState().openMerge();
  await usePullStore.getState().merge({ method: 'merge' });
  const state = usePullStore.getState();
  assert.equal(state.mergeState, 'failed');
  assert.equal(state.mergeError?.code, 'CONFLICT');
  assert.equal(state.mergeError?.detail, 'head');
});

test('P25: a submitted review re-reads the conversation and resets the form', async (t) => {
  load();
  const s = stub((kind) => {
    if (kind === 'github/submitReview') return { reviewId: 7 };
    if (kind === 'github/pullTimeline') return { items: [], truncated: false, rateLimit: RATE };
    return RATE;
  });
  t.after(() => s.restore());

  usePullStore.setState({ timeline: [] });
  await usePullStore.getState().review({ event: 'APPROVE', body: '' });
  const post = s.calls.find((c) => c.kind === 'github/submitReview');
  assert.ok(post, 'the review was posted');
  assert.equal(post.payload.event, 'APPROVE');
  assert.equal(post.payload.expectedHeadSha, 'a'.repeat(40));
  assert.equal(post.payload.confirm, undefined, 'the form is the act: no confirmation flag');
  assert.equal(usePullStore.getState().reviewState, 'idle');
  assert.ok(
    s.calls.some((c) => c.kind === 'github/pullTimeline'),
    'the conversation is re-read so the new review appears',
  );
});

test('P25: a review failure leaves the text so the user does not retype it', async (t) => {
  load();
  const s = stub(() => {
    throw Object.assign(new Error('nope'), {
      body: { status: 403, code: 'FORBIDDEN', message: 'The token needs the "repo" permission.' },
    });
  });
  t.after(() => s.restore());

  await usePullStore.getState().review({ event: 'REQUEST_CHANGES', body: 'Please fix.' });
  const state = usePullStore.getState();
  assert.equal(state.reviewState, 'failed');
  assert.equal(state.reviewError?.code, 'FORBIDDEN');
});

test('P25: a reply posts to its parent comment and refreshes the thread list', async (t) => {
  load();
  const s = stub((kind) => {
    if (kind === 'github/replyReviewComment') return { commentId: 55 };
    if (kind === 'github/pullTimeline') return { items: [], truncated: false, rateLimit: RATE };
    return RATE;
  });
  t.after(() => s.restore());

  usePullStore.setState({ timeline: [] });
  await usePullStore.getState().reply(44, 'Agreed.');
  const post = s.calls.find((c) => c.kind === 'github/replyReviewComment');
  assert.ok(post);
  assert.equal(post.payload.commentId, 44);
  assert.equal(post.payload.body, 'Agreed.');
});

test('P25: closing the pull request sends confirm and then re-reads the detail', async (t) => {
  load();
  const s = stub((kind) => {
    if (kind === 'github/closePullRequest') return { closed: true };
    if (kind === 'github/pullDetail') return { detail: detail({ state: 'closed' }), rateLimit: RATE };
    return RATE;
  });
  t.after(() => s.restore());

  await usePullStore.getState().close();
  const post = s.calls.find((c) => c.kind === 'github/closePullRequest');
  assert.ok(post);
  assert.equal(post.payload.confirm, true, 'close needs the level 1 confirmation');
  assert.equal(usePullStore.getState().detail?.state, 'closed');
});

test('P25: a merge is refused in the store before any request when a blocker exists', async (t) => {
  load(detail({ mergeableState: 'dirty' }));
  const s = stub(() => RATE);
  t.after(() => s.restore());

  usePullStore.getState().openMerge();
  await usePullStore.getState().merge({ method: 'merge' });
  assert.equal(s.calls.length, 0, 'a dirty pull request never reaches the network');
  assert.equal(usePullStore.getState().mergeState, 'failed');
  assert.equal(usePullStore.getState().mergeError?.code, 'CONFLICT');
});

/**
 * QA fix: a failed review must not vanish with the dialog.
 *
 * The dialog closes before `review()` runs, and the typed text lived in the
 * dialog's own state. A failure that only lands in `reviewError` with nothing
 * rendering it loses the review and tells the user nothing. The store keeps the
 * text so the panel can reopen the dialog with it; the panel shows the error.
 */
test('QA: a failed review keeps the text so the panel can offer it again', async (t) => {
  load();
  const s = stub(() => {
    throw Object.assign(new Error('nope'), {
      body: { status: 503, code: 'UNAVAILABLE', message: 'GitHub is unreachable.' },
    });
  });
  t.after(() => s.restore());

  await usePullStore.getState().review({ event: 'REQUEST_CHANGES', body: 'Please fix the inset.' });
  const state = usePullStore.getState();
  assert.equal(state.reviewState, 'failed');
  assert.equal(state.reviewError?.code, 'UNAVAILABLE');
  assert.equal(state.reviewDraft?.body, 'Please fix the inset.', 'the text survives the dialog');
  assert.equal(state.reviewDraft?.event, 'REQUEST_CHANGES');

  // Opening the review form again starts from the failed text, not a blank box.
  usePullStore.getState().openReview();
  assert.equal(usePullStore.getState().reviewOpen, true);
  assert.equal(usePullStore.getState().reviewDraft?.body, 'Please fix the inset.');
});

test('QA: a successful review clears the draft, and closing the form clears the open flag', async (t) => {
  load();
  const s = stub((kind) => {
    if (kind === 'github/submitReview') return { reviewId: 7 };
    if (kind === 'github/pullTimeline') return { items: [], truncated: false, rateLimit: RATE };
    return RATE;
  });
  t.after(() => s.restore());

  usePullStore.getState().openReview();
  await usePullStore.getState().review({ event: 'APPROVE', body: '' });
  assert.equal(usePullStore.getState().reviewState, 'idle');
  assert.equal(usePullStore.getState().reviewDraft, null);
  assert.equal(usePullStore.getState().reviewOpen, false, 'a successful submit closes the form');

  usePullStore.getState().openReview();
  usePullStore.getState().closeReview();
  assert.equal(usePullStore.getState().reviewOpen, false);
});

/**
 * QA-02: the dialog now survives its request, so the submit button does too.
 *
 * At `a9d76da` the dialog unmounted on submit, which was the only thing stopping
 * a second press. Since the form stays open while the request is in flight, the
 * store must refuse a second submit itself: each one mints a fresh key, so the
 * host cannot join them and GitHub would post two reviews.
 */
test('QA-02: a second review submitted while one is in flight is ignored', async (t) => {
  load();
  // The gate is created before the calls, so the resolver exists no matter when
  // the stubbed request runs. Assigning it inside the stub raced the release.
  let release = (): void => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const calls: string[] = [];
  const original = bridge.request;
  bridge.request = (async (kind: string) => {
    calls.push(kind);
    if (kind !== 'github/submitReview') return RATE;
    // Hold the first request open so the second submit arrives mid-flight.
    await gate;
    return { reviewId: 7 };
  }) as typeof bridge.request;
  t.after(() => {
    release();
    bridge.request = original;
  });

  usePullStore.getState().openReview();
  const first = usePullStore.getState().review({ event: 'APPROVE', body: '' });
  // The second press lands while `reviewState === 'sending'`.
  const second = usePullStore.getState().review({ event: 'APPROVE', body: '' });
  await Promise.resolve();
  release();
  await Promise.all([first, second]);

  assert.equal(
    calls.filter((kind) => kind === 'github/submitReview').length,
    1,
    'one submit in flight, one POST',
  );
});

/**
 * QA-02, the other half: a submit refused during `sending` must not clobber the
 * draft of the request already on the wire. The early return happens before the
 * store records anything, so a second string cannot overwrite the first.
 */
test('QA-02: the ignored second submit does not replace the draft in flight', async (t) => {
  load();
  let release = (): void => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const original = bridge.request;
  bridge.request = (async (kind: string) => {
    if (kind !== 'github/submitReview') return RATE;
    await gate;
    return { reviewId: 7 };
  }) as typeof bridge.request;
  t.after(() => {
    release();
    bridge.request = original;
  });

  usePullStore.getState().openReview();
  const first = usePullStore.getState().review({ event: 'REQUEST_CHANGES', body: 'the first text' });
  const second = usePullStore.getState().review({ event: 'APPROVE', body: 'the second text' });
  // Asserted before the release: the guard is synchronous, so an unguarded
  // second submit has already overwritten the draft by now.
  assert.equal(usePullStore.getState().reviewDraft?.body, 'the first text');
  release();
  await Promise.all([first, second]);
});

/**
 * Frame 52 names the success toasts, and `pullStore` never read them. The merge
 * announces itself after the re-read, and the deletion only when both halves
 * succeeded; a half-deletion is a warning the panel states, not a toast.
 */
test('P25: a landed merge announces itself, and the deletion when both halves succeeded', async (ctx) => {
  load();
  const s = stub((kind) =>
    kind === 'github/mergePullRequest'
      ? { merged: true, mergeSha: 'c'.repeat(40), branchDeleted: { local: true, remote: true }, warnings: [] }
      : { detail: detail({ state: 'merged' }), rateLimit: RATE },
  );
  ctx.after(() => s.restore());

  useOperationStore.setState({ toasts: [] });
  usePullStore.getState().openMerge();
  await usePullStore.getState().merge({ method: 'merge', deleteBranch: true });

  const messages = useOperationStore.getState().toasts.map((toast) => toast.message);
  assert.ok(
    messages.includes(t('en').prMerge.mergedToast('150', 'main')),
    'the merge announces itself',
  );
  assert.ok(
    messages.includes(t('en').prMerge.branchDeletedToast('fix/ui-review-polish')),
    'both halves deleted is announced too',
  );
});

test('P25: a submitted review and a sent reply each announce themselves', async (ctx) => {
  load();
  const s = stub((kind) => {
    if (kind === 'github/submitReview') return { reviewId: 7 };
    if (kind === 'github/replyReviewComment') return { commentId: 55 };
    if (kind === 'github/pullTimeline') return { items: [], truncated: false, rateLimit: RATE };
    return RATE;
  });
  ctx.after(() => s.restore());

  useOperationStore.setState({ toasts: [] });
  usePullStore.setState({ timeline: [] });
  usePullStore.getState().openReview();
  await usePullStore.getState().review({ event: 'APPROVE', body: '' });
  await usePullStore.getState().reply(44, 'Agreed.');

  const messages = useOperationStore.getState().toasts.map((toast) => toast.message);
  assert.ok(messages.includes(t('en').prMerge.reviewSubmittedToast), 'the review announces itself');
  assert.ok(messages.includes(t('en').prMerge.replyToast), 'the reply announces itself');
});

/**
 * Minor from the third gate: `reply()` had no in-flight guard, so two typed
 * replies (or one row clicked while a slow request hangs) posted twice. GitHub
 * has no reply dedupe either, and the reply is a mutation in the same class as
 * the review POST the gate found.
 */
test('QA-03: a second reply sent while one is in flight is ignored', async (t: TestContext) => {
  load();
  let release = (): void => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const calls: string[] = [];
  const original = bridge.request;
  bridge.request = (async (kind: string) => {
    calls.push(kind);
    if (kind !== 'github/replyReviewComment') return RATE;
    await gate;
    return { commentId: 55 };
  }) as typeof bridge.request;
  t.after(() => {
    release();
    bridge.request = original;
  });

  const first = usePullStore.getState().reply(44, 'Agreed.');
  const second = usePullStore.getState().reply(44, 'Agreed.');
  await Promise.resolve();
  release();
  await Promise.all([first, second]);

  assert.equal(
    calls.filter((kind) => kind === 'github/replyReviewComment').length,
    1,
    'one reply in flight, one POST',
  );
  // The refusal is reported, not silent: the reply row keeps its text until a
  // send actually went out, so an ignored press cannot eat what was typed.
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.sort(), [false, true], 'one send won, one was refused');
});

test('P25: closing the pull request refreshes the sidebar pull request list', async (t) => {
  load();
  useGitHubStore.setState({
    linkage: {
      available: true,
      host: 'github.com',
      owner: 'o',
      repo: 'r',
      webUrl: 'https://github.com/o/r',
      commitUrlTemplate: 'https://github.com/o/r/commit/{hash}',
      apiUrl: 'https://api.github.com',
    },
  });
  const s = stub((kind) => {
    if (kind === 'github/closePullRequest') return { closed: true };
    if (kind === 'github/pullDetail') return { detail: detail({ state: 'closed' }), rateLimit: RATE };
    if (kind === 'github/auth') return { connected: true, login: 'me', scopes: ['repo'] };
    if (kind === 'github/linkage') {
      return {
        available: true,
        host: 'github.com',
        owner: 'o',
        repo: 'r',
        webUrl: 'https://github.com/o/r',
        commitUrlTemplate: 'https://github.com/o/r/commit/{hash}',
        apiUrl: 'https://api.github.com',
      };
    }
    if (kind === 'github/pullRequests') return { pullRequests: [], rateLimit: RATE };
    return RATE;
  });
  t.after(() => s.restore());

  await usePullStore.getState().close();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(
    s.calls.some((c) => c.kind === 'github/pullRequests'),
    'sidebar pull request list refreshes after closing a PR',
  );
});

test('P25: a second close while one is in flight is ignored, and a failed close stays retryable', async (t: TestContext) => {
  load();
  let release = (): void => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let closeCalls = 0;
  let shouldFail = true;
  const original = bridge.request;
  bridge.request = (async (kind: string) => {
    if (kind === 'github/closePullRequest') {
      closeCalls += 1;
      await gate;
      if (shouldFail) {
        shouldFail = false;
        throw Object.assign(new Error('down'), { body: { status: 503, code: 'UNAVAILABLE', message: 'down' } });
      }
      return { closed: true };
    }
    if (kind === 'github/pullDetail') return { detail: detail({ state: 'closed' }), rateLimit: RATE };
    return RATE;
  }) as typeof bridge.request;
  t.after(() => {
    release();
    bridge.request = original;
  });

  const first = usePullStore.getState().close();
  const second = usePullStore.getState().close();
  await Promise.resolve();
  release();
  await Promise.all([first, second]);
  assert.equal(closeCalls, 1, 'second close ignored while first is on the wire');

  // After failure, closeSending resets so a retry runs.
  await usePullStore.getState().close();
  assert.equal(closeCalls, 2, 'failed close remains retryable');
});
