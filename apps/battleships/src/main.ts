/**
 * Battleships — the UI and its life cycle (the engine is pure and tested:
 * rules, seal, game, protocol; the words: view, i18n).
 *
 *  - `ui.games` Map<sessionId, GameEntry>, kept per person in `sh.store`
 *    under "game:<sessionId>"; the new-game draft fleet under "draft", the
 *    last locked-in fleet under "lastFleet".
 *  - Views: lobby (games + new game), place (our fleet), game (battle, and
 *    the end with both fleets).
 *  - Every message carries the whole game. Inbound messages are judged by
 *    `receive`; work on one game is serialized (`withGame`) so live and held
 *    copies never race.
 *  - Never send anything after a game's final message: it would replace
 *    the reveal in Social Home's one-slot mailbox.
 */

import sh, { ShError } from "@socialhome/app-sdk";
import type { AppLook, AppMessage, Contact, PickedPerson } from "@socialhome/app-sdk";
import { CELLS, SHIPS, canPlace, cellName, cryptoRng, isLegalFleet, parseFleet, placementCells, randomFleet, shipMap, withShip } from "./rules.js";
import type { Fleet, Placement } from "./rules.js";
import { fingerprint, fromB64url, newSeed } from "./seal.js";
import { fire, firedBy, hitsByMe, hitsOnMe, lockIn, newGame, phase, resign, setFleet } from "./game.js";
import type { Game } from "./game.js";
import { buildMessage, canSend, isBsMessage, markSent, passesTurn, receive } from "./protocol.js";
import {
  classifySessionEvent,
  continueCopy,
  entryForInvite,
  entryForPicked,
  isAwaitingOpponent,
  isUnknownGame,
  launchAction,
  pickFailure,
  removeCopy,
  resignCopy,
  personName,
  routeInbound,
  targetFor,
} from "./lifecycle.js";
import type { ConfirmCopy, GameEntry } from "./lifecycle.js";
import {
  announce,
  chipFor,
  lastShotAtMe,
  lieAt,
  ownBoard,
  ownCellLabel,
  ownHits,
  progressFor,
  revealedBoard,
  shipTitle,
  statusFor,
  targetBoard,
  targetCellLabel,
  theirSunk,
  verdictFor,
} from "./view.js";
import { dropFits, dropStart, droppedText, isNavKey, moveCursor, nudgeShip, placementText, rotateShip } from "./board-nav.js";
import { createAnnouncer } from "./announcer.js";
import type { Announcer } from "./announcer.js";
import { t } from "./i18n.js";
import { applyLook } from "./look.js";

const client = sh as NonNullable<typeof sh>;
const rng = cryptoRng();

type View = "lobby" | "place" | "game";

interface UI {
  view: View;
  /** The game shown (place / game views); `null` while placing a new game's draft. */
  active: string | null;
  selfUserId: string;
  contacts: Contact[];
  games: Map<string, GameEntry>;
  /** The new game's fleet before anyone is invited, and whom a rematch suggests. */
  draft: Fleet;
  suggest: Contact | null;
  lastFleet: Fleet | null;
  /** Placement: the selected ship, its place before a keyboard pick-up, the cursor. */
  sel: number | null;
  carry: Placement | null;
  placeCursor: number;
  placeError: boolean;
  /** Battle: the aimed square, the two cursors, the mobile tab, the ⋯ panel. */
  aim: number | null;
  cursorTarget: number;
  cursorOwn: number;
  tab: "target" | "own";
  moreOpen: boolean;
  liveInvites: boolean;
  reducedMotion: boolean;
  unsupportedShown: Set<string>;
}

const ui: UI = {
  view: "lobby",
  active: null,
  selfUserId: "",
  contacts: [],
  games: new Map(),
  draft: randomFleet(rng),
  suggest: null,
  lastFleet: null,
  sel: null,
  carry: null,
  placeCursor: 0,
  placeError: false,
  aim: null,
  cursorTarget: 0,
  cursorOwn: 0,
  tab: "target",
  moreOpen: false,
  liveInvites: false,
  reducedMotion: false,
  unsupportedShown: new Set(),
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const PREFIX = "game:";

const writes = new Map<string, Promise<void>>();
const queued = new Set<string>();

/**
 * Save a game in the background. Writes of one game are serialized and
 * coalesced (a write queued behind another saves the newest state once), and
 * a refused write (Social Home allows 60 app calls a minute per person) is
 * retried. The game on screen never waits for the store: the copy in memory
 * is the one that plays, the store catches up.
 */
function persist(entry: GameEntry): Promise<void> {
  const sid = entry.sessionId;
  if (queued.has(sid)) return writes.get(sid)!;
  queued.add(sid);
  const next = (writes.get(sid) ?? Promise.resolve()).then(async () => {
    queued.delete(sid);
    for (let attempt = 0; ; attempt++) {
      try {
        await client.store.set(PREFIX + sid, entry);
        return;
      } catch (err) {
        // Social Home allows 60 app calls a minute per person: keep trying
        // past a full window (the newest state is what gets written).
        if (attempt >= 8) {
          console.warn("battleships.persist_failed", { session_id: sid });
          return;
        }
        const backoff = Math.min(15_000, 2000 * (attempt + 1));
        const wait = err instanceof ShError && err.retryAfterMs ? Math.max(err.retryAfterMs, backoff) : backoff;
        console.info("battleships.persist_retry", { session_id: sid, attempt, wait });
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  });
  writes.set(sid, next);
  return next;
}

function parseEntry(v: unknown): GameEntry | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Partial<GameEntry>;
  const g = e.game as Partial<Game> | undefined;
  if (
    typeof e.sessionId !== "string" ||
    typeof e.opponentInstanceId !== "string" ||
    typeof e.opponentName !== "string" ||
    !g ||
    (g.role !== "challenger" && g.role !== "invitee") ||
    !Array.isArray(g.shots) ||
    !Array.isArray(g.fleet)
  ) {
    return null;
  }
  return {
    sessionId: e.sessionId,
    opponentInstanceId: e.opponentInstanceId,
    opponentRef: typeof e.opponentRef === "string" ? e.opponentRef : "",
    opponentIsLocal: e.opponentIsLocal === true,
    opponentName: e.opponentName,
    game: g as Game,
  };
}

async function loadAll(): Promise<void> {
  const all = await client.store.list();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PREFIX)) {
      const entry = parseEntry(value);
      if (entry) ui.games.set(entry.sessionId, entry);
    } else if (key === "draft") {
      const f = parseFleet(value);
      if (f) ui.draft = f;
    } else if (key === "lastFleet") {
      ui.lastFleet = parseFleet(value);
    }
  }
}

/** One game's work at a time: live, held and local steps never race. */
const queues = new Map<string, Promise<void>>();
function withGame(sid: string, fn: () => Promise<void>): Promise<void> {
  const prev = queues.get(sid) ?? Promise.resolve();
  const next = prev.then(fn).catch((err) => console.error("battleships.game_step_failed", err));
  queues.set(sid, next);
  return next;
}

