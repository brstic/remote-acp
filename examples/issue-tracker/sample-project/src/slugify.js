/**
 * Turn a product title into the slug used in product URLs: /products/<slug>.
 *
 * @param {string} title
 * @returns {string}
 */
export function slugify(title) {
  return String(title)
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents: "Café" -> "Cafe"
    .replace(/[^A-Za-z0-9]/g, "-")
    .replace(/^-+|-+$/g, "");
}
