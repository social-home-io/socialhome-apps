/**
 * Gift draw — the app's screens (DOM glue; the decisions are in view.ts,
 * rules.ts, share.ts and persist.ts, which are unit-tested).
 *
 * The app sets a gift draw up and shows where it is; **Social Home draws
 * the names** (`sh.engines.draw`, SDK 1.11) and shows each person whom they give to
 * in its own sheet (`sh.engines.draw.reveal`). No call gives the app a result, and
 * the app never stores or shows one.
 *
 * - New gift draw: name, budget, exchange day and the person's own wish
 *   list, then Social Home's sheet asks whom to invite (`sh.group.open`). A
 *   gift draw started from a space's Games opens straight on its page.
 * - A gift draw: who's in, the details (the organiser edits them and the
 *   pairs who shouldn't draw each other, and shares them with
 *   `sh.group.send`), the wish list, Draw names; then Drawing names…, with
 *   the homes it waits for (Draw without them = `sh.group.remove`); then
 *   "Your name is ready" → See who you're giving to, Update my wish list,
 *   and the organiser's Draw again.
 * - The app never closes a gift draw: closing it would take everyone's
 *   names away before the exchange day.
 */

import { sh, DRAW_WISH_MAX_CHARS } from "@socialhome/app-sdk";
import { withDraw } from "@socialhome/app-sdk/draw";
import { withGroups } from "@socialhome/app-sdk/group";
import type { AppContext, DrawSettings, DrawStatus, GroupEvent, GroupMessage, GroupSession } from "@socialhome/app-sdk";
import { createAnnouncer } from "./announcer.js";
import { errorKey } from "./errors.js";
import { getLocale, list, t } from "./i18n.js";
import type { MessageKey } from "./i18n.js";
import { applyLook } from "./look.js";
import { EMPTY_DRAFT, clearDraft, forgetDetails, loadDetails, loadDraft, saveDetails, saveDraft } from "./persist.js";
import type { Draft } from "./persist.js";
import {
  BUDGET_MAX,
  NAME_MAX,
  addPair,
  againLeft,
  canAddPair,
  canDrawAgain,
  cleanLine,
  formatDay,
  isPastDay,
  removePair,
  todayIso,
  unpaired,
  wishLength,
} from "./rules.js";
import type { Pair } from "./rules.js";
import { detailsMessage, readDetails } from "./share.js";
import {
  canEditDetails,
  chipOf,
  drawBlock,
  blamedHomes,
  homesCount,
  isOurTable,
  listOrder,
  livePairs,
  namesOf,
  organiserName,
  phaseOf,
  progressOf,
  seatSet,
  seatedPeople,
  shownDetails,
  waitingHomes,
} from "./view.js";
import type { Phase } from "./view.js";

const client = withDraw(withGroups(sh!));

type Route = { kind: "home" } | { kind: "new" } | { kind: "table"; id: string };
type Confirm = { kind: "again"; id: string } | { kind: "without"; id: string; seats: number[]; names: string[] };

const state = {
  ctx: null as AppContext | null,
  screen: "loading" as "loading" | "failed" | "unsupported" | "noPeople" | "ready",
  route: { kind: "home" } as Route,
  tables: new Map<string, GroupSession>(),
  status: new Map<string, DrawStatus>(),
  statusFailed: new Set<string>(),
  shared: new Map<string, DrawSettings>(),
  draft: { ...EMPTY_DRAFT } as Draft,
  wishDraft: new Map<string, string>(),
  detailsDraft: new Map<string, { name: string; budget: string; day: string }>(),
  notice: null as { text: string; error: boolean } | null,
  busy: false,
  confirm: null as Confirm | null,
  /** Waiting homes the organiser chose to keep waiting for (by their seats). */
  keptWaiting: new Set<string>(),
};

const root = (): HTMLElement => document.getElementById("app-root")!;
let live: HTMLElement | null = null;
const announcer = createAnnouncer((text) => {
  if (live) live.textContent = text;
});

// ─── DOM helpers ───────────────────────────────────────────────────────────

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids) {
    if (kid === null || kid === false) continue;
    node.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return node;
}

function button(label: string, onclick: () => void, attrs: Attrs = {}): HTMLButtonElement {
  return el("button", { type: "button", class: "btn", onclick: () => onclick(), disabled: state.busy, ...attrs }, label);
}

