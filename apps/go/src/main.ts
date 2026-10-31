/**
 * Go — the UI and its life cycle (the engine is pure and tested: rules,
 * game, inbound; the words: view, i18n).
 *
 *  - `ui.games` Map<sessionId, GameEntry>, kept per person in `sh.store`
 *    under "game:<sessionId>"; the new-game choices under "pref:size",
 *    "pref:color", "pref:handicap" and "pref:days".
 *  - The optional clock (clock.ts): times come only from this device; a
 *    claim from the other side is decided by our own records.
 *  - Views: lobby (new game + games), game (board, counting, the end).
 *  - Every message carries the whole game. Inbound messages are judged by
 *    `judgeInbound`; work on one game is serialized (`withGame`) so live and
 *    held copies never race.
 *  - Nothing new is sent after a game's final step: a retry only sends the
 *    same final log again.
 */

import sh, { ShError } from "@socialhome/app-sdk";
import type { AppLook, AppMessage, Contact, GroupEvent, GroupMessage, GroupSession, PickedPerson } from "@socialhome/app-sdk";
import { BLACK, COLUMNS, EMPTY, handicapsFor, isHandicap, isSize, maxHandicap, pointName, scoreArea, starPoints } from "./rules.js";
import type { Color, Size } from "./rules.js";
import { MAX_LOG, applyEntry, isTimeout, passesTurn, resignBy, sameEntry, timeoutOf, toggleChain, whyNot } from "./game.js";
import type { Entry, GameState, Rules } from "./game.js";
import { CLOCK_DAYS, buildMessage, catchUpFromOwnCopy, isClockDays, isGoMessage, judgeInbound } from "./inbound.js";
import type { MessageExtras } from "./inbound.js";
import { decideClaim, markFor } from "./clock.js";
import {
  canClaim,
  clockOf,
  hasPendingClaim,
  rulesOf,
  showClaimOffer,
  classifySessionEvent,
  continueCopy,
  entryForInvite,
  entryForPicked,
  isAwaitingOpponent,
  isOver,
  isMyTurn,
  isUnknownGame,
  launchAction,
  parseEntry,
  pickFailure,
  rematchOf,
  remember,
  removeCopy,
  resignCopy,
  resolveColor,
  personName,
  routeInbound,
  stateOf,
  targetFor,
  toStored,
} from "./lifecycle.js";
import type { ColorChoice, ConfirmCopy, GameEntry } from "./lifecycle.js";
import { groupGames } from "./lobby.js";
import { prefSaver } from "./prefs.js";
import {
  announceInbound,
  announceOwn,
  cellLabel,
  chipFor,
  clockName,
  colorName,
  handicapExplain,
  metaFor,
  opponentLabel,
  resultLine,
  rulesLine,
  sizeName,
  statusFor,
  timeLeftText,
} from "./view.js";
import type { CellView } from "./view.js";
import { isNavKey, moveCursor, needsConfirm, startCursor } from "./board-nav.js";
import { createAnnouncer } from "./announcer.js";
import type { Announcer } from "./announcer.js";
import { num, t } from "./i18n.js";
import type { MessageKey } from "./i18n.js";
import { applyLook } from "./look.js";
import {
  canCloseTable,
  classifyTableEvent,
  entryForTable,
  isPlayableTable,
  isSentAfterFinish,
  isWaitingForPlayer,
  parseSavedGame,
  routeTableMessage,
  tableSendOptions,
  updateFromTable,
} from "./table.js";
import type { TableAction } from "./table.js";

const client = sh as NonNullable<typeof sh>;
/** Lobby choices: saved in order per key, the last change wins (prefs.ts). */
const savePref = prefSaver(
  (key, value) => client.store.set(key, value),
  (key) => console.warn("go.pref_save_failed", { key }),
);

type View = "lobby" | "game";

interface UI {
  view: View;
  active: string | null;
  selfUserId: string;
  contacts: Contact[];
  games: Map<string, GameEntry>;
  size: Size;
  colorChoice: ColorChoice;
  handicap: number;
  days: number;
  /** Board: the focused point, a 19 × 19 tap waiting for Place, the counting draft. */
  cursor: number;
  preview: number | null;
  marking: number[] | null;
  /** The log length the counting draft was made for (reset when it changes). */
  markingAt: number;
  hint: string | null;
  liveInvites: boolean;
  reducedMotion: boolean;
  unsupportedShown: Set<string>;
  /** This Social Home has open games in spaces (`sh.group`, SDK 1.9). */
  groups: boolean;
  /** Join opened Go for this table before our seat was confirmed: open it once seated. */
  launchTable: string | null;
}

