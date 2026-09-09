/**
 * Webview internationalization module (FEAT-i18n).
 *
 * English is the source language: Catalog type is derived from `en`, and `id`
 * is typed as `Catalog` to force complete translation coverage at compile time.
 * Parameterized messages use plain type-safe functions instead of template engines.
 */
import type { Lang } from '../messages';
import en from './i18n.en';
import id from './i18n.id';

export type { Lang };
export type Catalog = typeof en;

export const catalogs: Record<Lang, Catalog> = { en, id };

/**
 * Module-level active language container.
 * Invariant: activeLang() must always mirror useSettingsStore.language.
 * The only module that mutates setActiveLang is store.ts (or test harness with teardown).
 */
let active: Lang = 'en';

export function setActiveLang(lang: Lang): void {
  active = lang === 'id' ? 'id' : 'en';
}

export function activeLang(): Lang {
  return active;
}

/** Non-reactive catalog lookup by language. */
export function t(lang: Lang): Catalog {
  return catalogs[lang] ?? catalogs.en;
}
