# CLAUDE.md — socialhome-apps

Instructions for AI agents (and a quick start for humans) working on the
Social Home Apps repo. Symlinked as `AGENTS.md` — edit only this file.

Social Home Apps are small JavaScript apps (e.g. Chess) that a household admin
adds from a catalog. They run inside Social Home in a **sandboxed iframe**,
save per-person data, and talk to the other player's household through Social
Home. The platform side lives in
[social-home-io/socialhome](https://github.com/social-home-io/socialhome)
(`docs/protocol/apps.md` is the contract); this repo holds the apps, the SDK
and the catalog tooling.

## Layout

| Path | What |
|---|---|
| `packages/app-sdk/` | `@socialhome/app-sdk` — the only way an app talks to Social Home (`postMessage` bridge) |
| `apps/<app_id>/` | one app: `manifest.json`, `CHANGELOG.json`, `src/`, `public/`, `build.mjs`, tests |
| `scripts/build-catalog.mjs` | packs each `apps/*/dist/` into a tarball and writes `catalog.json` |
| `scripts/catalog-lib.mjs` | manifest / changelog validation and catalog shape (schema 2) |
| `scripts/check-versions.mjs` | CI guard: a change to an app or the SDK must bump its version |
| `.github/workflows/` | `ci.yml` (every PR), `release-draft.yml` (every merge), `release.yml` (on publish) |
| `RELEASING.md` | versions, labels, when and how to release |

`apps/chess` is the reference app: copy its structure for a new one.

## Run, build, test

```sh
pnpm install                         # once; Node 24, pnpm from packageManager
pnpm build                           # SDK first, then every app → apps/*/dist/index.html
pnpm test                            # vitest: SDK, scripts, every app
pnpm lint                            # ESLint
pnpm -r exec tsc --noEmit            # types (after pnpm build — apps import the SDK's built types)
RELEASE_TAG=ci-dry-run pnpm catalog  # packaging dry-run: tarballs + catalog.json
node scripts/check-versions.mjs origin/main   # the PR version guard, locally
```

CI runs all of these on every pull request. Run the relevant ones before you
push; quote the real output when you report results.

## Testing in a real Social Home

Unit tests cover rules and message handling; anything a person sees or any
cross-household flow also needs a run against a real Social Home. The full
recipe is the `apps-development-testing` skill in the socialhome repo
(`.claude/skills/apps-development-testing/SKILL.md`). In short:

1. Build here, then serve a local catalog: `RELEASE_TAG=local REPO_BASE=http://127.0.0.1:<port> pnpm catalog`
   and serve the repo root so `catalog.json` and `dist-tars/` resolve.
2. Boot Social Home standalone from the socialhome repo with
   `apps_catalog_url` pointing at that catalog; set up an admin; install the
   app (`POST /api/apps {app_id}`).
3. For cross-household play, boot a second instance and pair the two
   (`/api/pairing/initiate` → `accept` → `confirm`).
4. Drive both with headless Chromium (`puppeteer-core`, `/usr/bin/chromium`).
   The app renders inside the bundle iframe
   (`page.frames().find(f => f.url().includes("/bundle/"))`).
5. Look at the result at **desktop 1280×720 and mobile 390×844**, in light
   and dark, in English and one other language (usually German).

Check that ports are free before booting and stop everything you start —
other sessions may share the machine.

## Rules for every app

**The bundle**
- `dist/` must be **one fully inlined `index.html`** (JS, CSS and icons
  inline) plus `manifest.json`. The iframe is `sandbox="allow-scripts"`, an
  opaque origin: any external file, CDN or `fetch` is blocked. No network,
  ever — everything goes through the SDK.
- Keep the bundle small (Social Home caps downloads at 8 MiB; aim for well
  under 200 KB). No large dependencies.

**Talking to Social Home and the other player**
- Invite people only with `sh.people.pick(...)`: Social Home draws the
  invite sheet. Never try to open sessions yourself.
- Social Home keeps **only the latest message per game** while an app is
  closed (the mailbox). Every message must carry the full game state needed
  to catch up, and nothing may be sent after a final message that must not
  be replaced.
- **Never trust the other side.** The opponent's app may be tampered with.
  Validate every incoming message against your own copy: accept only the next
  legal step on top of the history you already have, by the right player,
  and compute results (win, draw, check) yourself. Route by the session
  Social Home delivered, not an id inside the payload. Show a calm notice
  for a refused message; never crash. (Chess: `src/inbound.ts`.)
- Ask only for the capabilities you need (`storage`, `people`,
  `federation`); Social Home enforces them.

**People**
- Every screen works with a **keyboard and a screen reader**: grids as ARIA
  grids with one tab stop, a polite live region for what the other player
  did, visible focus, never colour alone.
- Follow Social Home's look: read `locale`, `dir`, `theme`, `reducedMotion`
  and the 8 colour tokens from `sh.context()` and react to
  `onContextChange` (SDK ≥ 1.6, `applyTheme()`).
- Ship **en, de, nl, fr, es**. Words follow the
  [shared glossary](https://github.com/social-home-io/translations) (clone it
  next to this repo): "Apps" and "Social Home" are never translated;
  du / je / vous / tú. New terms go into the glossary first, by PR.
- Write copy for people, in plain words.

## Versions and releases

Read `RELEASING.md`. The short version:
- A PR that changes what an app ships bumps that app's `version` (CalVer,
  `YYYY.M.D[.N]`) and adds the matching `CHANGELOG.json` entry in all shipped
  languages. A PR that changes the SDK bumps its semver. CI enforces both.
- Every PR has one label (`enhancement`, `bug`, `security`, `breaking`,
  `documentation`, `chore`, `skip-changelog`) and a title written for people.
- Merges refresh a draft release; a maintainer publishes it. Agents never
  publish a release unless a maintainer asked for that specific release.

## Working agreements

- **Pull requests only** — never commit or push to `main`; branch first.
- **Never bypass git hooks** (`--no-verify`, `core.hooksPath` tricks).
- **Verify before you claim**: run the command, quote its real output.
- Don't merge your own PR unless a maintainer authorized it for the session.
- A change that needs new Social Home behaviour goes to the socialhome repo
  first; set `min_core_version` to the release that has it.
- License: MPL-2.0 for all source. Third-party assets (fonts, piece sets,
  icons) need a compatible license, stated in the PR.
