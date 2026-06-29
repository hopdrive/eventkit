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
}

export interface TokenCodec {
  readonly separator: string;
  create(source: string, correlationId: string, jobExecutionId?: string): string;
  parse(token: string): TokenComponents | null;
  isValid(value: unknown): value is string;
  withJobExecutionId(token: string, jobExecutionId: string): string;
  getCorrelationId(token: string): string | null;
  getSource(token: string): string | null;
  getJobExecutionId(token: string): string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTokenCodec(config: TokenCodecConfig = {}): TokenCodec {
  const separator = config.separator ?? '.';
  const validateCorrelationId = config.validateCorrelationId ?? false;
  const sanitize = (v: string): string => v.split(separator).join('_');

  const isValid = (value: unknown): value is string => {
    if (!value || typeof value !== 'string') return false;
    const parts = value.split(separator);
    if (parts.length < 2 || parts.length > 3) return false;
    if (!parts.every(p => p.length > 0)) return false;
    if (validateCorrelationId && !UUID_RE.test(parts[1]!)) return false;
    return true;
  };

  const parse = (token: string): TokenComponents | null => {
    if (!isValid(token)) return null;
    const parts = token.split(separator);
    const components: TokenComponents = { source: parts[0]!, correlationId: parts[1]! };
    if (parts[2]) components.jobExecutionId = parts[2];
    return components;
  };

  const create = (source: string, correlationId: string, jobExecutionId?: string): string => {
    if (!source || !correlationId) throw new Error('Tracking token requires both source and correlationId.');
    const head = `${sanitize(source)}${separator}${correlationId}`;
    return jobExecutionId ? `${head}${separator}${sanitize(jobExecutionId)}` : head;
  };

  const withJobExecutionId = (token: string, jobExecutionId: string): string => {
    const parsed = parse(token);
    if (!parsed) throw new Error('Invalid tracking token provided.');
    return create(parsed.source, parsed.correlationId, jobExecutionId);
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
  };
}
