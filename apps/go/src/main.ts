/**
 * Go — the UI and its life cycle (the engine is pure and tested: rules,
 * game, inbound; the words: view, i18n).
 *
 *  - `ui.games` Map<sessionId, GameEntry>, kept per person in `sh.store`
 *    under "game:<sessionId>"; the new-game choices under "pref:size" and
 *    "pref:color".
 *  - Views: lobby (new game + games), game (board, counting, the end).
 *  - Every message carries the whole game. Inbound messages are judged by
 *    `judgeInbound`; work on one game is serialized (`withGame`) so live and
 *    held copies never race.
 *  - Nothing new is sent after a game's final step: a retry only sends the
 *    same final log again.
 */

import sh, { ShError } from "@socialhome/app-sdk";
import type { AppLook, AppMessage, Contact, PickedPerson } from "@socialhome/app-sdk";
import { BLACK, COLUMNS, EMPTY, isSize, pointName, scoreArea, starPoints } from "./rules.js";
import type { Color, Size } from "./rules.js";
import { MAX_LOG, applyEntry, passesTurn, resignBy, sameEntry, toggleChain, whyNot } from "./game.js";
import type { Entry, GameState } from "./game.js";
import { buildMessage, catchUpFromOwnCopy, isGoMessage, judgeInbound } from "./inbound.js";
import {
  classifySessionEvent,
  continueCopy,
  entryForInvite,
  entryForPicked,
  isAwaitingOpponent,
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
import { announceInbound, announceOwn, cellLabel, chipFor, colorName, metaFor, resultLine, sizeName, statusFor } from "./view.js";
import type { CellView } from "./view.js";
import { isNavKey, moveCursor, needsConfirm, startCursor } from "./board-nav.js";
import { createAnnouncer } from "./announcer.js";
import type { Announcer } from "./announcer.js";
import { num, t } from "./i18n.js";
import type { MessageKey } from "./i18n.js";
import { applyLook } from "./look.js";

const client = sh as NonNullable<typeof sh>;

type View = "lobby" | "game";

interface UI {
  view: View;
  active: string | null;
  selfUserId: string;
  contacts: Contact[];
  games: Map<string, GameEntry>;
  size: Size;
  colorChoice: ColorChoice;
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
}

const ui: UI = {
  view: "lobby",
  active: null,
  selfUserId: "",
  contacts: [],
  games: new Map(),
  size: 9,
  colorChoice: "random",
  cursor: 40,
  preview: null,
  marking: null,
  markingAt: -1,
  hint: null,
  liveInvites: false,
  reducedMotion: false,
  unsupportedShown: new Set(),
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const PREFIX = "game:";
const PREF_SIZE = "pref:size";
const PREF_COLOR = "pref:color";

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
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PREFIX)) {
      const entry = parseEntry(value);
      if (entry) ui.games.set(entry.sessionId, entry);
    } else if (key === PREF_SIZE && isSize(value)) {
      ui.size = value;
    } else if (key === PREF_COLOR && (value === "b" || value === "w" || value === "random")) {
      ui.colorChoice = value;
    }
  }
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
      void client.store.set(PREF_SIZE, v).catch(() => {});
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
      void client.store.set(PREF_COLOR, v).catch(() => {});
    }, stoneSwatch),
  );
  card.appendChild(
    button(t("btn.newGame"), "primary wide", () => void startNewGame(null, ui.size, resolveColor(ui.colorChoice)), { "data-new-game": "" }),
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
        button(t("btn.rematch"), "", () => void startNewGame(c, ui.size, resolveColor(ui.colorChoice)), {
          "aria-label": t("btn.rematchWho", { name: c.display_name }),
        }),
      );
      list.appendChild(li);
    }
    r.appendChild(list);
  }
}

function miniStone(c: Color | null): HTMLElement {
  return make("span", { cls: `swatch swatch-${c ?? "random"}`, attrs: { "aria-hidden": "true" } });
}

