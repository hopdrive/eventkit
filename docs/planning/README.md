# EventKit — planning & design archive

The full design record for EventKit, migrated here from `hasura-event-detector/docs/eventkit-rewrite/` (now the canonical home — make future design changes here). EventKit is the source-agnostic successor to `@hopdrive/hasura-event-detector`.

## Read order

1. **`EventKit-implementation-kickoff.md`** — the self-contained build entry point: read order, decision coverage, open-decision defaults, phased plan, correctness guards. Start here to build.
2. **`EventKit Architecture RFC v0.2 (canonical-draft).md`** — the canonical spec and source of truth. Filename says "v0.2" but the revision-history table is the real version (currently **v0.3.10**). Read §0 (change map), then §7–§13, then §22 (ADRs 001–026).
3. **`EventKit-design-changes-202606282030.md`** — the CHG-1…16 record: the *why* behind each change since v0.2.
4. **`EventKit-open-decisions-202606281830.md`** — the decision register (D1–D23): what's resolved vs. still open.

## The rest

- **`EventKit-plugin-parity-punchlist-202606282200.md`** — per-plugin parity work to bring the built plugins to no-loss-of-functionality vs. the legacy package.
- **`EventKit-design-evaluation-202606281700.md`** / **`EventKit-design-review-202606281600.md`** — the initial analyses of the v0.1 design against the current codebase.
- **`EventKit-RFC-amendment-A-B-C-202606281730.md`** / **`EventKit-RFC-amendment-D-E-202606281800.md`** — historical amendments, since folded into the canonical RFC.
- **`EventKit Architecture RFC.md`** — the original v0.1 RFC (superseded by the canonical-draft above; kept for history).
- **`raw-conversations/`** — the raw ChatGPT planning conversations the design grew out of (framework redesign, event-module naming, expected-vs-actual flows, project-plan consolidation).
- **`eventkit-chat-findings.md`** — analysis of those raw conversations.
- **`eventkit-conversation-audit.html`** / **`eventkit-report.html`** / **`eventkit-review-packet.html`** — intermediate review artifacts (open in a browser).

## Related (outside this folder)

- **`../guide.html`** — the DX guide + curated API reference (the showcase), rendered.
- **`../api/`** — the exhaustive generated API reference (`npm run docs`).
- **`../../README.md`** — the package front door.
</content>
