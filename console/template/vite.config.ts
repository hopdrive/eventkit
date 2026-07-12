import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server for the wrapper. In production the same `/api/grafana/*` route is
// served by the Netlify function (see netlify.toml); here we proxy it straight
// to Grafana so local dev matches deployed behavior. Server-side-only Grafana
// creds are read WITHOUT the VITE_ prefix so they never reach the client.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const grafanaHost = env.GRAFANA_HOST || 'https://logs-prod-036.grafana.net';
  const grafanaAuth =
    env.GRAFANA_ID && env.GRAFANA_SECRET
      ? Buffer.from(`${env.GRAFANA_ID}:${env.GRAFANA_SECRET}`).toString('base64')
      : undefined;

  return {
    plugins: [react()],
    // The console bundle (hopdrive-eventkit/console) externalizes react/react-dom
    // so it shares ONE React with this host. Dedupe guarantees a single copy even
    // if a transitive dep pulls its own; pre-bundle the console so its inlined UI
    // libs are optimized alongside the app.
    resolve: {
      dedupe: ['react', 'react-dom'],
    },
    optimizeDeps: {
      include: ['hopdrive-eventkit/console'],
    },
    server: {
      port: 3000,
      open: true,
      proxy: {
        '/api/grafana': {
          target: grafanaHost,
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/api\/grafana/, ''),
          configure: proxy => {
            proxy.on('proxyReq', proxyReq => {
              if (grafanaAuth) {
                proxyReq.setHeader('Authorization', `Basic ${grafanaAuth}`);
              }
            });
          },
        },
      },
    },
  };
});
