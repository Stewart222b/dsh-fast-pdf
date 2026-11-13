/**
 * The three strings the ported viewer core asks for.
 *
 * The full app localizes dozens of toolbar labels through its own i18n module;
 * the viewer core only reaches for these three, and the plugin's own chrome is
 * localized by the Host's `locale` service, so the port keeps a table this
 * small instead of importing the app's locale catalogue.
 */
const TABLE = {
  document: "文档",
  jump: "打开链接",
  pdfPasswordNeeded: "需要 PDF 密码",
};

/**
 * Localize one key.
 * @param key - message key.
 * @returns the message, or the key itself when unknown.
 */
export function t(key) {
  return TABLE[key] ?? key;
}
