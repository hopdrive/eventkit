# EventKit Consolidation Chat — Full Analysis
## Source: chatgpt-project-plan-consolidation-20260628.md (5755 lines, 134 messages)

---

## Concepts Captured in RFC (brief confirmation)

The following were confirmed agreed and appear to be in the final RFC:

- Source-agnostic `EventEnvelope` / `DetectedEvent` / `HandlerContext` / `JobContext` / `JobExecution` runtime chain
- `createEventKit({ sources, plugins, events })` explicit registration (no filesystem auto-discovery)
- `job(fn, JobOptions)` declarative job factory; `JobOptions` = `{name, timeoutMs, retries, tags, metadata, durable, continueOnFailure}`
- `run(event, jobs, options)` with `mode: 'parallel' | 'series'`
- `EventKitPlugin` lifecycle hooks (`onInvocationStart`, `onJobEnd`, etc.)
- BatchJobs as durability plugin (Core owns retry mechanics; BatchJobs owns persisted retry state)
- Observability plugin captures Invocation → Event → Job records
- Flow Manifests (design-time contract), Expected/Observed/Compare modes in console
- Single detector per event module (one detector, one handler, detector always at top)
- Subpath exports under single `@hopdrive/eventkit` package
- Source adapters: `HasuraDetectorContext`, `WebhookDetectorContext`, `CronDetectorContext`
- ADRs, testing strategy, CI validation with strictness levels
- 10-phase migration strategy, compatibility facade for `@hopdrive/hasura-event-detector`

---

## Concepts Discussed But LOST or Under-Specified in RFC

### 1. How a handler passes DATA to a job — the input/deps channel

**What was discussed:** The conversation established that the handler receives a `HandlerContext` (not the `DetectorContext`) and that `DetectorContext` helpers like `columnChanged()` are explicitly NOT available in handlers or jobs.

> "Handlers should not use detector-only helpers like `columnChanged()`. If handlers need source data, they use `ctx.envelope.payload` or source adapter-provided handler context extensions." — Lines 2063–2065

> "Important decision: `DetectedEvent` should not carry `DetectorContext`. Detector helpers are for detection only." — Lines 2007–2008

The conversation then showed this concrete `HasuraHandlerContext` extension:

```ts
export interface HasuraHandlerContext<TNewRow, TOldRow = TNewRow>
  extends HandlerContext<HasuraEventPayload<TNewRow>> {
  operation: HasuraOperation;
  oldRow: TOldRow | null;
  newRow: TNewRow | null;
}
```
(Lines 2067–2072)

