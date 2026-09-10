import test from 'node:test';
import assert from 'node:assert/strict';
import { copyToClipboard } from '../src/webview/clipboard';

test('copyToClipboard resolves true via navigator.clipboard.writeText', async () => {
  let copiedText = '';
  const originalNavigator = globalThis.navigator;

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: async (text: string) => {
            copiedText = text;
          },
        },
      },
      configurable: true,
      writable: true,
    });

    const success = await copyToClipboard('0123456789abcdef0123456789abcdef01234567');
    assert.equal(success, true);
    assert.equal(copiedText, '0123456789abcdef0123456789abcdef01234567');
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  }
});

test('copyToClipboard falls back to document.execCommand when navigator.clipboard throws', async () => {
  const originalNavigator = globalThis.navigator;
  const originalDocument = globalThis.document;

  let execCommandCalledWith = '';
  let appendedValue = '';
  let textareaRemoved = false;

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: async () => {
            throw new Error('Permission denied');
          },
        },
      },
      configurable: true,
      writable: true,
    });

    const mockTextarea: Record<string, unknown> = {
      style: {},
      value: '',
      setAttribute: () => {},
      select: () => {},
    };

    Object.defineProperty(globalThis, 'document', {
      value: {
        createElement: (tag: string) => {
          if (tag === 'textarea') return mockTextarea;
          return {};
        },
        body: {
          appendChild: (el: Record<string, unknown>) => {
            appendedValue = el.value as string;
          },
          removeChild: () => {
            textareaRemoved = true;
          },
        },
        execCommand: (command: string) => {
          execCommandCalledWith = command;
          return true;
        },
      },
      configurable: true,
      writable: true,
    });

    const success = await copyToClipboard('fallback-hash-val');
    assert.equal(success, true);
    assert.equal(appendedValue, 'fallback-hash-val');
    assert.equal(execCommandCalledWith, 'copy');
    assert.equal(textareaRemoved, true);
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: originalDocument,
      configurable: true,
      writable: true,
    });
  }
});

test('copyToClipboard returns false when both clipboard API and DOM are unavailable', async () => {
  const originalNavigator = globalThis.navigator;
  const originalDocument = globalThis.document;

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    const success = await copyToClipboard('some-hash');
    assert.equal(success, false);
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: originalDocument,
      configurable: true,
      writable: true,
    });
  }
});
