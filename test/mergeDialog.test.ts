import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeActionPayload } from '../src/webview/MergeDialog';
import { t } from '../src/webview/i18n';

test('mergeActionPayload: unchecked produces default fast-forward payload without noFf', () => {
  const payload = mergeActionPayload('feature', false);
  assert.deepEqual(payload, { action: 'merge', branch: 'feature' });
  assert.equal('noFf' in payload, false);
});

test('mergeActionPayload: checked produces payload with noFf: true', () => {
  const payload = mergeActionPayload('feature', true);
  assert.deepEqual(payload, { action: 'merge', branch: 'feature', noFf: true });
});

test('mergeDialog i18n catalogs provide complete and consistent translations without em-dash', () => {
  const en = t('en').mergeDialog;
  const id = t('id').mergeDialog;

  assert.equal(en.title, 'Merge branch');
  assert.equal(id.title, 'Gabungkan branch');

  assert.equal(en.submitButton, 'Merge');
  assert.equal(id.submitButton, 'Gabungkan');

  assert.equal(en.cancelButton, 'Cancel');
  assert.equal(id.cancelButton, 'Batal');

  assert.equal(en.noFfLabel, 'Create a merge commit');
  assert.equal(id.noFfLabel, 'Buat commit gabungan');

  assert.equal(en.noFfHint, 'Keeps a record that these branches merged.');
  assert.equal(id.noFfHint, 'Mencatat jejak bahwa branch ini digabung.');

  // Prompt with explicit target branch
  assert.equal(en.prompt('feature-a', 'main'), 'Merge feature-a into main?');
  assert.equal(id.prompt('feature-a', 'main'), 'Gabungkan feature-a ke main?');

  // Prompt fallback when current branch is absent
  assert.equal(en.prompt('feature-a'), 'Merge feature-a into current branch?');
  assert.equal(id.prompt('feature-a'), 'Gabungkan feature-a ke branch aktif?');

  for (const cat of [en, id]) {
    for (const val of Object.values(cat)) {
      const text = typeof val === 'function' ? val('feat', 'main') : val;
      assert.ok(!text.includes('\u2014'), 'no em-dash');
      assert.ok(!text.includes('\u2013'), 'no en-dash');
    }
  }
});

test('MergeDialog source contract: implements required modal accessibility attributes', () => {
  const dialogSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'MergeDialog.tsx'),
    'utf8',
  );

  assert.ok(dialogSource.includes('role="dialog"'), 'must declare role="dialog"');
  assert.ok(dialogSource.includes('aria-modal="true"'), 'must declare aria-modal="true"');
  assert.ok(dialogSource.includes('aria-labelledby={titleId}'), 'must wire aria-labelledby to title');
  assert.ok(dialogSource.includes('aria-describedby={descId}'), 'must wire aria-describedby to prompt text');
  assert.ok(dialogSource.includes('type="checkbox"'), 'must contain merge commit checkbox');
  assert.ok(dialogSource.includes("event.key === 'Escape'"), 'must handle Escape to cancel');
  assert.ok(!dialogSource.includes('\u2014'), 'zero em-dash in source');
  assert.ok(!dialogSource.includes('\u2013'), 'zero en-dash in source');
});