**Why it matters:** The current `hasura-event-detector` passes business data directly in the job options bag. The RFC defines `JobContext` (with `event`, `envelope`, `job`, `log`, `progress`, `checkpoint`) but is silent on HOW a handler passes business-specific data (e.g., a move's `id`, `newRow` values) INTO a job function. The `JobContext` has `event.envelope.payload` but that's the raw Hasura payload — nothing is stopping jobs from re-fetching. The conversation makes clear the path is `ctx.envelope.payload` (available in both `HandlerContext` and `JobContext`), but this design decision — that jobs must pull raw payload fields directly from the envelope rather than receiving a typed, handler-extracted input — is not explicitly stated in the RFC.

---

### 2. Execution mode default and failure isolation — the current lib uses Promise.allSettled

**What was discussed:** `RunOptions` includes `mode?: 'parallel' | 'series'`. The conversation from the runtime API section shows both modes are available but does NOT state a default. The current library runs ALL jobs in parallel via `Promise.allSettled` (failures do not stop other jobs).

> "Options: `export interface RunOptions { mode?: 'parallel' | 'series'; continueOnFailure?: boolean; ... }`" — Lines 2166–2173

**No explicit default was stated in the conversation.** The word "parallel" appears in the handler example:

> "`await Promise.all([run(job1), run(job2)]);`" — Line 773

But that was a user-driven example in the handler, not a framework default.

**Why it matters:** The current lib's behavior — parallel with failure isolation via `Promise.allSettled` — is load-bearing behavior that consumers depend on. If the RFC's default is `series`, or if `continueOnFailure` defaults to `false`, a silent behavioral regression happens during migration. The conversation never resolved the default, and this appears to be a gap in the final RFC.

---

### 3. Per-invocation config — invocationId, correlationId, x-hasura-client-name

**What was discussed:** The observability section listed `invocationId`, `correlationId`, `traceId`, and `trackingToken` as captured by the plugin on invocation records:

> "Invocation Records: invocation ID, source adapter kind, source function, correlation ID, trace ID, **tracking token**, source payload reference..." — Lines 1068–1078

> "Load observed invocations by invocation ID, correlation ID, trace ID, or **tracking token**." — Line 1155

**Tracking token was mentioned multiple times as a first-class correlation concept** alongside `correlationId`. But the conversation never specified:
- Where the tracking token comes from (header? generated? caller-supplied?)
- Whether the source adapter or the entry function surfaces it
- Whether it maps to the current `x-hasura-client-name` header pattern

The RFC structures `EventEnvelope` with `id`, `source`, `sourceType`, `receivedAt`, `correlationId`, `payload`, `meta`, `raw`. There is no `trackingToken` on the envelope.

**Why it matters:** The current library uses `x-hasura-client-name` for loop-prevention and updated_by provenance. The conversation explicitly captured `trackingToken` in the observability data model but then the final types — agreed in messages [9]/[15] — dropped it from the public types. This is a potential loss of a critical anti-loop/provenance mechanism.

---

### 4. Loop prevention / updated_by / event storm suppression

**What was discussed:** The observability data model included "tracking token" and "source job ID if invocation was triggered by a previous job" (line 1079). This directly implies the framework was designed to track job-triggered invocation chains.

> "source job ID if invocation was triggered by a previous job" — Line 1079

This is the core anti-loop mechanism: knowing that a DB write was made BY a job means the resulting Hasura event should be suppressed or identified. But neither the `EventEnvelope` type, `DetectorContext`, nor any plugin lifecycle hook was specified as the mechanism for surfacing this. It was listed only as an observability data field, not as a framework-level control mechanism.

**Why it matters:** Event storms are a real operational risk. The current library's `x-hasura-client-name` header approach threads provenance from the invocation through to any downstream DB writes. This conversation captured the concern in observability data but did not resolve how the framework actively prevents loops.

---

### 5. Package import convention — final form was NOT settled

**What was discussed:** There was an explicit disagreement between two import conventions throughout the conversation:

**Convention A** (user preference, stated at line 656):
> "I'd rather not have a separate package for each plugin and adapter. I'm worried it will clutter the HopDrive scope"

**Convention B** (ChatGPT's first take, e.g., in the example code at lines 1776–1811):
```ts
import { hasura } from '@hopdrive/eventkit-source-hasura';
import { batchJobs } from '@hopdrive/eventkit-plugin-batchjobs';
```

**Convention C** (ChatGPT's resolution at lines 851–859, 1894–1903):
```ts
import { hasura } from '@hopdrive/eventkit/sources/hasura';
import { batchJobs } from '@hopdrive/eventkit/plugins/batchjobs';
```

GPT repeatedly reverted to Convention B in code examples even after agreeing to Convention C. The BatchJobs example in the runtime API (lines 2297–2318) uses `@hopdrive/eventkit-plugin-batchjobs` (Convention B), contradicting the agreed subpath approach.

**Why it matters:** The final RFC specifies subpath exports but the exact import shape in code examples throughout the conversation is inconsistent. The RFC should normalize all examples to Convention C.

---

### 6. The `run()` function signature — two different shapes appeared

**Shape 1** (user-proposed runtime API at lines 2156–2163):
```ts
export async function run<TPayload, TMeta>(
  event: DetectedEvent<TPayload, TMeta>,
  jobs: JobDefinition[],
  options?: RunOptions,
): Promise<JobExecution[]>;
```

**Shape 2** (earlier handler example at lines 769–775):
```ts
export const handler = async ({ run }) => {
  await run(sendNotificationJob);
  await run(updateAnalyticsJob);
};
```

In Shape 2, `run` is destructured from the handler context and called with a SINGLE job. In Shape 1, it's a standalone function called with `(event, jobs[], options)`. These are different APIs.

> "The framework shouldn't prescribe orchestration beyond providing `run()`." — Line 778

**Why it matters:** The RFC needs to clearly specify whether `run` is (a) a standalone import called with explicit `event`, (b) a context-injected function, or (c) both. The conversation ended with Shape 1 (standalone) but earlier discussion implied Shape 2 (context-injected convenience). If both exist, that was never explicitly decided.

---

### 7. The async detector concern — detectors can return Promise<boolean>

**What was discussed:** The `DetectorFunction` type was defined as:
```ts
export type DetectorFunction<TContext extends DetectorContext = DetectorContext> =
  (ctx: TContext) => boolean | Promise<boolean>;
```
(Lines 2243–2245)

This means detectors can be async. This was never discussed as a performance concern — async detectors that hit the DB run for every invocation across every event module. The conversation noted this as a concern earlier in message [8]:

> "4. Registry/discovery model: How EventKit finds event modules is not specified." — Line 554

And the user said (line 653): "it's too complex right now with Netlify to ensure the dependencies are built into the lambda package when it's auto loaded by name using code."

**No performance discussion about async detectors appeared.** This is a potential N-detector * M-DB-call latency amplification that the RFC ignores.

---

### 8. Detection ordering — are all modules evaluated or is it first-match?

The conversation never stated whether ALL detectors are evaluated for every invocation or whether the framework stops at the first match. This has significant implications for:
- Performance (100+ event modules, all evaluated per Hasura trigger)
- Correctness (two detectors could theoretically both fire on the same invocation)

The current library evaluates all modules. The RFC does not specify this behavior.

---

### 9. Handler function signature — the conversation defined TWO shapes

**Shape 1** (lines 2216–2231 — the agreed type):
```ts
export type HandlerFunction<THandlerContext extends HandlerContext = HandlerContext> = (
  event: DetectedEvent,
  ctx: THandlerContext,
) => Promise<JobExecution[]> | JobExecution[];
```

**Shape 2** (the context-destructuring pattern, line 760):
```ts
export const handler = async ({ run }) => { ... };
```

The RFC uses Shape 1 in type definitions but the examples throughout the conversation use the old-style context-object approach. The conversation never explicitly reconciled these.

---

### 10. BatchJobs `batchJobs.record(ctx.newRow)` — the durable option shape

The BatchJobs example (lines 2312–2318) showed:
```ts
job(runARBatchV2, {
  durable: batchJobs.record(ctx.newRow),
})
```

But `durable` is typed as `boolean | DurableJobOptions`. What `batchJobs.record()` returns and how it maps to `DurableJobOptions` was never specified. The `DurableJobOptions` type itself was never defined in the conversation.

---

### 11. The `manuallyInvoked()` detector helper

The `HasuraDetectorContext` specification includes:
```ts
manuallyInvoked(): boolean;
```
(Line 1657)

This was listed without explanation. "Manually invoked" in Hasura means the event was triggered via the Hasura Console "Redeliver" button or the `x-hasura-event-type: manual` header. This is directly related to the MANUAL Hasura operations concern — but the RFC leaves `manuallyInvoked()` as a bare helper with no usage guidance. Detectors that should suppress re-detection on re-delivery need to use this, but the convention is undocumented.

---

### 12. Strategic framing section "Why EventKit Exists"

This was the LAST message in the conversation (lines 5701–5754) and was explicitly added to the Google Doc but may not appear in the RFC. User said:

> "EventKit is one of the foundational abstractions that HopDrive intends to build upon for the next decade. It standardizes how business events are discovered, executed, observed, documented, and reasoned about by both humans and AI agents. Its purpose is not simply to replace the Hasura Event Detector, but to establish a stable architectural language that survives changes to infrastructure, event sources, and execution environments." — Lines 5715–5720

The philosophical framing from the final message:

> "Infrastructure detects. Business events describe. Handlers respond. Plugins observe." — Lines 5750–5751

This was presented as "the architectural philosophy of EventKit" and should be near the top of the RFC.

---

## Decisions Made DIFFERENTLY in Conversation vs RFC

### Decision 1: Package naming — the conversation agreed on subpath exports but examples use separate packages

**In conversation (lines 851–859, confirmed at lines 1922–1931):** Single `@hopdrive/eventkit` package with subpath exports.

**In conversation code examples (lines 1776, 1800, 2268–2269, 2299–2301):** Many examples still use `@hopdrive/eventkit-source-hasura` and `@hopdrive/eventkit-plugin-batchjobs`. GPT acknowledged this discrepancy at lines 1891–1903 and recommended fixing it, but didn't update all prior examples.

**Impact:** The RFC should consistently use the subpath form. Any example using the multi-package form represents a pre-decision artifact.

---

### Decision 2: Retry ownership

**Resolved in conversation (lines 668–673):**
> "Core owns execution semantics, lifecycle, retry algorithm, and retry decisions. BatchJobs owns persistence, retry scheduling, state transitions, retry history, delayed execution, and durability."

This split was explicitly resolved after a noted contradiction in the source files (lines 501–525). The RFC should reflect this exact split; if it assigns retries differently, it contradicts the conversation consensus.

---

### Decision 3: `DetectedEvent` does NOT carry `DetectorContext`

**Explicit decision (lines 2007–2008):**
> "Important decision: DetectedEvent should not carry DetectorContext. Detector helpers are for detection only."

In the earlier (message [13]) draft of `DetectedEvent`, `detectorContext: TSourceContext` was included. The final agreed type removed it. If the RFC's `DetectedEvent` includes `detectorContext` (or `sourceContext`), it contradicts the final consensus.

---

### Decision 4: Flow Manifests are NOT required for runtime execution

**Explicit (lines 1123–1124, 1303):**
> "Runtime should not fail if no flow manifest exists. Observability should still capture the observed flow."
> "EventKit should not block runtime execution because of flow differences. These are observability and validation concerns."

And from message [12]:
> "Flow Manifests should not block the MVP rewrite. They should be included in the architecture and package design, but likely implemented after the core execution, BatchJobs, and Observability foundations are stable." — Lines 1490–1491

If the RFC treats Flow Manifests as a Phase 1 requirement, that contradicts this.

---

### Decision 5: One detector per event module — the reason matters

**The reasoning given (lines 688–689):**
> "If another source can detect the same business event in the future, I'd rather have a second event module than complicate the primary authoring model."

This means the RFC should state: if the same business event must be detected from a second source in the future, create a SECOND event module with a different name (or a variant name), not add a second detector to the existing module. This consequent rule was stated conversationally but may not appear in the RFC.

---

## Explicitly Rejected Ideas

### Rejected 1: Multiple detectors per event module

> "One detector keeps the authoring experience extremely simple... If another source can detect the same business event in the future, I'd rather have a second event module than complicate the primary authoring model. We can always revisit this years from now." — Lines 679–689

**Reason rejected:** Complicates authoring model, undermines readability, can always add a second module instead.

---

### Rejected 2: Filesystem auto-discovery of event modules

> "Trying to discover modules dynamically in serverless environments almost always becomes more complicated than it's worth." — Lines 748–749

**Reason rejected:** Non-deterministic, bundler-hostile, Netlify-hostile, not tree-shakeable.

---

### Rejected 3: Separate npm packages per adapter and plugin

> "I'd rather not have a separate package for each plugin and adapter etc. I'd like them to be optional for a user of eventkit but not a separate package to maintain. I'm worried it will clutter the HopDrive scope." — Lines 656–658

**Reason rejected:** Maintenance overhead, namespace clutter. Single `@hopdrive/eventkit` with subpath exports preferred.

---

### Rejected 4: HopDrive domain logic in source adapters or plugins

> "Framework code may understand Hasura concepts such as: operations, rows, schemas, tables. It must never understand business concepts such as: moves, drivers, appointments, dealerships." — Lines 3499–3508 (RFC-01 chapter text)

**Reason rejected:** Breaks source-agnosticism, creates tight coupling between framework and application domain.

---

### Rejected 5: Manually maintained architecture diagrams

> "Rather than maintaining architecture diagrams by hand, the system should generate dependency graphs directly from source code, package imports, Hasura metadata, event triggers, Netlify function manifests, GraphQL operations, and SDK definitions." — Lines 153–157

**Reason rejected:** Diagrams drift from reality. Architecture-as-code preferred.

---

### Rejected 6: Compatibility facade as long-term strategy

While not explicitly "rejected," the conversation explicitly deferred the deprecation question:
> "Not sure but I don't really care about depreciation right now" — Line 658

And GPT noted:
> "Compatibility facade duration: Not important right now. Can mark as 'defer.'" — Lines 1506–1507

The facade is NOT a permanent solution; the conversation treated it as a time-limited migration tool.

---

## Migration/Phasing Nuances and Risks Raised in Chat

### Nuance 1: The compatibility facade is "hard" — not discussed in detail but acknowledged

GPT listed the compatibility facade as one of the open items but the conversation never deeply analyzed what the facade actually needs to emulate from `@hopdrive/hasura-event-detector`. This is a blank check risk: the facade could be trivial or massive depending on how much surface area the existing library exposes.

### Nuance 2: Flow Manifests explicitly deferred from MVP

> "Flow Manifests should not block the MVP rewrite. They should be included in the architecture and package design, but likely implemented after the core execution, BatchJobs, and Observability foundations are stable." — Lines 1490–1491

This is a phasing decision: Core → BatchJobs → Observability → Flow Manifests → Compare Mode → Console. The RFC should reflect this ordering.

### Nuance 3: Google Doc as the living RFC

The conversation spent significant time (messages 57–134) trying to maintain a Google Doc as the living RFC rather than static Markdown files. The rationale:

> "Relying on past chats alone is insufficient for long-lived engineering efforts. Instead, important architectural decisions should be consolidated into a living design document." — Lines 135–137

The final RFC (the file being compared) may be a snapshot from that Google Doc process, not the final state. The Google Doc URL `https://docs.google.com/document/d/18Qk0-fufGjF-46hPvLR-wF7Iq-QJ5vdyY4-F5_odgtI` (line 4371) was the intended canonical source; the Markdown RFC was generated separately as downloadable chapters.

### Nuance 4: The RFC generation process was fragmented and acknowledged as incomplete

GPT explicitly stated multiple times:
> "I can't generate a true 40 to 60 page, fully realized RFC with hundreds of code examples, diagrams, and API reference in a single response. That exceeds the model's output limits, even if I write it directly to a file." — Lines 3114–3116

> "While these chapters accurately capture the architecture and decisions we've made, they're intentionally concise because of generation limits." — Lines 4145–4146

**This is critical:** The RFC chapters (RFC-01 through RFC-09) were each generated under output constraints and GPT explicitly acknowledged they are compressed summaries of the design, not the full detail intended. The "full detail" was meant to live in the Google Doc through iterative expansion.

### Nuance 5: The RFC's ADR count — proposed as 10 in the RFC, but conversation listed more

The conversation listed these ADRs explicitly at lines 2541–2558:
- ADR-001: Why EventKit replaces Hasura Event Detector
- ADR-002: Why detectors remain the primary authoring abstraction
- ADR-003: Why EventEnvelope and DetectedEvent are separate types
- ADR-004: Why BatchJobs is a plugin instead of a source adapter
- ADR-005: Why Flow Manifests describe intent rather than implementation
- ADR-006: Why explicit registration was chosen over filesystem discovery

Plus the conversation added (lines 4289–4316):
- ADR-007: One Detector Per Event Module

7 named ADRs in conversation vs "ADRs 001-010" in the RFC. The RFC has 3 more ADRs than the conversation explicitly named — those 3 additional ADRs were added during RFC generation and were not reviewed/confirmed with Rob.

---

## Notable Concerns the RFC Ignores

### Concern 1: Re-fetching data per job — GraphQL round-trips

The conversation established that `JobContext` carries `event.envelope.payload` (raw source payload). For Hasura events, `oldRow` and `newRow` are in the payload. But the conversation never addressed:
- Whether jobs that need the CURRENT state of a row (not the event-time snapshot) must re-fetch from the DB
- Whether the framework should support a shared data-fetching layer or cache
- Cost/latency implications of N jobs each potentially re-fetching M rows

This is particularly relevant for the BatchJobs plugin where `batchJobs.record(ctx.newRow)` is passed as `durable` — but other jobs in the same handler might need the same or related data and nothing prevents redundant fetches.

### Concern 2: Scope and blast radius — no count of existing event modules/jobs

The conversation never established:
- How many event modules currently exist in `hasura-event-detector`
- How many job functions exist
- How many consumers need the compatibility facade
- Whether ANY consumer uses APIs that the facade cannot trivially emulate

This is a significant planning gap. The migration phasing assumes incremental migration, but without knowing the blast radius, the phase estimates are speculative.

### Concern 3: The Google Doc vs Markdown RFC split — which is canonical?

The conversation's intent was for the Google Doc to be the canonical living spec. The RFC Markdown files were acknowledged as compressed/incomplete drafts. There is now a risk that the Markdown RFC (the "final RFC" being compared) represents a LESS complete version than what ended up in the Google Doc after the editorial passes in messages 96–134.

### Concern 4: Detector readability convention is a REQUIREMENT, not a suggestion

> "A primary design goal is detector readability. Detector code should read like business rules rather than framework plumbing. Complex conditions should be broken into individually named boolean variables, and the final return statement should read like a logical sentence composed of those variables. **The framework should optimize for this style above all else.**" — Lines 111–113

The phrase "above all else" is strong. The RFC captures this as a design principle, but whether the framework should ENFORCE it (e.g., via lint rules, code style checks in CI) or merely encourage it was never resolved.

### Concern 5: The console is identified as potentially out of scope for MVP

The long-term console vision (Expected/Observed/Compare modes) is presented as a future capability, not MVP. But the RFC presents it alongside the core architecture without clearly marking it as post-MVP. The conversation was explicit:

> "Start implementation with one high-value flow, likely Mobile Service Dispatch." — Line 448

> "Flow Manifests should not block the MVP rewrite." — Line 1490

The console and compare mode are LONG-TERM, but this phasing may be blurred in the RFC.

### Concern 6: The monorepo / pnpm / Turborepo stack is assumed but not scoped

One of the source snippets described a comprehensive platform-level change:
> "Consolidating the platform into a monorepo would significantly improve AI-assisted development, provided we preserve strong package boundaries." — Lines 144–146
> Stack: monorepo, pnpm workspaces, Turborepo, Dependency Cruiser, Generated Mermaid diagrams, Architecture metadata, Business flow registry — Lines 150–157

This is a separate (and massive) project from the EventKit rewrite itself. The conversation treated these as related but the RFC may conflate them as if EventKit requires the monorepo, which it doesn't.

### Concern 7: `AbortSignal` and cancellation — mentioned in types but never discussed

`HandlerContext` and `JobContext` both include `signal?: AbortSignal` (lines 2060, 2135). Cancellation semantics — who sends the signal, when, and what guarantees jobs receive and respect it — were never discussed. This is implementation-detail technical debt in the RFC.

### Concern 8: `progress()` and `checkpoint()` in JobContext — never specified

`JobContext` exposes:
```ts
progress(value: number, metadata?: Record<string, unknown>): Promise<void>;
checkpoint(name: string, metadata?: Record<string, unknown>): Promise<void>;
```
(Lines 2132–2134)

These were listed in the runtime API spec but never explained: what do they persist to? Who reads them? Is this a BatchJobs plugin feature or Core? This is unresolved.

---

## Summary: The Most Critical Gaps

In priority order for the RFC review:

1. **Execution mode default** (parallel vs series) and failure isolation (`Promise.allSettled` vs first-failure) — the current lib's behavior must be explicitly preserved or deliberately changed
2. **Data flow from handler into jobs** — how does business data (newRow, oldRow, business IDs) reach job functions without re-fetching?
3. **Loop prevention / tracking token** — the mechanism for preventing event storms and tracking updated_by provenance was noted in observability data but never wired into the framework types
4. **`DurableJobOptions` type** — mentioned but never defined
5. **Detection ordering guarantee** — first-match or all-match?
6. **`run()` import shape** — standalone function vs context-injected vs both?
7. **`DetectedEvent` must NOT carry `DetectorContext`** — confirm the RFC enforces this boundary
8. **Flow Manifests are post-MVP** — the RFC must clearly phase-gate this
9. **Google Doc vs Markdown RFC** — which is the actual canonical spec?
10. **Strategic "Why EventKit Exists" framing** — agreed to add, may be missing from RFC
