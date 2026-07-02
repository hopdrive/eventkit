// Generic tracking-token codec: `source<sep>correlationId<sep>jobExecutionId`.
// Ported from the legacy hasura-event-detector tracking-token.ts — which imports
// nothing HopDrive-specific, proving the mechanism is generic. Separator and
// correlation-id validation are config (ADR-024); HopDrive presets pin them.

export interface TokenCodecConfig {
  /** Delimiter between parts. Legacy HopDrive uses `'|'`; core's default is `'.'`. */
  separator?: string;
  /** When true, `isValid`/`parse` require the correlation part to be a UUID (legacy behavior). */
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (validateCorrelationId && !UUID_RE.test(parts[1]!)) return false;
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
