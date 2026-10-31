# Releasing Social Home Apps

How a change in this repo reaches households, and who does what.

## In short

1. Every PR that changes what an app (or the SDK) ships **bumps that app's
   version and adds a `CHANGELOG.json` entry** in the same PR. CI's version
   guard refuses the PR otherwise.
2. Every PR gets **one label** (below); it decides where the PR shows up in
   the release notes.
3. Every merge to `main` refreshes **one draft release** (the
   [Release — draft](.github/workflows/release-draft.yml) workflow) titled
   with today's date, `YYYY.M.D`.
4. A maintainer **publishes the draft** when it should go out. Publishing
   creates the tag and runs [Release](.github/workflows/release.yml), which
   builds, tests and uploads `catalog.json` plus every app's tarball.
5. Social Home installations pick it up from
   `releases/latest/download/catalog.json` within a day, or at once with
   **Apps → Check for updates**.

## Versions

There are three kinds of version, and they are independent:

| What | Format | Who bumps it | When |
|---|---|---|---|
| **Release tag** | CalVer `YYYY.M.D`, a second one the same day `YYYY.M.D.1`, … | the draft workflow computes it | on publish |
| **App version** — `apps/<id>/manifest.json` `version` | CalVer `YYYY.M.D[.N]` (the date of the PR) | the PR that changes the app | every change to what the app ships |
| **SDK version** — `packages/app-sdk/package.json` | semver `MAJOR.MINOR.PATCH` | the PR that changes the SDK | minor for additions, major for a breaking change, patch for a fix |

Why app versions are separate from the release tag: Social Home offers an
update only when an app's `version` goes **up**, compares it as CalVer, and
shows that version's `CHANGELOG.json` entry as "What's new". A release that
doesn't touch an app republishes it with the same version, so nobody gets a
pointless update. Never bump an app that didn't change.

Tests and docs (`*.test.*`, `*.md`) don't count as a change; the guard
ignores them.

`CHANGELOG.json` rules (the catalog build enforces them): newest first, one
entry per version, `notes.en` required plus every language the app ships,
≤ 500 characters per note, words from the
[shared glossary](https://github.com/social-home-io/translations). Write for
the people playing, not for developers ("Play with the keyboard: …"), never
a commit message.

## Labels

| Label | Release-notes section | Use for |
|---|---|---|
| `breaking` | Breaking changes | an app or SDK change that needs a newer Social Home or breaks older apps |
| `enhancement` (or `feat`) | New apps and features | a new app, a new feature |
| `bug` (or `fix`) | Fixes | a bug fix |
| `security` | Security | anything a tampered opponent, app or catalog could abuse |
| `documentation` | Docs | docs only |
| `chore` | Other changes | tooling, CI, refactors with no visible change |
| `skip-changelog` | left out | trivial changes nobody needs to read about |

Write the PR **title** for people: the notes show it as is ("Chess refuses
forged moves", not "fix(chess): validate inbound").

## When to publish

- **Security fixes:** publish right after the merge, the same day.
- **Bug fixes:** publish within a day, together with whatever else is merged.
- **Features and new apps:** publish when the feature is complete across its
  PRs. A half-built feature can sit in the draft; split work so `main` is
  always shippable.
- **Needs a newer Social Home:** set the app's `min_core_version` to the
  Social Home release that has what it needs, and publish only after that
  Social Home release is out. Older households then see "Needs a newer
  Social Home" instead of a broken app.
- **Before publishing**, check the draft: CI green on `main`, every listed PR
  has a label, and every app that changed has a new version (the guard makes
  this hard to miss).

## How to publish

- **Web:** Releases → the draft → **Publish release**.
- **CLI:** `gh release edit <tag> --draft=false -R social-home-io/socialhome-apps`
  (the tag is the draft's title, e.g. `2026.10.30`).

Then watch the **Release** workflow and check the result:

```sh
gh release view <tag> -R social-home-io/socialhome-apps --json assets -q '.assets[].name'
curl -sL https://github.com/social-home-io/socialhome-apps/releases/latest/download/catalog.json \
  | python3 -c "import json,sys;c=json.load(sys.stdin);print([(a['app_id'],a['latest_version']) for a in c['apps']])"
```

`catalog.json` and one `<app>-<version>.tgz` per app must be attached, and
`latest` must show the new versions.

Avoid `gh release create` by hand: it skips the draft's generated notes. If
the draft workflow didn't run (e.g. a missed day), run it with **Actions →
Release — draft → Run workflow** (optionally back-dated) and publish that.

## If a release is bad

There is no rollback (Social Home never offers an older version). **Fix
forward:** merge the fix with a new app version and publish a new release —
the same day gets `YYYY.M.D.1`. Don't delete or un-publish a release that
households already fetched; `latest` must keep pointing at a good catalog.
A household that needs relief right away can turn the app off in
**Apps → ⋯ → Turn off**; everything saved is kept.

## Dependency updates

[Dependabot](.github/dependabot.yml) keeps the tools current, the same way
it does for the Social Home SPA:

| Ecosystem | Directory | What moves |
|---|---|---|
| `npm` (pnpm) | `/` | every `package.json` in the workspace + the one `pnpm-lock.yaml` |
| `github-actions` | `/` | `uses:` versions in `.github/workflows/` |

Both run weekly on Monday with a 3-day `cooldown` (a release is only
proposed once it is 3 days old) and group patch + minor bumps into one PR;
each major is its own PR. They carry the `dependencies` label, so they stay
out of the release notes.

- **Patch/minor PRs auto-merge**:
  [dependabot-automerge.yml](.github/workflows/dependabot-automerge.yml)
  runs `gh pr merge --auto --squash`, so GitHub merges only after every
  required check on `main` passes. This needs `main` protected with
  **Build & test** as a required check, and **Allow auto-merge** on in the
  repository settings — without a required check, auto-merge would merge
  before CI ran.
- **Majors wait for a human review.** Read the changelog; a green run alone
  is not enough.
- **A failing Dependabot PR is a real signal.** Find the root cause like any
  other red CI; don't pin the old version to make it go away.
- **Tools don't need an app version.** The tooling lives in the root
  `package.json`, so a bump there passes the version guard. A change that
  alters what an app ships (an app's own dependency, or a compiler/bundler
  bump that changes `apps/*/dist/index.html`) does need the app's version
  and CHANGELOG entry: compare the built bundles before and after.

Bumped by hand instead: pnpm itself (`packageManager` in `package.json`,
which CI reads) and the Node major in the workflows. pnpm stays on the 11
line for now: pnpm 12 writes `pnpm-lock.yaml` as two YAML documents, and
GitHub's dependency graph doesn't read that shape yet, so Dependabot alerts
and security updates would stop for every package.

TypeScript follows the SPA: `tsc` is the native TypeScript 7 compiler
(`@typescript/native` → `typescript@7`), which type-checks and builds the
SDK; `typescript` is aliased to `@typescript/typescript6` because
typescript-eslint has no TypeScript 7 API yet.

## Who

Publishing is a maintainer's decision: it puts code on every household.
Automation (bots, agents) may open and merge PRs under the rules above, but
publishes only when a maintainer asked for that release.
