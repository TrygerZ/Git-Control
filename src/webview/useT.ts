/**
 * Reactive i18n hook subscribing to active settings store language.
 *
 * Isolated from `i18n.ts` so pure presentation helpers (`format.ts`) and unit
 * tests can import `i18n.ts` without loading store/bridge dependencies.
 */
import { useSettingsStore } from './store';
import { catalogs, type Catalog } from './i18n';

/** Reactive hook subscribing to active language changes. */
export function useT(): Catalog {
  const language = useSettingsStore((s) => s.language);
  return catalogs[language] ?? catalogs.en;
}
