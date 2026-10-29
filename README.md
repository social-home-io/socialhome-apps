# Social Home Apps

Embedded JavaScript extension apps for [Social Home](https://github.com/social-home-io/socialhome).
This monorepo contains:

- **`packages/app-sdk`** — `@socialhome/app-sdk`: the TypeScript SDK that apps use to talk to the host SPA.
- **`apps/`** — individual apps (e.g. `chess`). Each is a self-contained static bundle built with esbuild.
- **`scripts/build-catalog.mjs`** — release tooling that packages each app as a `.tgz` and emits `catalog.json`.

---

## App structure

Every app lives under `apps/<app_id>/` and must contain a `manifest.json`
(and should contain a `CHANGELOG.json`, see below):

```json
{
  "app_id": "chess",
  "name": "Chess",
  "version": "2026.10.29",
  "description": "Play a game of chess with another household over Social Home federation.",
  "entry": "index.html",
  "icon": "data:image/svg+xml,…",
  "capabilities": ["storage", "federation"],
  "min_age": 0,
  "languages": ["en"],
  "homepage": "https://github.com/social-home-io/socialhome-apps/tree/main/apps/chess",
  "min_core_version": "2026.10.29",
  "i18n": {
    "de": { "name": "Schach", "description": "Spiel eine Partie Schach mit einem anderen Haushalt über Social Home." }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `app_id` | yes | Stable identifier, unique across all apps: lower-case letters, digits, `-`, `_` (≤ 40). |
| `name` | yes | Display name in English, ≤ 40 characters. |
| `version` | yes | **CalVer** `YYYY.M.D[.N]` (matching Social Home core), bumped on every release. |
| `description` | yes | One line in English for the app list, ≤ 300 characters. |
| `entry` | yes | Entry HTML file relative to `dist/`. Usually `index.html`. |
| `icon` | yes | A self-contained `data:` URI (≤ 16 KB) so it renders in Social Home's app cards. |
| `capabilities` | yes | What the app needs: `storage`, `people`, `federation` (see below). Anything else fails the build. |
| `min_age` | no | Age rating, one of `0` / `13` / `16` / `18` (default `0`). Social Home uses it as the household's starting value; an admin can change it. |
| `languages` | no | Locales the app's own UI speaks, e.g. `["en", "de"]` (default `["en"]`). |
| `i18n` | no | `name` + `description` per locale (`de`, `nl`, `fr`, `es`, …; ≤ 12 locales, same length limits). English stays in `name`/`description`. Words follow the [shared glossary](https://github.com/social-home-io/translations): "Apps" stays untranslated; du / je / vous / tú. |
| `homepage` | no | `https://` link to the app's source or page (text only; Social Home doesn't fetch it). |
| `min_core_version` | no | Oldest Social Home (CalVer) the app works with. |

An app can't set `publisher`: the catalog sets it (`"Social Home"` for every app in this repo).

### Capabilities and permissions

| Capability | Plain-word permission(s) in the catalog | Meaning |
|---|---|---|
| `storage` | `storage` | Saves its own data for each person (`sh.store.*`). |
| `people` | `people` | Lets you pick people to play with (`sh.contacts`). |
| `federation` | `people` + `federation` | Sends invites and moves to other households (`sh.federation.*`, `sh.onMessage`). Sending needs someone to send to, so it implies `people`. |

The catalog carries both: `capabilities` exactly as the manifest says (what
today's Social Home reads) and `permissions`, the three plain words Social Home
shows people. Permission text is always Social Home's own translated wording,
never taken from the catalog.

### `CHANGELOG.json` (what's new)

A list, **newest first**, one entry per released version:

```json
[
  {
    "version": "2026.10.29",
    "date": "2026-10-29",
    "notes": { "en": "Play with the keyboard: …", "de": "Spiel mit der Tastatur: …" }
  }
]
```

`version` is CalVer and never newer than the manifest's, versions strictly
decrease, `date` is `YYYY-MM-DD`, `notes.en` is required and every note is
≤ 500 characters. The catalog carries the newest 5 entries. When you bump the
manifest version, add its entry at the top (the build warns if you don't).

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
RELEASE_TAG=ci-dry-run pnpm catalog
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
import { sh, parseSessionPayload } from '@socialhome/app-sdk';

// App identity, and why the app was opened (call this first)
const { appId, selfUserId, launch } = await sh.context();

// Invites are played from Social Home: "Play" in the person's Needs you
// opens your app with that game (launch.sessionId), and Social Home accepts
// that one invite (launch.invite). Opening the app any other way accepts
// nothing — launch is {}.
if (launch?.invite) startGame(launch.invite);          // seat + show it
else if (launch?.sessionId) showGameIfKnown(launch.sessionId); // gone: say so
// launch === undefined: an older Social Home (no launch contexts) — fall back to
// `await sh.federation.pendingSessions()` and seat live invites (onSession).

// Key-value store (scoped to this app)
await sh.store.set('board', JSON.stringify(gameState));
const raw = await sh.store.get('board');

// Invite someone — through Social Home, never straight from the app (SDK ≥ 1.4).
// Social Home shows its own invite sheet outside your app; the person picks and
// taps Send, and Social Home sends the invite. You get back only who was picked
// and the session it opened with each ([] if they cancel).
const [picked] = await sh.people.pick({ purpose: 'play', max: 1 });
if (picked) {
  const target = { instance_id: picked.instance_id, user_ref: picked.user_ref, is_local: picked.is_local };
  // Send a move (or your opening state) to them within that session. Only
  // sessions Social Home knows for that person take messages: a made-up
  // session id is refused with ShError code 'unknown_session'.
  await sh.federation.send(picked.sessionId, target, { move: 'e2e4' });
}

// A rematch: suggest the person; the sheet still asks and Send names them.
// await sh.people.pick({ suggest: target });

// A game Social Home no longer knows (started before it kept games, or quiet
// for more than 90 days): a send fails with ShError "unknown_session". Offer
// to pick it up again; Social Home's sheet asks "Continue game with Ben", the
// other person gets it in Needs you and taps Play, then send your state again.
// await sh.people.pick({ purpose: "continue", sessionId, suggest: target });

// The people your app may know: whom the person picked and plays with in
// your app — never the household or friends list.
const contacts = await sh.contacts();

// What the household agreed to: leave out what you may not do.
const { permissions } = await sh.context(); // ['storage', 'people', 'federation']

// Refusals are typed: ShError has code ('permission_denied', 'busy',
// 'too_soon' + retryAfterMs, 'unknown_session', 'use_people_pick', …).
// federation.openSession is deprecated: Social Home refuses it with
// 'use_people_pick'.

// Receive in-session messages (e.g. the opponent's move). The callback gets
// { sessionId, fromInstance, payload } so you can route to the right game and
// identify the sender — this is what makes many concurrent games work.
const offMsg = sh.onMessage(({ sessionId, fromInstance, payload }) => {
  console.log(`move in ${sessionId} from ${fromInstance}:`, payload);
});

// Live session events. With a launch context a live `open` is news only —
// the invite waits in Needs you until Play — so don't seat it as a game.
// Your own invites are never echoed back to you.
const offInvite = sh.onSession(({ sessionId, fromInstance }) => {
  console.log(`invite to ${sessionId} from ${fromInstance}`);
});

// The other side ended a session: payload {verb: "close", reason}.
// "declined" reaches the challenger (the invitee said no in Social Home's
// "Needs you"); "withdrawn" reaches the invitee (see cancelSession below).
// Treat a missing or unknown reason as a plain close.
sh.onSession(({ sessionId, payload }) => {
  const { verb, reason } = parseSessionPayload(payload);
  if (verb === 'close' && reason === 'declined') { /* end the pending game */ }
});

// Take back an invite nobody answered: the invitee's "Needs you" item clears
// and their app gets {verb: "close", reason: "withdrawn"}.
await sh.federation.cancelSession(sessionId, target);

// Stop listening
offMsg();
offInvite();
```

### Launch context (`@socialhome/app-sdk` 1.2)

`AppContext.launch` (type `LaunchContext`) says why Social Home opened the app:

| `launch` | Meaning |
|---|---|
| `undefined` | An older Social Home: it accepts every waiting invite on open — use `federation.pendingSessions()` and live `onSession` invites. |
| `{}` | Opened normally. Nothing was accepted; invites wait in the person's Needs you. |
| `{ sessionId, invite }` | **Play** in Needs you: Social Home accepted this one invite. Start that game and show it. |
| `{ sessionId }` | Play, but the invite no longer waits (played on another device, declined, withdrawn, expired): show the game if you have it, else say so. |

Older apps keep working on a newer Social Home: their `pendingSessions()` call gets only the invite Play opened them for, and a live invite they seat themselves is accepted with their first message in that game.

### Held messages: the latest message per session (`@socialhome/app-sdk` 1.3)

Social Home keeps what arrives while your app is closed — or turned off in the household — and hands it over when the app next opens. **It keeps only the latest message of each session** (game), per person: a move, or a close (`{verb: "close", reason: "declined" | "withdrawn"}`). So:

- **Send state, not deltas.** Every message should carry enough to catch up (chess sends the whole game with each move), or resync from your own `store` on open.
- **Dedupe.** A held message may repeat one you already received live, or be older than what you have — ignore it then (chess compares the move count).

```ts
// Ask Social Home to wait until you're ready (recommended):
const ctx = await sh.context({ pullHeld: true });
await loadMyGames();
try {
  for (const msg of await sh.federation.held()) {
    if (msg.kind === 'session') onSession(msg); else onMessage(msg);
  }
} catch {
  // An older Social Home keeps nothing: there is nothing to apply.
}
```

Without `pullHeld`, Social Home posts held messages as ordinary live events right after `context()` answers — that is how apps on SDK ≤ 1.2 get them, through the `onMessage` / `onSession` handlers already subscribed by then. A message for a game Social Home doesn't know for this person, or from anyone but the other side of that game, is never kept. When the person you invited declines while your app is closed, you also get a notification in Social Home.

### Language, light/dark and colours (`@socialhome/app-sdk` 1.6)

Social Home tells your app how to look, and an app in the catalog must follow the person's **language** and **light/dark** (the colours are a recommendation). `context()` carries:

| Field | Meaning |
|---|---|
| `locale` | The person's Social Home language (`en`, `de`, `nl`, `fr`, `es`, …). Pick your closest catalog, fall back to English. |
| `dir` | `"ltr"` or `"rtl"`. |
| `theme` | `"light"` or `"dark"` — what Social Home shows now (its Auto already resolved). |
| `reducedMotion` | The person asked for less motion: skip animations. |
| `tokens` | Eight colours, each a plain `#rrggbb[aa]` string. |

All five are `undefined` on an older Social Home: default to English, left to right and your own colours. `applyTheme(look)` writes the tokens as CSS variables on your `:root`, sets `color-scheme` (native controls and scrollbars follow) and `data-theme` / `data-reduced-motion` for your selectors; `onContextChange` fires when the person switches language or theme while your app is open.

| Token | CSS variable | Use it for |
|---|---|---|
| `bg` | `--sh-bg` | the page background |
| `surface` | `--sh-surface` | cards, panels, dialogs |
| `text` | `--sh-text` | body text |
| `muted` | `--sh-muted` | secondary text (≥ 4.5:1 on bg and surface) |
| `accent` | `--sh-accent` | primary buttons, highlights |
| `onAccent` | `--sh-on-accent` | text on an `accent` fill |
| `border` | `--sh-border` | hairlines, dividers |
| `focus` | `--sh-focus` | the keyboard focus ring |

```ts
import { sh, applyTheme } from '@socialhome/app-sdk';

const ctx = await sh.context();
applyTheme(ctx);                      // tokens, color-scheme, data-theme
useLanguage(ctx.locale ?? 'en');      // your own string catalog
document.documentElement.dir = ctx.dir ?? 'ltr';
sh.onContextChange((look) => { applyTheme(look); useLanguage(look.locale ?? 'en'); render(); });
```

```css
/* Always with a fallback, so an older Social Home still looks right. */
body { background: var(--sh-bg, #fff); color: var(--sh-text, #111); }
.primary { background: var(--sh-accent, #b54824); color: var(--sh-on-accent, #fff); }
:focus-visible { outline: 2px solid var(--sh-focus, #a44221); }
```

The values are plain hex colours — Social Home never injects CSS into your frame, and `parseLook` / `applyTheme` drop anything else. Write your strings in the five languages with the shared glossary ([social-home-io/translations](https://github.com/social-home-io/translations): du / je / vous / tú, "Social Home" and "Apps" never translated) and list them in `languages` in `manifest.json`. Chess is the reference (`apps/chess/src/i18n.ts`, `look.ts`; the board stays left to right in RTL like every chess board).

The SDK communicates with the host SPA over `postMessage` (it never has the user's auth token). All calls are async and time out after 15 seconds. In the iframe `sh` is non-null; in non-browser/test contexts it is `null`, so use `createClient(...)` in unit tests.

---

## Cutting a release (step by step)

To publish a new version of one or more apps:

1. **Bump the version** in each changed app's `apps/<id>/manifest.json` (`"version"`). Commit it to `main`.
2. **Verify green CI** — the [CI workflow](.github/workflows/ci.yml) runs on every push/PR (type-check + build + test + catalog dry-run). You can also dry-run the release build via **Actions → Release → Run workflow** (`workflow_dispatch`) without publishing.
3. **Create the GitHub release** with a tag — either:
   - CLI: `gh release create 2026.10.29 --title 2026.10.29 --notes "What changed"`, or
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

### `catalog.json` shape (schema 2)

```json
{
  "schema": 2,
  "generated_at": "2026-10-29T07:43:30+00:00",
  "apps": [
    {
      "app_id": "chess",
      "name": "Chess",
      "latest_version": "2026.10.29",
      "description": "Play a game of chess with another household over Social Home federation.",
      "icon_url": "data:image/svg+xml,…",
      "capabilities": ["storage", "federation"],
      "bundle_url": "https://github.com/social-home-io/socialhome-apps/releases/download/2026.10.29/chess-2026.10.29.tgz",
      "bundle_sha256": "<sha256 hex of the .tgz>",
      "bundle_size": 16198,
      "permissions": ["storage", "people", "federation"],
      "min_age": 0,
      "languages": ["en"],
      "publisher": "Social Home",
      "i18n": { "de": { "name": "Schach", "description": "…" } },
      "homepage": "https://github.com/social-home-io/socialhome-apps/tree/main/apps/chess",
      "min_core_version": "2026.10.29",
      "changelog": [
        { "version": "2026.10.29", "date": "2026-10-29", "notes": { "en": "…", "de": "…" } }
      ]
    }
  ]
}
```

Schema 2 only **adds** fields: every schema 1 field keeps its meaning, so a
Social Home that only knows schema 1 keeps installing from it. Social Home
requires `app_id`, `name`, `latest_version`, `description`, `bundle_url` and
`bundle_sha256`; everything else is optional to it.

| Field | Source |
|---|---|
| `schema`, `generated_at` | catalog level: `2`, and the UTC build time |
| `bundle_size` | bytes of the `.tgz`, computed at build |
| `bundle_sha256` | the pin Social Home checks before unpacking |
| `permissions` | from `capabilities` (table above) |
| `min_age`, `languages`, `i18n`, `homepage`, `min_core_version` | from `manifest.json` (`min_age` defaults to `0`, `languages` to `["en"]`) |
| `publisher` | always `"Social Home"`, shown as "From Social Home". The catalog isn't signed yet; the trust is the HTTPS release plus the sha256 pin. |
| `changelog` | newest 5 entries of `CHANGELOG.json` (`[]` without one) |

`scripts/build-catalog.mjs` fails the build (and CI) on a manifest or changelog
that breaks these rules, and on limits Social Home enforces when reading the
catalog: name ≤ 40 characters, description ≤ 300, ≤ 12 translations,
changelog ≤ 5 entries of ≤ 500 characters, icon ≤ 16 KB, whole catalog
≤ 256 KB. The rules live in `scripts/catalog-lib.mjs`, tested by
`scripts/catalog-lib.test.mjs` (part of `pnpm test`).

### Triggering a build without publishing

Use **Actions → Release → Run workflow** (`workflow_dispatch`). The workflow builds and tests everything and logs the produced artefacts, but skips the `gh release upload` step (no release object exists for an ad-hoc branch run). Use this to verify a build before tagging.

---

## The chess demo app

`apps/chess/` is the reference implementation. It demonstrates:

- Using `sh.people.pick` (Social Home's invite sheet) to start a game and `sh.federation.send` to relay chess moves cross-household.
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
