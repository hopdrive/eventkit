// =============================================================================
// Tiered loggers + log entries (§9.3)
// =============================================================================
// Detectors get `debug` only — they run for every invocation across every
// registered module and MUST stay side-effect-light. Handlers and jobs get the
// full structured set. Plugins decide where logs actually go (console, Grafana,
// observability tables, durable `batch_jobs.output`); the runtime routes its own
// framework-internal logs (detection, plugin-system, timeout handling) through
// `onLog`/`onJobLog` so observability coverage is never silently lost (§9.3, §11.3).

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Detection-phase logger: debug only, to discourage detector side effects. */
export interface DetectorLogger {
  debug(message: string, data?: Record<string, unknown>): void;
}

/** Full structured logger used by handlers. */
export interface HandlerLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, err?: unknown, data?: Record<string, unknown>): void;
}

/** Jobs log with the same surface as handlers. */
export type JobLogger = HandlerLogger;

/**
 * A single structured log record handed to `onLog`/`onJobLog`. The shape a
 * plugin receives — distinct from the call-site logger methods above.
 */
export interface LogEntry {
  level: LogLevel;
  message: string;
  /** When the entry was created. */
  at: Date;
  /** Free-form structured payload supplied at the call site. */
  data?: Record<string, unknown>;
  /** Present on error-level entries when an error object was supplied. */
  error?: unknown;
  // --- correlation (populated by the runtime, not the call site) ----------
  invocationId?: string;
  correlationId?: string;
  eventName?: string;
  jobName?: string;
  /** Logical scope/prefix, e.g. `'detection'`, `'plugin-system'`, `'timeout'`, or a job name. */
  scope?: string;
}
