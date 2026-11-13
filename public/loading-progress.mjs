/**
 * The staged line under the opening spinner.
 *
 * Ported from the browser extension's `loading-progress.js`, minus the DOM work:
 * there the module owned three elements and wrote to them, here it answers what
 * the line should say and the pane renders it. The phases are the same three the
 * reader can be in — waiting for the first byte, counting bytes, and parsing a
 * file it already has.
 */

export function formatLoadingBytes(value, locale = "en") {
  const number = Number(value);
  const bytes = Number.isFinite(number) ? Math.max(0, number) : 0;
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(3, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)));
  let amount;
  try {
    amount = new Intl.NumberFormat(locale, { maximumFractionDigits: index ? 1 : 0 }).format(bytes / 1024 ** index);
  } catch {
    amount = (bytes / 1024 ** index).toFixed(index ? 1 : 0);
  }
  return `${amount} ${units[index]}`;
}

/** Substitute `{name}` placeholders in one translated string. */
function fill(template, vars) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (whole, name) =>
    (vars[name] === undefined ? whole : String(vars[name])));
}

/**
 * What the opening line should say right now.
 *
 * Both phases count something real, and both can be countdowns the reader can
 * follow: during `download` the ratio is bytes over the length the Host
 * reported, during `prepare` it is pages laid out over pages in the file. The
 * port from the extension kept `prepare` indeterminate because there the bytes
 * streamed over HTTP and only the parse was left — here the bytes arrive
 * through the Host without a length, so the page count is the only 0-100 a
 * reader can be given, and an unchanging spinner for the whole open is what
 * they asked to have replaced.
 *
 * @param {{phase?: "download"|"prepare", progress?: number|null, loaded?: number, total?: number}} event
 * @param t - the pane's dictionary.
 * @param locale - for the byte grouping separator.
 */
export function loadingState(event, t, locale = "en") {
  const phase = event?.phase === "prepare" ? "prepare" : "download";
  const total = Number(event?.total) > 0 ? Number(event.total) : 0;
  const ratio = Number(event?.progress);
  const known = total > 0 && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1;
  const percent = known ? Math.floor(ratio * 100) : null;
  // The bar and the line count different things once a second phase starts:
  // the line is about bytes or pages, the bar is the one 0-100 that must not
  // walk backwards when the file finishes downloading and the layout begins
  // (measured: 100 → 48 on a 200-page file). `barPercent` is that number; the
  // text keeps its own phase percentage.
  const bar = Number(event?.barPercent);
  const barPercent = Number.isFinite(bar)
    ? Math.max(0, Math.min(100, Math.floor(bar)))
    : (known ? percent : null);
  const loaded = Number(event?.loaded);
  const received = Number.isFinite(loaded) && loaded > 0 ? loaded : (known ? total * ratio : 0);
  let text;
  if (phase === "prepare") {
    text = known
      ? fill(t("loadingPreparePages"), { loaded: Math.min(total, Math.round(received || total * ratio)), total })
      : t("loadingPrepare");
  } else if (known) {
    text = fill(t("loadingBytes"), {
      loaded: formatLoadingBytes(received, locale),
      total: formatLoadingBytes(total, locale),
      percent,
    });
  } else if (received > 0) {
    text = fill(t("loadingReceived"), { loaded: formatLoadingBytes(received, locale) });
  } else text = t("loadingWaiting");
  // The bar can be determinate while the line is not: the layout knows its
  // share (95 → 100) before it knows how many pages it is counting.
  return { mode: barPercent === null ? "indeterminate" : "determinate", percent: barPercent, text };
}