// ---------------------------------------------------------------------------
// DOM helpers, live regions, toasts
// ---------------------------------------------------------------------------

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { cls?: string; text?: string; attrs?: Record<string, string> } = {},
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (opts.cls) e.className = opts.cls;
  if (opts.text !== undefined) e.textContent = opts.text;
  for (const [k, v] of Object.entries(opts.attrs ?? {})) e.setAttribute(k, v);
  return e;
}

function button(text: string, cls: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = make("button", { cls: `btn ${cls}`.trim(), text, attrs: { type: "button", ...attrs } });
  b.addEventListener("click", onClick);
  return b;
}

let polite: Announcer | null = null;
let assertiveRegion: HTMLElement | null = null;

function say(text: string): void {
  if (!polite) {
    const region = make("div", { cls: "sr-only", attrs: { "aria-live": "polite", "aria-atomic": "true" } });
    document.body.appendChild(region);
    polite = createAnnouncer((s) => {
      region.textContent = "";
      setTimeout(() => (region.textContent = s), 30);
    });
  }
  polite.announce(text);
}

function alertNow(text: string): void {
  if (!assertiveRegion) {
    assertiveRegion = make("div", { cls: "sr-only", attrs: { role: "alert", "aria-live": "assertive" } });
    document.body.appendChild(assertiveRegion);
  }
  const region = assertiveRegion;
  region.textContent = "";
  setTimeout(() => (region.textContent = text), 30);
}

