/**
 * Backgammon — the UI and its life cycle (the engine is pure and tested:
 * rules, dice, game, inbound; the words: view, i18n).
 *
 *  - `ui.games` Map<sessionId, GameEntry>, kept per person in `sh.store`
 *    under "game:<sessionId>" (with this side's secret dice seed); the
 *    new-game choices under "pref:color", "pref:cube" and "pref:days".
 *  - Views: lobby (new game + games), game (board, cube, the end).
 *  - A turn is built on the board (tap or drag a checker, then a target;
 *    Undo) and sent whole with Done. A roll that can't be played passes by
 *    itself, with the reason said.
 *  - Every message carries the whole game. Inbound messages are judged by
 *    `judgeInbound`; work on one game is serialized (`withGame`) so live and
 *    held copies never race. Some steps are the app's own, never a
 *    person's: answering an invite with our dice tip, showing our link for
 *    the opening roll, passing a roll that can't be played.
 *  - Nothing new is sent after a game's final step: a retry only sends the
 *    same final log again.
 */

import sh, { ShError } from "@socialhome/app-sdk";
import type { AppLook, AppMessage, Contact, GroupEvent, GroupMessage, GroupSession, PickedPerson } from "@socialhome/app-sdk";
import { BAR, MAX_CUBE, OFF, other, flatten, nextSteps, targetsFrom, turnNeed, diceToPlay, without } from "./rules.js";
import type { Board, Color, Step } from "./rules.js";
import {
  applyEntry,
  autoEntry,
  boardAfter,
  canDouble,
  canSwitchAuto,
  isResign,
  isTimeout,
  mustPass,
  passReason,
  resignBy,
  resignResult,
  timeoutOf,
} from "./game.js";
import type { Entry, GameState, Setup } from "./game.js";
import { newSeed, toB64url } from "./dice.js";
import { CLOCK_DAYS, buildMessage, catchUpFromOwnCopy, isBgMessage, isClockDays } from "./inbound.js";
import type { MessageExtras } from "./inbound.js";
import { decideClaim, markFor } from "./clock.js";
import {
  canClaim,
  chainOf,
  classifySessionEvent,
  clockOf,
  continueCopy,
  declineCopy,
  diceOf,
  entryForInvite,
  entryForPicked,
  hasPendingClaim,
  isAwaitingOpponent,
  isMyTurn,
  isUnknownGame,
  launchAction,
  ownSideOf,
  adoptOwnCopy,
  parseEntry,
  personName,
  pickFailure,
  rematchOf,
  remember,
  removeCopy,
  resignCopy,
  resolveColor,
  routeInbound,
  showClaimOffer,
  stateOf,
  targetFor,
  toStored,
} from "./lifecycle.js";
import type { ColorChoice, ConfirmCopy, GameEntry } from "./lifecycle.js";
import { groupGames } from "./lobby.js";
import { prefSaver } from "./prefs.js";
import {
  announceInbound,
  announceStep,
  cellCounts,
  cellLabel,
  chipFor,
  clockName,
  colorName,
  metaFor,
  opponentLabel,
  passText,
  pipsText,
  pointsBreakdown,
  resultLine,
  seen,
  statusFor,
  timeLeftText,
} from "./view.js";
import { ROWS, THEIR_BAR, THEIR_OFF, isNavKey, isPointId, moveCursor } from "./board-nav.js";
import { createAnnouncer } from "./announcer.js";
import type { Announcer } from "./announcer.js";
import { t } from "./i18n.js";
import type { MessageKey } from "./i18n.js";
import { applyLook } from "./look.js";
import {
  canCloseTable,
  classifyTableEvent,
  entryForTable,
  handsTurn,
  isPlayableTable,
  isWaitingForPlayer,
  judgeGame,
  parseSavedGame,
  routeTableMessage,
  tableColor,
  tableRole,
  updateFromTable,
} from "./table.js";
import type { TableAction } from "./table.js";

const client = sh as NonNullable<typeof sh>;
/** Lobby choices: saved in order per key, the last change wins (prefs.ts). */
const savePref = prefSaver(
  (key, value) => client.store.set(key, value),
  (key) => console.warn("backgammon.pref_save_failed", { key }),
);

type View = "lobby" | "game";

interface UI {
  view: View;
  active: string | null;
  selfUserId: string;
  contacts: Contact[];
  games: Map<string, GameEntry>;
  colorChoice: ColorChoice;
  cube: boolean;
  days: number;
  /** This person rolls without being asked (gives up doubling) in every game with the cube. */
  autoRoll: boolean;
  /** Board: the focused place, the picked checker, the turn built so far (for log length `partialAt`). */
  cursor: number;
  selected: number | null;
  partial: Step[];
  partialAt: number;
  hint: string | null;
  liveInvites: boolean;
  reducedMotion: boolean;
  unsupportedShown: Set<string>;
  /** This Social Home has open games in spaces (`sh.group`, SDK 1.9). */
  groups: boolean;
  /** Join opened Backgammon for this table before our seat was confirmed: open it once seated. */
  launchTable: string | null;
}

const ui: UI = {
  view: "lobby",
  active: null,
  selfUserId: "",
  contacts: [],
  games: new Map(),
  colorChoice: "random",
  cube: true,
  days: 0,
  autoRoll: false,
  cursor: 24,
  selected: null,
  partial: [],
  partialAt: -1,
  hint: null,
  liveInvites: false,
  reducedMotion: false,
  unsupportedShown: new Set(),
  groups: false,
  launchTable: null,
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const PREFIX = "game:";
const PREF_COLOR = "pref:color";
const PREF_CUBE = "pref:cube";
const PREF_DAYS = "pref:days";
const PREF_AUTO = "pref:autoroll";

const writes = new Map<string, Promise<void>>();
const queued = new Set<string>();

/**
 * Save a game in the background. Writes of one game are serialized and
 * coalesced, and a refused write (Social Home allows 60 app calls a minute
 * per person) is retried. The copy in memory is the one that plays.
 */
function persist(entry: GameEntry): Promise<void> {
  const sid = entry.sessionId;
  if (queued.has(sid)) return writes.get(sid)!;
  queued.add(sid);
  const next = (writes.get(sid) ?? Promise.resolve()).then(async () => {
    queued.delete(sid);
    for (let attempt = 0; ; attempt++) {
      try {
        await client.store.set(PREFIX + sid, toStored(entry));
        return;
      } catch (err) {
        if (attempt >= 8) {
          console.warn("backgammon.persist_failed", { session_id: sid });
          return;
        }
        const backoff = Math.min(15_000, 2000 * (attempt + 1));
        const wait = err instanceof ShError && err.retryAfterMs ? Math.max(err.retryAfterMs, backoff) : backoff;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  });
  writes.set(sid, next);
  return next;
}

async function loadAll(): Promise<void> {
  const all = await client.store.list();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PREFIX)) {
      const entry = parseSavedGame(value);
      if (!entry) continue;
      ui.games.set(entry.sessionId, entry);
      // A clock without a mark for this position starts counting now (never earlier).
      if (entry.setup && entry.setup.days > 0 && entry.clockFrom?.n !== entry.log.length) {
        entry.clockFrom = markFor(entry.clockFrom, entry.log.length, Date.now());
        void persist(entry);
      }
    } else if (key === PREF_COLOR && (value === "w" || value === "b" || value === "random")) {
      ui.colorChoice = value;
    } else if (key === PREF_CUBE && typeof value === "boolean") {
      ui.cube = value;
    } else if (key === PREF_DAYS && isClockDays(value)) {
      ui.days = value;
    } else if (key === PREF_AUTO && typeof value === "boolean") {
      ui.autoRoll = value;
    }
  }
}

/** One game's work at a time: live, held and local steps never race. */
const queues = new Map<string, Promise<void>>();
function withGame(sid: string, fn: () => Promise<void>): Promise<void> {
  const prev = queues.get(sid) ?? Promise.resolve();
  const next = prev.then(fn).catch((err) => console.error("backgammon.game_step_failed", err));
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

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, cls: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = make("button", { cls: `btn ${cls}`.trim(), text, attrs: { type: "button", ...attrs } });
  b.addEventListener("click", onClick);
  return b;
}

let polite: Announcer | null = null;

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
    dlg.append(make("h2", { text: copy.title, attrs: { id: "confirm-title" } }), make("p", { text: copy.body, attrs: { id: "confirm-body" } }));
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
      if (back?.isConnected) back.focus();
      resolve(ok);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    cancel.focus();
  });
}

function root(): HTMLElement {
  return document.getElementById("app-root")!;
}

function render(): void {
  if (ui.view === "game") renderGame();
  else renderLobby();
}

let lastOffers = "";
function offersKey(now: number): string {
  return [...ui.games.values()]
    .filter((g) => (g.setup?.days ?? 0) > 0)
    .map((g) => `${g.sessionId}:${canClaim(g, now)}:${clockOf(g, now)?.expired ?? ""}`)
    .join("|");
}

function drawnClocks(): void {
  lastOffers = offersKey(Date.now());
}

