import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  // Load ALL env vars (not just VITE_-prefixed) so the dev-server proxy can
  // read server-side-only Grafana credentials without ever exposing them to
  // client code / the bundle. This mirrors the grafana-proxy Netlify
  // function used in production (netlify.toml redirects /api/grafana/* to
  // it) so local dev and deployed behavior match (bug B1 fix).
  const env = loadEnv(mode, process.cwd(), '');
  const grafanaHost = env.GRAFANA_HOST || 'https://logs-prod-036.grafana.net';
  const grafanaAuth =
    env.GRAFANA_ID && env.GRAFANA_SECRET
      ? Buffer.from(`${env.GRAFANA_ID}:${env.GRAFANA_SECRET}`).toString('base64')
      : undefined;

  return {
    plugins: [react()],
    server: {
      port: 3000,
      open: true,
      allowedHosts: ['.ngrok-free.app'],
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
    build: {
      outDir: 'dist',
      sourcemap: true,
      // Build as a standard app, not a library
      // The console is meant to be served, not imported
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
        },
      },
    },
    define: {
      // Properly define process.env.NODE_ENV
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
    },
  };
});