const ui: UI = {
  view: "lobby",
  active: null,
  selfUserId: "",
  contacts: [],
  games: new Map(),
  size: 9,
  colorChoice: "random",
  handicap: 0,
  days: 0,
  cursor: 40,
  preview: null,
  marking: null,
  markingAt: -1,
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
const PREF_SIZE = "pref:size";
const PREF_COLOR = "pref:color";
const PREF_HANDICAP = "pref:handicap";
const PREF_DAYS = "pref:days";

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
          console.warn("go.persist_failed", { session_id: sid });
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
  let handicap: unknown = 0;
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PREFIX)) {
      const entry = parseSavedGame(value);
      if (!entry) continue;
      ui.games.set(entry.sessionId, entry);
      // A clock without a mark for this position starts counting now (never earlier).
      if (entry.days > 0 && entry.size !== null && entry.clockFrom?.n !== entry.log.length) {
        entry.clockFrom = markFor(entry.clockFrom, entry.log.length, Date.now());
        void persist(entry);
      }
    } else if (key === PREF_SIZE && isSize(value)) {
      ui.size = value;
    } else if (key === PREF_COLOR && (value === "b" || value === "w" || value === "random")) {
      ui.colorChoice = value;
    } else if (key === PREF_HANDICAP) {
      handicap = value;
    } else if (key === PREF_DAYS && isClockDays(value)) {
      ui.days = value;
    }
  }
  if (isHandicap(ui.size, handicap)) ui.handicap = handicap;
}

/** One game's work at a time: live, held and local steps never race. */
const queues = new Map<string, Promise<void>>();
function withGame(sid: string, fn: () => Promise<void>): Promise<void> {
  const prev = queues.get(sid) ?? Promise.resolve();
  const next = prev.then(fn).catch((err) => console.error("go.game_step_failed", err));
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
function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
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
    .filter((g) => g.days > 0)
    .map((g) => `${g.sessionId}:${canClaim(g, now)}:${clockOf(g, now)?.expired ?? ""}`)
    .join("|");
}

/** What the clock tick compares against: the clocks as last drawn. */
function drawnClocks(): void {
  lastOffers = offersKey(Date.now());
}

