// Registry for probes that would not fit in `index.html` any more.
//
// `index.html` hands each entry here the same toolbox its inline blocks use
// (`note`, `until`, `settle`, `click`, `spans`, `selectSpan`, …), so a probe
// written here is indistinguishable from an inline one — same prologue notes,
// same `log:` line, same screenshot, same exit code.
//
// One file per owner on purpose: `index.html` is one file, and two people
// adding a scenario to it at the same time means one of them loses a block.
// A new probe is a key in your own file, nothing else.
import probeA from "./hunt-a.mjs";
import probeB from "./hunt-b.mjs";
import probeC from "./hunt-c.mjs";
import probeLead from "./lead.mjs";

const table = new Map([probeA, probeB, probeC, probeLead].flatMap((group) => Object.entries(group)));

/**
 * The probe registered under a `?scenario=` value, or `null` when no block
 * answers to that name (the inline blocks are tried first, then this table).
 */
export function loadScenario(name) {
  const entry = table.get(name);
  if (entry === undefined) return null;
  if (typeof entry !== "function") throw new Error(`scenario "${name}" is not a function`);
  return entry;
}

/** Everything registered, for a `?scenario=list` convenience. */
export function scenarioNames() {
  return [...table.keys()];
}
