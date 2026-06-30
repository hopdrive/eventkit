// =============================================================================
// @hopdrive/eventkit/plugins/transports/sentry
// =============================================================================
// Generic error transport (ADR-024). Forwards `onError` to Sentry using the REAL
// ingest protocol: the default sender derives the envelope endpoint + X-Sentry-Auth
// header from the DSN and POSTs a Sentry envelope (so it actually delivers — not a
// raw JSON no-op). DSN arrives via injected config — never process.env. For
// production teams that prefer the official SDK, inject `send` delegating to
// `@sentry/node`; the plugin stays dependency-free.
import type { EventKitPlugin, ErrorContext } from '../../core/index.js';

/** Sentry event payload (the subset we populate), passed to `send`. */
export interface SentryEvent {
  event_id: string;
  timestamp: number; // seconds since epoch
  platform: 'node';
  level: 'error';
  exception: { values: Array<{ type: string; value: string }> };
  tags: Record<string, string>;
  extra?: Record<string, unknown>;
  environment?: string;
  release?: string;
}

export interface SentryConfig {
  /** Sentry DSN — `https://<key>@<host>/<projectId>`. Required unless a custom `send` is provided. */
  dsn?: string;
  environment?: string;
  release?: string;
  /** Delivery seam. Default derives endpoint+auth from the DSN and POSTs an envelope. Inject to delegate to @sentry/node. */
  send?: (event: SentryEvent, target: { dsn?: string }) => void | Promise<void>;
}

interface DsnParts {
  endpoint: string;
  authHeader: string;
}

/** Derive the envelope ingest endpoint + X-Sentry-Auth header from a DSN. */
function parseDsn(dsn: string): DsnParts {
  const u = new URL(dsn);
  const publicKey = u.username;
  const segments = u.pathname.split('/').filter(Boolean);
  const projectId = segments.pop();
  if (!publicKey || !projectId) throw new Error(`Invalid Sentry DSN: ${dsn}`);
  const prefix = segments.length ? `/${segments.join('/')}` : '';
  const endpoint = `${u.protocol}//${u.host}${prefix}/api/${projectId}/envelope/`;
  const authHeader = `Sentry sentry_version=7, sentry_client=eventkit/0.0.0, sentry_key=${publicKey}`;
  return { endpoint, authHeader };
}

const newEventId = (): string =>
  (typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`)
    .replace(/-/g, '')
    .slice(0, 32)
    .padEnd(32, '0');

export function sentry(config: SentryConfig = {}): EventKitPlugin {
  if (!config.send && !config.dsn) {
    throw new Error('sentry() requires a `dsn` (for the default envelope sender) or a custom `send`.');
  }
  const parts = config.dsn ? parseDsn(config.dsn) : null;

  const defaultSend = async (event: SentryEvent): Promise<void> => {
    if (!parts || !config.dsn) throw new Error('sentry default sender needs a dsn.');
    const envelopeHeader = JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString(), dsn: config.dsn });
    const itemHeader = JSON.stringify({ type: 'event' });
    const body = `${envelopeHeader}\n${itemHeader}\n${JSON.stringify(event)}`;
    await fetch(parts.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': parts.authHeader },
      body,
    });
  };
  const send = config.send ?? defaultSend;

  return {
    name: 'sentry',
    async onError(ctx: ErrorContext) {
      const event: SentryEvent = {
        event_id: newEventId(),
        timestamp: Date.now() / 1000,
        platform: 'node',
        level: 'error',
        exception: { values: [{ type: ctx.error.name, value: ctx.error.message }] },
        tags: {
          phase: ctx.phase,
          ...(ctx.invocationId ? { invocationId: ctx.invocationId } : {}),
          ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
          ...(ctx.eventName ? { eventName: ctx.eventName } : {}),
          ...(ctx.jobName ? { jobName: ctx.jobName } : {}),
        },
        ...(ctx.error.stack ? { extra: { stack: ctx.error.stack } } : {}),
        ...(config.environment ? { environment: config.environment } : {}),
        ...(config.release ? { release: config.release } : {}),
      };
      try {
        await send(event, { ...(config.dsn ? { dsn: config.dsn } : {}) });
      } catch {
        // best-effort: an error-transport failure must not fail business execution
      }
    },
  };
}