function activeEntry(): GameEntry | null {
  return ui.active ? (ui.games.get(ui.active) ?? null) : null;
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function choiceGroup<T extends string | number>(
  legend: string,
  name: string,
  options: [T, string][],
  current: T,
  onPick: (v: T) => void,
  swatch?: (v: T) => HTMLElement | null,
): HTMLElement {
  const group = make("fieldset", { cls: "choice" });
  group.appendChild(make("legend", { text: legend }));
  const row = make("div", { cls: "choice-row" });
  for (const [value, label] of options) {
    const id = `${name}-${value}`;
    const input = make("input", { attrs: { type: "radio", name, id, value: String(value) } });
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

function stoneSwatch(c: Color | "random"): HTMLElement {
  return make("span", { cls: `swatch swatch-${c}`, attrs: { "aria-hidden": "true" } });
}

function renderLobby(): void {
  const r = root();
  r.replaceChildren();
  r.className = "view-lobby";
  drawnClocks();

  const card = make("section", { cls: "card new-game", attrs: { "aria-labelledby": "new-game-title" } });
  card.appendChild(make("h2", { cls: "section-title", text: t("lobby.newGame"), attrs: { id: "new-game-title" } }));
  card.appendChild(make("p", { cls: "muted small", text: t("lobby.hint") }));
  const sizes: [Size, string][] = [
    [9, t("size.9")],
    [13, t("size.13")],
    [19, t("size.19")],
  ];
  card.appendChild(
    choiceGroup(t("newGame.size"), "size", sizes, ui.size, (v) => {
      ui.size = v;
      void savePref(PREF_SIZE, v);
      // 9 × 9 takes at most 5 stones: the choice follows the board.
      if (ui.handicap > maxHandicap(v)) setHandicap(maxHandicap(v));
      fillHandicaps();
    }),
  );
  const colors: [ColorChoice, string][] = [
    ["random", t("color.random")],
    ["b", t("color.b")],
    ["w", t("color.w")],
  ];
  card.appendChild(
    choiceGroup(t("newGame.playAs"), "color", colors, ui.colorChoice, (v) => {
      ui.colorChoice = v;
      void savePref(PREF_COLOR, v);
    }, stoneSwatch),
  );
  card.appendChild(setupFields());
  card.appendChild(
    button(t("btn.newGame"), "primary wide", () => void startNewGame(null, ui.size, resolveColor(ui.colorChoice), currentRules()), {
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
        button(t("btn.rematch"), "", () => void startNewGame(c, ui.size, resolveColor(ui.colorChoice), currentRules()), {
          "aria-label": t("btn.rematchWho", { name: c.display_name }),
        }),
      );
      list.appendChild(li);
    }
    r.appendChild(list);
  }
}

function currentRules(): Rules {
  return { handicap: isHandicap(ui.size, ui.handicap) ? ui.handicap : 0, days: ui.days };
}

function setHandicap(n: number): void {
  ui.handicap = n;
  void savePref(PREF_HANDICAP, n);
  const explain = document.getElementById("handicap-explain");
  if (explain) explain.textContent = handicapExplain(n);
}

/** The handicap list for the chosen board (2 … 5 on 9 × 9, 2 … 9 otherwise). */
function fillHandicaps(sel = document.getElementById("handicap") as HTMLSelectElement | null): void {
  if (!sel) return;
  sel.replaceChildren(
    ...handicapsFor(ui.size).map((n) => {
      const o = make("option", { text: n === 0 ? t("handicap.none") : t("handicap.n", { n }), attrs: { value: String(n) } });
      o.selected = n === ui.handicap;
      return o;
    }),
  );
}

/** Handicap and clock: two native selects, each with a one-line explanation. */
function setupFields(): HTMLElement {
  const pair = make("div", { cls: "setup-pair" });

  const hField = make("div", { cls: "field" });
  const hSel = make("select", { attrs: { id: "handicap", "aria-describedby": "handicap-explain" } });
  hSel.addEventListener("change", () => setHandicap(Number(hSel.value)));
  hField.append(
    make("label", { text: t("newGame.handicap"), attrs: { for: "handicap" } }),
    hSel,
    make("p", { cls: "explain muted small", text: handicapExplain(ui.handicap), attrs: { id: "handicap-explain" } }),
  );

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

  pair.append(hField, cField);
  fillHandicaps(hSel);
  return pair;
}

function miniStone(c: Color | null): HTMLElement {
  return make("span", { cls: `swatch swatch-${c ?? "random"}`, attrs: { "aria-hidden": "true" } });
}

function gameCard(entry: GameEntry): HTMLElement {
  const name = opponentLabel(entry);
  const li = make("li", { cls: "card game" });
  const top = make("div", { cls: "game-top" });
  top.append(miniStone(entry.myColor), make("span", { cls: "who", text: name }));
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

function toLobby(): void {
  const from = ui.active;
  ui.view = "lobby";
  ui.active = null;
  ui.preview = null;
  ui.marking = null;
  ui.hint = null;
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
  ui.preview = null;
  ui.hint = null;
  ui.marking = null;
  ui.markingAt = -1;
  const st = stateOf(entry);
  ui.cursor = st ? startCursor(st.size, st.lastMove) : 0;
  renderGame();
  const grid = document.getElementById("board-grid");
  if (grid) focusPoint(ui.cursor);
  else document.querySelector<HTMLElement>(".back")?.focus();
}

/** The counting draft for our turn: starts from the other side's marking. */
function syncMarking(entry: GameEntry, st: GameState): void {
  if (st.phase !== "counting" || st.toMove !== entry.myColor) {
    ui.marking = null;
    ui.markingAt = -1;
    return;
  }
  if (ui.marking === null || ui.markingAt !== entry.log.length) {
    ui.marking = st.proposal ? [...st.proposal.dead] : [];
    ui.markingAt = entry.log.length;
  }
}

/** The dead stones shown: our draft on our counting turn, else the latest marking or the final one. */
function shownDead(st: GameState): number[] {
  if (st.result?.by === "score") return st.result.dead;
  if (st.phase !== "counting") return [];
  return ui.marking ?? st.proposal?.dead ?? [];
}

function showCoords(): boolean {
  return window.matchMedia("(min-width: 600px)").matches;
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

  if (!st) {
    const s = statusFor(entry);
    const card = make("div", { cls: "card status-card", attrs: { role: "status" } });
    card.append(make("div", { cls: "big", text: s.title }));
    if (s.detail) card.append(make("p", { cls: "muted", text: s.detail }));
    r.appendChild(card);
    return;
  }
  syncMarking(entry, st);

  const layout = make("div", { cls: "game-layout" });
  const panel = sidePanel(entry, st, name);
  layout.append(panel.info, boardEl(entry, st), panel.lower);
  r.appendChild(layout);
  if (hadBoardFocus) focusPoint(ui.cursor);
}

function sidePanel(entry: GameEntry, st: GameState, name: string): { info: HTMLElement; lower: HTMLElement } {
  const side = make("div", { cls: "side info" });
  const lower = make("div", { cls: "side lower" });
  const me = entry.myColor!;
  const them: Color = me === "b" ? "w" : "b";

  // Players + captures (+ the time left of the player to move)
  const clock = clockOf(entry);
  const players = make("ul", { cls: "players", attrs: { "aria-label": t("captures.label") } });
  const playerRow = (c: Color, who: string) => {
    const li = make("li", { cls: `player${st.phase !== "over" && st.toMove === c ? " to-move" : ""}` });
    li.append(miniStone(c), make("span", { cls: "pname", text: `${who} · ${colorName(c)}` }));
    li.append(
      make("span", {
        cls: "caps",
        text: `${t(c === "b" ? "captures.b" : "captures.w", { n: st.captures[c] })}`,
      }),
    );
    if (clock && clock.who === c) {
      li.append(make("span", { cls: `clock${clock.expired ? " out" : ""}`, text: timeLeftText(clock.leftMs), attrs: { "data-clock": "" } }));
    }
    return li;
  };
  players.append(playerRow(them, name), playerRow(me, t("game.you")));
  side.appendChild(players);
  const setup = rulesLine(entry);
  if (setup) side.appendChild(make("p", { cls: "setup-line muted small", text: setup }));

  if (st.phase === "over") {
    side.appendChild(resultCard(entry, st));
    const row = make("div", { cls: "row acts" });
    if (!entry.table) row.append(button(t("btn.rematch"), "primary", () => void rematch(entry)));
    row.append(button(t("btn.backToGames"), entry.table ? "primary" : "", toLobby));
    lower.appendChild(row);
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
  if (ui.hint) side.appendChild(make("p", { cls: "hint small", text: ui.hint }));
  // A 19 × 19 tap waiting for Place: right under the hint, above the board on a phone.
  if (ui.preview !== null && isMyTurn(entry) && st.phase === "play") {
    const row = make("div", { cls: "row acts" });
    row.append(
      button(t("btn.place", { point: pointName(st.size, ui.preview) }), "primary", () => void onPlace(entry, ui.preview!), { "data-place": "" }),
      button(t("btn.cancel"), "ghost", () => {
        ui.preview = null;
        ui.hint = null;
        renderGame();
      }),
    );
    side.appendChild(row);
  }

  const mine = isMyTurn(entry);
  const acts = make("div", { cls: "row acts" });
  if (st.phase === "counting") {
    const dead = shownDead(st);
    const score = scoreArea(st.board, st.size, dead, st.handicap);
    side.appendChild(make("p", { cls: "preview-score", text: t("count.preview", { b: num(score.b.total), w: num(score.w.total) }) }));
    if (mine) {
      const agrees = !!st.proposal && st.proposal.by !== me && sameEntry(st.proposal.dead, ui.marking ?? []);
      acts.append(button(agrees ? t("btn.agree") : t("btn.sendMarking"), "primary", () => void onMark(entry), { "data-mark": "" }));
      acts.append(button(t("btn.resume"), "", () => void onStep(entry, "resume")));
      lower.appendChild(acts);
      lower.appendChild(make("p", { cls: "muted small", text: t("count.resumeNote") }));
    }
  } else if (mine) {
    acts.append(button(t("btn.pass"), "", () => void onStep(entry, "pass"), { "data-pass": "" }));
    lower.appendChild(acts);
  } else if (isAwaitingOpponent(entry)) {
    acts.append(button(t("btn.cancelInvite"), "ghost", () => void cancelInvite(entry)));
    lower.appendChild(acts);
  } else if (canClaim(entry) && !showClaimOffer(entry)) {
    // After Keep playing: the claim stays one tap away until they move.
    acts.append(button(t("btn.claim"), "", () => void onClaim(entry), { "data-claim": "" }));
    lower.appendChild(acts);
  }
  if (isWaitingForPlayer(entry)) {
    // Nobody to resign to yet at our open game: Close it instead.
    if (canCloseTable(entry)) {
      acts.append(closeTableButton(entry));
      lower.appendChild(acts);
    }
  } else {
    lower.appendChild(button(t("btn.resign"), "ghost danger resign", () => void onResign(entry)));
  }
  lower.appendChild(make("p", { cls: "muted small keys", text: t(entry.days > 0 ? "game.keysClock" : "game.keys") }));
  if (st.n >= MAX_LOG - 1) lower.appendChild(make("p", { cls: "muted small", text: t("illegal.long") }));
  return { info: side, lower };
}

function resultCard(entry: GameEntry, st: GameState): HTMLElement {
  const r = st.result!;
  const won = r.winner === entry.myColor;
  const card = make("div", { cls: `card verdict ${won ? "good" : "bad"}`, attrs: { role: "status" } });
  card.append(make("div", { cls: "verdict-title", text: won ? t("end.won") : t("end.lost") }));
  card.append(make("div", { cls: "verdict-line", text: resultLine(st) ?? "" }));
  if (r.by === "resign") {
    const last = entry.log[entry.log.length - 1];
    const iResigned = last === resignBy(entry.myColor!);
    card.append(make("p", { cls: "muted small", text: iResigned ? t("end.youResigned") : t("end.theyResigned", { name: personName(entry) }) }));
    return card;
  }
  if (r.by === "time") {
    card.append(make("p", { cls: "muted small", text: won ? t("end.theyTimedOut", { name: personName(entry) }) : t("end.youTimedOut") }));
    return card;
  }
  const table = make("table", { cls: "score" });
  const cap = make("caption", { cls: "sr-only", text: t("score.title") });
  table.appendChild(cap);
  const head = make("tr");
  head.append(make("th", { attrs: { scope: "col" } }));
  for (const c of ["b", "w"] as const) {
    const th = make("th", { attrs: { scope: "col" } });
    th.append(miniStone(c), ` ${colorName(c)}`);
    head.append(th);
  }
  const thead = make("thead");
  thead.appendChild(head);
  table.appendChild(thead);
  const tbody = make("tbody");
  const row = (key: MessageKey, b: number, w: number, total = false) => {
    const tr = make("tr", { cls: total ? "total" : "" });
    tr.append(make("th", { text: t(key), attrs: { scope: "row" } }), make("td", { text: num(b) }), make("td", { text: num(w) }));
    tbody.appendChild(tr);
  };
  row("score.stones", r.score.b.stones, r.score.w.stones);
  row("score.territory", r.score.b.territory, r.score.w.territory);
  row("score.komi", r.score.b.komi, r.score.w.komi);
  if (r.score.w.handicap > 0) row("score.handicap", r.score.b.handicap, r.score.w.handicap);
  row("score.total", r.score.b.total, r.score.w.total, true);
  table.appendChild(tbody);
  card.appendChild(table);
  return card;
}

// ---- The board ------------------------------------------------------------

function boardEl(entry: GameEntry, st: GameState): HTMLElement {
  const size = st.size;
  const me = entry.myColor!;
  const coords = showCoords();
  const m = coords ? 0.75 : 0;
  const total = size + 2 * m;
  const wrap = make("div", { cls: `board-wrap size-${size}`, attrs: { dir: "ltr" } });

  const dead = new Set(shownDead(st));
  const area =
    st.result?.by === "score" ? st.result.score.owner : st.phase === "counting" ? scoreArea(st.board, size, dead, st.handicap).owner : null;
  const playable = isMyTurn(entry) && st.phase === "play";
  const marking = isMyTurn(entry) && st.phase === "counting";

  const s = svg("svg", { viewBox: `${-m} ${-m} ${total} ${total}`, class: "board-svg", "aria-hidden": "true", focusable: "false" });
  s.appendChild(svg("rect", { x: -m, y: -m, width: total, height: total, rx: 0.3, class: "bd-bg" }));
  const lines = svg("g", { class: "bd-line" });
  for (let i = 0; i < size; i++) {
    lines.appendChild(svg("line", { x1: 0.5, y1: i + 0.5, x2: size - 0.5, y2: i + 0.5 }));
    lines.appendChild(svg("line", { x1: i + 0.5, y1: 0.5, x2: i + 0.5, y2: size - 0.5 }));
  }
  s.appendChild(lines);
  for (const p of starPoints(size)) {
    s.appendChild(svg("circle", { cx: (p % size) + 0.5, cy: Math.floor(p / size) + 0.5, r: size === 19 ? 0.13 : 0.1, class: "bd-star" }));
  }
  if (coords) {
    const labels = svg("g", { class: "bd-label" });
    for (let i = 0; i < size; i++) {
      const col = COLUMNS[i];
      const row = String(size - i);
      for (const [x, y, text] of [
        [i + 0.5, -m / 2, col],
        [i + 0.5, size + m / 2, col],
        [-m / 2, i + 0.5, row],
        [size + m / 2, i + 0.5, row],
      ] as [number, number, string][]) {
        const tx = svg("text", { x, y, "text-anchor": "middle", "dominant-baseline": "central" });
        tx.textContent = text;
        labels.appendChild(tx);
      }
    }
    s.appendChild(labels);
  }

  const cellViews: CellView[] = [];
  for (let p = 0; p < size * size; p++) {
    const stone = st.board[p];
    const v: CellView = {
      stone,
      last: st.lastMove === p && st.phase === "play",
      dead: dead.has(p),
      area: area ? area[p] : EMPTY,
      preview: ui.preview === p && playable && stone === EMPTY,
    };
    cellViews.push(v);
    const cx = (p % size) + 0.5;
    const cy = Math.floor(p / size) + 0.5;
    if (area && (stone === EMPTY || v.dead) && area[p] !== EMPTY) {
      s.appendChild(svg("rect", { x: cx - 0.17, y: cy - 0.17, width: 0.34, height: 0.34, class: area[p] === BLACK ? "terr terr-b" : "terr terr-w" }));
    }
    if (stone !== EMPTY) {
      const cls = `stone ${stone === BLACK ? "st-b" : "st-w"}${v.dead ? " dead" : ""}`;
      s.appendChild(svg("circle", { cx, cy, r: 0.47, class: cls }));
      if (v.dead) {
        s.appendChild(svg("path", { d: `M${cx - 0.2} ${cy - 0.2}L${cx + 0.2} ${cy + 0.2}M${cx + 0.2} ${cy - 0.2}L${cx - 0.2} ${cy + 0.2}`, class: `dead-x ${stone === BLACK ? "on-b" : "on-w"}` }));
      }
      if (v.last) s.appendChild(svg("circle", { cx, cy, r: 0.2, class: `last-mark ${stone === BLACK ? "on-b" : "on-w"}` }));
    } else if (v.preview) {
      s.appendChild(svg("circle", { cx, cy, r: 0.47, class: `stone preview ${me === "b" ? "st-b" : "st-w"}` }));
      s.appendChild(svg("circle", { cx, cy, r: 0.47, class: "preview-ring" }));
    }
  }
  wrap.appendChild(s);

  // The grid overlays the playing area: one gridcell per point.
  const inset = `${(m / total) * 100}%`;
  const grid = make("div", {
    cls: `grid${playable ? " playable" : ""}${marking ? " marking" : ""} mine-${me}`,
    attrs: { role: "grid", id: "board-grid", "aria-label": t("game.boardLabel", { size: sizeName(size) }) },
  });
  grid.style.inset = inset;
  grid.style.setProperty("--n", String(size));
  for (let r = 0; r < size; r++) {
    const row = make("div", { cls: "grid-row", attrs: { role: "row" } });
    for (let c = 0; c < size; c++) {
      const p = r * size + c;
      const v = cellViews[p];
      const cell = make("div", {
        cls: `cell${v.stone === EMPTY ? " free" : ""}`,
        attrs: {
          role: "gridcell",
          "aria-label": cellLabel(size, p, v, me),
          tabindex: p === ui.cursor ? "0" : "-1",
          "data-p": String(p),
        },
      });
      row.appendChild(cell);
    }
    grid.appendChild(row);
  }
  grid.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-p]");
    if (!el) return;
    const p = Number(el.dataset["p"]);
    ui.cursor = p;
    onPoint(entry, p, ev.detail === 0);
  });
  grid.addEventListener("keydown", (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-p]");
    if (!el) return;
    const p = Number(el.dataset["p"]);
    if (isNavKey(ev.key)) {
      ev.preventDefault();
      const next = moveCursor(size, p, ev.key, ev.ctrlKey || ev.metaKey);
      moveFocus(p, next);
      return;
    }
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      onPoint(entry, p, true);
      return;
    }
    if ((ev.key === "t" || ev.key === "T") && !ev.ctrlKey && !ev.metaKey && !ev.altKey && entry.days > 0) {
      ev.preventDefault();
      sayClock(entry);
      return;
    }
    if (ev.key === "Escape" && ui.preview !== null) {
      ev.preventDefault();
      ev.stopPropagation();
      ui.preview = null;
      renderGame();
    }
  });
  wrap.appendChild(grid);
  return wrap;
}

