/**
 * Grafana Loki proxy — host-agnostic core.
 *
 * The console's Logs viewer fetches `/api/grafana/*` and never holds Grafana
 * credentials (they would ship in the client bundle). Some server the host
 * controls has to forward those requests and inject basic-auth. This is that
 * forwarder as a plain function: give it the incoming method/path/query/body
 * and the Grafana env, get back a status/headers/body. The Netlify function
 * next to this file is a ~10-line adapter; the same core drops into an express
 * or hono route, or any other host, unchanged.
 *
 * The wrapper template ships a copy of this file so a consumer's deploy owns
 * its own proxy without depending on the console's internal layout.
 */

export interface GrafanaProxyEnv {
  GRAFANA_HOST?: string;
  GRAFANA_ID?: string;
  GRAFANA_SECRET?: string;
}

export interface GrafanaProxyRequest {
  method: string;
  /** Full incoming path, still carrying the `/api/grafana` prefix. */
  path: string;
  /** Raw query string without the leading `?`. */
  rawQuery?: string;
  /** Request body for non-GET methods. */
  body?: string | null;
}

export interface GrafanaProxyResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const PROXY_PREFIX = '/api/grafana';

function stripPrefix(path: string, prefix: string): string {
  const idx = path.indexOf(prefix);
  if (idx === -1) return path;
  const rest = path.slice(idx + prefix.length);
  return rest || '/';
}

export async function proxyGrafanaRequest(
  req: GrafanaProxyRequest,
  env: GrafanaProxyEnv,
  options: { proxyPrefix?: string } = {}
): Promise<GrafanaProxyResult> {
  const { GRAFANA_HOST, GRAFANA_ID, GRAFANA_SECRET } = env;

  if (!GRAFANA_HOST || !GRAFANA_ID || !GRAFANA_SECRET) {
    return {
      statusCode: 501,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error:
          'Grafana proxy is not configured. Set GRAFANA_HOST, GRAFANA_ID, and GRAFANA_SECRET in the host environment.',
      }),
    };
  }

  const host = GRAFANA_HOST.replace(/\/$/, '');
  const upstreamPath = stripPrefix(req.path, options.proxyPrefix ?? PROXY_PREFIX);
  const query = req.rawQuery ? `?${req.rawQuery}` : '';
  const url = `${host}${upstreamPath}${query}`;
  const auth = Buffer.from(`${GRAFANA_ID}:${GRAFANA_SECRET}`).toString('base64');

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: ['GET', 'HEAD'].includes(req.method.toUpperCase()) ? undefined : req.body ?? undefined,
    });

    const body = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
      },
      body,
    };
  } catch (error) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: `Failed to reach Grafana: ${error instanceof Error ? error.message : String(error)}`,
      }),
    };
  }
}
