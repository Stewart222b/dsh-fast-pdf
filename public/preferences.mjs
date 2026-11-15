/** Local preferences for the DSH PDF viewer. */
export const PREFERENCES_KEY = "dsh-fast-pdf.preferences.v1";

export const DEFAULT_PREFERENCES = Object.freeze({
  translationLanguage: "auto",
  defaultZoom: "page-fit",
  pageGap: 14,
});

const LANGUAGES = new Set(["auto", "zh", "en"]);
const ZOOMS = new Set(["page-fit", "page-width", "50", "75", "100", "125", "150", "175", "200", "250", "300"]);

function normalize(input) {
  const value = input !== null && typeof input === "object" ? input : {};
  const gap = value.pageGap === null || value.pageGap === "" ? Number.NaN : Number(value.pageGap);
  return {
    translationLanguage: LANGUAGES.has(value.translationLanguage)
      ? value.translationLanguage
      : DEFAULT_PREFERENCES.translationLanguage,
    defaultZoom: ZOOMS.has(String(value.defaultZoom))
      ? String(value.defaultZoom)
      : DEFAULT_PREFERENCES.defaultZoom,
    pageGap: Number.isFinite(gap)
      ? Math.max(0, Math.min(48, Math.round(gap)))
      : DEFAULT_PREFERENCES.pageGap,
  };
}

/** Read preferences safely; unavailable or malformed storage uses defaults. */
export function readPreferences(storage) {
  try {
    const source = storage ?? globalThis.localStorage;
    const raw = source?.getItem(PREFERENCES_KEY);
    return raw ? normalize(JSON.parse(raw)) : { ...DEFAULT_PREFERENCES };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Save only supported values and return the normalized saved preferences. */
export function writePreferences(value, storage) {
  const preferences = normalize(value);
  try {
    const target = storage ?? globalThis.localStorage;
    target?.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Private browsing and constrained webviews may deny localStorage.
  }
  return preferences;
}