function moveFocus(from: number, to: number): void {
  const grid = document.getElementById("board-grid");
  grid?.querySelector(`[data-p="${from}"]`)?.setAttribute("tabindex", "-1");
  const el = grid?.querySelector<HTMLElement>(`[data-p="${to}"]`);
  el?.setAttribute("tabindex", "0");
  el?.focus();
  ui.cursor = to;
}

function focusPoint(p: number): void {
  document.querySelector<HTMLElement>(`#board-grid [data-p="${p}"]`)?.focus({ preventScroll: true });
}

const ILLEGAL_TEXT: Partial<Record<string, MessageKey>> = {
  occupied: "illegal.occupied",
  suicide: "illegal.suicide",
  ko: "illegal.ko",
  "too-long": "illegal.long",
};

/** A tap or Enter on a point. */
function onPoint(entry: GameEntry, p: number, fromKey: boolean): void {
  const st = stateOf(entry);
  if (!st || st.phase === "over") return;
  if (isWaitingForPlayer(entry)) {
    setHint(t("status.waitingForPlayer"));
    return;
  }
  if (!isMyTurn(entry)) {
    setHint(t("illegal.turn", { name: personName(entry) }));
    return;
  }
  if (st.phase === "counting") {
    if (st.board[p] === EMPTY) return;
    ui.marking = toggleChain(st, ui.marking ?? [], p);
    say(t("say.marking", { n: ui.marking.length }));
    renderGame();
    focusPoint(p);
    return;
  }
  const why = whyNot(st, p);
  if (why) {
    const key = ILLEGAL_TEXT[why];
    if (key) setHint(t(key, { point: pointName(st.size, p) }));
    return;
  }
  if (!fromKey && needsConfirm(st.size) && ui.preview !== p) {
    ui.preview = p;
    ui.hint = t("hint.preview", { point: pointName(st.size, p) });
    say(ui.hint);
    renderGame();
    return;
  }
  void onPlace(entry, p);
}