function activeEntry(): GameEntry | null {
  return ui.active ? (ui.games.get(ui.active) ?? null) : null;
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function choiceGroup<T extends string>(
  legend: string,
  name: string,
  options: [T, string][],
  current: T,
  onPick: (v: T) => void,
  swatch?: (v: T) => Element | null,
): HTMLElement {
  const group = make("fieldset", { cls: "choice" });
  group.appendChild(make("legend", { text: legend }));
  const row = make("div", { cls: "choice-row" });
  for (const [value, label] of options) {
    const id = `${name}-${value}`;
    const input = make("input", { attrs: { type: "radio", name, id, value } });
    input.checked = current === value;
    input.addEventListener("change", () => onPick(value));
    const lab = make("label", { attrs: { for: id } });
    const sw = swatch?.(value);
    if (sw) lab.appendChild(sw);
    lab.append(label);
    row.append(input, lab);
  }
  group.appendChild(row);
  return group;
}

/** A small checker: White with a ring, Black with a dot — told apart by shape too, never by colour alone. */
function checkerIcon(c: Color | "random"): SVGElement {
  const s = svg("svg", { viewBox: "0 0 20 20", class: "chk-icon", "aria-hidden": "true", focusable: "false" });
  const one = (col: Color, clip?: string) => {
    const g = svg("g", clip ? { "clip-path": clip } : {});
    g.appendChild(svg("circle", { cx: 10, cy: 10, r: 8.5, class: `ck ck-${col}` }));
    g.appendChild(col === "w" ? svg("circle", { cx: 10, cy: 10, r: 4.6, class: "ck-mark ck-ring" }) : svg("circle", { cx: 10, cy: 10, r: 2.6, class: "ck-mark ck-dot" }));
    return g;
  };
  if (c === "random") {
    const defs = svg("defs", {});
    const left = svg("clipPath", { id: "half-l" });
    left.appendChild(svg("rect", { x: 0, y: 0, width: 10, height: 20 }));
    const right = svg("clipPath", { id: "half-r" });
    right.appendChild(svg("rect", { x: 10, y: 0, width: 10, height: 20 }));
    defs.append(left, right);
    s.append(defs, one("w", "url(#half-l)"), one("b", "url(#half-r)"));
  } else {
    s.appendChild(one(c));
  }
  return s;
}

function renderLobby(): void {
  const r = root();
  r.replaceChildren();
  r.className = "view-lobby";
  drawnClocks();

  const card = make("section", { cls: "card new-game", attrs: { "aria-labelledby": "new-game-title" } });
  card.appendChild(make("h2", { cls: "section-title", text: t("lobby.newGame"), attrs: { id: "new-game-title" } }));
  card.appendChild(make("p", { cls: "muted small", text: t("lobby.hint") }));
  const colors: [ColorChoice, string][] = [
    ["random", t("color.random")],
    ["w", t("color.w")],
    ["b", t("color.b")],
  ];
  card.appendChild(
    choiceGroup(t("newGame.playAs"), "color", colors, ui.colorChoice, (v) => {
      ui.colorChoice = v;
      void savePref(PREF_COLOR, v);
    }, checkerIcon),
  );
  card.appendChild(setupFields());
  card.appendChild(
    button(t("btn.newGame"), "primary wide", () => void startNewGame(null, resolveColor(ui.colorChoice), ui.cube, ui.days), {
      "data-new-game": "",
    }),
  );
  r.appendChild(card);

  const groups = groupGames(ui.games.values());
  if (ui.games.size === 0) {
    r.appendChild(make("h2", { cls: "section-title", text: t("lobby.games") }));
    r.appendChild(make("p", { cls: "empty muted", text: t("lobby.empty") }));
  }
  const section = (title: MessageKey, list: GameEntry[]) => {
    if (list.length === 0) return;
    const id = `sec-${title}`;
    const s = make("section", { attrs: { "aria-labelledby": id } });
    s.appendChild(make("h2", { cls: "section-title", text: t(title), attrs: { id } }));
    const ul = make("ul", { cls: "game-list" });
    for (const e of list) ul.appendChild(gameCard(e));
    s.appendChild(ul);
    r.appendChild(s);
  };
  section("lobby.yourTurn", groups.yourTurn);
  section("lobby.waiting", groups.waiting);
  section("lobby.finished", groups.finished);

  const played = ui.contacts.filter((c) => c.user_ref !== ui.selfUserId);
  if (played.length > 0) {
    r.appendChild(make("h2", { cls: "section-title", text: t("lobby.playedBefore") }));
    const list = make("ul", { cls: "people" });
    for (const c of played) {
      const li = make("li", { cls: "card person" });
      li.append(make("span", { cls: "who", text: c.display_name }));
      li.append(
        button(t("btn.rematch"), "", () => void startNewGame(c, resolveColor(ui.colorChoice), ui.cube, ui.days), {
          "aria-label": t("btn.rematchWho", { name: c.display_name }),
        }),
      );
      list.appendChild(li);
    }
    r.appendChild(list);
  }
}

/** Doubling cube (a switch) and clock (a native select), each with a one-line explanation. */
function setupFields(): HTMLElement {
  const pair = make("div", { cls: "setup-pair" });

  const cubeField = make("div", { cls: "field" });
  const cubeBox = make("input", { attrs: { type: "checkbox", id: "cube", role: "switch", "aria-describedby": "cube-explain" } });
  cubeBox.checked = ui.cube;
  const cubeExplain = make("p", { cls: "explain muted small", attrs: { id: "cube-explain" } });
  const explainCube = () => (cubeExplain.textContent = ui.cube ? t("cube.explainOn") : t("cube.explainOff"));
  explainCube();
  cubeBox.addEventListener("change", () => {
    ui.cube = cubeBox.checked;
    void savePref(PREF_CUBE, ui.cube);
    explainCube();
  });
  const cubeLabel = make("label", { cls: "switch", attrs: { for: "cube" } });
  cubeLabel.append(cubeBox, make("span", { cls: "switch-track", attrs: { "aria-hidden": "true" } }), make("span", { text: t("newGame.cube") }));
  cubeField.append(cubeLabel, cubeExplain);

  const cField = make("div", { cls: "field" });
  const cSel = make("select", { attrs: { id: "clock", "aria-describedby": "clock-explain" } });
  for (const d of CLOCK_DAYS) {
    const o = make("option", { text: d === 0 ? t("clock.none") : clockName(d), attrs: { value: String(d) } });
    o.selected = d === ui.days;
    cSel.appendChild(o);
  }
  const cExplain = make("p", { cls: "explain muted small", attrs: { id: "clock-explain" } });
  const explainClock = () => {
    cExplain.textContent = ui.days > 0 ? t("clock.explain") : "";
    cExplain.hidden = ui.days === 0;
  };
  explainClock();
  cSel.addEventListener("change", () => {
    ui.days = Number(cSel.value);
    void savePref(PREF_DAYS, ui.days);
    explainClock();
  });
  cField.append(make("label", { text: t("newGame.clock"), attrs: { for: "clock" } }), cSel, cExplain);

  cubeField.appendChild(autoField("auto-lobby", () => {}));
  pair.append(cubeField, cField);
  return pair;
}

/** "Roll without asking": one choice of this person's for every game with the cube. */
function autoField(id: string, changed: () => void): HTMLElement {
  const field = make("div", { cls: "field auto-field" });
  const box = make("input", { attrs: { type: "checkbox", id, role: "switch", "aria-describedby": `${id}-explain` } });
  box.checked = ui.autoRoll;
  box.addEventListener("change", () => {
    ui.autoRoll = box.checked;
    void savePref(PREF_AUTO, ui.autoRoll);
    changed();
  });
  const label = make("label", { cls: "switch", attrs: { for: id } });
  label.append(box, make("span", { cls: "switch-track", attrs: { "aria-hidden": "true" } }), make("span", { text: t("auto.label") }));
  field.append(label, make("p", { cls: "explain muted small", text: t("auto.explain"), attrs: { id: `${id}-explain` } }));
  return field;
}

/** Switched in a game: say what happens, and roll now if we were being asked. */
function onAutoChanged(entry: GameEntry): void {
  say(t(ui.autoRoll ? "say.autoOn" : "say.autoOff"));
  void withGame(entry.sessionId, async () => {
    await autoAct(entry);
    if (ui.active === entry.sessionId && ui.view === "game") {
      renderGame();
      document.getElementById("auto-game")?.focus();
    }
  });
}

function gameCard(entry: GameEntry): HTMLElement {
  const name = opponentLabel(entry);
  const li = make("li", { cls: "card game" });
  const top = make("div", { cls: "game-top" });
  const icon = entry.myColor ?? (entry.table ? tableColor(entry.table.me) : "random");
  top.append(checkerIcon(icon), make("span", { cls: "who", text: name }));
  const chip = chipFor(entry);
  top.append(make("span", { cls: `chip ${chip.tone}`, text: chip.text, attrs: { "data-chip": entry.sessionId } }));
  li.appendChild(top);
  li.appendChild(make("p", { cls: "muted small meta", text: metaFor(entry) }));
  const acts = make("div", { cls: "acts" });
  const open = () => openGame(entry.sessionId);
  const attrs = { "aria-label": t("btn.openWith", { name }), "data-open": entry.sessionId };
  acts.append(isMyTurn(entry) ? button(t("btn.play"), "primary", open, attrs) : button(t("btn.open"), "", open, attrs));
  if (isAwaitingOpponent(entry)) acts.append(button(t("btn.cancelInvite"), "ghost", () => void cancelInvite(entry)));
  // Our open game in a space: nobody took the seat yet. Close it there.
  if (canCloseTable(entry)) acts.append(closeTableButton(entry));
  if (stateOf(entry)?.phase === "over") {
    // A rematch goes through the invite sheet: not for an open game in a
    // space (Social Home gives an app seats there, never people).
    if (!entry.table) acts.append(button(t("btn.rematch"), "", () => void rematch(entry), { "aria-label": t("btn.rematchWho", { name }) }));
    acts.append(button(t("btn.remove"), "ghost", () => void removeGame(entry), { "aria-label": t("btn.removeWith", { name }) }));
  }
  li.appendChild(acts);
  return li;
}

function closeTableButton(entry: GameEntry): HTMLButtonElement {
  return button(t("btn.closeTable"), "ghost", () => void closeTable(entry), { "aria-label": t("btn.closeTableLabel") });
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

function resetBoardUi(): void {
  ui.selected = null;
  ui.partial = [];
  ui.partialAt = -1;
  ui.hint = null;
}

function toLobby(): void {
  const from = ui.active;
  ui.view = "lobby";
  ui.active = null;
  resetBoardUi();
  polite?.clear();
  renderLobby();
  const back = from ? document.querySelector<HTMLElement>(`[data-open="${CSS.escape(from)}"]`) : null;
  (back ?? document.querySelector<HTMLElement>("[data-new-game]"))?.focus();
}

// ---------------------------------------------------------------------------
// Game view
// ---------------------------------------------------------------------------

function openGame(sid: string): void {
  const entry = ui.games.get(sid);
  if (!entry) return;
  ui.view = "game";
  ui.active = sid;
  resetBoardUi();
  ui.cursor = startCursor(entry);
  renderGame();
  const grid = document.getElementById("board-grid");
  if (grid) focusCell(ui.cursor);
  else document.querySelector<HTMLElement>(".back")?.focus();
  void withGame(sid, () => autoAct(entry));
}

/** Where the cursor starts: our bar when a checker waits there, else our 24-point… the first checker that can move. */
function startCursor(entry: GameEntry): number {
  const st = stateOf(entry);
  if (!st || !entry.myColor) return 24;
  const can = movable(entry, st);
  if (can) {
    const sources = sourcesOf(st, entry.myColor);
    if (sources.length > 0) return sources[0];
  }
  return st.board[entry.myColor][BAR] > 0 ? BAR : 24;
}

/** Whether we are building our turn on the board now. */
function movable(entry: GameEntry, st: GameState): boolean {
  return (st.phase === "play" || st.phase === "start") && st.mover === entry.myColor && st.toMove === entry.myColor && !!st.roll;
}

/** The turn built so far belongs to this position; a new position starts it afresh. */
function syncPartial(entry: GameEntry): void {
  if (ui.partialAt !== entry.log.length) {
    ui.partial = [];
    ui.selected = null;
    ui.partialAt = entry.log.length;
  }
}

function sourcesOf(st: GameState, me: Color): number[] {
  return [...new Set(nextSteps(st.board, me, st.roll!, ui.partial).map((s) => s.from))].sort((a, b) => b - a);
}

function renderGame(): void {
  const entry = activeEntry();
  if (!entry) {
    ui.view = "lobby";
    return renderLobby();
  }
  const st = stateOf(entry);
  const name = personName(entry) || opponentLabel(entry);
  const hadBoardFocus = document.activeElement?.closest("#board-grid") != null;
  const r = root();
  r.replaceChildren();
  r.className = "view-game";
  drawnClocks();

  const top = make("div", { cls: "topbar" });
  const back = make("button", { cls: "btn ghost back", attrs: { type: "button", "aria-label": t("game.backLabel") } });
  back.append(make("span", { cls: "flip-rtl", text: "←", attrs: { "aria-hidden": "true" } }), ` ${t("game.back")}`);
  back.addEventListener("click", toLobby);
  top.append(back, make("h2", { cls: "title", text: opponentLabel(entry) }));
  r.appendChild(top);

  if (!st || !entry.myColor) {
    const s = statusFor(entry);
    const card = make("div", { cls: "card status-card", attrs: { role: "status" } });
    card.append(make("div", { cls: "big", text: s.title }));
    if (s.detail) card.append(make("p", { cls: "muted", text: s.detail }));
    if (isAwaitingOpponent(entry)) {
      const row = make("div", { cls: "row acts" });
      row.append(button(t("btn.cancelInvite"), "ghost", () => void cancelInvite(entry)));
      card.append(row);
    }
    // Our open game, nobody seated yet: no Resign (nobody to resign to), Close instead.
    if (canCloseTable(entry)) {
      const row = make("div", { cls: "row acts" });
      row.append(closeTableButton(entry));
      card.append(row);
    }
    r.appendChild(card);
    return;
  }
  syncPartial(entry);

  const layout = make("div", { cls: "game-layout" });
  const panel = sidePanel(entry, st, name);
  layout.append(panel.info, boardEl(entry, st), panel.lower);
  r.appendChild(layout);
  if (hadBoardFocus) focusCell(ui.cursor);
}

function sidePanel(entry: GameEntry, st: GameState, name: string): { info: HTMLElement; lower: HTMLElement } {
  const side = make("div", { cls: "side info" });
  const lower = make("div", { cls: "side lower" });
  const me = entry.myColor!;
  const them = other(me);
  const board = movable(entry, st) ? boardAfter(st, ui.partial) : st.board;

  // Players: colour, name, borne off (+ the time left of the player to act).
  const clock = clockOf(entry);
  const players = make("ul", { cls: "players", attrs: { "aria-label": t("players.label") } });
  const playerRow = (c: Color, who: string) => {
    const acting = st.phase !== "over" && st.toMove === c;
    const li = make("li", { cls: `player${acting ? " to-move" : ""}` });
    li.append(checkerIcon(c), make("span", { cls: "pname", text: `${who} · ${colorName(c)}` }));
    li.append(make("span", { cls: "caps", text: t("players.off", { n: board[c][OFF] }) }));
    if (clock && clock.who === c) {
      li.append(make("span", { cls: `clock${clock.expired ? " out" : ""}`, text: timeLeftText(clock.leftMs), attrs: { "data-clock": "" } }));
    }
    return li;
  };
  players.append(playerRow(them, name), playerRow(me, t("game.you")));
  side.appendChild(players);
  const facts = make("p", { cls: "setup-line muted small" });
  facts.textContent = [pipsText(board, me, name), cubeText(entry, st)].filter(Boolean).join(" · ");
  side.appendChild(facts);

  if (st.phase === "over") {
    side.appendChild(resultCard(entry, st));
    const row = make("div", { cls: "row acts" });
    if (!entry.table) row.append(button(t("btn.rematch"), "primary", () => void rematch(entry)));
    row.append(button(t("btn.backToGames"), entry.table ? "primary" : "", toLobby));
    lower.appendChild(row);
    lower.appendChild(fairDice());
    return { info: side, lower };
  }

  const s = statusFor(entry);
  const status = make("div", { cls: "status", attrs: { role: "status" } });
  status.append(make("div", { cls: "big", text: s.title }));
  if (s.detail) status.append(make("p", { cls: "muted", text: s.detail }));
  side.appendChild(status);

  if (clock && clock.mine && clock.expired) {
    side.appendChild(make("p", { cls: "card notice small", text: t("claim.mineOut", { name }), attrs: { role: "status" } }));
  }
  if (hasPendingClaim(entry)) {
    side.appendChild(make("p", { cls: "card notice small", text: t("claim.sent", { name }), attrs: { role: "status" } }));
  } else if (showClaimOffer(entry)) {
    const offer = make("div", { cls: "card notice claim-offer", attrs: { role: "region", "aria-labelledby": "claim-title" } });
    offer.append(
      make("p", { cls: "big", text: t("claim.ranOut", { name }), attrs: { id: "claim-title" } }),
      make("p", { cls: "muted small", text: t("claim.ranOutBody", { name }) }),
    );
    const row = make("div", { cls: "row acts" });
    row.append(
      button(t("btn.claim"), "primary", () => void onClaim(entry), { "data-claim": "" }),
      button(t("btn.keepPlaying"), "", () => keepPlaying(entry)),
    );
    offer.appendChild(row);
    side.appendChild(offer);
  }
  if ((entry.outOfStep ?? 0) > 0) {
    side.appendChild(make("p", { cls: "card notice small", text: t("notice.refused", { name }), attrs: { role: "status" } }));
  }
  if (entry.unsent) {
    const bar = make("div", { cls: "card notice unsent", attrs: { role: "alert" } });
    bar.append(make("span", { text: t("unsent.text", { name }) }), button(t("btn.retry"), "primary", () => void retrySend(entry)));
    side.appendChild(bar);
  }

  const acts = make("div", { cls: "row acts turn-acts" });
  if (movable(entry, st)) {
    const need = turnNeed(st.board, me, st.roll!);
    const done = ui.partial.length >= need.count;
    acts.append(
      button(t("btn.undo"), "", () => onUndo(), { "data-undo": "", ...(ui.partial.length === 0 ? { disabled: "" } : {}) }),
      button(t("btn.done"), "primary", () => void onDone(entry), { "data-done": "", ...(done ? {} : { disabled: "" }) }),
    );
    lower.appendChild(acts);
    const hint = ui.hint ?? (done ? t("hint.done") : ui.selected !== null ? t("hint.pickTarget") : t("hint.pickChecker"));
    lower.appendChild(make("p", { cls: "hint small", text: hint, attrs: { id: "turn-hint" } }));
  } else if (canDouble(st) && st.toMove === me && !ui.autoRoll) {
    // Before the roll: roll, or double first (nobody knows the roll yet).
    acts.append(
      button(t("btn.roll"), "primary", () => void onRoll(entry), { "data-roll": "" }),
      button(t("btn.double", { n: Math.min(MAX_CUBE, st.cube.value * 2) }), "", () => void onDouble(entry), { "data-double": "" }),
    );
    lower.appendChild(acts);
    lower.appendChild(make("p", { cls: "muted small", text: t("cube.askHint", { name }), attrs: { id: "turn-hint" } }));
  } else if (st.phase === "cube" && st.toMove === me) {
    acts.append(
      button(t("btn.accept", { n: st.cube.value * 2 }), "primary", () => void onAnswer(entry, "take"), { "data-take": "" }),
      button(t("btn.decline", { n: st.cube.value }), "", () => void onDecline(entry), { "data-drop": "" }),
    );
    lower.appendChild(acts);
    lower.appendChild(make("p", { cls: "muted small", text: t("cube.answerHint", { name }) }));
  } else if (canClaim(entry) && !showClaimOffer(entry)) {
    acts.append(button(t("btn.claim"), "", () => void onClaim(entry), { "data-claim": "" }));
    lower.appendChild(acts);
  } else if (ui.hint) {
    lower.appendChild(make("p", { cls: "hint small", text: ui.hint }));
  }
  if (entry.setup!.cube) lower.appendChild(autoField("auto-game", () => onAutoChanged(entry)));
  if (!isWaitingForPlayer(entry)) lower.appendChild(button(t("btn.resign"), "ghost danger resign", () => void onResign(entry)));
  lower.appendChild(fairDice());
  lower.appendChild(make("p", { cls: "muted small keys", text: t(entry.setup!.days > 0 ? "game.keysClock" : "game.keys") }));
  return { info: side, lower };
}

/** "Cube 2 · yours" / "Cube 4 · Ben's" / "Cube in the middle" / nothing without a cube. */
function cubeText(entry: GameEntry, st: GameState): string {
  if (!entry.setup!.cube) return "";
  const { value, owner } = st.cube;
  if (owner === null) return t("cube.middle", { n: value });
  return owner === entry.myColor ? t("cube.yours", { n: value }) : t("cube.theirs", { n: value, name: personName(entry) });
}

/** The plain-words note on how the dice stay fair (closed by default). */
function fairDice(): HTMLElement {
  const d = make("details", { cls: "fair" });
  d.append(make("summary", { text: t("fair.title") }), make("p", { cls: "muted small", text: t("fair.body") }));
  return d;
}

function resultCard(entry: GameEntry, st: GameState): HTMLElement {
  const r = st.result!;
  const won = r.winner === entry.myColor;
  const tone = r.winner === null ? "" : won ? "good" : "bad";
  const card = make("div", { cls: `card verdict ${tone}`, attrs: { role: "status" } });
  card.append(make("div", { cls: "verdict-title", text: r.winner === null ? t("end.drawTitle") : won ? t("end.won") : t("end.lost") }));
  card.append(make("div", { cls: "verdict-line", text: resultLine(st, entry.myColor!, personName(entry)) ?? "" }));
  const how = pointsBreakdown(st);
  if (how) card.append(make("p", { cls: "muted small", text: how }));
  return card;
}

// ---- The board ------------------------------------------------------------

/** Board geometry in SVG units: 12 points + bar + tray across, two halves of 5 with a band between. */
const G = {
  M: 0.2,
  LBL: 0.55,
  W: 14.9,
  H: 12.1,
  pointW: 1,
  half: 5,
  band: 1,
  r: 0.45,
  stepY: 0.92,
};

/** Left edge and width of a column (0 … 13). */
function colBox(col: number): { x: number; w: number } {
  if (col < 6) return { x: G.M + col, w: 1 };
  if (col === 6) return { x: G.M + 6, w: 1 };
  if (col < 13) return { x: G.M + 7 + (col - 7), w: 1 };
  return { x: G.M + 13.2, w: 1.3 };
}

const yTop = G.LBL;
const yMid = G.LBL + G.half;
const yBottom = G.LBL + 2 * G.half + G.band;

function boardEl(entry: GameEntry, st: GameState): HTMLElement {
  const me = entry.myColor!;
  const them = other(me);
  const name = personName(entry);
  const canMove = movable(entry, st);
  const board: Board = canMove ? boardAfter(st, ui.partial) : st.board;
  const sources = new Set(canMove ? sourcesOf(st, me) : []);
  const targets = canMove && ui.selected !== null ? targetsFrom(st.board, me, st.roll!, ui.partial, ui.selected) : new Map<number, Step[]>();
  // The other player's latest turn, in our numbering.
  const lastFrom = new Set<number>();
  const lastTo = new Set<number>();
  if (st.last && st.last.by === them && ui.partial.length === 0) {
    for (const s of st.last.steps) {
      const f = s.from === BAR ? THEIR_BAR : seen(s.from, them, me);
      const to = s.to === OFF ? THEIR_OFF : seen(s.to, them, me);
      lastFrom.add(f);
      lastTo.add(to);
    }
  }

  const wrap = make("div", { cls: "board-wrap", attrs: { dir: "ltr" } });
  const s = svg("svg", { viewBox: `0 0 ${G.W} ${G.H}`, class: "board-svg", "aria-hidden": "true", focusable: "false" });
  s.appendChild(svg("rect", { x: 0, y: 0, width: G.W, height: G.H, rx: 0.25, class: "bd-frame" }));
  s.appendChild(svg("rect", { x: G.M, y: yTop, width: 13, height: 2 * G.half + G.band, class: "bd-bg" }));
  s.appendChild(svg("rect", { x: G.M + 6, y: yTop, width: 1, height: 2 * G.half + G.band, class: "bd-bar" }));
  const tray = colBox(13);
  s.appendChild(svg("rect", { x: tray.x, y: yTop, width: tray.w, height: G.half, rx: 0.1, class: "bd-tray" }));
  s.appendChild(svg("rect", { x: tray.x, y: yMid + G.band, width: tray.w, height: G.half, rx: 0.1, class: "bd-tray" }));

  // Points: triangles, labels, highlights, checkers.
  ROWS.forEach((row, ri) => {
    row.forEach((id, col) => {
      const { x, w } = colBox(col);
      if (isPointId(id)) {
        const base = ri === 0 ? yTop : yBottom;
        const apex = ri === 0 ? yTop + 4.4 : yBottom - 4.4;
        const shade = (col + ri) % 2 === 0 ? "pt-a" : "pt-b";
        s.appendChild(svg("path", { d: `M${x + 0.04} ${base}L${x + w - 0.04} ${base}L${x + w / 2} ${apex}Z`, class: `pt ${shade}` }));
        const ly = ri === 0 ? G.LBL / 2 : G.H - G.LBL / 2;
        s.appendChild(svg("text", { x: x + w / 2, y: ly, "text-anchor": "middle", "dominant-baseline": "central", class: "bd-label" }, String(id)));
      }
      if (ui.selected === id) {
        const y0 = ri === 0 ? yTop : yMid + G.band;
        s.appendChild(svg("rect", { x: x + 0.05, y: y0 + 0.03, width: w - 0.1, height: G.half - 0.06, rx: 0.12, class: "hl-selected" }));
      }
      drawPlace(s, board, me, id, ri, x, w, {
        target: targets.has(id),
        source: sources.has(id) && ui.selected === null,
        lastFrom: lastFrom.has(id) && !lastTo.has(id),
        lastTo: lastTo.has(id),
      });
    });
  });

  drawDice(s, entry, st);
  if (entry.setup!.cube) drawCube(s, st, me);
  wrap.appendChild(s);

  // The grid overlays the board: one gridcell per place, two rows.
  const grid = make("div", {
    cls: `grid${canMove ? " playable" : ""}`,
    attrs: { role: "grid", id: "board-grid", "aria-label": t("game.boardLabel"), "aria-describedby": "turn-hint" },
  });
  ROWS.forEach((row, ri) => {
    const rowEl = make("div", { cls: "grid-row", attrs: { role: "row" } });
    row.forEach((id, col) => {
      const { x, w } = colBox(col);
      const counts = cellCounts(board, me, id);
      const label = cellLabel(
        {
          id,
          ...counts,
          selected: ui.selected === id,
          target: targets.has(id),
          source: sources.has(id) && ui.selected === null,
          lastFrom: lastFrom.has(id),
          lastTo: lastTo.has(id),
        },
        me,
        name,
      );
      const cell = make("div", {
        cls: `cell${targets.has(id) ? " target" : ""}${sources.has(id) ? " source" : ""}${ui.selected === id ? " selected" : ""}`,
        attrs: { role: "gridcell", "aria-label": label, tabindex: id === ui.cursor ? "0" : "-1", "data-id": String(id) },
      });
      cell.style.left = `${(x / G.W) * 100}%`;
      cell.style.width = `${(w / G.W) * 100}%`;
      cell.style.top = ri === 0 ? "0" : `${((yMid + G.band / 2) / G.H) * 100}%`;
      cell.style.height = `${((yMid + G.band / 2) / G.H) * 100}%`;
      rowEl.appendChild(cell);
    });
    grid.appendChild(rowEl);
  });
  wireBoard(grid, entry);
  wrap.appendChild(grid);
  return wrap;
}

interface Marks {
  target: boolean;
  source: boolean;
  lastFrom: boolean;
  lastTo: boolean;
}

/** The checkers on one place, and its marks. */
function drawPlace(s: SVGElement, board: Board, me: Color, id: number, row: number, x: number, w: number, m: Marks): void {
  const them = other(me);
  const { mine, theirs } = cellCounts(board, me, id);
  const count = mine || theirs;
  const color: Color = mine > 0 ? me : them;
  const cx = x + w / 2;
  if (id === OFF || id === THEIR_OFF) {
    // Borne-off checkers as thin slabs from the outer edge.
    const c: Color = id === OFF ? me : them;
    for (let k = 0; k < count; k++) {
      const y = row === 0 ? yTop + 0.1 + k * 0.3 : yBottom - 0.1 - (k + 1) * 0.3;
      s.appendChild(svg("rect", { x: x + 0.15, y: y + 0.03, width: w - 0.3, height: 0.24, rx: 0.06, class: `slab ck-${c}` }));
    }
    if (count > 0) {
      const ty = row === 0 ? yTop + 0.1 + count * 0.3 + 0.3 : yBottom - 0.1 - count * 0.3 - 0.3;
      s.appendChild(svg("text", { x: cx, y: ty, "text-anchor": "middle", "dominant-baseline": "central", class: "bd-count" }, String(count)));
    }
    if (m.target) s.appendChild(svg("rect", { x: x + 0.06, y: row === 0 ? yTop + 0.04 : yMid + G.band + 0.04, width: w - 0.12, height: G.half - 0.08, rx: 0.12, class: "hl-target" }));
    return;
  }
  const isBar = id === BAR || id === THEIR_BAR;
  // Where the k-th checker sits: from the outer edge for points, from the middle band for the bar.
  const slotY = (k: number): number => {
    if (isBar) return row === 0 ? yMid - 0.55 - k * G.stepY : yMid + G.band + 0.55 + k * G.stepY;
    return row === 0 ? yTop + 0.5 + k * G.stepY : yBottom - 0.5 - k * G.stepY;
  };
  const shown = Math.min(count, isBar ? 4 : 5);
  for (let k = 0; k < shown; k++) {
    drawChecker(s, cx, slotY(k), color, m.source && mine > 0 && k === shown - 1);
  }
  if (count > shown) {
    s.appendChild(svg("text", { x: cx, y: slotY(shown - 1), "text-anchor": "middle", "dominant-baseline": "central", class: `bd-count on-${color}` }, String(count)));
  }
  if (m.target) {
    // A dashed ghost where the checker lands (on a blot: on top of it).
    const k = mine > 0 ? Math.min(mine, 4) : 0;
    s.appendChild(svg("circle", { cx, cy: slotY(k), r: G.r, class: "hl-target ghost" }));
  }
  if (isPointId(id) && (m.lastFrom || m.lastTo)) {
    const y = row === 0 ? yTop - 0.05 : yBottom + 0.05;
    const tip = row === 0 ? y + 0.28 : y - 0.28;
    // Filled arrowhead where they landed, hollow where they left.
    s.appendChild(svg("path", { d: `M${cx - 0.22} ${y}L${cx + 0.22} ${y}L${cx} ${tip}Z`, class: m.lastTo ? "last-mark to" : "last-mark from" }));
  }
}

function drawChecker(s: SVGElement, cx: number, cy: number, c: Color, ring: boolean): void {
  s.appendChild(svg("circle", { cx, cy, r: G.r, class: `ck ck-${c}` }));
  s.appendChild(c === "w" ? svg("circle", { cx, cy, r: 0.25, class: "ck-mark ck-ring" }) : svg("circle", { cx, cy, r: 0.14, class: "ck-mark ck-dot" }));
  if (ring) s.appendChild(svg("circle", { cx, cy, r: G.r + 0.06, class: "hl-source" }));
}

/** The dice in the middle band: ours on our half (right), theirs on theirs (left). */
function drawDice(s: SVGElement, entry: GameEntry, st: GameState): void {
  const me = entry.myColor!;
  let roll: [number, number] | null = null;
  let who: Color | null = null;
  let used: number[] = [];
  let faded = false;
  if (st.phase !== "over" && st.roll && st.mover) {
    roll = st.roll;
    who = st.mover;
    if (movable(entry, st)) used = ui.partial.map((p) => p.die);
  } else if (st.last) {
    roll = st.last.roll;
    who = st.last.by;
    faded = true;
  }
  if (!roll || !who) return;
  const dice = diceToPlay(roll);
  let left = [...dice];
  const states = dice.map(() => false);
  for (const d of used) {
    const i = dice.findIndex((x, j) => x === d && !states[j]);
    if (i >= 0) states[i] = true;
    left = without(left, d);
  }
  const size = dice.length === 4 ? 0.72 : 0.82;
  const gap = 0.14;
  const total = dice.length * size + (dice.length - 1) * gap;
  const centre = who === me ? G.M + 7 + 3 : G.M + 3;
  const y = yMid + (G.band - size) / 2;
  dice.forEach((d, i) => {
    const x = centre - total / 2 + i * (size + gap);
    const g = svg("g", { class: `die${states[i] || faded ? " used" : ""} die-${who}` });
    g.appendChild(svg("rect", { x, y, width: size, height: size, rx: 0.14, class: "die-face" }));
    for (const [px, py] of PIPS[d]) {
      g.appendChild(svg("circle", { cx: x + px * size, cy: y + py * size, r: size * 0.09, class: "die-pip" }));
    }
    if (states[i]) g.appendChild(svg("path", { d: `M${x + 0.08} ${y + size - 0.08}L${x + size - 0.08} ${y + 0.08}`, class: "die-strike" }));
    s.appendChild(g);
  });
}

const PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.27, 0.27], [0.73, 0.73]],
  3: [[0.27, 0.27], [0.5, 0.5], [0.73, 0.73]],
  4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]],
  5: [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]],
  6: [[0.27, 0.25], [0.73, 0.25], [0.27, 0.5], [0.73, 0.5], [0.27, 0.75], [0.73, 0.75]],
};

