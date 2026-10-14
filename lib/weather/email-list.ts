/** Shared by the form (client) and the API (server) so both split a pasted list the same way. */

/** Splits "a@x.com, b@y.org c@z.net" into distinct, lower-cased addresses. */
export function splitEmailList(text: string): string[] {
  const parts = text
    .split(/[\s,;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(parts)];
}

/** Deliberately loose: one @, something on both sides, a dot in the domain. Zod validates for real. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
