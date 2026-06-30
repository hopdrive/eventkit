// =============================================================================
// @hopdrive/eventkit/platforms
// =============================================================================
// Platform adapters (§9.8, ADR-021) — the plugin kind that provides the optional
// singleton `'platform'` capability (§11.0). Each named platform lives in its own
// folder (ADR-027); this barrel is the short public entry point so consumers keep
// `import { netlifyPlatform } from '@hopdrive/eventkit/platforms'`.
export { lambdaPlatform } from './lambda-platform/index.js';
export { netlifyPlatform } from './netlify-platform/index.js';
export { netlifyBackgroundPlatform } from './netlify-background-platform/index.js';
export { netlifyV2Platform } from './netlify-v2-platform/index.js';