/** The doubling cube on the bar: in the middle, or nudged to its owner's half. */
function drawCube(s: SVGElement, st: GameState, me: Color): void {
  const size = 0.78;
  const { value, owner } = st.cube;
  const x = G.M + 6 + (1 - size) / 2;
  let y = yMid + (G.band - size) / 2;
  if (owner === me) y += 0.12;
  else if (owner !== null) y -= 0.12;
  const offered = st.phase === "cube";
  const g = svg("g", { class: `cube${offered ? " offered" : ""}` });
  g.appendChild(svg("rect", { x, y, width: size, height: size, rx: 0.12, class: "cube-face" }));
  g.appendChild(svg("text", { x: x + size / 2, y: y + size / 2, "text-anchor": "middle", "dominant-baseline": "central", class: "cube-text" }, String(offered ? value * 2 : owner === null ? 64 : value)));
  s.appendChild(g);
}

// ---- Board input: tap, drag, keys ------------------------------------------

let drag: { from: number; x: number; y: number; moved: boolean } | null = null;
let suppressClick = false;

function wireBoard(grid: HTMLElement, entry: GameEntry): void {
  grid.addEventListener("click", (ev) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (!el) return;
    const id = Number(el.dataset["id"]);
    ui.cursor = id;
    onPlace(entry, id);
  });
  grid.addEventListener("keydown", (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (!el) return;
    const id = Number(el.dataset["id"]);
    if (isNavKey(ev.key)) {
      ev.preventDefault();
      moveFocus(id, moveCursor(id, ev.key));
      return;
    }
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      onPlace(entry, id);
      return;
    }
    if (ev.key === "Escape" && ui.selected !== null) {
      ev.preventDefault();
      ev.stopPropagation();
      ui.selected = null;
      ui.hint = null;
      renderGame();
      focusCell(id);
      return;
    }
    if ((ev.key === "t" || ev.key === "T") && !ev.ctrlKey && !ev.metaKey && !ev.altKey && entry.setup!.days > 0) {
      ev.preventDefault();
      sayClock(entry);
    }
  });
  // Drag with a mouse: press on a checker that can move, let go on a target.
  grid.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType !== "mouse" || ev.button !== 0) return;
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-id]");
    const st = stateOf(entry);
    if (!el || !st || !movable(entry, st)) return;
    const id = Number(el.dataset["id"]);
    if (!sourcesOf(st, entry.myColor!).includes(id)) return;
    drag = { from: id, x: ev.clientX, y: ev.clientY, moved: false };
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("pointermove", (ev) => {
    if (!drag || drag.moved) return;
    if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) < 6) return;
    drag.moved = true;
    if (ui.selected !== drag.from) {
      ui.selected = drag.from;
      ui.hint = null;
      renderGame();
    }
    document.getElementById("board-grid")?.classList.add("dragging");
  });
  window.addEventListener("pointerup", (ev) => {
    const d = drag;
    drag = null;
    if (!d || !d.moved) return;
    document.getElementById("board-grid")?.classList.remove("dragging");
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("#board-grid [data-id]");
    const entry = activeEntry();
    if (!el || !entry) return;
    const id = Number(el.dataset["id"]);
    if (id !== d.from) onPlace(entry, id);
  });
}