function toast(message: string): void {
  let box = document.getElementById("toasts");
  if (!box) {
    box = make("div", { attrs: { id: "toasts", "aria-live": "polite" } });
    document.body.appendChild(box);
  }
  const el = make("div", { cls: "toast", text: message });
  box.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/** In-app confirm (the sandboxed frame can't use window.confirm). */
function confirmDialog(copy: ConfirmCopy): Promise<boolean> {
  return new Promise((resolve) => {
    const back = document.activeElement as HTMLElement | null;
    const dlg = make("dialog", { cls: "confirm", attrs: { "aria-labelledby": "confirm-title", "aria-describedby": "confirm-body" } });
    dlg.append(
      make("h2", { text: copy.title, attrs: { id: "confirm-title" } }),
      make("p", { text: copy.body, attrs: { id: "confirm-body" } }),
    );
    let ok = false;
    const cancel = button(copy.cancel, "ghost", () => dlg.close());
    const yes = button(copy.confirm, copy.primary ? "primary" : "danger", () => {
      ok = true;
      dlg.close();
    });
    const row = make("div", { cls: "row end" });
    row.append(cancel, yes);
    dlg.appendChild(row);
    dlg.addEventListener("click", (ev) => {
      if (ev.target === dlg) dlg.close();
    });
    dlg.addEventListener("close", () => {
      dlg.remove();
      if (!ok && back?.isConnected) back.focus();
      resolve(ok);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    cancel.focus();
  });
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

interface BoardSpec {
  id: string;
  label: string;
  cursor: number;
  cell: (c: number) => { cls: string[]; label: string };
  onKey?: (ev: KeyboardEvent, cell: number) => void;
  onActivate?: (cell: number) => void;
  extraCls?: string;
}

const COLS = "ABCDEFGHIJ";

/** A 10 × 10 ARIA grid with coordinates; always left to right. */
function buildBoard(spec: BoardSpec): HTMLElement {
  const wrap = make("div", { cls: `board ${spec.extraCls ?? ""}`.trim(), attrs: { dir: "ltr" } });
  const top = make("div", { cls: "lbl-row", attrs: { "aria-hidden": "true" } });
  top.appendChild(make("span", { cls: "lbl corner" }));
  for (const c of COLS) top.appendChild(make("span", { cls: "lbl", text: c }));
  wrap.appendChild(top);
  const body = make("div", { cls: "board-body" });
  const side = make("div", { cls: "lbl-col", attrs: { "aria-hidden": "true" } });
  for (let r = 1; r <= 10; r++) side.appendChild(make("span", { cls: "lbl", text: String(r) }));
  body.appendChild(side);
  const grid = make("div", { cls: "grid", attrs: { role: "grid", id: spec.id, "aria-label": spec.label } });
  for (let r = 0; r < 10; r++) {
    const row = make("div", { cls: "grid-row", attrs: { role: "row" } });
    for (let c = 0; c < 10; c++) {
      const i = r * 10 + c;
      const v = spec.cell(i);
      const cell = make("div", {
        cls: ["cell", ...v.cls].join(" "),
        attrs: { role: "gridcell", "aria-label": v.label, tabindex: i === spec.cursor ? "0" : "-1", "data-cell": String(i) },
      });
      row.appendChild(cell);
    }
    grid.appendChild(row);
  }
  if (spec.onActivate) {
    grid.addEventListener("click", (ev) => {
      const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-cell]");
      if (el) spec.onActivate!(Number(el.dataset["cell"]));
    });
  }
  grid.addEventListener("keydown", (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!el) return;
    const cell = Number(el.dataset["cell"]);
    if (spec.onKey) spec.onKey(ev, cell);
  });
  body.appendChild(grid);
  wrap.appendChild(body);
  return wrap;
}

/** Move a grid's single tab stop to *to* and focus it. */
function moveFocus(gridId: string, from: number, to: number): void {
  const grid = document.getElementById(gridId);
  grid?.querySelector(`[data-cell="${from}"]`)?.setAttribute("tabindex", "-1");
  const el = grid?.querySelector<HTMLElement>(`[data-cell="${to}"]`);
  el?.setAttribute("tabindex", "0");
  el?.focus();
}

function focusCell(gridId: string, cell: number): void {
  document.querySelector<HTMLElement>(`#${gridId} [data-cell="${cell}"]`)?.focus({ preventScroll: true });
}

/** Rounded ends for ship squares. */
function shipEnds(fleet: Fleet): Map<number, string> {
  const ends = new Map<number, string>();
  for (const p of fleet) {
    const cells = placementCells(p) ?? [];
    ends.set(cells[0], p[2] === "h" ? "end-l" : "end-t");
    ends.set(cells[cells.length - 1], p[2] === "h" ? "end-r" : "end-b");
  }
  return ends;
}

function pips(len: number, sunk = false): HTMLElement {
  const p = make("span", { cls: `pips${sunk ? " sunk" : ""}`, attrs: { "aria-hidden": "true" } });
  for (let i = 0; i < len; i++) p.appendChild(make("i"));
  return p;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function root(): HTMLElement {
  return document.getElementById("app-root")!;
}

function render(): void {
  if (ui.view === "place") renderPlace();
  else if (ui.view === "game") renderGame();
  else renderLobby();
}

function activeEntry(): GameEntry | null {
  return ui.active ? (ui.games.get(ui.active) ?? null) : null;
}

/** Your-turn games first, then games in play, then the finished ones. */
function sortedGames(): GameEntry[] {
  const rank = (e: GameEntry): number => {
    const p = phase(e.game);
    return p === "my-turn" || p === "place" ? 0 : p === "over" ? 2 : 1;
  };
  return [...ui.games.values()].sort((a, b) => rank(a) - rank(b) || b.game.updatedAt - a.game.updatedAt);
}

function renderLobby(): void {
  const r = root();
  r.replaceChildren();
  r.className = "view-lobby";

  const head = make("div", { cls: "lobby-head" });
  head.append(make("h2", { cls: "lobby-title", text: t("lobby.games") }));
  head.append(button(t("btn.newGame"), "primary", () => startNewGame(null), { "data-new-game": "" }));
  r.appendChild(head);
  r.appendChild(make("p", { cls: "muted lobby-hint", text: t("lobby.hint") }));

  const games = sortedGames();
  if (games.length === 0) {
    r.appendChild(make("p", { cls: "empty", text: t("lobby.empty") }));
  } else {
    const list = make("ul", { cls: "game-list" });
    for (const entry of games) list.appendChild(gameCard(entry));
    r.appendChild(list);
  }

  const played = ui.contacts.filter((c) => c.user_ref !== ui.selfUserId);
  if (played.length > 0) {
    r.appendChild(make("h2", { cls: "section", text: t("lobby.playedBefore") }));
    const list = make("ul", { cls: "people" });
    for (const c of played) {
      const li = make("li", { cls: "card person" });
      li.append(make("span", { cls: "who", text: c.display_name }));
      li.append(button(t("btn.rematch"), "", () => startNewGame(c), { "aria-label": t("btn.rematchWho", { name: c.display_name }) }));
      list.appendChild(li);
    }
    r.appendChild(list);
  }
}

function gameCard(entry: GameEntry): HTMLElement {
  const g = entry.game;
  const name = entry.opponentName;
  const li = make("li", { cls: "card game" });
  const top = make("div", { cls: "game-top" });
  top.append(make("span", { cls: "who", text: name }));
  const chip = chipFor(entry);
  top.append(make("span", { cls: `chip ${chip.tone}`, text: chip.text }));
  li.appendChild(top);
  li.appendChild(make("p", { cls: "muted small progress", text: progressFor(entry) }));

  const acts = make("div", { cls: "acts" });
  const p = phase(g);
  const open = () => openGame(entry.sessionId);
  if (g.outcome?.kind === "void") {
    acts.append(button(t("btn.seeWhy"), "", open, { "aria-label": t("btn.openWith", { name }), "data-open": entry.sessionId }));
  } else if (p === "my-turn" || p === "place") {
    acts.append(button(t("btn.play"), "primary", open, { "aria-label": t("btn.openWith", { name }), "data-open": entry.sessionId }));
  } else {
    acts.append(button(t("btn.open"), "", open, { "aria-label": t("btn.openWith", { name }), "data-open": entry.sessionId }));
  }
  if (isAwaitingOpponent(entry)) acts.append(button(t("btn.cancelInvite"), "ghost", () => void cancelInvite(entry)));
  if (g.outcome) {
    const contact = contactFor(entry);
    acts.append(button(t("btn.rematch"), "", () => startNewGame(contact), { "aria-label": t("btn.rematchWho", { name }) }));
    acts.append(button(t("btn.remove"), "ghost", () => void removeGame(entry), { "aria-label": t("btn.removeWith", { name }) }));
  }
  li.appendChild(acts);
  return li;
}

function contactFor(entry: GameEntry): Contact {
  return (
    ui.contacts.find((c) => c.instance_id === entry.opponentInstanceId && c.user_ref === entry.opponentRef) ?? {
      instance_id: entry.opponentInstanceId,
      user_ref: entry.opponentRef,
      is_local: entry.opponentIsLocal,
      display_name: entry.opponentName,
      online: false,
    }
  );
}

function backButton(): HTMLElement {
  const b = make("button", { cls: "btn ghost back", attrs: { type: "button", "aria-label": t("battle.backLabel") } });
  b.append(make("span", { cls: "flip-rtl", text: "←", attrs: { "aria-hidden": "true" } }), ` ${t("battle.back")}`);
  b.addEventListener("click", toLobby);
  return b;
}

function toLobby(): void {
  const from = ui.active;
  ui.view = "lobby";
  ui.active = null;
  ui.aim = null;
  ui.sel = null;
  ui.carry = null;
  ui.moreOpen = false;
  polite?.clear();
  renderLobby();
  const back = from ? document.querySelector<HTMLElement>(`[data-open="${CSS.escape(from)}"]`) : null;
  (back ?? document.querySelector<HTMLElement>("[data-new-game]"))?.focus();
}

// ---- Placement ------------------------------------------------------------

function placeFleet(): Fleet {
  const e = activeEntry();
  return e ? e.game.fleet : ui.draft;
}

function setPlaceFleet(f: Fleet): void {
  const e = activeEntry();
  if (e) {
    e.game = setFleet(e.game, f);
    void persist(e);
  } else {
    ui.draft = f;
    // Saved once the person stops moving ships (each move is not a store call).
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => void client.store.set("draft", ui.draft).catch(() => {}), 2000);
  }
}

let draftTimer: ReturnType<typeof setTimeout> | null = null;

function startNewGame(suggest: Contact | null): void {
  ui.view = "place";
  ui.active = null;
  ui.suggest = suggest;
  ui.sel = null;
  ui.carry = null;
  ui.placeCursor = 0;
  ui.placeError = false;
  renderPlace();
  document.querySelector<HTMLElement>(".ship-btn")?.focus();
}

function renderPlace(): void {
  const r = root();
  const hadGridFocus = document.activeElement?.closest("#place-grid") != null;
  r.replaceChildren();
  r.className = "view-place";
  const entry = activeEntry();
  const fleet = placeFleet();
  const name = entry ? personName(entry) : (ui.suggest?.display_name.split(" · ")[0] ?? null);

  const top = make("div", { cls: "topbar" });
  top.append(backButton(), make("h2", { cls: "title", text: t("place.title") }));
  r.appendChild(top);
  r.appendChild(make("p", { cls: "muted center", text: t("place.hint") }));

  const wrap = make("div", { cls: "place-wrap" });
  const ends = shipEnds(fleet);
  const map = shipMap(fleet);
  const board = buildBoard({
    id: "place-grid",
    label: t("battle.yourFleetLabel"),
    cursor: ui.placeCursor,
    extraCls: "placing",
    cell: (c) => {
      const cls: string[] = [];
      const ship = map[c];
      if (ship >= 0) {
        cls.push("ship");
        if (ends.has(c)) cls.push(ends.get(c)!);
        if (ship === ui.sel) cls.push("selected");
      }
      const label =
        ship >= 0 ? t("cell.ownShip", { cell: cellName(c), ship: shipTitle(ship) }) : t("cell.water", { cell: cellName(c) });
      return { cls, label };
    },
    onKey: placeKey,
  });
  attachDrag(board.querySelector<HTMLElement>("#place-grid")!);
  wrap.appendChild(board);

  const sideEl = make("div", { cls: "place-side" });
  const ships = make("div", { cls: "ships", attrs: { role: "group", "aria-label": t("place.ships") } });
  SHIPS.forEach((s, i) => {
    const b = make("button", {
      cls: "ship-btn",
      attrs: {
        type: "button",
        "aria-pressed": ui.sel === i ? "true" : "false",
        "aria-label": t("place.shipButton", { ship: shipTitle(i), len: s.len }),
      },
    });
    b.append(make("span", { text: shipTitle(i) }), pips(s.len));
    b.addEventListener("click", () => {
      ui.sel = ui.sel === i ? null : i;
      ui.placeError = false;
      if (ui.sel !== null) {
        ui.placeCursor = fleet[i][1];
        say(t("place.selected", { ship: shipTitle(i) }));
      }
      renderPlace();
    });
    ships.appendChild(b);
  });
  sideEl.appendChild(ships);

  const tools = make("div", { cls: "row tools" });
  tools.append(
    button(`↻ ${t("btn.rotate")}`, "", () => {
      const idx = ui.sel ?? 0;
      const p = rotateShip(placeFleet(), idx);
      if (!p) return placeBad();
      ui.sel = idx;
      setPlaceFleet(withShip(placeFleet(), idx, p[1], p[2]));
      ui.placeError = false;
      say(placementText(p));
      renderPlace();
    }),
    button(`⤨ ${t("btn.shuffle")}`, "", () => {
      setPlaceFleet(randomFleet(rng));
      ui.sel = null;
      ui.placeError = false;
      say(t("place.shuffled"));
      renderPlace();
    }),
  );
  sideEl.appendChild(tools);
  if (ui.lastFleet && !entry) {
    sideEl.appendChild(
      button(t("btn.lastFleet"), "ghost wide", () => {
        setPlaceFleet(ui.lastFleet!);
        renderPlace();
      }),
    );
  }
  if (ui.placeError) sideEl.appendChild(make("p", { cls: "bad-note", text: t("place.bad"), attrs: { role: "status" } }));
  sideEl.appendChild(
    button(entry ? t("btn.lockIn") : t("btn.lockInvite"), "primary wide lock", () => void (entry ? lockInvitee(entry) : lockAndInvite()), {
      "data-lock": "",
    }),
  );
  sideEl.appendChild(make("p", { cls: "muted small", text: name ? t("place.seal", { name }) : t("place.sealAnyone") }));
  sideEl.appendChild(make("p", { cls: "muted small keys", text: t("place.keys") }));
  wrap.appendChild(sideEl);
  r.appendChild(wrap);
  if (hadGridFocus) focusCell("place-grid", ui.placeCursor);
}

function placeBad(): void {
  ui.placeError = true;
  say(t("place.bad"));
  renderPlace();
}

/** Keys on the placement grid: Enter picks up / drops, arrows move, R rotates, Escape cancels. */
function placeKey(ev: KeyboardEvent, cell: number): void {
  const fleet = placeFleet();
  if (ui.carry && ui.sel !== null) {
    const idx = ui.sel;
    if (isNavKey(ev.key) && ev.key.startsWith("Arrow")) {
      ev.preventDefault();
      const p = nudgeShip(fleet, idx, ev.key);
      if (!p) return void say(t("place.bad"));
      setPlaceFleet(withShip(fleet, idx, p[1], p[2]));
      ui.placeCursor = p[1];
      say(placementText(p));
      renderPlace();
      focusCell("place-grid", ui.placeCursor);
      return;
    }
    if (ev.key === "r" || ev.key === "R") {
      ev.preventDefault();
      const p = rotateShip(fleet, idx);
      if (!p) return void say(t("place.bad"));
      setPlaceFleet(withShip(fleet, idx, p[1], p[2]));
      ui.placeCursor = p[1];
      say(placementText(p));
      renderPlace();
      focusCell("place-grid", ui.placeCursor);
      return;
    }
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      ui.carry = null;
      say(droppedText(fleet[idx]));
      ui.sel = null;
      renderPlace();
      focusCell("place-grid", ui.placeCursor);
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      setPlaceFleet(withShip(fleet, idx, ui.carry[1], ui.carry[2]));
      ui.placeCursor = ui.carry[1];
      ui.carry = null;
      ui.sel = null;
      say(t("place.cancelled", { ship: shipTitle(idx) }));
      renderPlace();
      focusCell("place-grid", ui.placeCursor);
    }
    return;
  }
  if (isNavKey(ev.key)) {
    ev.preventDefault();
    const next = moveCursor(cell, ev.key, ev.ctrlKey || ev.metaKey);
    moveFocus("place-grid", cell, next);
    ui.placeCursor = next;
    return;
  }
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    const ship = shipMap(fleet)[cell];
    if (ship >= 0) {
      ui.sel = ship;
      ui.carry = [...fleet[ship]] as Placement;
      ui.placeCursor = fleet[ship][1];
      say(`${t("place.picked", { ship: shipTitle(ship) })} ${placementText(fleet[ship])}`);
      renderPlace();
      focusCell("place-grid", ui.placeCursor);
    } else if (ui.sel !== null) {
      tapPlace(cell);
    }
  }
}

