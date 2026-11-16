import assert from "node:assert/strict";
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  readPreferences,
  writePreferences,
} from "../public/preferences.mjs";

function storageWith(initial = null) {
  let value = initial;
  return {
    getItem(key) { assert.equal(key, PREFERENCES_KEY); return value; },
    setItem(key, next) { assert.equal(key, PREFERENCES_KEY); value = next; },
    get value() { return value; },
  };
}

assert.deepEqual(readPreferences(storageWith()), DEFAULT_PREFERENCES);
assert.deepEqual(readPreferences(storageWith("not-json")), DEFAULT_PREFERENCES);

const storage = storageWith();
const saved = writePreferences({ translationLanguage: "en", defaultZoom: "125", pageGap: 32 }, storage);
assert.deepEqual(saved, { translationLanguage: "en", defaultZoom: "125", pageGap: 32 });
assert.deepEqual(readPreferences(storage), saved);

assert.deepEqual(writePreferences({ translationLanguage: "xx", defaultZoom: "999", pageGap: 80 }, storage), {
  ...DEFAULT_PREFERENCES,
  pageGap: 48,
});
assert.deepEqual(writePreferences({ pageGap: -4 }, storage), { ...DEFAULT_PREFERENCES, pageGap: 0 });
assert.deepEqual(writePreferences({ pageGap: "invalid" }, storage), DEFAULT_PREFERENCES);
assert.deepEqual(writePreferences({ pageGap: null }, storage), DEFAULT_PREFERENCES);

// Only numbers and plain decimal strings are real settings. Loose Number()/
// String() coercion used to persist booleans, arrays, hex strings and objects.
for (const fake of [true, false, [], ["32"], "0x20", "  ", {}, null]) {
  assert.deepEqual(writePreferences({ pageGap: fake }, storage), DEFAULT_PREFERENCES, `pageGap ${JSON.stringify(fake)} must be rejected`);
}
assert.equal(writePreferences({ pageGap: "32" }, storage).pageGap, 32, "a decimal string is still accepted");
for (const fake of [["100"], { toString: () => "125" }, {}]) {
  assert.equal(writePreferences({ defaultZoom: fake }, storage).defaultZoom, DEFAULT_PREFERENCES.defaultZoom, `defaultZoom ${JSON.stringify(fake)} must be rejected`);
}
assert.equal(writePreferences({ defaultZoom: 100 }, storage).defaultZoom, "100", "a numeric zoom is still accepted");
assert.deepEqual(writePreferences({ translationLanguage: ["zh"] }, storage), DEFAULT_PREFERENCES);

const deniedStorage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
assert.deepEqual(readPreferences(deniedStorage), DEFAULT_PREFERENCES);
assert.deepEqual(writePreferences({ translationLanguage: "zh" }, deniedStorage), {
  ...DEFAULT_PREFERENCES,
  translationLanguage: "zh",
});

console.log("preferences defaults, validation, persistence, and unavailable storage passed");