function moveFocus(from: number, to: number): void {
  const grid = document.getElementById("board-grid");
  grid?.querySelector(`[data-id="${from}"]`)?.setAttribute("tabindex", "-1");
  const el = grid?.querySelector<HTMLElement>(`[data-id="${to}"]`);
  el?.setAttribute("tabindex", "0");
  el?.focus();
  ui.cursor = to;
}

function focusCell(id: number): void {
  document.querySelector<HTMLElement>(`#board-grid [data-id="${id}"]`)?.focus({ preventScroll: true });
}

/** A tap, a drop or Enter on a place. */
function onPlace(entry: GameEntry, id: number): void {
  const st = stateOf(entry);
  if (!st || st.phase === "over") return;
  const me = entry.myColor!;
  if (!movable(entry, st)) {
    if (st.toMove !== me) setHint(t("hint.notYourTurn", { name: personName(entry) }));
    return;
  }
  const sources = sourcesOf(st, me);
  if (ui.selected !== null) {
    if (id === ui.selected) {
      ui.selected = null;
      ui.hint = null;
      renderGame();
      focusCell(id);
      return;
    }
    const path = targetsFrom(st.board, me, st.roll!, ui.partial, ui.selected).get(id);
    if (path) {
      takeSteps(entry, st, path, id);
      return;
    }
    if (sources.includes(id)) {
      ui.selected = id;
      ui.hint = null;
      say(t("say.picked", { place: placeLabel(id) }));
      renderGame();
      focusCell(id);
      return;
    }
    setHint(t("hint.cantGo", { place: placeLabel(id) }));
    return;
  }
  if (sources.includes(id)) {
    ui.selected = id;
    ui.hint = null;
    const n = targetsFrom(st.board, me, st.roll!, ui.partial, id).size;
    say(t("say.pickedTargets", { place: placeLabel(id), n }));
    renderGame();
    focusCell(id);
    return;
  }
  const board = boardAfter(st, ui.partial);
  const mineHere = cellCounts(board, me, id).mine > 0 && id !== OFF;
  if (ui.partial.length >= turnNeed(st.board, me, st.roll!).count) setHint(t("hint.done"));
  else if (board[me][BAR] > 0 && id !== BAR) setHint(t("hint.barFirst"));
  else setHint(mineHere ? t("hint.cantMove", { place: placeLabel(id) }) : t("hint.noChecker"));
}

