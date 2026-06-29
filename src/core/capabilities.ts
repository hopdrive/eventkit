// =============================================================================
// Capability tokens (D20 — qualified)
// =============================================================================
// A capability is a *singleton role* a plugin fills (`provides`) or depends on
// (`requires`). Per the resolved default for D20 these are QUALIFIED tokens:
// a bare role (`'source'`, `'platform'`) plus an optional `:qualifier`, so a
// plugin can depend on Hasura specifically (`'source:hasura'`) rather than
// "any source". Uniqueness is enforced at the ROLE level (two plugins cannot
// both `provides: ['source']`); `requires` may pin a qualifier (§11.1).

/** The two singleton roles the runtime arbitrates today. */
export type CapabilityRole = 'source' | 'platform';

/**
 * A capability token: a role, optionally qualified.
 *  - `'source'`            — the source role, unqualified
 *  - `'source:hasura'`     — the source role, qualified to a specific provider
 *  - `'platform'`          — the platform role
 *
 * Modeled as a template-literal union so `provides`/`requires` get autocompletion
 * on the roles while still accepting any qualifier string.
 */
export type Capability = CapabilityRole | `${CapabilityRole}:${string}`;

/** Split a capability token into its role and optional qualifier. */
export interface ParsedCapability {
  role: CapabilityRole;
  qualifier?: string;
}