function field(id: string, label: string, input: HTMLElement, help?: Node | string, optional = false): HTMLElement {
  return el(
    "div",
    { class: "field" },
    el("label", { for: id }, label, optional ? el("span", { class: "muted small" }, ` ${t("field.optional")}`) : null),
    input,
    help ? el("p", { class: "help", id: `${id}-help` }, help) : null,
  );
}

// ─── Rendering ─────────────────────────────────────────────────────────────

function render(): void {
  const active = document.activeElement as HTMLInputElement | null;
  const focusId = active && active !== document.body ? active.id : "";
  const sel = focusId && "selectionStart" in active! ? [active!.selectionStart, active!.selectionEnd] : null;

  const main = root();
  main.replaceChildren();
  live = el("div", { class: "sr-only", "aria-live": "polite", id: "live" });
  main.append(live);
  if (state.notice) {
    main.append(
      el(
        "p",
        { class: state.notice.error ? "notice error" : "notice", role: state.notice.error ? "alert" : "status" },
        state.notice.text,
      ),
    );
  }
  switch (state.screen) {
    case "loading":
      main.append(el("p", { class: "muted" }, t("app.loading")));
      break;
    case "failed":
      main.append(el("p", {}, t("app.loadFailed")), button(t("btn.retry"), () => void start(), { class: "btn" }));
      break;
    case "unsupported":
      main.append(message(t("unsupported.title"), t("unsupported.body")));
      break;
    case "noPeople":
      main.append(message(t("noPeople.title"), t("noPeople.body")));
      break;
    case "ready":
      if (state.route.kind === "new") main.append(newScreen());
      else if (state.route.kind === "table") main.append(tableScreen(state.route.id));
      else main.append(homeScreen());
  }

  if (focusId) {
    const again = document.getElementById(focusId) as HTMLInputElement | null;
    if (again) {
      again.focus();
      if (sel && "setSelectionRange" in again && sel[0] !== null) {
        try {
          again.setSelectionRange(sel[0], sel[1]);
        } catch {
          // Inputs without a selection (date) refuse it.
        }
      }
    }
  }
}

function message(title: string, body: string): HTMLElement {
  return el("section", { class: "card" }, el("h2", {}, title), el("p", {}, body));
}

function about(): HTMLElement {
  return el(
    "details",
    { class: "about" },
    el("summary", {}, t("about.title")),
    el("p", {}, t("about.how")),
    el("p", {}, t("about.limits")),
  );
}

function titleOf(id: string): string {
  const d = shownDetails(state.status.get(id), state.shared.get(id));
  return d?.name || t("home.untitled");
}

function phase(id: string): Phase {
  const table = state.tables.get(id);
  if (!table) return "ended";
  return phaseOf(table, state.status.get(id), state.statusFailed.has(id));
}

// ─── Home: the person's gift draws ─────────────────────────────────────────

function homeScreen(): HTMLElement {
  const appId = state.ctx?.appId ?? "";
  const rows = [...state.tables.values()]
    .filter((tb) => isOurTable(tb, appId) && phase(tb.id) !== "gone")
    .sort((a, b) => listOrder(phase(a.id), phase(b.id)));
  const listEl = el("ul", { class: "draws" });
  for (const tb of rows) {
    const n = seatedPeople(tb).length;
    const chip = chipOf(phase(tb.id));
    const name = titleOf(tb.id);
    listEl.append(
      el(
        "li",
        {},
        el(
          "button",
          { type: "button", class: "row", id: `open-${tb.id}`, "aria-label": t("home.openLabel", { name }), onclick: () => go({ kind: "table", id: tb.id }) },
          el("span", { class: "row-main" }, el("span", { class: "row-name" }, name), el("span", { class: "muted small" }, n === 1 ? t("home.people_one") : t("home.people", { n }))),
          chip ? el("span", { class: `chip chip-${chip}` }, t(`chip.${chip}` as MessageKey)) : null,
        ),
      ),
    );
  }
  return el(
    "section",
    { class: "screen" },
    el("p", { class: "lead" }, t("home.intro")),
    button(t("home.new"), () => go({ kind: "new" }), { class: "btn pri block-m", id: "new-draw" }),
    el("h2", { class: "section-title" }, t("home.list")),
    rows.length ? listEl : el("p", { class: "muted" }, t("home.empty")),
    about(),
  );
}

// ─── New gift draw ─────────────────────────────────────────────────────────

