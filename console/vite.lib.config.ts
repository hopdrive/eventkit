import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Library build for the `hopdrive-eventkit/console` subpath export.
//
// Distinct from vite.config.ts (which builds the standalone dev/site app from
// index.html). This builds src/index.ts as a component library and writes the
// output into the ROOT package's dist so it ships in the npm tarball
// (root package.json `files: ["dist", ...]`).
//
// Every heavy UI dep is EXTERNALIZED: it is not bundled, it resolves from the
// host wrapper's node_modules at the wrapper's build time. That is why these
// are optional peerDependencies of hopdrive-eventkit and real dependencies of
// the create-eventkit-console template. Bundling them would ship a second copy
// of React et al. into every consumer.

// Match a bare specifier or any subpath of it (e.g. '@apollo/client/link/context',
// 'react/jsx-runtime'). Order/exactness matters: 'react' must not swallow
// 'react-dom' or 'react-router-dom' — the `/` boundary in the startsWith guard
// keeps `react/...` distinct from `react-...`.
const EXTERNAL_PACKAGES = [
  'react',
  'react-dom',
  'react-router-dom',
  '@apollo/client',
  'graphql',
  'antd',
  '@ant-design/icons',
  '@headlessui/react',
  '@heroicons/react',
  '@tanstack/react-table',
  '@tanstack/react-virtual',
  '@microlink/react-json-view',
  'framer-motion',
  'recharts',
  'reactflow',
  'jsondiffpatch',
  'date-fns',
  'clsx',
  'yaml',
];

function isExternal(id: string): boolean {
  return EXTERNAL_PACKAGES.some(pkg => id === pkg || id.startsWith(pkg + '/'));
}

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '../dist/console'),
    emptyOutDir: true,
    // No sourcemaps in the published tarball — consumers rebuild from their own
    // source, and the maps balloon the package. (Flip on locally when debugging.)
    sourcemap: false,
    // Single combined stylesheet, exported as hopdrive-eventkit/console/style.css
    // for the wrapper to import once.
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
      cssFileName: 'style',
    },
    rollupOptions: {
      external: isExternal,
    },
  },
});