function setHint(text: string): void {
  ui.hint = text;
  say(text);
  renderGame();
  focusPoint(ui.cursor);
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
    const over = isOver(entry);
    return client.group.send(entry.sessionId, msg, tableSendOptions(table.them, turn, over)).catch((err: unknown) => {
      if (isSentAfterFinish(err, over)) return null;
      throw err;
    });
  }
  return client.federation.send(entry.sessionId, targetFor(entry), msg, { turn });
}

/** Send our whole game to the opponent (with our time claim while it waits for an answer). */
async function sendState(entry: GameEntry): Promise<void> {
  if (entry.size === null || entry.myColor === null) return;
  const st = stateOf(entry);
  if (!st) return;
  const claim = hasPendingClaim(entry);
  // Only when our step hands them the turn (never the setup, a claim, a resignation or the end).
  const turn = entry.log.length > 0 && passesTurn(st, entry.myColor) && !claim;
  try {
    const msg = buildMessage(entry.size, entry.myColor, entry.log, rulesOf(entry), claim ? { claim: true } : {});
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
    console.warn("go.send_failed", { session_id: entry.sessionId });
    entry.unsent = true;
    void persist(entry);
    if (ui.active === entry.sessionId) render();
    else toast(t("toast.couldntReach", { name: personName(entry) }));
  }
}