function placeLabel(id: number): string {
  if (id === BAR) return t("pt.yourBar");
  if (id === OFF) return t("pt.off");
  return t("cell.point", { n: id });
}

function takeSteps(entry: GameEntry, st: GameState, path: Step[], to: number): void {
  const me = entry.myColor!;
  ui.partial = [...ui.partial, ...path];
  ui.selected = null;
  ui.hint = null;
  const need = turnNeed(st.board, me, st.roll!).count;
  let left = diceToPlay(st.roll!);
  for (const s of ui.partial) left = without(left, s.die);
  const complete = ui.partial.length >= need;
  say(path.map((s, i) => announceStep(s, me, left, complete && i === path.length - 1)).join(". "));
  ui.cursor = to === OFF ? OFF : to;
  renderGame();
  if (complete) document.querySelector<HTMLElement>("[data-done]")?.focus();
  else focusCell(ui.cursor);
}

function onUndo(): void {
  if (ui.partial.length === 0) return;
  const last = ui.partial[ui.partial.length - 1];
  ui.partial = ui.partial.slice(0, -1);
  ui.selected = null;
  ui.hint = null;
  say(t("say.undone", { step: `${placeLabel(last.from)} → ${placeLabel(last.to)}` }));
  ui.cursor = last.from;
  renderGame();
  const undo = document.querySelector<HTMLButtonElement>("[data-undo]");
  if (undo && !undo.disabled) undo.focus();
  else focusCell(ui.cursor);
}

