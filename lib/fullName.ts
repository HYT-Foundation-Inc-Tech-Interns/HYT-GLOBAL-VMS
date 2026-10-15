/**
 * The three name parts, and the one place that turns them into a display name.
 *
 * `public.users.name` is the canonical display string - the UI shows it and
 * `orientation_status_for` returns it - but the forms now collect a first name,
 * an optional middle initial and a last name. Every write path composes `name`
 * from those parts through `composeFullName`, so the two cannot drift apart on
 * formatting.
 *
 * `name` is deliberately NOT a generated column and is not derived in the
 * database. The roster rows hold full middle names ("Gemmalyn Ocbina Aranda"),
 * and recomputing from an initial would rewrite them all to "Gemmalyn O.
 * Aranda" and throw the middle name away. See migration 20260101000019.
 */

/**
 * One upper-case letter, or null.
 *
 * Accepts what a person actually types - `o`, `O`, `O.`, ` o ` - and reduces it
 * to `O`. A period is stripped rather than added, so `composeFullName` can add
 * exactly one. A value with no letter in it is treated as "no middle name"
 * rather than stored as punctuation.
 */
export function normaliseMiddleInitial(
  value: string | null | undefined
): string | null {
  const letter = (value ?? '').replace(/\./g, '').trim().charAt(0);
  if (!letter) return null;
  // A stray digit or symbol is a typo, not a name.
  if (!/\p{L}/u.test(letter)) return null;
  return letter.toUpperCase();
}

/**
 * "First M. Last", or "First Last" when there is no middle initial.
 *
 * Each part is trimmed and empty parts are dropped, so a blank middle initial
 * cannot leave a double space behind.
 */
export function composeFullName(
  firstName: string,
  middleInitial: string | null | undefined,
  lastName: string
): string {
  const mi = normaliseMiddleInitial(middleInitial);
  return [firstName.trim(), mi ? `${mi}.` : '', lastName.trim()]
    .filter(Boolean)
    .join(' ');
}
