# EventKit — planning & design archive

The design record for EventKit, the source-agnostic successor to `@hopdrive/hasura-event-detector`.
This is the canonical home for design changes — make future design decisions here.

The framework is **built**. These docs are the *why* and the decision history; for *what the system
does today*, the authority is the canonical RFC (below) and the code (`../../README.md` is the front door).

## Read order

1. **`architecture.md`** — the canonical spec and source of truth (revision **v0.3.15**; see its
   revision-history table). Read §0 (change map), then §7–§13 (the API surface), then §22 (ADRs 001–027).
2. **`design-rationale.md`** — the distilled *why*: the consumption-failure evidence that drove the
   rewrite, and each major decision paired with the alternative it replaced. Read this so settled
   decisions aren't re-litigated and rejected designs aren't mistaken for the current API.
3. **`design-change-log.md`** — the CHG-1…13 change-by-change record (continued in
   the RFC revision history through CHG-17).
4. **`decision-register.md`** — the decision register (D1–D23). The STATUS block at
   the top is authoritative; only D6/D10/D13 remain genuinely open (process/migration calls).

## The rest

- **`implementation-plan.md`** — the original phased build plan. Historical: the build is
  done (banner at top). Kept for provenance, not as a current build guide.
- **`plugin-parity.md`** — per-plugin parity work vs the legacy package.
  Complete: every P0/P1 item shipped; kept as a verification record.
- **`raw-conversations/`** — the raw ChatGPT planning conversations the design grew out of (framework
  redesign, event-module naming, expected-vs-actual flows, project-plan consolidation). Primary-source
  provenance, with source URLs.

> **Removed (folded into `design-rationale.md` + the canonical RFC; recoverable via git history):** the
> v0.1 RFC, the A–E amendment docs, the pre-build design review and design evaluation, the chat-findings
> analysis, and the intermediate `.html` review snapshots. They documented superseded/intermediate
> designs in present tense and were a standing risk of being read as canonical.

## Related (outside this folder)

- **`../guide.html`** — the DX guide + curated API reference (generated; `npm run docs`).
- **`../api/`** — the exhaustive generated API reference (`npm run docs`).
- **`../../README.md`** — the package front door.
