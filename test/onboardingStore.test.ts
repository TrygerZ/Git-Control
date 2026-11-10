/**
 * Get started checklist store slice (P16).
 *
 * The preference is the only durable piece of the card (D-14): the steps are
 * derived every time, and "dismissed" is one boolean per workspace. These cases
 * pin the round trip, the reopen path the Help footer will call, and the fact
 * that a failed write never blocks the interaction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridge } from '../src/webview/bridge';
import { useSettingsStore } from '../src/webview/store';
import type { SettingsSnapshot } from '../src/messages';

const SNAPSHOT: SettingsSnapshot = {
  gitPath: 'git',
  commitLimit: 10_000,
  pageSize: 500,
  showIgnoredFiles: false,
  githubApiUrl: 'https://api.github.com',
  fetchStalenessMs: 300_000,
  language: 'en',
  ui: { zoom: 1, branchFilter: '', checklistDismissed: false },
};

interface Call {
  kind: string;
  payload: unknown;
}

function stub(reply: (kind: string, payload: unknown) => unknown): { calls: Call[]; restore(): void } {
  const calls: Call[] = [];
  const original = bridge.request;
  bridge.request = (async (kind: string, payload: unknown): Promise<unknown> => {
    calls.push({ kind, payload });
    return reply(kind, payload);
  }) as typeof bridge.request;
  return {
    calls,
    restore: () => {
      bridge.request = original;
    },
  };
}

function reset(): void {
  useSettingsStore.setState({ checklistDismissed: false, checklistForced: false });
}

test('load reads the dismissed flag from the settings snapshot', async (t) => {
  reset();
  const s = stub(() => ({ ...SNAPSHOT, ui: { ...SNAPSHOT.ui, checklistDismissed: true } }));
  t.after(s.restore);

  await useSettingsStore.getState().load();
  assert.equal(useSettingsStore.getState().checklistDismissed, true);
});

test('a missing flag in the snapshot reads as not dismissed', async (t) => {
  reset();
  useSettingsStore.setState({ checklistDismissed: true });
  const s = stub(() => ({ ...SNAPSHOT, ui: { zoom: 1, branchFilter: '' } }) as unknown as SettingsSnapshot);
  t.after(s.restore);

  await useSettingsStore.getState().load();
  assert.equal(useSettingsStore.getState().checklistDismissed, false, 'an absent field is not "dismissed"');
});

test('setChecklistDismissed flips the local flag and persists the boolean', async (t) => {
  reset();
  const s = stub(() => SNAPSHOT);
  t.after(s.restore);

  useSettingsStore.getState().setChecklistDismissed(true);
  assert.equal(useSettingsStore.getState().checklistDismissed, true, 'the UI reacts before the write lands');
  await new Promise((resolve) => setImmediate(resolve));

  const write = s.calls.find((call) => call.kind === 'settings/set');
  assert.ok(write !== undefined, 'the preference is persisted');
  assert.deepEqual(write.payload, { key: 'checklistDismissed', value: true });
});

test('a repeated value does not write again', async (t) => {
  reset();
  const s = stub(() => SNAPSHOT);
  t.after(s.restore);

  useSettingsStore.getState().setChecklistDismissed(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.calls.filter((call) => call.kind === 'settings/set').length, 0, 'already false, nothing to send');
});

test('reopenChecklist clears the dismissal and forces the card for this session', async (t) => {
  reset();
  useSettingsStore.setState({ checklistDismissed: true });
  const s = stub(() => SNAPSHOT);
  t.after(s.restore);

  useSettingsStore.getState().reopenChecklist();
  assert.equal(useSettingsStore.getState().checklistDismissed, false);
  assert.equal(useSettingsStore.getState().checklistForced, true, 'the forced flag is webview-only, never persisted');
  await new Promise((resolve) => setImmediate(resolve));

  const write = s.calls.find((call) => call.kind === 'settings/set');
  assert.deepEqual(write?.payload, { key: 'checklistDismissed', value: false });
});

test('the forced flag is dropped once the card is dismissed again', async (t) => {
  reset();
  useSettingsStore.setState({ checklistForced: true });
  const s = stub(() => SNAPSHOT);
  t.after(s.restore);

  useSettingsStore.getState().setChecklistDismissed(true);
  assert.equal(useSettingsStore.getState().checklistForced, false, 'a fresh dismissal beats a stale force');
});

test('a failed persist keeps the local flag and does not throw', async (t) => {
  reset();
  const s = stub(() => {
    throw new Error('host down');
  });
  t.after(s.restore);

  useSettingsStore.getState().setChecklistDismissed(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useSettingsStore.getState().checklistDismissed, true);
});