/** Tap a ship to select it; with one selected, tap a square to move it there. */
function tapPlace(cell: number): void {
  const fleet = placeFleet();
  const ship = shipMap(fleet)[cell];
  if (ship >= 0 && ship !== ui.sel) {
    ui.sel = ship;
    ui.placeError = false;
    say(t("place.selected", { ship: shipTitle(ship) }));
    renderPlace();
    return;
  }
  if (ui.sel === null) return;
  if (ship === ui.sel) {
    ui.sel = null;
    renderPlace();
    return;
  }
  const dir = fleet[ui.sel][2];
  if (!canPlace(fleet, ui.sel, cell, dir)) return placeBad();
  setPlaceFleet(withShip(fleet, ui.sel, cell, dir));
  say(droppedText([ui.sel, cell, dir]));
  ui.placeError = false;
  ui.placeCursor = cell;
  renderPlace();
}

/** Drag a ship with mouse or touch; a press without a move is a tap. */
function attachDrag(grid: HTMLElement): void {
  let drag: { idx: number; grip: number; from: number; pointer: number; moved: boolean; target: number | null } | null = null;
  const cellAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("#place-grid [data-cell]");
    return el ? Number(el.dataset["cell"]) : null;
  };
  const clearGhost = () => grid.querySelectorAll(".ghost, .bad").forEach((c) => c.classList.remove("ghost", "bad"));
  grid.addEventListener("pointerdown", (ev) => {
    const cell = cellAt(ev.clientX, ev.clientY);
    if (cell === null) return;
    const fleet = placeFleet();
    const ship = shipMap(fleet)[cell];
    if (ship < 0) {
      drag = null;
      return;
    }
    const cells = placementCells(fleet[ship])!;
    drag = { idx: ship, grip: cells.indexOf(cell), from: cell, pointer: ev.pointerId, moved: false, target: null };
    grid.setPointerCapture(ev.pointerId);
  });
  grid.addEventListener("pointermove", (ev) => {
    if (!drag || ev.pointerId !== drag.pointer) return;
    const cell = cellAt(ev.clientX, ev.clientY);
    if (cell === null || cell === drag.target) return;
    if (cell !== drag.from) drag.moved = true;
    drag.target = cell;
    clearGhost();
    const fleet = placeFleet();
    const dir = fleet[drag.idx][2];
    const len = SHIPS[drag.idx].len;
    const ok = dropFits(cell, drag.grip, dir, len) && canPlace(fleet, drag.idx, dropStart(cell, drag.grip, dir), dir);
    const start = dropStart(cell, drag.grip, dir);
    for (let k = 0; k < len; k++) {
      const c = dir === "h" ? start + k : start + k * 10;
      if (dir === "h" && Math.floor(c / 10) !== Math.floor(cell / 10)) continue;
      grid.querySelector(`[data-cell="${c}"]`)?.classList.add(ok ? "ghost" : "bad");
    }
  });
  const end = (ev: PointerEvent) => {
    if (!drag || ev.pointerId !== drag.pointer) return;
    const d = drag;
    drag = null;
    clearGhost();
    if (!d.moved) {
      tapPlace(d.from);
      return;
    }
    const fleet = placeFleet();
    const dir = fleet[d.idx][2];
    const cell = d.target ?? d.from;
    const start = dropStart(cell, d.grip, dir);
    if (!dropFits(cell, d.grip, dir, SHIPS[d.idx].len) || !canPlace(fleet, d.idx, start, dir)) return placeBad();
    setPlaceFleet(withShip(fleet, d.idx, start, dir));
    ui.sel = d.idx;
    ui.placeError = false;
    say(droppedText([d.idx, start, dir]));
    renderPlace();
  };
  grid.addEventListener("pointerup", end);
  grid.addEventListener("pointercancel", () => {
    drag = null;
    clearGhost();
  });
  // Taps on empty water with a selected ship (no pointerdown drag).
  grid.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!el || ev.detail === 0) return; // keyboard "clicks" are handled by placeKey
    const cell = Number(el.dataset["cell"]);
    if (shipMap(placeFleet())[cell] < 0 && ui.sel !== null) tapPlace(cell);
  });
}