function wishField(id: string, value: string, onInput: (v: string) => void, label: MessageKey = "wish.label", helpKey: MessageKey = "wish.help"): HTMLElement {
  const counter = el("span", { class: "count", id: `${id}-count` });
  const over = el("span", { class: "over", id: `${id}-over` });
  const update = (v: string): void => {
    const n = wishLength(v);
    counter.textContent = t("wish.count", { n, max: DRAW_WISH_MAX_CHARS });
    over.textContent = n > DRAW_WISH_MAX_CHARS ? ` ${t("wish.tooLong", { n: n - DRAW_WISH_MAX_CHARS })}` : "";
    area.setAttribute("aria-invalid", String(n > DRAW_WISH_MAX_CHARS));
  };
  const area = el("textarea", {
    id,
    class: "input area",
    rows: 4,
    "aria-describedby": `${id}-help`,
    oninput: (e: Event) => {
      const v = (e.target as HTMLTextAreaElement).value;
      onInput(v);
      update(v);
    },
  });
  area.value = value;
  update(value);
  return field(id, t(label), area, el("span", {}, `${t(helpKey)} `, counter, over), true);
}

function newScreen(): HTMLElement {
  const d = state.draft;
  const today = todayIso();
  const keep = (): void => void saveDraft(client.store, state.draft).catch(() => undefined);
  const name = el("input", {
    id: "new-name", class: "input", maxlength: NAME_MAX, placeholder: t("field.namePh"), autocomplete: "off",
    oninput: (e: Event) => { state.draft.name = (e.target as HTMLInputElement).value; keep(); },
  });
  name.value = d.name;
  const budget = el("input", {
    id: "new-budget", class: "input", maxlength: BUDGET_MAX, placeholder: t("field.budgetPh"), autocomplete: "off",
    oninput: (e: Event) => { state.draft.budget = (e.target as HTMLInputElement).value; keep(); },
  });
  budget.value = d.budget;
  const day = el("input", {
    id: "new-day", class: "input", type: "date", min: today,
    oninput: (e: Event) => { state.draft.day = (e.target as HTMLInputElement).value; keep(); },
  });
  day.value = d.day;
  // Not a <form>: the sandbox (no allow-forms) blocks form submission
  // before a submit event could be handled.
  return el(
    "section",
    { class: "screen" },
    backButton(),
    el("h2", { class: "title" }, t("new.title")),
    el("p", { class: "lead" }, t("new.lead")),
    field("new-name", t("field.name"), name),
    el("div", { class: "two" }, field("new-budget", t("field.budget"), budget, undefined, true), field("new-day", t("field.day"), day, undefined, true)),
    el("div", { class: "field" }, el("p", { class: "label" }, t("pairs.title"), el("span", { class: "muted small" }, ` ${t("field.optional")}`)), el("p", { class: "help" }, t("new.pairsHint"))),
    wishField("new-wish", d.wish, (v) => { state.draft.wish = v; keep(); }),
    el("p", { class: "help" }, t("new.next")),
    el(
      "div",
      { class: "actions" },
      button(t("new.send"), () => void createDraw(), { class: "btn pri lg block-m", id: "new-send" }),
      button(t("btn.cancel"), () => go({ kind: "home" }), { class: "btn ghost" }),
    ),
    about(),
  );
}

async function createDraw(): Promise<void> {
  const d = state.draft;
  if (d.day && isPastDay(d.day, todayIso())) return say(t("field.dayPast"), true);
  if (wishLength(d.wish) > DRAW_WISH_MAX_CHARS) return say(t("err.wishTooLong"), true);
  await act(async () => {
    const table = await client.group.open();
    if (!table) return;
    state.tables.set(table.id, table);
    try {
      const st = await client.engines.draw.configure(table.id, {
        name: cleanLine(d.name, NAME_MAX),
        budget: cleanLine(d.budget, BUDGET_MAX),
        day: d.day || null,
      });
      state.status.set(table.id, st);
      if (d.wish.trim()) state.status.set(table.id, await client.engines.draw.setWishes(table.id, d.wish));
      await share(table.id);
    } finally {
      state.draft = { ...EMPTY_DRAFT };
      void clearDraft(client.store).catch(() => undefined);
      state.route = { kind: "table", id: table.id };
    }
  });
}

// ─── One gift draw ─────────────────────────────────────────────────────────

function backButton(): HTMLElement {
  return el(
    "button",
    { type: "button", class: "back", id: "back", "aria-label": t("btn.backLabel"), onclick: () => go({ kind: "home" }) },
    el("span", { class: "flip-rtl", "aria-hidden": "true" }, "←"),
    ` ${t("btn.back")}`,
  );
}

