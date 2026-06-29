// =============================================================================
// @hopdrive/eventkit/plugins/transports/sentry
// =============================================================================
// Generic error transport (ADR-024). Forwards `onError` to Sentry. DSN/endpoint
// arrive via injected config — never process.env. `send` is the delivery seam
// (default: fetch POST of the event JSON); inject it to test or to delegate to the
// official Sentry SDK.
import type { EventKitPlugin, ErrorContext } from '../../../core/index.js';

export interface SentryEvent {
  level: 'error';
  phase: ErrorContext['phase'];
  message: string;
  exception: { type: string; value: string; stacktrace?: string };
  tags: Record<string, string>;
  environment?: string;
  release?: string;
  timestamp: string;
}

export interface SentryConfig {
  /** Sentry DSN. Used as the default delivery target when `send`/`endpoint` are absent. */
  dsn?: string;
  /** Explicit ingest endpoint (overrides the DSN-derived one for the default sender). */
  endpoint?: string;
  environment?: string;
  release?: string;
  /** Delivery seam. Default posts the event via fetch to `endpoint ?? dsn`. Inject for tests/the Sentry SDK. */
  send?: (event: SentryEvent, target: { endpoint: string }) => void | Promise<void>;
}

const defaultSend = async (event: SentryEvent, target: { endpoint: string }) => {
  await fetch(target.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
};

export function sentry(config: SentryConfig = {}): EventKitPlugin {
  const send = config.send ?? defaultSend;
  const endpoint = config.endpoint ?? config.dsn;
  if (!send && !endpoint) throw new Error('sentry() requires a `dsn`, an `endpoint`, or a custom `send`.');

  return {
    name: 'sentry',
    async onError(ctx: ErrorContext) {
      const event: SentryEvent = {
        level: 'error',
        phase: ctx.phase,
        message: `${ctx.error.name}: ${ctx.error.message}`,
        exception: {
          type: ctx.error.name,
          value: ctx.error.message,
          ...(ctx.error.stack ? { stacktrace: ctx.error.stack } : {}),
        },
        tags: {
          phase: ctx.phase,
          ...(ctx.invocationId ? { invocationId: ctx.invocationId } : {}),
          ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
          ...(ctx.eventName ? { eventName: ctx.eventName } : {}),
          ...(ctx.jobName ? { jobName: ctx.jobName } : {}),
        },
        ...(config.environment ? { environment: config.environment } : {}),
        ...(config.release ? { release: config.release } : {}),
        timestamp: new Date().toISOString(),
      };
      try {
        await send(event, { endpoint: endpoint ?? '' });
      } catch {
        // best-effort: an error-transport failure must not fail business execution
      }
    },
  };
}
