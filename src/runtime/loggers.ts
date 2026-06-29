// Concrete logger implementations. A logger builds a structured `LogEntry` and
// hands it to a sink; the sink routes it to plugins (`onLog` for framework/handler
// logs, `onJobLog` for job logs). Plugins decide where logs ultimately go — with
// none registered, logs are simply not transported (§9.3).
import type { DetectorLogger, HandlerLogger, JobLogger, LogEntry, LogLevel } from '../core/index.js';

export type LogSink = (entry: LogEntry) => void;

/** Correlation fields stamped onto every entry from a logger. */
export type LogBase = Pick<LogEntry, 'invocationId' | 'correlationId' | 'eventName' | 'jobName' | 'scope'>;

const buildEntry = (
  level: LogLevel,
  message: string,
  base: LogBase,
  data?: Record<string, unknown>,
  error?: unknown,
): LogEntry => {
  const entry: LogEntry = { level, message, at: new Date() };
  if (base.invocationId !== undefined) entry.invocationId = base.invocationId;
  if (base.correlationId !== undefined) entry.correlationId = base.correlationId;
  if (base.eventName !== undefined) entry.eventName = base.eventName;
  if (base.jobName !== undefined) entry.jobName = base.jobName;
  if (base.scope !== undefined) entry.scope = base.scope;
  if (data !== undefined) entry.data = data;
  if (error !== undefined) entry.error = error;
  return entry;
};

/** Full structured logger for handlers, jobs, and framework-internal logs. */
export const createHandlerLogger = (base: LogBase, sink: LogSink): HandlerLogger => ({
  debug: (m, d) => sink(buildEntry('debug', m, base, d)),
  info: (m, d) => sink(buildEntry('info', m, base, d)),
  warn: (m, d) => sink(buildEntry('warn', m, base, d)),
  error: (m, err, d) => sink(buildEntry('error', m, base, d, err)),
});

export const createJobLogger = (base: LogBase, sink: LogSink): JobLogger => createHandlerLogger(base, sink);

/** Detection-phase logger: debug only, to keep detectors side-effect-light (§9.3). */
export const createDetectorLogger = (base: LogBase, sink: LogSink): DetectorLogger => ({
  debug: (m, d) => sink(buildEntry('debug', m, base, d)),
});