function tableScreen(id: string): HTMLElement {
  const table = state.tables.get(id);
  const out = el("section", { class: "screen" }, backButton());
  if (!table) {
    out.append(el("h2", { class: "title" }, t("ended.title")));
    return out;
  }
  const status = state.status.get(id);
  const ph = phase(id);
  const details = shownDetails(status, state.shared.get(id));
  const people = seatedPeople(table);
  const isHost = status?.isHost ?? table.isHost;

  // The draw's name above the heading — unless the heading is the name.
  if (ph !== "gathering") out.append(el("p", { class: "small muted kicker" }, titleOf(id)));

  switch (ph) {
    case "invited":
      out.append(el("h2", { class: "title" }, t("invited.title")), el("p", { class: "lead" }, t("invited.body")));
      return out;
    case "joining":
      out.append(el("h2", { class: "title" }, t("joining.title")), el("p", { class: "lead" }, t("joining.body")));
      return out;
    case "gone":
      out.append(el("h2", { class: "title" }, t("gone.title")));
      return out;
    case "ended":
      out.append(el("h2", { class: "title" }, t("ended.title")), el("p", { class: "lead" }, t("ended.body")));
      return out;
    case "loading":
      out.append(el("p", { class: "muted" }, t("app.loading")));
      return out;
    case "error":
      out.append(el("p", {}, t("app.loadFailed")), button(t("btn.retry"), () => void refresh(id), { id: "retry" }));
      return out;
    default:
      break;
  }
  const st = status!;

  // Where the draw is.
  if (ph === "gathering") {
    out.append(el("h2", { class: "title" }, details?.name || t("home.untitled")));
  } else if (ph === "drawing") {
    out.append(el("h2", { class: "title" }, t("drawing.title")), el("p", { class: "lead" }, t("drawing.body")));
    const prog = progressOf(st, homesCount(people));
    if (prog) {
      const label = t("drawing.progress", prog);
      out.append(
        el("div", { class: "prog", role: "progressbar", "aria-valuenow": prog.done, "aria-valuemin": 0, "aria-valuemax": prog.of, "aria-label": label },
          el("i", { style: `inline-size:${Math.round((100 * prog.done) / prog.of)}%` })),
        el("p", { class: "small muted" }, label),
      );
    }
    out.append(...waitingCallouts(table, st));
  } else if (ph === "ready") {
    out.append(
      el("h2", { class: "title" }, t("ready.title")),
      el("p", { class: "lead" }, t("ready.body")),
      button(t("ready.see"), () => void reveal(id), { class: "btn pri lg block-m", id: "reveal" }),
    );
    if (st.again > 0) out.append(el("p", { class: "small muted" }, t("ready.again", { n: st.again + 1 })));
  } else if (ph === "readyNoName") {
    out.append(el("h2", { class: "title" }, t("noName.title")), el("p", { class: "lead" }, t("noName.body")));
  } else if (ph === "failedRules") {
    out.append(el("h2", { class: "title" }, t("failedRules.title")), el("p", { class: "lead" }, t("failedRules.body")));
    out.append(el("p", {}, isHost ? t("failedRules.fix") : t("failed.wait", { name: organiserName(table) })));
  } else if (ph === "failedTooFew") {
    out.append(el("h2", { class: "title" }, t("failedTooFew.title")), el("p", { class: "lead" }, t("failedTooFew.body")));
  } else if (ph === "failedBroken") {
    out.append(el("h2", { class: "title" }, t("failedBroken.title")), el("p", { class: "lead" }, isHost ? t("failedBroken.fix") : t("failed.wait", { name: organiserName(table) })));
  } else if (ph === "failed") {
    out.append(el("h2", { class: "title" }, t("failed.title")), el("p", { class: "lead" }, isHost ? t("failed.fix") : t("failed.wait", { name: organiserName(table) })));
  }
  for (const names of blamedHomes(table, st)) {
    out.append(el("p", { class: "callout" }, t(isHost ? "blamed" : "blamed.others", { names: list(names) })));
  }

  // Who started it, and the details.
  out.append(el("p", { class: "muted" }, isHost ? t("table.youStarted") : t("table.started", { name: organiserName(table) })));
  out.append(detailsSummary(table, details));

  const editable = canEditDetails(st);
  const pairs = livePairs(table, details);
  if (editable) out.append(detailsEditor(id, details), pairsEditor(id, table, pairs));
  else if (pairs.length > 0) {
    out.append(el("p", { class: "small" }, t("pairs.shown", { list: pairs.map(([a, b]) => t("pairs.item", { a: namesOf(table, [a])[0], b: namesOf(table, [b])[0] })).join("; ") })));
  }

  // Draw names / Draw again.
  if (editable) out.append(drawNamesBlock(id, table, pairs, st.state === "failed"));
  else if (ph === "gathering") out.append(el("p", { class: "muted" }, t("draw.wait", { name: organiserName(table) })));
  if (ph === "ready" || ph === "readyNoName") {
    if (canDrawAgain(st, todayIso())) out.append(drawAgainBlock(id, st));
  }

  // The wish list: before the reveal, and as an update after it.
  if (ph === "gathering" || ph === "drawing" || ph.startsWith("failed")) {
    out.append(wishBlock(id, st, false));
  } else if (ph === "ready") {
    out.append(wishBlock(id, st, true));
  }

  out.append(peopleBlock(table), about());
  return out;
}