function gameCard(entry: GameEntry): HTMLElement {
  const name = entry.opponentName;
  const li = make("li", { cls: "card game" });
  const top = make("div", { cls: "game-top" });
  top.append(miniStone(entry.myColor), make("span", { cls: "who", text: name }));
  const chip = chipFor(entry);
  top.append(make("span", { cls: `chip ${chip.tone}`, text: chip.text }));
  li.appendChild(top);
  li.appendChild(make("p", { cls: "muted small meta", text: metaFor(entry) }));
  const acts = make("div", { cls: "acts" });
  const open = () => openGame(entry.sessionId);
  const attrs = { "aria-label": t("btn.openWith", { name }), "data-open": entry.sessionId };
  acts.append(isMyTurn(entry) ? button(t("btn.play"), "primary", open, attrs) : button(t("btn.open"), "", open, attrs));
  if (isAwaitingOpponent(entry)) acts.append(button(t("btn.cancelInvite"), "ghost", () => void cancelInvite(entry)));
  if (stateOf(entry)?.phase === "over") {
    acts.append(button(t("btn.rematch"), "", () => void rematch(entry), { "aria-label": t("btn.rematchWho", { name }) }));
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
  const name = personName(entry);
  const hadBoardFocus = document.activeElement?.closest("#board-grid") != null;
  const r = root();
  r.replaceChildren();
  r.className = "view-game";

  const top = make("div", { cls: "topbar" });
  const back = make("button", { cls: "btn ghost back", attrs: { type: "button", "aria-label": t("game.backLabel") } });
  back.append(make("span", { cls: "flip-rtl", text: "←", attrs: { "aria-hidden": "true" } }), ` ${t("game.back")}`);
  back.addEventListener("click", toLobby);
  top.append(back, make("h2", { cls: "title", text: entry.opponentName }));
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
  layout.appendChild(boardEl(entry, st));
  layout.appendChild(sidePanel(entry, st, name));
  r.appendChild(layout);
  if (hadBoardFocus) focusPoint(ui.cursor);
}

function sidePanel(entry: GameEntry, st: GameState, name: string): HTMLElement {
  const side = make("div", { cls: "side" });
  const me = entry.myColor!;
  const them: Color = me === "b" ? "w" : "b";

  // Players + captures
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
    return li;
  };
  players.append(playerRow(them, name), playerRow(me, t("game.you")));
  side.appendChild(players);

  if (st.phase === "over") {
    side.appendChild(resultCard(entry, st));
    const row = make("div", { cls: "row acts" });
    row.append(button(t("btn.rematch"), "primary", () => void rematch(entry)), button(t("btn.backToGames"), "", toLobby));
    side.appendChild(row);
    return side;
  }

  const s = statusFor(entry);
  const status = make("div", { cls: "status", attrs: { role: "status" } });
  status.append(make("div", { cls: "big", text: s.title }));
  if (s.detail) status.append(make("p", { cls: "muted", text: s.detail }));
  side.appendChild(status);

  if ((entry.outOfStep ?? 0) > 0) {
    side.appendChild(make("p", { cls: "card notice small", text: t("notice.refused", { name }), attrs: { role: "status" } }));
  }
  if (entry.unsent) {
    const bar = make("div", { cls: "card notice unsent", attrs: { role: "alert" } });
    bar.append(make("span", { text: t("unsent.text", { name }) }), button(t("btn.retry"), "primary", () => void retrySend(entry)));
    side.appendChild(bar);
  }
  if (ui.hint) side.appendChild(make("p", { cls: "hint small", text: ui.hint }));

  const mine = isMyTurn(entry);
  const acts = make("div", { cls: "row acts" });
  if (st.phase === "counting") {
    const dead = shownDead(st);
    const score = scoreArea(st.board, st.size, dead);
    side.appendChild(make("p", { cls: "preview-score", text: t("count.preview", { b: num(score.b.total), w: num(score.w.total) }) }));
    if (mine) {
      const agrees = !!st.proposal && st.proposal.by !== me && sameEntry(st.proposal.dead, ui.marking ?? []);
      acts.append(button(agrees ? t("btn.agree") : t("btn.sendMarking"), "primary", () => void onMark(entry), { "data-mark": "" }));
      acts.append(button(t("btn.resume"), "", () => void onStep(entry, "resume")));
      side.appendChild(acts);
      side.appendChild(make("p", { cls: "muted small", text: t("count.resumeNote") }));
    }
  } else if (mine) {
    if (ui.preview !== null) {
      acts.append(
        button(t("btn.place", { point: pointName(st.size, ui.preview) }), "primary", () => void onPlace(entry, ui.preview!), { "data-place": "" }),
        button(t("btn.cancel"), "ghost", () => {
          ui.preview = null;
          renderGame();
        }),
      );
    }
    acts.append(button(t("btn.pass"), "", () => void onStep(entry, "pass"), { "data-pass": "" }));
    side.appendChild(acts);
  } else if (isAwaitingOpponent(entry)) {
    acts.append(button(t("btn.cancelInvite"), "ghost", () => void cancelInvite(entry)));
    side.appendChild(acts);
  }
  side.appendChild(
    button(t("btn.resign"), "ghost danger resign", () => void onResign(entry)),
  );
  side.appendChild(make("p", { cls: "muted small keys", text: t("game.keys") }));
  if (st.n >= MAX_LOG - 1) side.appendChild(make("p", { cls: "muted small", text: t("illegal.long") }));
  return side;
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
    st.result?.by === "score" ? st.result.score.owner : st.phase === "counting" ? scoreArea(st.board, size, dead).owner : null;
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

/** Send our whole game to the opponent. */
async function sendState(entry: GameEntry): Promise<void> {
  if (entry.size === null || entry.myColor === null) return;
  const st = stateOf(entry);
  if (!st) return;
  // Only when our step hands them the turn (never the setup, a resignation or the end).
  const turn = entry.log.length > 0 && passesTurn(st, entry.myColor);
  try {
    await client.federation.send(entry.sessionId, targetFor(entry), buildMessage(entry.size, entry.myColor, entry.log), { turn });
    if (entry.unsent) {
      entry.unsent = false;
      void persist(entry);
      if (ui.active === entry.sessionId) render();
    }
  } catch (err) {
    if (isUnknownGame(err)) {
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

async function startNewGame(suggest: Contact | null, size: Size, color: Color): Promise<void> {
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
  const entry = entryForPicked(p, size, color);
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
  await startNewGame(contactFor(entry), r.size, r.color);
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
  let v = judgeInbound({ size: entry.size, myColor: entry.myColor, log: entry.log }, payload);
  if (v.kind === "refuse" && entry.size !== null && (v.reason === "wrong-player" || v.reason === "too-many" || v.reason === "rewrite")) {
    // This screen may be behind our own store (the same person played on another screen).
    const stored = parseEntry(await client.store.get(PREFIX + entry.sessionId).catch(() => null));
    const ahead = stored ? catchUpFromOwnCopy(entry.size, entry.log, stored.log) : null;
    if (ahead) {
      entry.log = ahead;
      v = judgeInbound({ size: entry.size, myColor: entry.myColor, log: entry.log }, payload);
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
      entry.log = v.log;
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
        if (v.added.length > 0) toast(t("toast.newsIn", { name: personName(entry) }));
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
    // A step that didn't go out (offline when it was made): send it now.
    for (const entry of ui.games.values()) {
      if (entry.unsent) void withGame(entry.sessionId, () => sendState(entry));
    }
  } catch (err) {
    console.error("go.init_failed", err);
    const box = make("div", { cls: "card error", attrs: { role: "alert" } });
    box.append(make("p", { text: t("app.loadFailed") }), button(t("btn.retry"), "primary", () => void main()));
    root().replaceChildren(box);
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
  void main();
}
