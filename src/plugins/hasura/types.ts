// =============================================================================
// Hasura source types (§7, §8, §9.2, ADR-023)
// =============================================================================
// Source-specific types live with the source, not in /core, so core stays
// domain- and transport-agnostic (§3.3). Three Hasura-origin adapters:
//   hasuraEvent  — DB event triggers     (sourceType: 'database')
//   hasuraCron   — scheduled triggers    (sourceType: 'cron')
//   hasuraAction — Actions (req/response) (sourceType: 'action', §7.2/ADR-026)

import type { DetectorContext, HandlerContext } from '../../core/index.js';

export type HasuraOperation = 'INSERT' | 'UPDATE' | 'DELETE' | 'MANUAL';

export interface HasuraSessionVariables {
  'x-hasura-role'?: string;
  'x-hasura-user-id'?: string;
  'x-hasura-user-email'?: string;
  [key: string]: string | undefined;
}

/** The raw payload a Hasura DB event trigger delivers. */
export interface HasuraEventPayload<TNewRow = Record<string, unknown>, TOldRow = TNewRow> {
  event: {
    op: HasuraOperation;
    data: { old: TOldRow | null; new: TNewRow | null };
    session_variables?: HasuraSessionVariables | null;
    trace_context?: { trace_id?: string; span_id?: string };
  };
  table: { schema: string; name: string };
  trigger: { name: string };
  id: string;
  created_at: string;
  delivery_info?: { max_retries: number; current_retry: number };
}

/** The raw payload a Hasura scheduled (cron) trigger delivers — a sibling shape. */
export interface HasuraCronPayload<TPayload = Record<string, unknown>> {
  name: string;
  scheduled_time: string;
  payload: TPayload;
  id: string;
}

/**
 * What a `hasuraEvent.detector` receives. The base DetectorContext flattened
 * with Hasura source helpers so authors write `ctx.operation` / `ctx.columnChanged()`
 * directly (the §3.2 house style). Detection-only, side-effect-light.
 */
export interface HasuraDetectorContext<
  TNewRow = Record<string, unknown>,
  TOldRow = TNewRow,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> extends DetectorContext<HasuraEventPayload<TNewRow, TOldRow>, TMeta> {
  operation: HasuraOperation;
  schema: string;
  table: string;
  oldRow: TOldRow | null;
  newRow: TNewRow | null;
  /** `newRow ?? oldRow ?? null`. */
  row: TNewRow | TOldRow | null;
  columnChanged(column: keyof TNewRow | string): boolean;
  columnAdded(column: keyof TNewRow | string): boolean;
  columnRemoved(column: keyof TNewRow | string): boolean;
  previousValue<K extends keyof TOldRow>(column: K): TOldRow[K] | undefined;
  currentValue<K extends keyof TNewRow>(column: K): TNewRow[K] | undefined;
}

/**
 * What a `hasuraEvent.handler` receives — DATA only, no detection helpers (§9.2,
 * Amendment B). `receivedAt` replaces the old `parseHasuraEvent().hasuraEventTime`.
 */
export interface HasuraHandlerContext<
  TNewRow = Record<string, unknown>,
  TOldRow = TNewRow,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> extends HandlerContext<HasuraEventPayload<TNewRow, TOldRow>, TMeta> {
  operation: HasuraOperation;
  oldRow: TOldRow | null;
  newRow: TNewRow | null;
  row: TNewRow | TOldRow | null;
  role: string | null;
  userId: string | null;
  userEmail: string | null;
  receivedAt: Date;
}

// ── hasuraAction (request/response — §7.2, ADR-026) ──────────────────────────

/** The raw payload a Hasura Action delivers (§7.2 — verbatim shape). */
export interface HasuraActionPayload<TInput = Record<string, unknown>> {
  action: { name: string };
  input: TInput;
  /** ALL keys lowercase, e.g. `x-hasura-role`, `x-hasura-user-id`. */
  session_variables?: HasuraSessionVariables | null;
  /** The originating GraphQL query/mutation. */
  request_query?: string;
}

/** The session identity extracted from the lowercase `x-hasura-*` keys. */
export interface HasuraActionSession {
  role: string | null;
  userId: string | null;
  email: string | null;
}

/** What a `hasuraAction.detector` receives — typically matches `ctx.actionName`. */
export interface HasuraActionContext<
  TInput = Record<string, unknown>,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> extends DetectorContext<HasuraActionPayload<TInput>, TMeta> {
  actionName: string;
  input: TInput;
  sessionVariables: HasuraActionSession;
  requestQuery: string | undefined;
}

/** What a `hasuraAction.prepare`/`.resolve` receives — the action args + identity. */
export interface HasuraActionHandlerContext<
  TInput = Record<string, unknown>,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> extends HandlerContext<HasuraActionPayload<TInput>, TMeta> {
  actionName: string;
  input: TInput;
  sessionVariables: HasuraActionSession;
  requestQuery: string | undefined;
}

/** What a `hasuraCron.detector` receives — schedule + payload, no rows. */
export interface HasuraCronContext<
  TPayload = Record<string, unknown>,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> extends DetectorContext<HasuraCronPayload<TPayload>, TMeta> {
  scheduleName: string;
  scheduledAt: Date;
  payload: TPayload;
}

/** What a `hasuraCron.handler` receives — schedule + payload data, no rows. */
export interface HasuraCronHandlerContext<
  TPayload = Record<string, unknown>,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> extends HandlerContext<HasuraCronPayload<TPayload>, TMeta> {
  scheduleName: string;
  scheduledAt: Date;
  payload: TPayload;
}