function detailsSummary(table: GroupSession, details: DrawSettings | null): HTMLElement {
  const box = el("div", { class: "facts" });
  if (!details) {
    box.append(el("p", { class: "muted" }, t("det.none", { name: organiserName(table) })));
    return box;
  }
  if (details.budget) box.append(el("p", {}, t("det.budget", { budget: details.budget })));
  if (details.day) box.append(el("p", {}, t("det.day", { day: formatDay(details.day, getLocale()) })));
  return box;
}

function detailsEditor(id: string, details: DrawSettings | null): HTMLElement {
  const cur = state.detailsDraft.get(id) ?? { name: details?.name ?? "", budget: details?.budget ?? "", day: details?.day ?? "" };
  const set = (k: "name" | "budget" | "day", v: string): void => {
    state.detailsDraft.set(id, { ...(state.detailsDraft.get(id) ?? cur), [k]: v });
  };
  const name = el("input", { id: "det-name", class: "input", maxlength: NAME_MAX, placeholder: t("field.namePh"), oninput: (e: Event) => set("name", (e.target as HTMLInputElement).value) });
  name.value = cur.name;
  const budget = el("input", { id: "det-budget", class: "input", maxlength: BUDGET_MAX, placeholder: t("field.budgetPh"), oninput: (e: Event) => set("budget", (e.target as HTMLInputElement).value) });
  budget.value = cur.budget;
  const day = el("input", { id: "det-day", class: "input", type: "date", min: todayIso(), oninput: (e: Event) => set("day", (e.target as HTMLInputElement).value) });
  day.value = cur.day;
  return el(
    "details",
    { class: "card edit", open: !details?.name },
    el("summary", {}, t("det.title")),
    field("det-name", t("field.name"), name),
    el("div", { class: "two" }, field("det-budget", t("field.budget"), budget, undefined, true), field("det-day", t("field.day"), day, undefined, true)),
    button(t("det.save"), () => void saveDetailsNow(id), { id: "det-save" }),
  );
}

function pairsEditor(id: string, table: GroupSession, pairs: Pair[]): HTMLElement {
  const seats = seatSet(table);
  const box = el("section", { class: "card", "aria-labelledby": "pairs-title" }, el("h3", { id: "pairs-title" }, t("pairs.title"), el("span", { class: "muted small" }, ` ${t("field.optional")}`)));
  box.append(el("p", { class: "help" }, t("pairs.hint")));
  const ul = el("ul", { class: "pairs" });
  pairs.forEach(([a, b], i) => {
    const an = namesOf(table, [a])[0];
    const bn = namesOf(table, [b])[0];
    ul.append(el("li", {}, el("span", {}, t("pairs.item", { a: an, b: bn })), button(t("pairs.remove"), () => void setPairs(id, removePair(pairs, i)), { class: "btn ghost sm", id: `pair-rm-${a}`, "aria-label": t("pairs.removeLabel", { a: an, b: bn }) })));
  });
  box.append(pairs.length ? ul : el("p", { class: "muted small" }, t("pairs.none")));
  if (seats.size < 4) {
    box.append(el("p", { class: "muted small" }, t("pairs.need4")));
  } else if (!canAddPair(pairs, seats)) {
    box.append(el("p", { class: "muted small" }, t("pairs.full", { n: seats.size })));
  } else {
    const free = unpaired(pairs, seats);
    const opts = (sel: string): HTMLSelectElement => {
      const s = el("select", { id: sel, class: "input" });
      for (const seat of free) s.append(el("option", { value: seat }, namesOf(table, [seat])[0]));
      return s;
    };
    const a = opts("pair-a");
    const b = opts("pair-b");
    if (free.length > 1) b.value = String(free[1]);
    box.append(
      el("div", { class: "two" }, field("pair-a", t("pairs.first"), a), field("pair-b", t("pairs.second"), b)),
      button(t("pairs.add"), () => {
        const next = addPair(pairs, Number(a.value), Number(b.value), seats);
        if (!next || a.value === b.value) return say(t("err.pairs"), true);
        void setPairs(id, next);
      }, { id: "pair-add" }),
    );
  }
  return box;
}

