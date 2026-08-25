/**
 * Unique, timestamped throwaway data for the consumer-journey suite.
 *
 * Every value is derived from `Date.now()` plus a short random suffix (two runs in the
 * same millisecond — unlikely but not impossible under `workers: 1` serial execution —
 * would otherwise collide on the email/team unique constraints). Nothing here is shared
 * across runs or reused from a fixture file, so re-running the suite never collides with
 * a previous run's rows, and parallel runs (were this project ever un-serialized) would
 * not collide with each other either.
 */
export type JourneyUser = {
  stamp: string;
  name: string;
  email: string;
  password: string;
  /** Passed to the join form's "Team Name" field. Kept slug-safe (lowercase, hyphenated,
   *  no spaces) so the server's slugify is a no-op and the predicted slug is exact — but
   *  callers should still read the REAL slug back from the post-login URL rather than
   *  assume it, since the server is the one source of truth for the final slug. */
  teamName: string;
  routeName: string;
};

export function makeJourneyUser(): JourneyUser {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  return {
    stamp,
    name: 'Consumer Journey',
    email: `cj-${stamp}@e2e.coreframe-labs.dev`,
    // Meets the join form's own password rules (checked against the real validation,
    // not guessed): mixed case, digit, symbol, 8+ chars.
    password: `Cj-${stamp}-Aa1!`,
    teamName: `cj-${stamp}`,
    routeName: `cj-route-${stamp}`,
  };
}
