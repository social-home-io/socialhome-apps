# Social Home Apps

Embedded JavaScript extension apps for [Social Home](https://github.com/social-home-io/socialhome).
This monorepo contains:

- **`packages/app-sdk`** — `@socialhome/app-sdk`: the TypeScript SDK that apps use to talk to the host SPA.
- **`apps/`** — individual apps (e.g. `chess`). Each is a self-contained static bundle built with esbuild.
- **`scripts/build-catalog.mjs`** — release tooling that packages each app as a `.tgz` and emits `catalog.json`.

---

## App structure

Every app lives under `apps/<app_id>/` and must contain a `manifest.json`:

```json
{
  "app_id": "chess",
  "name": "Chess",
  "version": "1.0.0",
  "description": "Play chess with another household over Social Home federation.",
  "entry": "index.html",
  "icon": "icon.svg",
  "capabilities": ["storage", "federation"]
}
```

| Field | Required | Description |
|---|---|---|
| `app_id` | yes | Stable identifier. Must be unique across all apps. |
| `name` | yes | Human-readable display name. |
| `version` | yes | **CalVer** `YYYY.M.D` (matching Social Home core), bumped on every release. |
| `description` | yes | Short description shown in the app browser. |
| `entry` | yes | Entry HTML file relative to `dist/`. Usually `index.html`. |
| `icon` | yes | Icon file relative to `dist/` (SVG or PNG). |
| `capabilities` | yes | Array of capability strings the app needs (see below). |

### Capabilities

| Value | Meaning |
|---|---|
| `storage` | Access to the per-app key-value store (`sh.store.*`). |
| `federation` | Cross-household messaging (`sh.federation.*`, `sh.onMessage`). |

The app's built bundle (`apps/<app_id>/dist/`) must be self-contained: `manifest.json`, `index.html`, `app.js`, `style.css`, and any icons — no external CDN dependencies at runtime. Social Home serves the bundle locally after install.

---

## Building and testing locally

```sh
# 1. Install all workspace dependencies
pnpm install

# 2. Build the SDK then every app
pnpm build

# 3. Run all unit tests
pnpm test

# 4. Build the release catalog (produces catalog.json + dist-tars/*.tgz)
RELEASE_TAG=1.0.0 pnpm catalog
```

`pnpm catalog` is shorthand for `node scripts/build-catalog.mjs`. It requires `RELEASE_TAG` to be set; optionally set `REPO_BASE` to override the default download URL base (`https://github.com/social-home-io/socialhome-apps`).

### GitHub Actions

| Workflow | Trigger | Does |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | every push to `main` + every PR (+ manual) | type-check, build, test, catalog dry-run — the always-on quality gate |
| [`release.yml`](.github/workflows/release.yml) | a published GitHub release (+ manual dry-run) | build + test, then publish `catalog.json` + each app tarball as release assets |

---

## SDK quickstart

```ts
import { sh } from '@socialhome/app-sdk';

// App identity
const { appId, selfUserId } = await sh.context();

// Key-value store (scoped to this app)
await sh.store.set('board', JSON.stringify(gameState));
const raw = await sh.store.get('board');

// List paired households
const peers = await sh.peers();

// Start a game with a friend's household (they receive an invite — see onSession)
const sessionId = await sh.federation.openSession(peers[0].instance_id);

// Send a move to that peer within the session
await sh.federation.send(sessionId, peers[0].instance_id, { move: 'e2e4' });

// Receive in-session messages (e.g. the opponent's move). The callback gets
// { sessionId, fromInstance, payload } so you can route to the right game and
// identify the sender — this is what makes many concurrent games work.
const offMsg = sh.onMessage(({ sessionId, fromInstance, payload }) => {
  console.log(`move in ${sessionId} from ${fromInstance}:`, payload);
});

// Receive incoming session invites (a friend challenged you)
const offInvite = sh.onSession(({ sessionId, fromInstance }) => {
  console.log(`invite to ${sessionId} from ${fromInstance}`);
});

// Stop listening
offMsg();
offInvite();
```

The SDK communicates with the host SPA over `postMessage` (it never has the user's auth token). All calls are async and time out after 15 seconds. In the iframe `sh` is non-null; in non-browser/test contexts it is `null`, so use `createClient(...)` in unit tests.

---

## Cutting a release (step by step)

To publish a new version of one or more apps:

1. **Bump the version** in each changed app's `apps/<id>/manifest.json` (`"version"`). Commit it to `main`.
2. **Verify green CI** — the [CI workflow](.github/workflows/ci.yml) runs on every push/PR (type-check + build + test + catalog dry-run). You can also dry-run the release build via **Actions → Release → Run workflow** (`workflow_dispatch`) without publishing.
3. **Create the GitHub release** with a tag — either:
   - CLI: `gh release create 1.2.0 --title 1.2.0 --notes "What changed"`, or
   - UI: **Releases → Draft a new release → Choose a tag → Publish**.
4. Publishing fires the [**Release** workflow](.github/workflows/release.yml), which builds everything and uploads `catalog.json` + each `<app>-<version>.tgz` (SHA-256-pinned) as **release assets**.
5. Social Home installs fetch `releases/latest/download/catalog.json`, so the new version is live for the **Browse Apps** page as soon as the workflow finishes. (The tag must be the highest/most-recent release for `latest` to point at it.)

> **Adding a new app:** create `apps/<new-id>/` with a `manifest.json` + a `build` script that emits a self-contained `dist/`, give it a `package.json` (`"build"` script), and the catalog script + workflows pick it up automatically — no workflow edits needed.

---

## How releases work (mechanism)

1. A GitHub release is published (any tag).
2. The **Release** workflow (`.github/workflows/release.yml`) runs automatically:
   - Installs dependencies, builds the SDK + all apps, runs tests.
   - Runs `scripts/build-catalog.mjs`:
     - Packs each `apps/<id>/dist/` into `dist-tars/<id>-<version>.tgz` (tarball root = dist contents, not nested).
     - Computes `sha256` of every tarball.
     - Writes `catalog.json` at the repo root.
   - Uploads `catalog.json` + all `.tgz` files as release assets (with `--clobber` to allow re-runs).
3. Social Home installations poll `releases/latest/download/catalog.json`, pick up new or updated apps, download each bundle tarball, **verify the SHA-256 against the catalog entry**, and unpack it.

### `catalog.json` shape

```json
{
  "apps": [
    {
      "app_id": "chess",
      "name": "Chess",
      "latest_version": "1.0.0",
      "description": "Play chess with another household over Social Home federation.",
      "icon_url": null,
      "capabilities": ["storage", "federation"],
      "bundle_url": "https://github.com/social-home-io/socialhome-apps/releases/download/1.0.0/chess-1.0.0.tgz",
      "bundle_sha256": "<sha256 hex of the .tgz>"
    }
  ]
}
```

All fields except `icon_url` are required by the Social Home backend.

### Triggering a build without publishing

Use **Actions → Release → Run workflow** (`workflow_dispatch`). The workflow builds and tests everything and logs the produced artefacts, but skips the `gh release upload` step (no release object exists for an ad-hoc branch run). Use this to verify a build before tagging.

---

## The chess demo app

`apps/chess/` is the reference implementation. It demonstrates:

- Using `sh.federation.openSession` + `sh.federation.send` to relay chess moves cross-household.
- Persisting game state with `sh.store.set` / `sh.store.get`.
- Listening for opponent moves via `sh.onMessage`.

Read `apps/chess/` alongside `packages/app-sdk/src/index.ts` when writing a new app.

---

## Security model

- Apps run in a **sandboxed iframe** — no access to the host SPA's DOM, cookies, or auth tokens. The Content Security Policy sets `connect-src 'none'` for the iframe, so apps cannot make arbitrary network requests; all cross-origin communication goes through the SDK's `postMessage` channel.
- The **bundle SHA-256 is pinned** in `catalog.json` and verified by the Social Home backend on install. A tampered tarball is rejected before unpacking.
- Apps have no bearer token and no direct database access. The host SPA mediates every store read/write and every federation message through the SDK RPC bridge.

---

## License

MPL-2.0. See [LICENSE](LICENSE).