/** Draw names — or, after a draw gave up, try again (Social Home counts
 *  that as a Draw again: its count and the exchange day). */
function drawNamesBlock(id: string, table: GroupSession, pairs: Pair[], retry: boolean): HTMLElement {
  const block = drawBlock(table, pairs);
  const hint = block === "few" ? t("draw.few") : block === "pairs" ? t("draw.pairs") : retry ? t("draw.retryHint") : t("draw.noJoin");
  return el(
    "div",
    { class: "actions" },
    button(retry ? t("again.btn") : t("draw.btn"), () => void drawNames(id, pairs), { class: "btn pri lg block-m", id: "draw-names", disabled: state.busy || block !== null, "aria-describedby": "draw-hint" }),
    el("p", { class: "help", id: "draw-hint" }, hint),
  );
}

function drawAgainBlock(id: string, st: DrawStatus): HTMLElement {
  if (state.confirm?.kind === "again" && state.confirm.id === id) {
    return el(
      "div",
      { class: "callout", role: "group", "aria-labelledby": "again-q" },
      el("p", { id: "again-q" }, t("again.confirm", { n: againLeft(st) })),
      el("div", { class: "actions" },
        button(t("again.btn"), () => void drawAgain(id), { class: "btn pri", id: "again-yes" }),
        button(t("btn.cancel"), () => { state.confirm = null; render(); focus("again"); }, { class: "btn ghost", id: "again-no" })),
    );
  }
  return el("div", { class: "actions" }, button(t("again.btn"), () => { state.confirm = { kind: "again", id }; render(); focus("again-yes"); }, { id: "again" }));
}

function waitingCallouts(table: GroupSession, st: DrawStatus): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const home of waitingHomes(table, st)) {
    const key = `${table.id}:${home.seats.join(",")}`;
    if (state.keptWaiting.has(key)) continue;
    const names = list(home.names);
    const confirming = state.confirm?.kind === "without" && state.confirm.id === table.id && state.confirm.seats.join() === home.seats.join();
    out.push(
      el(
        "div",
        { class: "callout", role: "group", "aria-label": t("waiting.title", { names }) },
        el("p", {}, el("b", {}, t("waiting.title", { names }))),
        el("p", { class: "small muted" }, confirming ? t("waiting.confirm", { names }) : t("waiting.body")),
        confirming
          ? el("div", { class: "actions" },
            button(t("waiting.yes"), () => void drawWithout(table.id, home.seats), { class: "btn pri", id: `without-yes-${home.seats[0]}` }),
            button(t("btn.cancel"), () => { state.confirm = null; render(); }, { class: "btn ghost", id: `without-no-${home.seats[0]}` }))
          : el("div", { class: "actions" },
            button(t("waiting.keep"), () => { state.keptWaiting.add(key); render(); focus("back"); }, { id: `keep-${home.seats[0]}` }),
            button(t("waiting.without"), () => { state.confirm = { kind: "without", id: table.id, seats: home.seats, names: home.names }; render(); focus(`without-yes-${home.seats[0]}`); }, { class: "btn ghost", id: `without-${home.seats[0]}` })),
        el("p", { class: "small muted" }, t("waiting.only")),
      ),
    );
  }
  return out;
}

function wishBlock(id: string, st: DrawStatus, after: boolean): HTMLElement {
  const value = state.wishDraft.get(id) ?? st.wish;
  return el(
    "section",
    { class: "card" },
    wishField(`wish-${id}`, value, (v) => state.wishDraft.set(id, v), after ? "wish.update" : "wish.label", after ? "wish.updateHelp" : "wish.help"),
    button(after ? t("wish.update") : t("wish.save"), () => void saveWish(id), { id: "wish-save" }),
  );
}

