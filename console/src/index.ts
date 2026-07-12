// Public library surface for `hopdrive-eventkit/console`.
//
// This barrel is the entry for the Vite library build (vite.lib.config.ts).
// The heavy UI deps (react, antd, reactflow, apollo, ...) are externalized —
// they resolve from the host wrapper's node_modules, which is why they are
// optional peerDependencies of hopdrive-eventkit and real dependencies of the
// wrapper template. The CSS is extracted to `hopdrive-eventkit/console/style.css`.
export { EventKitConsole } from './EventKitConsole';
export { EventKitConsole as default } from './EventKitConsole';
export type { EventKitConsoleConfig, EventKitConsoleAuth } from './config';