// ---- Battle and end -----------------------------------------------------

function openGame(sid: string): void {
  const entry = ui.games.get(sid);
  if (!entry) return;
  ui.active = sid;
  ui.aim = null;
  ui.moreOpen = false;
  if (phase(entry.game) === "place") {
    ui.view = "place";
    ui.sel = null;
    ui.carry = null;
    ui.placeCursor = 0;
    renderPlace();
    document.querySelector<HTMLElement>(".ship-btn")?.focus();
    return;
  }
  ui.view = "game";
  ui.tab = phase(entry.game) === "my-turn" || phase(entry.game) === "over" ? "target" : "own";
  ui.cursorTarget = firstFree(entry.game);
  ui.cursorOwn = lastShotAtMe(entry.game) ?? 0;
  renderGame();
  focusCell("target-grid", ui.cursorTarget);
}

function firstFree(g: Game): number {
  const fired = firedBy(g, true);
  for (let c = 0; c < CELLS; c++) if (!fired.has(c)) return c;
  return 0;
}

function renderGame(): void {
  const entry = activeEntry();
  if (!entry) {
    ui.view = "lobby";
    return renderLobby();
  }
  const g = entry.game;
  const name = personName(entry);
  const focusedGrid = document.activeElement?.closest(".grid")?.id ?? null;
  const r = root();
  r.replaceChildren();
  r.className = "view-game";
  const over = phase(g) === "over";

  // Header: back, opponent, score + resign (desktop) / ⋯ (mobile)
  const top = make("div", { cls: "topbar" });
  top.append(backButton(), make("h2", { cls: "title", text: entry.opponentName }));
  top.append(make("span", { cls: "spacer" }));
  const score = t("battle.score", { mine: hitsByMe(g), theirs: hitsOnMe(g), name });
  top.append(make("span", { cls: "chip desk-only", text: score }));
  if (!over && g.root) {
    top.append(button(t("btn.resign"), "ghost danger desk-only", () => void onResign(entry)));
    top.append(
      button("⋯", "ghost mob-only", () => {
        ui.moreOpen = !ui.moreOpen;
        renderGame();
      }, { "aria-label": t("btn.moreLabel"), "aria-expanded": ui.moreOpen ? "true" : "false" }),
    );
  }
  r.appendChild(top);
  if (ui.moreOpen && !over) {
    const more = make("div", { cls: "more mob-only-block" });
    more.append(make("span", { cls: "chip", text: score }), button(t("btn.resign"), "ghost danger", () => void onResign(entry)));
    r.appendChild(more);
  }

  // Verdict (end) or status line
  const verdict = verdictFor(entry);
  if (verdict) {
    const card = make("div", { cls: `card verdict ${verdict.tone}`, attrs: { role: verdict.tone === "bad" ? "alert" : "status" } });
    card.append(make("div", { cls: "icon", text: verdict.tone === "bad" ? "⚠" : verdict.tone === "ok" ? "✓" : "•", attrs: { "aria-hidden": "true" } }));
    const body = make("div");
    body.append(make("div", { cls: "verdict-title", text: verdict.title }));
    verdict.lines.forEach((l, i) => body.append(make("div", { cls: i > 0 ? "muted small" : "", text: l })));
    if (verdict.checks.length) {
      const ul = make("ul", { cls: "checks muted small" });
      for (const c of verdict.checks) ul.append(make("li", { text: c }));
      body.append(ul);
    }
    card.append(body);
    r.appendChild(card);
  } else {
    const st = statusFor(entry);
    const status = make("div", { cls: "status" });
    status.append(make("div", { cls: "big", text: st.title }));
    if (st.detail) status.append(make("div", { cls: "muted", text: st.detail }));
    r.appendChild(status);
  }
  if (g.outOfStep >= 3 && !over) {
    const warn = make("div", { cls: "card warn", attrs: { role: "status" } });
    warn.append(make("strong", { text: t("battle.outOfStep", { name }) }), make("p", { cls: "small", text: t("battle.outOfStepBody", { name }) }));
    warn.append(button(t("btn.resign"), "danger", () => void onResign(entry)));
    r.appendChild(warn);
  }

  // Mobile tabs
  const hitsOnMine = hitsOnMe(g);
  const tabs = make("div", { cls: "tabs", attrs: { role: "tablist", "aria-label": t("battle.boards") } });
  const mkTab = (id: "target" | "own", text: string) => {
    const b = make("button", {
      cls: "tab",
      text,
      attrs: { type: "button", role: "tab", "aria-selected": ui.tab === id ? "true" : "false", "aria-controls": `pane-${id}` },
    });
    b.addEventListener("click", () => {
      ui.tab = id;
      renderGame();
    });
    return b;
  };
  tabs.append(
    mkTab("target", over && g.theirReveal ? t("end.theirFleet", { name }) : t("battle.theirWaters", { name })),
    mkTab("own", hitsOnMine > 0 ? t("battle.yourFleetHits", { n: hitsOnMine }) : t("battle.yourFleet")),
  );
  r.appendChild(tabs);

  const boards = make("div", { cls: "boards", attrs: { "data-tab": ui.tab } });
  boards.appendChild(targetPane(entry));
  boards.appendChild(ownPane(entry));
  attachSwipe(boards);
  r.appendChild(boards);

  // Fire bar / end actions
  const bar = make("div", { cls: phase(g) === "my-turn" ? "firebar playing" : "firebar" });
  if (over) {
    bar.append(button(t("btn.rematch"), "primary", () => startNewGame(contactFor(entry))), button(t("btn.backToGames"), "", toLobby));
  } else if (phase(g) === "my-turn") {
    const label = ui.aim === null ? t("battle.pickFirst") : t("battle.fireAt", { cell: cellName(ui.aim) });
    const fireBtn = button(label, "primary fire", () => void onFire(entry), { "data-fire": "" });
    if (ui.aim === null) fireBtn.disabled = true;
    bar.append(fireBtn);
  } else if (isAwaitingOpponent(entry)) {
    bar.append(button(t("btn.cancelInvite"), "ghost", () => void cancelInvite(entry)));
  }
  r.appendChild(bar);
  if (!over) r.appendChild(make("p", { cls: "muted small center desk-only", text: t("battle.hint") }));
  if (g.root && g.leaves) {
    const fp = fromB64url(g.root, 32);
    if (fp) r.appendChild(make("p", { cls: "muted tiny center seal", text: `Seal ${fingerprint(fp)}` }));
  }

  if (focusedGrid === "target-grid") focusCell("target-grid", ui.cursorTarget);
  else if (focusedGrid === "own-grid") focusCell("own-grid", ui.cursorOwn);
}