function peopleBlock(table: GroupSession): HTMLElement {
  const people = seatedPeople(table);
  const homes = homesCount(people);
  const ul = el("ul", { class: "people" });
  for (const p of people) {
    const bits = [p.household ?? t("people.ownHome")];
    if (p.isMe) bits.unshift(t("people.you"));
    if (p.isOrganiser) bits.push(t("people.starter"));
    ul.append(el("li", {}, el("span", { class: "av", "aria-hidden": "true" }, [...p.name][0]?.toUpperCase() ?? "?"), el("span", {}, el("span", { class: "row-name" }, p.name), el("span", { class: "muted small" }, ` · ${bits.join(" · ")}`))));
  }
  return el(
    "section",
    { class: "card", "aria-labelledby": "people-title" },
    el("h3", { id: "people-title" }, t("people.title", { n: people.length })),
    el("p", { class: "small muted" }, homes === 1 ? t("people.oneHome") : t("people.homes", { n: homes })),
    ul,
  );
}

// ─── Actions ───────────────────────────────────────────────────────────────

function say(text: string, error = false): void {
  state.notice = { text, error };
  render();
}

function focus(id: string): void {
  document.getElementById(id)?.focus();
}

function go(route: Route): void {
  state.route = route;
  state.notice = null;
  state.confirm = null;
  render();
  window.scrollTo?.(0, 0);
  focus(route.kind === "home" ? "new-draw" : route.kind === "new" ? "new-name" : "back");
  if (route.kind === "table") void refresh(route.id);
}

/** Run *fn* with the buttons off; a refusal becomes a notice. */
async function act(fn: () => Promise<void>, ok?: string): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  state.notice = null;
  render();
  try {
    await fn();
    if (ok) state.notice = { text: ok, error: false };
  } catch (err) {
    state.notice = { text: t(errorKey(err)), error: true };
  } finally {
    state.busy = false;
    render();
  }
}

async function refresh(id: string): Promise<void> {
  const table = state.tables.get(id);
  if (!table || table.myState !== "seated" || table.state === "ended") return;
  try {
    state.status.set(id, await client.engines.draw.status(id));
    state.statusFailed.delete(id);
  } catch {
    if (!state.status.has(id)) state.statusFailed.add(id);
  }
  render();
}

/** Send the organiser's details to everyone at the table (best effort). */
async function share(id: string): Promise<void> {
  const st = state.status.get(id);
  if (!st?.isHost || !st.settings) return;
  try {
    await client.group.send(id, detailsMessage(st.settings));
  } catch {
    // Nobody else seated yet, or the table's send budget: they get the
    // details when the names are drawn anyway.
  }
}

async function saveDetailsNow(id: string): Promise<void> {
  const cur = state.detailsDraft.get(id);
  const st = state.status.get(id);
  const base = st?.settings;
  const name = cleanLine(cur?.name ?? base?.name ?? "", NAME_MAX);
  const budget = cleanLine(cur?.budget ?? base?.budget ?? "", BUDGET_MAX);
  const day = cur ? cur.day || null : base?.day ?? null;
  if (day && isPastDay(day, todayIso())) return say(t("field.dayPast"), true);
  await act(async () => {
    state.status.set(id, await client.engines.draw.configure(id, { name, budget, day }));
    state.detailsDraft.delete(id);
    await share(id);
  }, t("det.saved"));
}

async function setPairs(id: string, pairs: Pair[]): Promise<void> {
  await act(async () => {
    state.status.set(id, await client.engines.draw.configure(id, { pairs }));
    await share(id);
  });
}

async function saveWish(id: string): Promise<void> {
  const st = state.status.get(id);
  const text = state.wishDraft.get(id) ?? st?.wish ?? "";
  if (wishLength(text) > DRAW_WISH_MAX_CHARS) return say(t("err.wishTooLong"), true);
  await act(async () => {
    state.status.set(id, await client.engines.draw.setWishes(id, text));
    state.wishDraft.delete(id);
  }, t("wish.saved"));
}

async function drawNames(id: string, pairs: Pair[]): Promise<void> {
  await act(async () => {
    const st = state.status.get(id);
    // Pairs of someone who left go before the names are drawn.
    const saved = st?.settings?.pairs ?? [];
    if (saved.length !== pairs.length) state.status.set(id, await client.engines.draw.configure(id, { pairs }));
    state.status.set(id, await client.engines.draw.start(id));
  });
  focus("back");
}

async function drawAgain(id: string): Promise<void> {
  state.confirm = null;
  await act(async () => {
    state.status.set(id, await client.engines.draw.start(id, { again: true }));
  });
}

