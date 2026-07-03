// =============================================================================
// Chain-guard seam (ADR-034 / ADR-041)
// =============================================================================
// The pre-dispatch suppress seam grows a deliberate STRUCTURED contract — no
// string parsing. A pre-dispatch plugin (e.g. loopGuard at its hop ceiling)
// communicates a halt or an early alarm by writing one of these shapes onto
// `envelope.meta`; the RUNTIME (which owns invocationId/correlationId and the
// reportError fan-out) does the reporting on the plugin's behalf — a plugin's
// `augmentEnvelope` cannot reach `onError` without throwing, and a throw is the
// wrong signal for a deliberate, non-erroring halt.

/**
 * Set at `envelope.meta[SUPPRESS_DISPATCH_KEY]` by a pre-dispatch plugin to
 * HARD-STOP the invocation before any detector runs. `error` (typically a branded
 * `LoopDetectedError`) is reported through `onError` with phase `'chain-guard'`.
 * A plain string reason is still accepted at the meta key for generic plugins that
 * carry no branded error.
 */
export interface SuppressDispatch {
  reason: string;
  error?: unknown;
}

/**
 * Set at `envelope.meta[CHAIN_GUARD_WARNING_KEY]` to report a NON-FATAL branded
 * error (severity `'warn'`) through `onError` while dispatch PROCEEDS — the
 * `warnAtDepth` early alarm (ADR-041) that fires while the chain is still running.
 */
export interface ChainGuardWarning {
  error: unknown;
}

/** Meta key for a {@link SuppressDispatch} (or a bare reason string). */
export const SUPPRESS_DISPATCH_KEY = 'suppressDispatch';

/** Meta key for a {@link ChainGuardWarning}. */
export const CHAIN_GUARD_WARNING_KEY = 'chainGuardWarning';
