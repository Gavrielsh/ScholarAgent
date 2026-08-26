/**
 * Numeric access level, as stored in the database and enforced by RLS.
 *
 * 0 is the most privileged tier and 3 the least; a knowledge_base row is
 * visible when the caller's level is <= the row's classification level.
 *
 * This is the persistence layer's own contract. The security layer maps its
 * four-tier role model onto these numbers (`PermissionLevel` is an alias of
 * this type), which lets core open an RLS-scoped transaction without knowing
 * anything about roles, registries, or how a level was derived.
 */
export type AccessLevel = 0 | 1 | 2 | 3;

/**
 * Most privileged level. Maintenance and bookkeeping transactions run here so
 * their existence checks can see every row regardless of classification.
 */
export const MAX_PRIVILEGE_LEVEL: AccessLevel = 0;

/** Least privileged level still permitted to write to the corpus. */
export const MIN_CORPUS_WRITE_LEVEL: AccessLevel = 1;
