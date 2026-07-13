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
// Externalization strategy: externalize React AND every React-coupled UI lib;
// bundle only our own source plus small pure-ESM utils (clsx, date-fns, yaml,
// jsondiffpatch). Two earlier attempts failed and led here:
//
//  1. Externalize the UI libs as OPTIONAL peerDependencies. Vite 8 / rolldown
//     stubs an optional-peer import (`__vite-optional-peer-dep:...`) even when
//     the consumer HAS it installed, so the console never mounts.
//  2. Bundle everything except react. Several UI libs (reactflow, recharts,
//     react-json-view, ...) are "mixed" modules whose ESM entry still calls
//     `require("react")` internally. With react externalized, rolldown can't
//     route that CJS require to the external ESM import, so it emits a
//     `__require("react")` shim that THROWS in the browser. `commonjsOptions`
//     doesn't help — rolldown ignores it.
//
// The fix that works: don't bundle the React-coupled libs at all. Externalize
// them so the CONSUMER's app build bundles them, where React is NOT external
// (the app bundles its own single copy), so `require("react")` resolves
// normally and no shim is produced. This is how the legacy console shipped.
//
// These libs are intentionally NOT declared as peers of hopdrive-eventkit (that
// is what caused attempt 1's stubs). The wrapper template lists them as real
// dependencies, so the bare imports in this bundle resolve from the consumer's
// node_modules. react/react-dom are the only declared peers (optional), for
// dedupe guidance.
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
];

// External iff it's one of the above or a subpath of it (e.g.
// '@apollo/client/link/context', 'react/jsx-runtime'). The `/` boundary keeps
// `react/...` distinct from `react-router-dom`, which is listed explicitly.
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