function targetPane(entry: GameEntry): HTMLElement {
  const g = entry.game;
  const name = personName(entry);
  const over = phase(g) === "over";
  const sec = make("section", { cls: "pane", attrs: { id: "pane-target", role: "tabpanel", "data-pane": "target" } });
  const h = make("h3", { cls: "pane-title desk-only-block" });
  h.append(
    over && g.theirReveal ? t("end.theirFleet", { name }) : t("battle.theirWaters", { name }),
    " ",
    make("span", { cls: "muted small", text: over ? (g.theirReveal ? t("end.revealed") : t("end.notRevealed")) : t("battle.whereYouFire") }),
  );
  sec.appendChild(h);
  const view = targetBoard(g);
  const revealed = revealedBoard(g);
  const ends = g.theirReveal ? shipEnds(g.theirReveal.fleet) : new Map<number, string>();
  const myTurn = phase(g) === "my-turn";
  const lie = lieAt(g);
  sec.appendChild(
    buildBoard({
      id: "target-grid",
      label: t("battle.theirWaters", { name }),
      cursor: ui.cursorTarget,
      extraCls: myTurn ? "aimable" : "",
      cell: (c) => {
        const v = view[c];
        const cls: string[] = [];
        if (revealed && revealed[c].ship >= 0) {
          cls.push("ship");
          if (ends.has(c)) cls.push(ends.get(c)!);
        }
        if (lie === c) cls.push("lie");
        else if (v.kind !== "none") cls.push(v.kind);
        if (ui.aim === c) cls.push("aim");
        return { cls, label: targetCellLabel(g, c, name, ui.aim === c) };
      },
      onActivate: (c) => aimAt(entry, c, false),
      onKey: (ev, c) => targetKey(ev, c, entry),
    }),
  );
  // Their fleet: chips, sunk ones struck through.
  const sunk = theirSunk(g);
  const chips = make("ul", { cls: "fleet-chips", attrs: { "aria-label": t("battle.theirFleetLabel", { name }) } });
  SHIPS.forEach((s, i) => {
    const isSunk = sunk.has(i);
    const li = make("li", {
      cls: `chip${isSunk ? " sunk" : ""}`,
      attrs: { "aria-label": t(isSunk ? "battle.shipSunk" : "battle.shipAfloat", { ship: shipTitle(i) }) },
    });
    li.append(make("span", { cls: "chip-name", text: shipTitle(i), attrs: { "aria-hidden": "true" } }), pips(s.len, isSunk));
    chips.appendChild(li);
  });
  sec.appendChild(chips);
  return sec;
}

function ownPane(entry: GameEntry): HTMLElement {
  const g = entry.game;
  const name = personName(entry);
  const sec = make("section", { cls: "pane", attrs: { id: "pane-own", role: "tabpanel", "data-pane": "own" } });
  const h = make("h3", { cls: "pane-title desk-only-block" });
  h.append(t("battle.yourFleet"), " ", make("span", { cls: "muted small", text: t("battle.whereTheyFire", { name }) }));
  sec.appendChild(h);
  const board = ownBoard(g);
  const ends = shipEnds(g.fleet);
  const last = lastShotAtMe(g);
  sec.appendChild(
    buildBoard({
      id: "own-grid",
      label: t("battle.yourFleetLabel"),
      cursor: ui.cursorOwn,
      cell: (c) => {
        const v = board[c];
        const cls: string[] = [];
        if (v.ship >= 0) {
          cls.push("ship");
          if (ends.has(c)) cls.push(ends.get(c)!);
        }
        if (v.shot !== "none") cls.push(v.shot);
        if (last === c) cls.push("last");
        return { cls, label: ownCellLabel(g, c, name) };
      },
      onKey: (ev, c) => {
        if (!isNavKey(ev.key)) return;
        ev.preventDefault();
        const next = moveCursor(c, ev.key, ev.ctrlKey || ev.metaKey);
        moveFocus("own-grid", c, next);
        ui.cursorOwn = next;
      },
    }),
  );
  const hits = ownHits(g);
  const chips = make("ul", { cls: "fleet-chips", attrs: { "aria-label": t("battle.yourFleetLabel") } });
  SHIPS.forEach((s, i) => {
    const isSunk = hits[i] >= s.len;
    chips.appendChild(make("li", { cls: `chip${isSunk ? " sunk" : ""}`, text: t("battle.shipHits", { ship: shipTitle(i), hit: hits[i], len: s.len }) }));
  });
  sec.appendChild(chips);
  return sec;
}

