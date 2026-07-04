# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). It tracks
intended version bumps and changelog entries for `eventkit`.

While EventKit is pre-1.0 and unpublished, changesets still give us a clean, reviewable
record of what changed in each phase. The flow:

```bash
npx changeset           # describe a change (pick a bump: patch / minor / major)
npx changeset version   # consume pending changesets → bump version + write CHANGELOG.md
npx changeset publish   # (later) publish to the GitHub registry — gated on the bundle smoke test
```

`access` is `restricted` because the package publishes to the private `@hopdrive` GitHub
registry. Do not run `changeset publish` until the package is ready to ship — see the
implementation kickoff for the phased plan.
