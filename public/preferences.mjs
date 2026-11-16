/** Local preferences for the DSH PDF viewer. */
export const PREFERENCES_KEY = "dsh-fast-pdf.preferences.v1";

export const DEFAULT_PREFERENCES = Object.freeze({
  translationLanguage: "auto",
  defaultZoom: "page-width",
  pageGap: 14,
});

const LANGUAGES = new Set(["auto", "zh", "en"]);
const ZOOMS = new Set(["page-width", "50", "75", "100", "125", "150", "175", "200", "250", "300"]);

/**
 * Zoom modes that used to be saved and no longer exist.
 *
 * A preference file outlives the build that wrote it: a reader who chose
 * `page-fit` before it was removed would otherwise fall back to the default,
 * which is the very mode they were trying to leave. Mapping the old name keeps
 * the closest thing to what they picked.
 */
const RETIRED_ZOOMS = new Map([["page-fit", "page-width"]]);

function normalize(input) {
  // Only a plain object is a preference bag. An array, Date or string would
  // otherwise be spread into numeric keys and read as "no preferences".
  const value = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
  // Accept numbers and decimal strings only. `Number(true)` is 1, `Number([])`
  // is 0 and `Number("0x20")` is 32 — all of which would silently persist a
  // value the settings UI never produced.
  const rawGap = value.pageGap;
  const gap = typeof rawGap === "number"
    ? rawGap
    : typeof rawGap === "string" && rawGap.trim() !== "" && /^\d+(?:\.\d+)?$/u.test(rawGap.trim())
      ? Number(rawGap)
      : Number.NaN;
  const rawZoom = value.defaultZoom;
  const stored = typeof rawZoom === "number" ? String(rawZoom) : typeof rawZoom === "string" ? rawZoom : "";
  const zoom = RETIRED_ZOOMS.get(stored) ?? stored;
  return {
    translationLanguage: typeof value.translationLanguage === "string" && LANGUAGES.has(value.translationLanguage)
      ? value.translationLanguage
      : DEFAULT_PREFERENCES.translationLanguage,
    defaultZoom: ZOOMS.has(zoom) ? zoom : DEFAULT_PREFERENCES.defaultZoom,
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
