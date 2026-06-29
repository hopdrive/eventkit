// =============================================================================
// Branded string identifiers
// =============================================================================
// Branded primitives prevent accidentally passing, say, a JobName where an
// EventName is expected. They are erased at runtime — a branded value is just a
// string. Carried over from @hopdrive/hasura-event-detector, which the team
// already relies on.

/** A business-event name in dot notation, e.g. `appointment.ready`. Stable; renames are breaking (§8). */
export type EventName = string & { readonly __brand: 'EventName' };

/** A job's name, used for observability + durability attribution. */
export type JobName = string & { readonly __brand: 'JobName' };

/** Correlation id linking every record produced by one logical chain of work. */
export type CorrelationId = string & { readonly __brand: 'CorrelationId' };

/** A registered plugin's unique name. */
export type PluginName = string & { readonly __brand: 'PluginName' };

/** A single invocation's id (one inbound execution; §4). */
export type InvocationId = string & { readonly __brand: 'InvocationId' };

/** The name an adapter gives its source, e.g. `'hasura'`, `'webhook'`. */
export type EventSourceName = string & { readonly __brand: 'EventSourceName' };

// --- Helpers to mint branded values without `as` noise at call sites. -------
// These are identity functions at runtime; they exist purely for ergonomics.

export const asEventName = (value: string): EventName => value as EventName;
export const asJobName = (value: string): JobName => value as JobName;
export const asCorrelationId = (value: string): CorrelationId => value as CorrelationId;
export const asPluginName = (value: string): PluginName => value as PluginName;
export const asInvocationId = (value: string): InvocationId => value as InvocationId;
export const asEventSourceName = (value: string): EventSourceName => value as EventSourceName;