/** A one-off answer that adds no step (refusing a claim): a failure only logs. */
async function sendExtra(entry: GameEntry, extras: MessageExtras): Promise<void> {
  if (entry.size === null || entry.myColor === null) return;
  try {
    const msg = buildMessage(entry.size, entry.myColor, entry.log, rulesOf(entry), extras);
    await sendGame(entry, msg, false);
  } catch {
    console.warn("go.send_failed", { session_id: entry.sessionId, kind: "claim-answer" });
  }
}

async function retrySend(entry: GameEntry): Promise<void> {
  await withGame(entry.sessionId, () => sendState(entry));
}

/** Add our own step to the log, save it, show it, send it. */
async function takeOwnStep(entry: GameEntry, e: Entry): Promise<boolean> {
  const st = stateOf(entry);
  if (!st) return false;
  let next: GameState;
  try {
    next = applyEntry(st, e);
  } catch {
    return false;
  }
  entry.log = [...entry.log, e];
  remember(entry.log, next);
  entry.updatedAt = Date.now();
  // Their turn starts now, as far as this side can know.
  entry.clockFrom = { n: entry.log.length, at: entry.updatedAt };
  ui.preview = null;
  ui.hint = null;
  if (ui.active === entry.sessionId) {
    for (const line of announceOwn(e, next)) say(line);
    renderGame();
  }
  // Saved before it goes out: a reopened app must know every step the other side saw.
  await persist(entry);
  await sendState(entry);
  return true;
}

