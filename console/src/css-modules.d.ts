// Let the declaration build (tsconfig.lib.json) resolve the `import './styles/globals.css'`
// side-effect import in EventKitConsole.tsx. Vite handles the actual CSS at
// build time; tsc only needs to know the module exists.
declare module '*.css';