async function drawWithout(id: string, seats: number[]): Promise<void> {
  state.confirm = null;
  await act(async () => {
    let table = state.tables.get(id);
    for (const seat of seats) table = await client.group.remove(id, seat);
    if (table) state.tables.set(id, table);
  });
  void refresh(id);
}

async function reveal(id: string): Promise<void> {
  try {
    await client.engines.draw.reveal(id);
  } catch (err) {
    say(t(errorKey(err)), true);
  }
}

// ─── Hearing Social Home ───────────────────────────────────────────────────

function onDetails(msg: GroupMessage): void {
  const details = readDetails(msg, state.tables.get(msg.id));
  if (!details) return;
  state.shared.set(msg.id, details);
  void saveDetails(client.store, msg.id, details).catch(() => undefined);
}

function onGroupEvent(e: GroupEvent): void {
  if (e.type === "message") {
    onDetails(e);
    render();
    return;
  }
  const before = state.tables.get(e.id);
  if (!before && !isOurTable(e.session, state.ctx?.appId ?? "")) return;
  state.tables.set(e.id, e.session);
  const name = e.type === "joined" || e.type === "left" || e.type === "removed" ? namesOf(e.session, [e.seat])[0] : undefined;
  if (e.type === "joined" && name && e.seat !== e.session.me) {
    announcer.announce(t("ann.joined", { name }));
    if (e.session.isHost) void share(e.id);
  }
  if ((e.type === "left" || e.type === "removed") && name && e.seat !== e.session.me) announcer.announce(t("ann.left", { name }));
  if (e.type === "ended") {
    state.shared.delete(e.id);
    void forgetDetails(client.store, e.id).catch(() => undefined);
  }
  render();
  if (e.type !== "joined") void refresh(e.id);
}

function onDrawStatus(st: DrawStatus): void {
  const before = state.status.get(st.id);
  state.status.set(st.id, st);
  state.statusFailed.delete(st.id);
  if (before?.state !== st.state || before.hasResult !== st.hasResult) {
    // A notice about the last step ("Wish list saved.") is stale now.
    if (!state.notice?.error) state.notice = null;
    if (st.state === "ready" && st.hasResult) announcer.announce(t("ann.ready"));
    else if (st.state === "drawing") announcer.announce(t("ann.drawing"));
    else if (st.state === "failed") announcer.announce(t("ann.failed"));
  }
  render();
}

// ─── Start ─────────────────────────────────────────────────────────────────

function applyShell(): void {
  document.title = t("app.docTitle");
  const title = document.getElementById("app-title");
  if (title) title.textContent = t("app.title");
  root().setAttribute("aria-label", t("app.mainLabel"));
}

let subscribed = false;

async function start(): Promise<void> {
  state.screen = "loading";
  render();
  try {
    const ctx = await client.context({ pullHeld: true });
    state.ctx = ctx;
    applyLook(ctx, document.documentElement);
    applyShell();
    if (!subscribed) {
      subscribed = true;
      client.onContextChange((look) => {
        applyLook(look, document.documentElement);
        applyShell();
        render();
      });
      client.group.onEvent(onGroupEvent);
      client.engines.draw.onEvent((e) => onDrawStatus(e.status));
    }
    if (!ctx.groups || !ctx.engines?.includes("draw")) {
      state.screen = "unsupported";
      render();
      return;
    }
    if (ctx.permissions && !ctx.permissions.includes("people")) {
      state.screen = "noPeople";
      render();
      return;
    }
    const kept = await client.store.list().catch(() => ({}) as Record<string, unknown>);
    state.shared = loadDetails(kept);
    state.draft = loadDraft(kept);
    for (const tb of await client.group.list()) {
      if (isOurTable(tb, ctx.appId)) state.tables.set(tb.id, tb);
    }
    const launched = ctx.launch?.group;
    if (launched) state.tables.set(launched.id, launched);
    for (const msg of await client.group.held().catch(() => [])) onDetails(msg);
    await Promise.all(
      [...state.tables.values()]
        .filter((tb) => tb.myState === "seated" && tb.state !== "ended")
        .slice(0, 30)
        .map(async (tb) => {
          try {
            state.status.set(tb.id, await client.engines.draw.status(tb.id));
          } catch {
            state.statusFailed.add(tb.id);
          }
        }),
    );
    state.screen = "ready";
    if (launched) state.route = { kind: "table", id: launched.id };
    render();
  } catch {
    state.screen = "failed";
    render();
  }
}

void start();