function setHint(text: string): void {
  ui.hint = text;
  say(text);
  renderGame();
  focusCell(ui.cursor);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Send a game's message to the other player: over its table for an open game
 * in a space (handing their seat the turn), else over the 1:1 session.
 */
function sendGame(entry: GameEntry, msg: unknown, turn: boolean): Promise<unknown> {
  const table = entry.table;
  if (table) {
    if (table.them === null) return Promise.reject(new Error("nobody has taken the seat yet"));
    return client.group.send(entry.sessionId, msg, turn ? { turn: table.them } : {});
  }
  return client.federation.send(entry.sessionId, targetFor(entry), msg, { turn });
}

/** Send our whole game to the opponent (with our time claim while it waits for an answer). */
async function sendState(entry: GameEntry): Promise<void> {
  const own = ownSideOf(entry);
  if (!own) return;
  const claim = hasPendingClaim(entry);
  // Only when our step hands them the turn (never the invite, a claim, a resignation or the end);
  // at a table also our opening dice commitment (table.ts).
  const turn = handsTurn(entry) && !claim;
  try {
    const msg = buildMessage(own, claim ? { claim: true } : {});
    await sendGame(entry, msg, turn);
    if (entry.unsent) {
      entry.unsent = false;
      void persist(entry);
      if (ui.active === entry.sessionId) render();
    }
  } catch (err) {
    if (isUnknownGame(err) && !entry.table) {
      void offerContinue(entry);
      return;
    }
    console.warn("backgammon.send_failed", { session_id: entry.sessionId });
    entry.unsent = true;
    void persist(entry);
    if (ui.active === entry.sessionId) render();
    else toast(t("toast.couldntReach", { name: personName(entry) }));
  }
}

/** A one-off answer that adds no step (refusing a claim): a failure only logs. */
async function sendExtra(entry: GameEntry, extras: MessageExtras): Promise<void> {
  const own = ownSideOf(entry);
  if (!own) return;
  try {
    await sendGame(entry, buildMessage(own, extras), false);
  } catch {
    console.warn("backgammon.send_failed", { session_id: entry.sessionId, kind: "claim-answer" });
  }
}

async function retrySend(entry: GameEntry): Promise<void> {
  await withGame(entry.sessionId, () => sendState(entry));
}

/**
 * Our step, after the switch of rolling without being asked when this
 * person's choice differs from what the log says and the switch may go
 * now (the first thing on our own turn; game.ts). Never before a double
 * (that would give the cube up) or giving up the game.
 */
function withAutoSwitch(entry: GameEntry, st: GameState, e: Entry): Entry[] {
  const me = entry.myColor;
  if (!me || e === "double" || isResign(e) || isTimeout(e)) return [e];
  if (st.autoRoll[me] === ui.autoRoll || !canSwitchAuto(st, me)) return [e];
  return [autoEntry(me, ui.autoRoll), e];
}

/** Add our own step to the log, save it, show it, send it. */
async function takeOwnStep(entry: GameEntry, e: Entry): Promise<boolean> {
  const st = stateOf(entry);
  const dice = diceOf(entry);
  if (!st || !dice) return false;
  const entries = withAutoSwitch(entry, st, e);
  let next: GameState = st;
  try {
    for (const x of entries) next = applyEntry(next, x, dice);
  } catch {
    return false;
  }
  entry.log = [...entry.log, ...entries];
  remember(entry, next);
  entry.updatedAt = Date.now();
  // Their turn starts now, as far as this side can know.
  entry.clockFrom = { n: entry.log.length, at: entry.updatedAt };
  if (ui.active === entry.sessionId) {
    resetBoardUi();
    const name = personName(entry);
    if (next.phase === "over") say(resultLine(next, entry.myColor!, name) ?? "");
    else if (e === "double") say(t("say.youDoubled", { name, n: next.cube.value * 2 }));
    else if (e === "roll") say(t("say.rolling", { name }));
    else if (Array.isArray(e)) say(t("say.sent", { name }));
    renderGame();
  }
  // Saved before it goes out: a reopened app must know every step the other side saw.
  await persist(entry);
  await sendState(entry);
  return true;
}

async function onDone(entry: GameEntry): Promise<void> {
  const steps = [...ui.partial];
  await withGame(entry.sessionId, async () => {
    const st = stateOf(entry);
    if (!st || !movable(entry, st)) return;
    if (steps.length < turnNeed(st.board, entry.myColor!, st.roll!).count) return;
    await takeOwnStep(entry, flatten(steps));
  });
  if (ui.active === entry.sessionId) focusCell(ui.cursor);
}

async function onRoll(entry: GameEntry): Promise<void> {
  await withGame(entry.sessionId, async () => {
    const st = stateOf(entry);
    if (!st || !canDouble(st) || st.toMove !== entry.myColor) return;
    await takeOwnStep(entry, "roll");
  });
}

async function onDouble(entry: GameEntry): Promise<void> {
  await withGame(entry.sessionId, async () => {
    const st = stateOf(entry);
    if (!st || !canDouble(st) || st.toMove !== entry.myColor) return;
    await takeOwnStep(entry, "double");
  });
}

async function onAnswer(entry: GameEntry, e: "take" | "drop"): Promise<void> {
  await withGame(entry.sessionId, async () => {
    const st = stateOf(entry);
    if (!st || st.phase !== "cube" || st.toMove !== entry.myColor) return;
    if (await takeOwnStep(entry, e)) {
      if (e === "take") say(t("say.youTook", { n: (stateOf(entry)?.cube.value ?? 2) }));
    }
  });
}

async function onDecline(entry: GameEntry): Promise<void> {
  const st = stateOf(entry);
  if (!st || st.phase !== "cube") return;
  if (!(await confirmDialog(declineCopy(entry, st.cube.value)))) return;
  await onAnswer(entry, "drop");
}

async function onResign(entry: GameEntry): Promise<void> {
  const st = stateOf(entry);
  if (!st || !entry.myColor) return;
  if (!(await confirmDialog(resignCopy(entry, resignResult(st, entry.myColor))))) return;
  await withGame(entry.sessionId, async () => {
    const now = stateOf(entry);
    if (!now || now.phase === "over") return;
    await takeOwnStep(entry, resignBy(entry.myColor!));
  });
}

/**
 * The app's own steps, never a person's: show our link for the opening roll
 * when the other player won it or for their roll when they rolled, and pass
 * a roll that can't be played (with the reason said and shown).
 */
async function autoAct(entry: GameEntry): Promise<void> {
  const st = stateOf(entry);
  if (!st || !entry.myColor || st.toMove !== entry.myColor) return;
  if (st.phase === "start" && st.opening && st.mover !== entry.myColor) {
    await takeOwnStep(entry, "open");
    return;
  }
  if (st.phase === "dice") {
    await takeOwnStep(entry, "show");
    return;
  }
  // This person rolls without being asked: no Roll or Double question (the switch goes with it).
  if (st.phase === "ask" && st.mover === entry.myColor && ui.autoRoll) {
    await takeOwnStep(entry, "roll");
    return;
  }
  if (st.phase === "play" && st.mover === entry.myColor && mustPass(st)) {
    const text = passText(passReason(st), st.roll!);
    if (await takeOwnStep(entry, [])) {
      if (ui.active === entry.sessionId) say(text);
      else toast(`${personName(entry)}: ${text}`);
    }
  }
}

/** Claim the win on time: their app decides by its own clock (clock.ts). */
async function onClaim(entry: GameEntry): Promise<void> {
  await withGame(entry.sessionId, async () => {
    if (!canClaim(entry)) return;
    entry.claimedAt = entry.log.length;
    await persist(entry);
    say(t("say.claimSent", { name: personName(entry) }));
    if (ui.active === entry.sessionId) renderGame();
    await sendState(entry);
  });
}

function keepPlaying(entry: GameEntry): void {
  entry.claimHiddenAt = entry.log.length;
  void persist(entry);
  renderGame();
  document.querySelector<HTMLElement>("[data-claim]")?.focus();
}

/** The time left, said on request (T on the board). */
function sayClock(entry: GameEntry): void {
  const c = clockOf(entry);
  if (!c) return;
  const left = timeLeftText(c.leftMs);
  say(c.mine ? t("say.clockMine", { left }) : t("say.clockTheirs", { name: personName(entry), left }));
}

async function startNewGame(suggest: Contact | null, color: Color, cube: boolean, days: number): Promise<void> {
  let picked: PickedPerson[];
  try {
    picked = await client.people.pick({
      purpose: "play",
      max: 1,
      ...(suggest ? { suggest: { instance_id: suggest.instance_id, user_ref: suggest.user_ref, is_local: suggest.is_local } } : {}),
    });
  } catch (err) {
    const f = pickFailure(err);
    if (f.kind === "toast") toast(f.message);
    return;
  }
  const p = picked[0];
  if (!p) return; // cancelled
  const setup: Setup = { inviter: color, cube, days };
  const entry = entryForPicked(p, setup, newSeed());
  ui.games.set(entry.sessionId, entry);
  // The seed is saved before its tip goes out.
  await persist(entry);
  ui.contacts = await client.contacts().catch(() => ui.contacts);
  openGame(entry.sessionId);
  // The first message tells the invitee the setup and our dice tip.
  await withGame(entry.sessionId, () => sendState(entry));
}

async function rematch(entry: GameEntry): Promise<void> {
  const r = rematchOf(entry);
  if (!r) return;
  await startNewGame(contactFor(entry), r.color, r.cube, r.days);
}

async function removeGame(entry: GameEntry): Promise<void> {
  if (!(await confirmDialog(removeCopy(entry)))) return;
  // A finished game at a table: our seat there isn't needed any more.
  if (entry.table && ui.groups) void client.group.leave(entry.sessionId).catch(() => {});
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

/**
 * Close our open game in a space before anyone took the seat: it goes from
 * the space's games (Social Home ends the table for everyone) and from here.
 */
async function closeTable(entry: GameEntry): Promise<void> {
  if (!entry.table) return;
  try {
    await client.group.close(entry.sessionId);
  } catch (err) {
    // Already over there (closed on another screen, expired): just forget it.
    const code = err instanceof ShError ? err.code : undefined;
    if (code !== "group_closed" && code !== "group_not_found") {
      toast(t("table.closeFailed"));
      return;
    }
  }
  await dropGame(entry.sessionId);
  document.querySelector<HTMLElement>("[data-new-game]")?.focus();
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
  await sendState(entry);
  if (!entry.unsent) toast(t("toast.askedContinue", { name: personName(entry) }));
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

function onInboundMessage(msg: AppMessage): void {
  if (!isBgMessage(msg.payload)) return;
  const route = routeInbound(msg, ui.games);
  if (route.kind === "drop") {
    console.warn("backgammon.inbound_dropped", { session_id: msg.sessionId, reason: route.reason });
    return;
  }
  const entry = route.entry;
  void withGame(entry.sessionId, () => takeMessage(entry, msg.payload));
}

async function takeMessage(entry: GameEntry, payload: unknown): Promise<void> {
  let v = judgeGame(entry, payload);
  if (v.kind === "refuse" && entry.setup && (v.reason === "wrong-player" || v.reason === "too-many" || v.reason === "rewrite" || v.reason === "claim" || v.reason === "dice")) {
    // This screen may be behind our own store (the same person played on another screen).
    const stored = parseEntry(await client.store.get(PREFIX + entry.sessionId).catch(() => null));
    const dice = stored ? diceOf(stored) : null;
    const ahead = stored && dice ? catchUpFromOwnCopy(entry.setup, entry.log, stored.log, dice) : null;
    if (ahead && stored) {
      entry.log = ahead;
      entry.theirShown = stored.theirShown;
      if (stored.clockFrom) entry.clockFrom = stored.clockFrom;
      v = judgeGame(entry, payload);
    }
  }
  const shown = ui.active === entry.sessionId && ui.view === "game";
  const name = personName(entry);
  switch (v.kind) {
    case "stale":
      return;
    case "unsupported":
      if (!ui.unsupportedShown.has(entry.sessionId)) {
        ui.unsupportedShown.add(entry.sessionId);
        toast(t("toast.unsupported", { name }));
      }
      return;
    case "invite": {
      // The inviter's setup and tip: answer with our own tip and link 1.
      entry.setup = v.setup;
      entry.myColor = v.myColor;
      entry.theirTip = toB64url(v.theirTip);
      // Another screen of ours may have answered already: answer with its seed, never a second one.
      const saved = parseEntry(await client.store.get(PREFIX + entry.sessionId).catch(() => null));
      const same = saved?.seed && saved.setup && saved.myColor === v.myColor && saved.theirTip === entry.theirTip;
      entry.seed = same ? saved.seed! : toB64url(newSeed());
      chainOf(entry.seed);
      entry.heard = true;
      entry.outOfStep = 0;
      entry.updatedAt = Date.now();
      entry.clockFrom = markFor(entry.clockFrom, 0, Date.now());
      // The seed is saved before its tip goes out.
      await persist(entry);
      render();
      await sendState(entry);
      return;
    }
    case "other-screen":
      await adoptFromOtherScreen(entry, v.myTip, payload);
      return;
    case "claim": {
      const st = stateOf(entry);
      if (!st || entry.myColor === null) return;
      const d = decideClaim(
        { state: st, myColor: entry.myColor, logLength: entry.log.length, clockFrom: entry.clockFrom, awaiting: false },
        Date.now(),
      );
      if (d.accept) {
        if (await takeOwnStep(entry, timeoutOf(entry.myColor))) {
          if (shown) say(t("say.youTimedOut", { name }));
          else toast(t("say.youTimedOut", { name }));
          render();
        }
      } else {
        console.info("backgammon.claim_refused", { session_id: entry.sessionId });
        toast(t("claim.youRefused", { name }));
        await sendExtra(entry, { refusedMs: d.leftMs });
      }
      return;
    }
    case "claim-refused":
      if (hasPendingClaim(entry)) {
        entry.claimedAt = undefined;
        entry.theirHint = { n: entry.log.length, at: Date.now() + v.leftMs };
        void persist(entry);
        toast(t("claim.refused", { name }));
        render();
      }
      return;
    case "refuse":
      console.warn("backgammon.inbound_refused", { session_id: entry.sessionId, reason: v.reason });
      entry.outOfStep = (entry.outOfStep ?? 0) + 1;
      if (shown) render();
      return;
    case "apply": {
      entry.setup = v.setup;
      entry.myColor = v.myColor;
      entry.theirTip = toB64url(v.theirTip);
      entry.theirShown = v.theirShown ? { n: v.theirShown.n, link: toB64url(v.theirShown.link) } : null;
      entry.log = v.log;
      // Our turn (or theirs) starts when this side first has it — never a time from them.
      entry.clockFrom = markFor(entry.clockFrom, entry.log.length, Date.now());
      remember(entry, v.state);
      entry.heard = true;
      entry.outOfStep = 0;
      entry.updatedAt = Date.now();
      void persist(entry);
      if (shown) {
        resetBoardUi();
        for (const line of announceInbound(entry, v.added, v.state)) say(line);
        const focused = document.activeElement?.closest("#board-grid") != null;
        if (v.state.toMove === entry.myColor) ui.cursor = startCursor(entry);
        renderGame();
        if (focused) focusCell(ui.cursor);
      } else {
        if (v.added.some(isTimeout)) toast(t("say.theyTimedOut", { name }));
        else if (v.accepted) toast(t(entry.table ? "table.started" : "toast.accepted", { name }));
        else if (v.added.length > 0) toast(t("toast.newsIn", { name }));
        render();
      }
      await autoAct(entry);
      return;
    }
  }
}

/** Waits before looking again for the copy of the screen whose answer the inviter took. */
const ADOPT_RETRY_MS = [2000, 5000, 15000];

/**
 * Another screen of this person answered the invite first: take its saved
 * copy (seed, log) and play on with it. That screen saves its copy with
 * every step; if it hasn't yet, look again a few times, then show the
 * calm "out of step" notice (opening the game again reloads it).
 */
async function adoptFromOtherScreen(entry: GameEntry, myTip: Uint8Array, payload: unknown, attempt = 0): Promise<void> {
  const stored = parseEntry(await client.store.get(PREFIX + entry.sessionId).catch(() => null));
  const adopted = adoptOwnCopy(entry, stored, myTip);
  if (adopted) {
    console.info("backgammon.adopted_other_screen", { session_id: entry.sessionId });
    Object.assign(entry, adopted);
    ui.games.set(entry.sessionId, entry);
    resetBoardUi();
    render();
    await takeMessage(entry, payload);
    return;
  }
  if (attempt < ADOPT_RETRY_MS.length) {
    const wait = ADOPT_RETRY_MS[attempt];
    setTimeout(() => void withGame(entry.sessionId, () => adoptFromOtherScreen(entry, myTip, payload, attempt + 1)), wait);
    return;
  }
  console.warn("backgammon.inbound_refused", { session_id: entry.sessionId, reason: "other-screen" });
  entry.outOfStep = (entry.outOfStep ?? 0) + 1;
  if (ui.active === entry.sessionId) render();
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

/** We were invited: the setup comes with the inviter's first message. */
function seatInvite(invite: AppMessage): GameEntry | null {
  if (ui.games.has(invite.sessionId)) return null;
  const entry = entryForInvite(invite, ui.contacts);
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
// Open games in a space (tables, SDK 1.9) — table.ts decides, this applies
// ---------------------------------------------------------------------------

/** Table events that came in before our saved games were loaded. */
let tableEventsBeforeBoot: GroupEvent[] | null = [];

function onGroupEvent(event: GroupEvent): void {
  if (tableEventsBeforeBoot) {
    tableEventsBeforeBoot.push(event);
    return;
  }
  if (event.type === "message") {
    void takeTableMessage(event).catch((err) => console.error("backgammon.table_message_failed", err));
    return;
  }
  handleTableAction(classifyTableEvent(event, ui.games));
}

/**
 * A message at a table: routed by the table Social Home delivered it for and
 * the sender's seat (never an id in the payload), then judged like any 1:1
 * message (the dice handshake, steps, the cube, resignations, claims).
 */
async function takeTableMessage(msg: GroupMessage): Promise<void> {
  if (!isBgMessage(msg.data)) return;
  let route = routeTableMessage(msg, ui.games);
  if (route.kind === "drop" && route.reason === "no-opponent-yet") {
    // A step before the roster said who sat down: ask Social Home for the table once.
    const session = await client.group.get(msg.id).catch(() => null);
    if (session) seatTable(session, false);
    route = routeTableMessage(msg, ui.games);
  }
  if (route.kind === "drop") {
    console.warn("backgammon.table_dropped", { session_id: msg.id, reason: route.reason });
    return;
  }
  const entry = route.entry;
  await withGame(entry.sessionId, () => takeMessage(entry, msg.data));
}

function handleTableAction(action: TableAction): void {
  switch (action.kind) {
    case "seat": {
      const launched = ui.launchTable === action.session.id;
      const entry = seatTable(action.session, launched);
      if (entry && launched) {
        ui.launchTable = null;
        openGame(entry.sessionId);
      } else {
        if (!entry) void adoptTableFromStore(action.session.id);
        render();
      }
      return;
    }
    case "joined":
      onSeatTaken(action.entry);
      return;
    case "update":
      void persist(action.entry);
      render();
      return;
    case "gone":
      toast(action.reason === "left" ? t("table.left", { name: opponentLabel(action.entry) }) : t("table.ended"));
      void dropGame(action.entry.sessionId);
      return;
    case "mine-over":
      // We left on another screen, or Social Home took us out: forget it.
      void dropGame(action.entry.sessionId);
      return;
    case "ignore":
      return;
  }
}

/** Someone took the seat at our open game: their app sends its dice commitment. */
function onSeatTaken(entry: GameEntry): void {
  entry.updatedAt = Date.now();
  void persist(entry);
  const text = t("table.joined", { name: opponentLabel(entry) });
  if (ui.view === "game" && ui.active === entry.sessionId) say(text);
  else toast(text);
  render();
}

/**
 * Our game for a table we sit at: the one we have (names refreshed), or a
 * new one. A new game of the player who sat down makes our secret dice seed
 * and sends its commitment at once — only where *mayStart* (the screen Join
 * opened, or opening the app), so two screens of one person never commit
 * two different seeds; another screen takes the saved copy instead.
 */
function seatTable(session: GroupSession, mayStart: boolean): GameEntry | null {
  const known = ui.games.get(session.id);
  if (known) {
    if (!known.table) return null; // a 1:1 game's id never becomes a table
    const { changed, joined } = updateFromTable(known, session);
    if (joined) onSeatTaken(known);
    else if (changed) void persist(known);
    return known;
  }
  if (!isPlayableTable(session)) return null;
  const commits = tableRole(session.me!) === "inviter";
  if (commits && !mayStart) return null;
  const entry = entryForTable(session, newSeed(), Date.now());
  if (!entry) return null;
  ui.games.set(entry.sessionId, entry);
  if (commits) {
    // The seed is saved before its tip goes out; the commitment hands the opener the turn.
    void withGame(entry.sessionId, async () => {
      await persist(entry);
      await sendState(entry);
    });
  } else {
    void persist(entry);
  }
  return entry;
}

/** Waits before looking again for the table game another screen of ours started. */
const TABLE_ADOPT_RETRY_MS = [2000, 6000];

/** Another screen of this person took the seat: take its saved game when it is there. */
async function adoptTableFromStore(id: string, attempt = 0): Promise<void> {
  if (ui.games.has(id)) return;
  const saved = parseSavedGame(await client.store.get(PREFIX + id).catch(() => null));
  if (saved?.table && saved.sessionId === id) {
    ui.games.set(id, saved);
    render();
    return;
  }
  if (attempt < TABLE_ADOPT_RETRY_MS.length) {
    setTimeout(() => void adoptTableFromStore(id, attempt + 1), TABLE_ADOPT_RETRY_MS[attempt]);
  }
}

/**
 * On open: what happened at our tables while Backgammon was closed — someone
 * took the seat, the table ended, we left on another screen — and tables we
 * sit at but have no game for yet (opened or joined on another screen).
 */
async function syncTables(): Promise<void> {
  let tables: GroupSession[];
  try {
    tables = await client.group.list();
  } catch (err) {
    console.info("backgammon.no_tables", err);
    return;
  }
  for (const session of tables) {
    const known = ui.games.get(session.id);
    if (!known) {
      if (isPlayableTable(session)) seatTable(session, true);
      continue;
    }
    if (!known.table) continue;
    if (session.myState === "left" || session.myState === "removed") {
      handleTableAction({ kind: "mine-over", entry: known });
    } else if (session.state === "ended") {
      handleTableAction(classifyTableEvent({ type: "ended", id: session.id, session }, ui.games));
    } else {
      seatTable(session, true);
    }
  }
}

/** Messages at our tables that waited while Backgammon was closed (each player's latest). */
async function applyGroupHeld(): Promise<void> {
  let held: GroupMessage[];
  try {
    held = await client.group.held();
  } catch (err) {
    console.info("backgammon.no_held_table_messages", err);
    return;
  }
  for (const msg of held) {
    await takeTableMessage(msg).catch((err) => console.error("backgammon.held_table_message_failed", err));
  }
}

/** Boot is done: take the table events that came in meanwhile. */
function flushEarlyTableEvents(): void {
  const early = tableEventsBeforeBoot ?? [];
  tableEventsBeforeBoot = null;
  for (const event of early) onGroupEvent(event);
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

let booted = false;

async function main(): Promise<void> {
  if (!booted) {
    client.onMessage(onInboundMessage);
    client.onSession(onInboundSession);
    client.group.onEvent(onGroupEvent);
  }
  root().replaceChildren(make("p", { cls: "muted", text: t("app.loading") }));
  try {
    const [ctx] = await Promise.all([client.context({ pullHeld: true }), loadAll()]);
    onLook(ctx);
    if (!booted) {
      client.onContextChange((look) => {
        onLook(look);
        render();
      });
      booted = true;
    }
    ui.selfUserId = ctx.selfUserId;
    // Open games in spaces (an older Social Home has none: 1:1 only).
    ui.groups = ctx.groups === true;
    ui.contacts = await client.contacts().catch(() => []);
    if (ui.groups) await syncTables();
    render();

    if (ctx.launch === undefined) {
      // An older Social Home accepts waiting invites on open.
      ui.liveInvites = true;
      for (const invite of await client.federation.pendingSessions().catch(() => [])) onInboundSession(invite);
      render();
    } else {
      const launch = launchAction(ctx.launch, ui.games);
      if (launch.kind === "table") {
        const entry = seatTable(launch.session, true);
        if (entry) openGame(entry.sessionId);
        else if (launch.session.state !== "ended" && launch.session.myState === "joining") {
          // Join was pressed; the table's household hasn't seated us yet.
          ui.launchTable = launch.session.id;
          toast(t("table.joining"));
        } else toast(t("table.ended"));
      } else if (launch.kind === "start") {
        const entry = seatInvite(launch.invite);
        if (entry) openGame(entry.sessionId);
      } else if (launch.kind === "open") openGame(launch.sessionId);
      else if (launch.kind === "gone") toast(t("invite.gone"));
      else if (launch.kind === "mismatch") toast(t("invite.mismatch"));
    }
    await applyHeld();
    if (ui.groups) await applyGroupHeld();
    flushEarlyTableEvents();
    for (const entry of ui.games.values()) {
      // A step that didn't go out (offline when it was made): send it now.
      if (entry.unsent) void withGame(entry.sessionId, () => sendState(entry));
      // An automatic step a closed app didn't get to.
      void withGame(entry.sessionId, () => autoAct(entry));
    }
  } catch (err) {
    flushEarlyTableEvents();
    console.error("backgammon.init_failed", err);
    const box = make("div", { cls: "card error", attrs: { role: "alert" } });
    box.append(make("p", { text: t("app.loadFailed") }), button(t("btn.retry"), "primary", () => void main()));
    root().replaceChildren(box);
  }
}

/**
 * Once a minute: the time left in place (no re-render, no announcement,
 * nothing that moves), and a re-render only when a clock runs out.
 */
function clockTick(): void {
  const now = Date.now();
  const offers = offersKey(now);
  const changed = offers !== lastOffers;
  lastOffers = offers;
  if (ui.view === "game") {
    const entry = activeEntry();
    if (!entry || !entry.setup || entry.setup.days === 0) return;
    if (changed) return renderGame();
    const c = clockOf(entry, now);
    const el = document.querySelector<HTMLElement>("[data-clock]");
    if (c && el) el.textContent = timeLeftText(c.leftMs);
    return;
  }
  if (!changed) return;
  for (const el of document.querySelectorAll<HTMLElement>("[data-chip]")) {
    const g = ui.games.get(el.dataset["chip"] ?? "");
    if (!g) continue;
    const chip = chipFor(g, now);
    el.textContent = chip.text;
    el.className = `chip ${chip.tone}`;
  }
}

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
if (typeof window !== "undefined" && sh) {
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (ui.view === "game") renderGame();
    }, 150);
  });
  setInterval(clockTick, 60_000);
  void main();
}

