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
// Externalization strategy: bundle EVERYTHING except React itself.
//
// We tried externalizing all the UI libs (antd, reactflow, apollo, ...) as
// optional peerDependencies. That broke consumer builds: marking a dep
// `optional` in peerDependenciesMeta tells Vite 8 / rolldown "this might be
// absent," so it replaces each import with a `__vite-optional-peer-dep:...`
// stub — even when the consumer HAS it installed — and the console fails to
// mount. A single package.json can't say "optional for a core/server consumer"
// and "required for a console consumer" at the same time.
//
// So the console bundle is self-contained: antd/reactflow/recharts/apollo/etc.
// are inlined. Only react + react-dom stay external, because they MUST be a
// single instance shared with the host (two Reacts break hooks/context). The
// consumer dedupes them via resolve.dedupe (the template does this). This keeps
// the core install lean too — react/react-dom are the only peers now, and
// they're optional so a server consumer of the core never installs them.

// External iff it's react / react-dom or a subpath of them (react/jsx-runtime,
// react-dom/client). The `/` boundary keeps `react/...` from matching
// `react-router-dom` (which we DO bundle).
const EXTERNAL_PACKAGES = ['react', 'react-dom'];

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
