# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). It tracks
intended version bumps and changelog entries for `hopdrive-eventkit`, which publishes to
public npm from `.github/workflows/release.yml`. Versions are never bumped or published by
hand.

## Releasing

```bash
npx changeset           # describe a change (pick a bump: patch / minor / major) — commit it with the PR
```

Merging a PR with a changeset to `main` makes the release workflow open (or update) a
**"chore: version packages"** PR that consumes the pending changesets, bumps `package.json`
and writes `CHANGELOG.md`. Merging that PR publishes the version to npm under `latest` and
cuts a GitHub Release.

## Release candidates

To try a change in a consumer before it merges, publish the branch as a release candidate:

```bash
gh workflow run release.yml --repo hopdrive/eventkit -f rc_branch=feat/my-change
```

The run publishes what the branch's changesets would release, with `-rc.<UTC datetime>`
appended — a minor on top of 0.7.0 publishes as `0.8.0-rc.20261012153000` — under the npm
dist-tag `rc`. `latest` doesn't move, so nobody picks an RC up by accident; install one by
its exact version (the run's summary prints the command). Nothing is committed or tagged:
push more commits and run it again for the next RC.

The branch must carry at least one changeset, and must include `snapshot.useCalculatedVersion`
in `config.json` (branches cut before RC support need a rebase on `main`); the run fails
with a message saying which.