async function onPlace(entry: GameEntry, p: number): Promise<void> {
  await withGame(entry.sessionId, async () => {
    if (!isMyTurn(entry)) return;
    await takeOwnStep(entry, p);
  });
  if (ui.active === entry.sessionId) focusPoint(p);
}

async function onStep(entry: GameEntry, e: "pass" | "resume"): Promise<void> {
  await withGame(entry.sessionId, async () => {
    if (!isMyTurn(entry)) return;
    await takeOwnStep(entry, e);
  });
}

async function onMark(entry: GameEntry): Promise<void> {
  const marking = ui.marking ?? [];
  await withGame(entry.sessionId, async () => {
    if (!isMyTurn(entry)) return;
    if (await takeOwnStep(entry, [...marking])) {
      ui.marking = null;
      render();
    }
  });
}

async function onResign(entry: GameEntry): Promise<void> {
  if (!(await confirmDialog(resignCopy(entry)))) return;
  await withGame(entry.sessionId, async () => {
    const st = stateOf(entry);
    if (!st || st.phase === "over") return;
    await takeOwnStep(entry, resignBy(entry.myColor!));
  });
}

/** Claim the win on time: their Go decides by its own clock (clock.ts). */
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

async function startNewGame(suggest: Contact | null, size: Size, color: Color, rules: Rules): Promise<void> {
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
  const entry = entryForPicked(p, size, color, rules);
  ui.games.set(entry.sessionId, entry);
  await persist(entry);
  ui.contacts = await client.contacts().catch(() => ui.contacts);
  openGame(entry.sessionId);
  // The first message tells the invitee the board and the colours.
  await withGame(entry.sessionId, () => sendState(entry));
}

async function rematch(entry: GameEntry): Promise<void> {
  const r = rematchOf(entry);
  if (!r) return;
  await startNewGame(contactFor(entry), r.size, r.color, r.rules);
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
  if (!isGoMessage(msg.payload)) return;
  const route = routeInbound(msg, ui.games);
  if (route.kind === "drop") {
    console.warn("go.inbound_dropped", { session_id: msg.sessionId, reason: route.reason });
    return;
  }
  const entry = route.entry;
  void withGame(entry.sessionId, () => takeMessage(entry, msg.payload));
}

async function takeMessage(entry: GameEntry, payload: unknown): Promise<void> {
  const local = () => ({ size: entry.size, myColor: entry.myColor, rules: rulesOf(entry), role: entry.role, log: entry.log });
  let v = judgeInbound(local(), payload);
  if (
    v.kind === "refuse" &&
    entry.size !== null &&
    (v.reason === "wrong-player" || v.reason === "too-many" || v.reason === "rewrite" || v.reason === "claim")
  ) {
    // This screen may be behind our own store (the same person played on another screen).
    const stored = parseEntry(await client.store.get(PREFIX + entry.sessionId).catch(() => null));
    const ahead = stored ? catchUpFromOwnCopy(entry.size, entry.log, stored.log, rulesOf(entry)) : null;
    if (ahead && stored) {
      entry.log = ahead;
      if (stored.clockFrom) entry.clockFrom = stored.clockFrom;
      v = judgeInbound(local(), payload);
    }
  }
  const shown = ui.active === entry.sessionId && ui.view === "game";
  switch (v.kind) {
    case "stale":
      return;
    case "unsupported":
      if (!ui.unsupportedShown.has(entry.sessionId)) {
        ui.unsupportedShown.add(entry.sessionId);
        toast(t("toast.unsupported", { name: personName(entry) }));
      }
      return;
    case "claim": {
      // They say our time ran out: only our own records decide.
      const st = stateOf(entry);
      if (!st || entry.myColor === null) return;
      const d = decideClaim(
        { state: st, myColor: entry.myColor, logLength: entry.log.length, clockFrom: entry.clockFrom, awaiting: false },
        Date.now(),
      );
      if (d.accept) {
        const name = personName(entry);
        if (await takeOwnStep(entry, timeoutOf(entry.myColor))) {
          if (shown) say(t("say.youTimedOut", { name }));
          else toast(t("say.youTimedOut", { name }));
          render();
        }
      } else {
        console.info("go.claim_refused", { session_id: entry.sessionId });
        toast(t("claim.youRefused", { name: personName(entry) }));
        await sendExtra(entry, { refusedMs: d.leftMs });
      }
      return;
    }
    case "claim-refused":
      if (hasPendingClaim(entry)) {
        entry.claimedAt = undefined;
        entry.theirHint = { n: entry.log.length, at: Date.now() + v.leftMs };
        void persist(entry);
        toast(t("claim.refused", { name: personName(entry) }));
        render();
      }
      return;
    case "refuse":
      console.warn("go.inbound_refused", { session_id: entry.sessionId, reason: v.reason });
      entry.outOfStep = (entry.outOfStep ?? 0) + 1;
      if (shown) render();
      return;
    case "apply": {
      const before = stateOf(entry);
      const fresh = entry.size === null;
      entry.size = v.size;
      entry.myColor = v.myColor;
      entry.handicap = v.rules.handicap;
      entry.days = v.rules.days;
      entry.log = v.log;
      // Our turn (or theirs) starts when this side first has it — never a time from them.
      entry.clockFrom = markFor(entry.clockFrom, entry.log.length, Date.now());
      remember(entry.log, v.state);
      entry.heard = true;
      entry.outOfStep = 0;
      entry.updatedAt = Date.now();
      void persist(entry);
      if (shown) {
        if (fresh) ui.cursor = startCursor(v.size, v.state.lastMove);
        else if (v.state.lastMove !== null) ui.cursor = v.state.lastMove;
        ui.preview = null;
        ui.hint = null;
        for (const line of announceInbound(entry, v.added, before, v.state)) say(line);
        const focused = document.activeElement?.closest("#board-grid") != null;
        renderGame();
        if (focused) focusPoint(ui.cursor);
      } else {
        if (v.added.some(isTimeout)) toast(t("say.theyTimedOut", { name: personName(entry) }));
        else if (v.added.length > 0) toast(t("toast.newsIn", { name: personName(entry) }));
        render();
      }
      return;
    }
  }
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

/** We were invited: the board and colours come with the inviter's first message. */
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
    void takeTableMessage(event).catch((err) => console.error("go.table_message_failed", err));
    return;
  }
  handleTableAction(classifyTableEvent(event, ui.games));
}

