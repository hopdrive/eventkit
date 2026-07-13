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
    // The console (hopdrive-eventkit/console) is a prebuilt ESM bundle that
    // externalizes react + its React-coupled UI libs (reactflow, apollo, ...).
    // THIS app build bundles those (react is not external here), so their inner
    // require("react") resolves normally. Dedupe keeps a single React. Do NOT
    // pre-bundle the console itself: optimizeDeps would try to convert its
    // external react import into a browser require() that throws — exclude it so
    // Vite serves its ESM as-is and resolves each bare import individually.
    resolve: {
      dedupe: ['react', 'react-dom'],
    },
    optimizeDeps: {
      exclude: ['hopdrive-eventkit'],
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
