/**
 * Grafana Loki proxy — Netlify Function
 *
 * Production parity for the Vite dev-server's `/api/grafana` proxy
 * (vite.config.ts). Without this, a deployed build has no proxy and every
 * Loki log fetch 404s (bug B1). It also keeps Grafana credentials
 * server-side only (S3): GRAFANA_HOST/GRAFANA_ID/GRAFANA_SECRET are Netlify
 * environment variables, never VITE_-prefixed, so they never ship in the
 * client bundle.
 *
 * netlify.toml redirects `/api/grafana/*` to
 * `/.netlify/functions/grafana-proxy/:splat`, so `event.path` here still
 * contains the full `/api/grafana/...` prefix — strip it before forwarding
 * to the Loki host.
 */
import type { Handler, HandlerEvent } from '@netlify/functions';

const PROXY_PREFIX = '/api/grafana';

function stripPrefix(path: string): string {
  const idx = path.indexOf(PROXY_PREFIX);
  if (idx === -1) return path;
  const rest = path.slice(idx + PROXY_PREFIX.length);
  return rest || '/';
}

export const handler: Handler = async (event: HandlerEvent) => {
  const grafanaHost = process.env.GRAFANA_HOST;
  const grafanaId = process.env.GRAFANA_ID;
  const grafanaSecret = process.env.GRAFANA_SECRET;

  if (!grafanaHost || !grafanaId || !grafanaSecret) {
    return {
      statusCode: 501,
      body: JSON.stringify({
        error:
          'Grafana proxy is not configured. Set GRAFANA_HOST, GRAFANA_ID, and GRAFANA_SECRET in the Netlify site environment.',
      }),
    };
  }

  const host = grafanaHost.replace(/\/$/, '');
  const upstreamPath = stripPrefix(event.path);
  const query = event.rawQuery ? `?${event.rawQuery}` : '';
  const url = `${host}${upstreamPath}${query}`;

  const auth = Buffer.from(`${grafanaId}:${grafanaSecret}`).toString('base64');

  try {
    const upstreamResponse = await fetch(url, {
      method: event.httpMethod,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: ['GET', 'HEAD'].includes(event.httpMethod) ? undefined : event.body ?? undefined,
    });

    const body = await upstreamResponse.text();

    return {
      statusCode: upstreamResponse.status,
      headers: {
        'Content-Type': upstreamResponse.headers.get('content-type') || 'application/json',
      },
      body,
    };
  } catch (error) {
    return {
      statusCode: 502,
      body: JSON.stringify({
        error: `Failed to reach Grafana: ${error instanceof Error ? error.message : String(error)}`,
      }),
    };
  }
};