/**
 * A message at a table: routed by the table Social Home delivered it for and
 * the sender's seat (never an id in the payload), then judged like any
 * 1:1 message (moves, passes, markings, resignations, claims).
 */
async function takeTableMessage(msg: GroupMessage): Promise<void> {
  if (!isGoMessage(msg.data)) return;
  let route = routeTableMessage(msg, ui.games);
  if (route.kind === "drop" && route.reason === "no-opponent-yet") {
    // A move before the roster said who sat down: ask Social Home for the table once.
    const session = await client.group.get(msg.id).catch(() => null);
    if (session) seatTable(session);
    route = routeTableMessage(msg, ui.games);
  }
  if (route.kind === "drop") {
    console.warn("go.table_dropped", { session_id: msg.id, reason: route.reason });
    return;
  }
  const entry = route.entry;
  await withGame(entry.sessionId, () => takeMessage(entry, msg.data));
}

function handleTableAction(action: TableAction): void {
  switch (action.kind) {
    case "seat": {
      const entry = seatTable(action.session);
      if (entry && ui.launchTable === entry.sessionId) {
        ui.launchTable = null;
        openGame(entry.sessionId);
      } else {
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

/** Someone took the seat at our open game: they play Black and move first. */
function onSeatTaken(entry: GameEntry): void {
  entry.updatedAt = Date.now();
  void persist(entry);
  const text = t("table.joined", { name: opponentLabel(entry) });
  if (ui.view === "game" && ui.active === entry.sessionId) say(text);
  else toast(text);
  render();
}

/** Our game for a table we sit at: the one we have (names refreshed), or a new one. */
function seatTable(session: GroupSession): GameEntry | null {
  const known = ui.games.get(session.id);
  if (known) {
    if (!known.table) return null; // a 1:1 game's id never becomes a table
    const { changed, joined } = updateFromTable(known, session);
    if (joined) onSeatTaken(known);
    else if (changed) void persist(known);
    return known;
  }
  const entry = entryForTable(session, Date.now());
  if (!entry) return null;
  ui.games.set(entry.sessionId, entry);
  void persist(entry);
  return entry;
}

/**
 * On open: what happened at our tables while Go was closed — someone took
 * the seat, the table ended, we left on another screen — and tables we sit
 * at but have no game for yet (opened on another screen).
 */
async function syncTables(): Promise<void> {
  let tables: GroupSession[];
  try {
    tables = await client.group.list();
  } catch (err) {
    console.info("go.no_tables", err);
    return;
  }
  for (const session of tables) {
    const known = ui.games.get(session.id);
    if (!known) {
      if (isPlayableTable(session)) seatTable(session);
      continue;
    }
    if (!known.table) continue;
    if (session.myState === "left" || session.myState === "removed") {
      handleTableAction({ kind: "mine-over", entry: known });
    } else if (session.state === "ended") {
      handleTableAction(classifyTableEvent({ type: "ended", id: session.id, session }, ui.games));
    } else {
      seatTable(session);
    }
  }
}

/** Messages at our tables that waited while Go was closed (each player's latest). */
async function applyGroupHeld(): Promise<void> {
  let held: GroupMessage[];
  try {
    held = await client.group.held();
  } catch (err) {
    console.info("go.no_held_table_messages", err);
    return;
  }
  for (const msg of held) {
    await takeTableMessage(msg).catch((err) => console.error("go.held_table_message_failed", err));
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
        const entry = seatTable(launch.session);
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
    // A step that didn't go out (offline when it was made): send it now.
    for (const entry of ui.games.values()) {
      if (entry.unsent) void withGame(entry.sessionId, () => sendState(entry));
    }
  } catch (err) {
    flushEarlyTableEvents();
    console.error("go.init_failed", err);
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
    if (!entry || entry.days === 0) return;
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