function attachSwipe(el: HTMLElement): void {
  let x0 = 0;
  let y0 = 0;
  el.addEventListener("touchstart", (ev) => {
    x0 = ev.touches[0].clientX;
    y0 = ev.touches[0].clientY;
  }, { passive: true });
  el.addEventListener("touchend", (ev) => {
    const dx = ev.changedTouches[0].clientX - x0;
    const dy = ev.changedTouches[0].clientY - y0;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 40) return;
    const rtl = document.documentElement.dir === "rtl";
    const toOwn = rtl ? dx > 0 : dx < 0;
    const next = toOwn ? "own" : "target";
    if (next !== ui.tab) {
      ui.tab = next;
      renderGame();
    }
  });
}

/** Aim at a square (click, or Enter); Enter on the aimed square fires. */
function aimAt(entry: GameEntry, cell: number, fromKey: boolean): void {
  const g = entry.game;
  ui.cursorTarget = cell;
  const p = phase(g);
  if (p !== "my-turn") {
    if (p === "their-turn") say(t("aim.notTurn", { name: personName(entry) }));
    else if (p === "wait-seal") say(t("aim.notYet", { name: personName(entry) }));
    renderGame();
    return;
  }
  if (firedBy(g, true).has(cell)) {
    say(t("aim.already", { cell: cellName(cell) }));
    renderGame();
    return;
  }
  if (fromKey && ui.aim === cell) {
    void onFire(entry);
    return;
  }
  ui.aim = cell;
  say(t("aim.aimed", { cell: cellName(cell) }));
  renderGame();
  if (!fromKey) document.querySelector<HTMLElement>("[data-fire]")?.focus({ preventScroll: true });
}

