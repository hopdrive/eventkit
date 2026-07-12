/**
 * Grafana Loki proxy — Netlify Function adapter.
 *
 * Thin wrapper over the host-agnostic core in `grafanaProxyCore.ts`. Netlify
 * redirects `/api/grafana/*` here (see netlify.toml), so `event.path` still
 * carries the `/api/grafana` prefix, which the core strips before forwarding.
 * Credentials (GRAFANA_HOST/GRAFANA_ID/GRAFANA_SECRET) are Netlify env vars,
 * never VITE_-prefixed, so they stay server-side.
 */
import type { Handler, HandlerEvent } from '@netlify/functions';
import { proxyGrafanaRequest } from './grafanaProxyCore';

export const handler: Handler = async (event: HandlerEvent) => {
  const result = await proxyGrafanaRequest(
    {
      method: event.httpMethod,
      path: event.path,
      rawQuery: event.rawQuery,
      body: event.body,
    },
    {
      GRAFANA_HOST: process.env.GRAFANA_HOST,
      GRAFANA_ID: process.env.GRAFANA_ID,
      GRAFANA_SECRET: process.env.GRAFANA_SECRET,
    }
  );

  return {
    statusCode: result.statusCode,
    headers: result.headers,
    body: result.body,
  };
};
