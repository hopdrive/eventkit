// Pure helpers over a Hasura DB-event payload. Defensive by design — a malformed
// payload yields undefined/null/false rather than throwing, so a detector's
// `switch (ctx.operation)` simply falls through to its default (no false positives).
import type { HasuraEventPayload, HasuraOperation, HasuraSessionVariables } from './types.js';

type Row = Record<string, unknown>;

export const getOperation = (p: HasuraEventPayload | undefined): HasuraOperation | undefined => p?.event?.op;

export const getOldRow = (p: HasuraEventPayload | undefined): Row | null =>
  (p?.event?.data?.old as Row | null | undefined) ?? null;

export const getNewRow = (p: HasuraEventPayload | undefined): Row | null =>
  (p?.event?.data?.new as Row | null | undefined) ?? null;

export const getSession = (p: HasuraEventPayload | undefined): HasuraSessionVariables =>
  (p?.event?.session_variables as HasuraSessionVariables | null | undefined) ?? {};

const has = (row: Row | null, col: string): boolean =>
  !!row && Object.prototype.hasOwnProperty.call(row, col);

/**
 * True if `col` exists in BOTH old and new and the values differ. Ports the
 * legacy `columnHasChanged` semantics exactly (INSERT/DELETE → false, since one
 * side is absent).
 */
export const columnChanged = (oldRow: Row | null, newRow: Row | null, col: string): boolean => {
  if (!col || !oldRow || !newRow) return false;
  if (!has(oldRow, col) || !has(newRow, col)) return false;
  return oldRow[col] !== newRow[col];
};

/** True if `col` went from null/absent (old) to a non-null value (new) — incl. INSERT. */
export const columnAdded = (oldRow: Row | null, newRow: Row | null, col: string): boolean => {
  const before = oldRow?.[col];
  const after = newRow?.[col];
  return before == null && after != null;
};

/** True if `col` went from a non-null value (old) to null/absent (new) — incl. DELETE. */
export const columnRemoved = (oldRow: Row | null, newRow: Row | null, col: string): boolean => {
  const before = oldRow?.[col];
  const after = newRow?.[col];
  return before != null && after == null;
};