function targetKey(ev: KeyboardEvent, cell: number, entry: GameEntry): void {
  if (isNavKey(ev.key)) {
    ev.preventDefault();
    const next = moveCursor(cell, ev.key, ev.ctrlKey || ev.metaKey);
    moveFocus("target-grid", cell, next);
    ui.cursorTarget = next;
    return;
  }
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    aimAt(entry, cell, true);
    focusCell("target-grid", ui.cursorTarget);
    return;
  }
  if (ev.key === "Escape" && ui.aim !== null) {
    ev.preventDefault();
    ev.stopPropagation();
    ui.aim = null;
    say(t("aim.cleared"));
    renderGame();
    focusCell("target-grid", cell);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Send our whole game to the opponent (never after the final message). */
async function sendState(entry: GameEntry): Promise<void> {
  if (!canSend(entry.game)) return;
  const msg = buildMessage(entry.game);
  try {
    await client.federation.send(entry.sessionId, targetFor(entry), msg, { turn: passesTurn(entry.game) });
    if (entry.game.outcome) {
      entry.game = markSent(entry.game);
      void persist(entry);
    }
  } catch (err) {
    if (isUnknownGame(err)) {
      void offerContinue(entry);
      return;
    }
    console.warn("battleships.send_failed", { session_id: entry.sessionId });
    toast(t("toast.couldntReach", { name: personName(entry) }));
  }
}

async function lockAndInvite(): Promise<void> {
  const fleet = ui.draft;
  if (!isLegalFleet(fleet)) return placeBad();
  let picked: PickedPerson[];
  try {
    const s = ui.suggest;
    picked = await client.people.pick({
      purpose: "play",
      max: 1,
      ...(s ? { suggest: { instance_id: s.instance_id, user_ref: s.user_ref, is_local: s.is_local } } : {}),
    });
  } catch (err) {
    const f = pickFailure(err);
    if (f.kind === "toast") toast(f.message);
    return;
  }
  const p = picked[0];
  if (!p) return; // cancelled: the draft stays
  const game = lockIn(newGame(p.sessionId, "challenger", fleet), newSeed());
  const entry = entryForPicked(p, game);
  ui.games.set(entry.sessionId, entry);
  ui.lastFleet = fleet;
  ui.draft = randomFleet(rng);
  if (draftTimer) clearTimeout(draftTimer);
  await Promise.all([
    persist(entry),
    client.store.set("lastFleet", fleet).catch(() => {}),
    client.store.delete("draft").catch(() => {}),
  ]);
  ui.contacts = await client.contacts().catch(() => ui.contacts);
  openGame(entry.sessionId);
  await withGame(entry.sessionId, () => sendState(entry));
}

async function lockInvitee(entry: GameEntry): Promise<void> {
  await withGame(entry.sessionId, async () => {
    if (entry.game.root) return;
    entry.game = lockIn(entry.game, newSeed());
    ui.lastFleet = entry.game.fleet;
    void persist(entry);
    void client.store.set("lastFleet", entry.game.fleet).catch(() => {});
    openGame(entry.sessionId);
    // Without the challenger's seal yet, send ours so theirs comes back.
    if (!entry.game.theirLeaves) await sendState(entry);
  });
}

async function onFire(entry: GameEntry): Promise<void> {
  const cell = ui.aim;
  if (cell === null) return;
  await withGame(entry.sessionId, async () => {
    if (phase(entry.game) !== "my-turn" || firedBy(entry.game, true).has(cell)) return;
    entry.game = fire(entry.game, cell);
    ui.aim = null;
    ui.cursorTarget = cell;
    if (ui.active === entry.sessionId && ui.view === "game") {
      renderGame();
      if (!ui.reducedMotion) splash(cell);
      focusCell("target-grid", cell);
    }
    // Our own shot is saved before it goes out: a reopened app must know
    // every shot the other side has seen from us (it can work out its
    // answers again, but never its shots).
    await persist(entry);
    await sendState(entry);
  });
}

function splash(cell: number): void {
  const el = document.querySelector<HTMLElement>(`#target-grid [data-cell="${cell}"]`);
  el?.classList.add("splash");
}

async function onResign(entry: GameEntry): Promise<void> {
  if (!(await confirmDialog(resignCopy(entry)))) return;
  await withGame(entry.sessionId, async () => {
    if (entry.game.outcome) return;
    entry.game = resign(entry.game);
    ui.moreOpen = false;
    await persist(entry);
    render();
    await sendState(entry);
  });
}

async function removeGame(entry: GameEntry): Promise<void> {
  if (!(await confirmDialog(removeCopy(entry)))) return;
  await dropGame(entry.sessionId);
  document.querySelector<HTMLElement>("[data-new-game]")?.focus();
}

async function dropGame(sid: string): Promise<void> {
  ui.games.delete(sid);
  if (ui.active === sid) {
    ui.active = null;
    ui.view = "lobby";
  }
  await client.store.delete(PREFIX + sid).catch(() => {});
  render();
}

async function cancelInvite(entry: GameEntry): Promise<void> {
  try {
    await client.federation.cancelSession(entry.sessionId, targetFor(entry));
    toast(t("toast.inviteCancelled", { name: personName(entry) }));
  } catch {
    toast(t("toast.inviteMayShow", { name: personName(entry) }));
  }
  await dropGame(entry.sessionId);
}

/** "Continue game with Ben": Social Home's sheet re-registers the game, then our state goes out again. */
async function offerContinue(entry: GameEntry): Promise<void> {
  if (!(await confirmDialog(continueCopy(entry)))) return;
  let picked: PickedPerson[];
  try {
    picked = await client.people.pick({ purpose: "continue", sessionId: entry.sessionId, suggest: targetFor(entry) });
  } catch (err) {
    const f = pickFailure(err);
    if (f.kind === "toast") toast(f.message);
    return;
  }
  if (!picked.some((p) => p.sessionId === entry.sessionId)) return;
  try {
    await client.federation.send(entry.sessionId, targetFor(entry), buildMessage(entry.game), { turn: passesTurn(entry.game) });
    entry.game = markSent(entry.game);
    void persist(entry);
    toast(t("toast.askedContinue", { name: personName(entry) }));
  } catch {
    toast(t("toast.couldntReach", { name: personName(entry) }));
  }
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

function onInboundMessage(msg: AppMessage): void {
  if (!isBsMessage(msg.payload)) return;
  const route = routeInbound(msg, ui.games);
  if (route.kind === "drop") {
    console.warn("battleships.inbound_dropped", { session_id: msg.sessionId, reason: route.reason });
    return;
  }
  const entry = route.entry;
  void withGame(entry.sessionId, () => takeMessage(entry, msg.payload));
}

async function takeMessage(entry: GameEntry, payload: unknown): Promise<void> {
  let v = receive(entry.game, payload);
  if (v.kind === "refuse" && v.reason === "ahead") {
    // This screen may be behind our own store (the same person played on another screen).
    const stored = parseEntry(await client.store.get(PREFIX + entry.sessionId).catch(() => null));
    if (stored && stored.game.shots.length > entry.game.shots.length) {
      entry.game = stored.game;
      v = receive(entry.game, payload);
    }
  }
  const shown = ui.active === entry.sessionId;
  switch (v.kind) {
    case "stale":
      return;
    case "unsupported":
      if (!ui.unsupportedShown.has(entry.sessionId)) {
        ui.unsupportedShown.add(entry.sessionId);
        toast(t("toast.unsupported", { name: personName(entry) }));
      }
      return;
    case "refuse":
      console.warn("battleships.inbound_refused", { session_id: entry.sessionId, reason: v.reason });
      entry.game = { ...entry.game, outOfStep: entry.game.outOfStep + 1 };
      void persist(entry);
      if (shown) render();
      return;
    case "update": {
      const before = phase(entry.game);
      entry.game = v.game;
      void persist(entry);
      const words = announce(v.events, entry);
      if (shown && ui.view === "game") {
        for (const s of words.polite) say(s);
        for (const s of words.assertive) alertNow(s);
        if (before !== "my-turn" && phase(entry.game) === "my-turn") ui.tab = "target";
        renderGame();
        if (!ui.reducedMotion) pulseLast(entry);
      } else {
        if (v.events.some((e) => e.type === "fired" || e.type === "over")) toast(t("toast.newsIn", { name: personName(entry) }));
        render();
      }
      if (v.reply) await sendState(entry);
      return;
    }
  }
}

function pulseLast(entry: GameEntry): void {
  const last = lastShotAtMe(entry.game);
  if (last !== null) document.querySelector(`#own-grid [data-cell="${last}"]`)?.classList.add("splash");
}

function onInboundSession(msg: AppMessage): void {
  const action = classifySessionEvent(msg, ui.games, { liveInvites: ui.liveInvites, selfUserId: ui.selfUserId });
  switch (action.kind) {
    case "declined":
      toast(t("invite.declined", { name: personName(action.entry) }));
      void dropGame(action.entry.sessionId);
      return;
    case "withdrawn":
      toast(t("invite.withdrawn", { name: personName(action.entry) }));
      void dropGame(action.entry.sessionId);
      return;
    case "ended":
      toast(t("invite.ended", { name: personName(action.entry) }));
      void dropGame(action.entry.sessionId);
      return;
    case "invite":
      seatInvite(msg);
      render();
      return;
    case "ignore":
      return;
  }
}

/** We were invited: a new game where we place our fleet and fire first. */
function seatInvite(invite: AppMessage): GameEntry | null {
  if (ui.games.has(invite.sessionId)) return null;
  const entry = entryForInvite(invite, ui.contacts, newGame(invite.sessionId, "invitee", randomFleet(rng)));
  ui.games.set(entry.sessionId, entry);
  void persist(entry);
  return entry;
}

async function applyHeld(): Promise<void> {
  let held;
  try {
    held = await client.federation.held();
  } catch {
    return;
  }
  for (const msg of held) {
    if (msg.kind === "session") onInboundSession(msg);
    else onInboundMessage(msg);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function onLook(look: AppLook): void {
  applyLook(look, document.documentElement);
  document.title = t("app.docTitle");
  const title = document.getElementById("app-title");
  if (title) title.textContent = t("app.title");
  root().setAttribute("aria-label", t("app.mainLabel"));
  ui.reducedMotion = look.reducedMotion === true;
}

async function main(): Promise<void> {
  client.onMessage(onInboundMessage);
  client.onSession(onInboundSession);
  root().replaceChildren(make("p", { cls: "muted", text: t("app.loading") }));
  try {
    const [ctx] = await Promise.all([client.context({ pullHeld: true }), loadAll()]);
    onLook(ctx);
    client.onContextChange((look) => {
      onLook(look);
      render();
    });
    ui.selfUserId = ctx.selfUserId;
    ui.contacts = await client.contacts().catch(() => []);
    render();

    if (ctx.launch === undefined) {
      // An older Social Home accepts waiting invites on open.
      ui.liveInvites = true;
      for (const invite of await client.federation.pendingSessions().catch(() => [])) onInboundSession(invite);
      render();
    } else {
      const launch = launchAction(ctx.launch, ui.games);
      if (launch.kind === "start") {
        const entry = seatInvite(launch.invite);
        if (entry) openGame(entry.sessionId);
      } else if (launch.kind === "open") openGame(launch.sessionId);
      else if (launch.kind === "gone") toast(t("invite.gone"));
      else if (launch.kind === "mismatch") toast(t("invite.mismatch"));
    }
    await applyHeld();
    // A final message that didn't go out (offline when the game ended): send it now.
    for (const entry of ui.games.values()) {
      if (entry.game.outcome && !entry.game.sentFinal && entry.game.root) void withGame(entry.sessionId, () => sendState(entry));
    }
  } catch (err) {
    console.error("battleships.init_failed", err);
    root().replaceChildren(make("p", { cls: "error", text: t("app.loadFailed") }));
  }
}

if (typeof window !== "undefined" && sh) void main();
