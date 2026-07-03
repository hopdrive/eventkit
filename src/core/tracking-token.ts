// Generic tracking-token codec: `source<sep>correlationId<sep>jobExecutionId`.
// Ported from the legacy hasura-event-detector tracking-token.ts — which imports
// nothing HopDrive-specific, proving the mechanism is generic. Separator and
// correlation-id validation are config (ADR-024); HopDrive presets pin them.
//
// This is a pure, dependency-free core primitive (ADR-039.1). It is consumed by
// `loopGuard`, `correlationResolver`, the Hasura sources, and (eventually) sdk-*
// write helpers. It used to live inside the loop-guard plugin; `correlationResolver`
// reaching across into `plugins/loop-guard/codec.js` for it was the tell that it
// belonged in core.

export interface TokenCodecConfig {
  /** Delimiter between parts. Legacy HopDrive uses `'|'`; core's default is `'.'`. */
  separator?: string;
  /** When true, `isValid`/`parse` require the correlation part to match `isCorrelationIdShape` (legacy behavior). */
  validateCorrelationId?: boolean;
}

export interface TokenComponents {
  source: string;
  correlationId: string;
  jobExecutionId?: string;
  /** Optional hop counter (ADR-034), the 4th token segment. Present only when hop-depth tracking is on. */
  hopDepth?: number;
}

export interface TokenCodec {
  readonly separator: string;
  create(source: string, correlationId: string, jobExecutionId?: string, hopDepth?: number): string;
  parse(token: string): TokenComponents | null;
  isValid(value: unknown): value is string;
  withJobExecutionId(token: string, jobExecutionId: string, hopDepth?: number): string;
  getCorrelationId(token: string): string | null;
  getSource(token: string): string | null;
  getJobExecutionId(token: string): string | null;
  /** The hop counter carried in the token (ADR-034), or null when absent. */
  getHopDepth(token: string): number | null;
}

// ADR-040: a correlation id is a canonical UUID (8-4-4-4-12) OR 128-bit dashless
// hex (exactly 32 hex chars). Hasura `trace_context.trace_id` roots are 32-hex
// dashless; UUID-only validation silently broke every trace-rooted token parse in
// the live proof (the whole token got treated as a bare id, nesting tokens inside
// tokens and losing sourceJobId/hop depth). One widened regex covers both shapes.
const CORRELATION_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/**
 * True when `value` is a string shaped like a correlation id: a canonical UUID
 * (8-4-4-4-12) or 128-bit dashless hex (exactly 32 hex chars). Non-string inputs
 * are rejected. No whitespace trimming — the value must match exactly.
 */
export function isCorrelationIdShape(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_RE.test(value);
}

export function createTokenCodec(config: TokenCodecConfig = {}): TokenCodec {
  const separator = config.separator ?? '.';
  const validateCorrelationId = config.validateCorrelationId ?? false;
  const sanitize = (v: string): string => v.split(separator).join('_');

  // 2-3 parts is the base token; a 4th part is the optional hop counter (ADR-034),
  // present only when hop-depth tracking is on. The 4th slot never changes a plain
  // `source<sep>correlationId<sep>jobId` token.
  const isValid = (value: unknown): value is string => {
    if (!value || typeof value !== 'string') return false;
    const parts = value.split(separator);
    if (parts.length < 2 || parts.length > 4) return false;
    if (!parts.every(p => p.length > 0)) return false;
    if (validateCorrelationId && !isCorrelationIdShape(parts[1]!)) return false;
    return true;
  };

  const parse = (token: string): TokenComponents | null => {
    if (!isValid(token)) return null;
    const parts = token.split(separator);
    const components: TokenComponents = { source: parts[0]!, correlationId: parts[1]! };
    if (parts[2]) components.jobExecutionId = parts[2];
    if (parts[3]) {
      const depth = Number.parseInt(parts[3], 10);
      if (Number.isFinite(depth)) components.hopDepth = depth;
    }
    return components;
  };

  const create = (source: string, correlationId: string, jobExecutionId?: string, hopDepth?: number): string => {
    if (!source || !correlationId) throw new Error('Tracking token requires both source and correlationId.');
    let token = `${sanitize(source)}${separator}${correlationId}`;
    // A hop counter needs a job-id slot before it, so the 4-part shape stays unambiguous.
    if (jobExecutionId || hopDepth !== undefined) token += `${separator}${sanitize(jobExecutionId ?? '0')}`;
    if (hopDepth !== undefined) token += `${separator}${hopDepth}`;
    return token;
  };

  const withJobExecutionId = (token: string, jobExecutionId: string, hopDepth?: number): string => {
    const parsed = parse(token);
    if (!parsed) throw new Error('Invalid tracking token provided.');
    return create(parsed.source, parsed.correlationId, jobExecutionId, hopDepth);
  };

  return {
    separator,
    create,
    parse,
    isValid,
    withJobExecutionId,
    getCorrelationId: t => parse(t)?.correlationId ?? null,
    getSource: t => parse(t)?.source ?? null,
    getJobExecutionId: t => parse(t)?.jobExecutionId ?? null,
    getHopDepth: t => parse(t)?.hopDepth ?? null,
  };
}
