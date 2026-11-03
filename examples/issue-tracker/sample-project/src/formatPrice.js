/**
 * Format an amount in minor units (e.g. cents) as a localized price.
 *
 * @param {number} minor amount in the currency's minor unit
 * @param {string} currency ISO 4217 code, e.g. "USD"
 * @param {string} [locale="en-US"]
 * @returns {string}
 */
export function formatPrice(minor, currency, locale = "en-US") {
  if (!Number.isFinite(minor)) throw new TypeError("formatPrice: amount must be a finite number");
  const fmt = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  return fmt.format(minor / 10 ** digits);
}
