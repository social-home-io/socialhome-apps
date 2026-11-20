/**
 * Coin toss — the screen and one toss's life.
 *
 *  - A press (the big button, Space / Enter on it, or a tap on the coin)
 *    decides the side and the time in the air at once (random.ts,
 *    `crypto.getRandomValues`), then animates: the coin rises, spins and
 *    falls for that time and lands on the decided side. With reduced
 *    motion (Social Home's flag or the system's) the coin fades out and
 *    back in instead, after the same random wait.
 *  - While the coin is in the air the button is disabled and taps on the
 *    coin are ignored.
 *  - The result line is a polite live region: "In the air…", then
 *    "Heads!" / "Tails!".
 *  - A tally and the last few results for this sitting (session.ts);
 *    nothing is saved and nothing leaves the device.
 */
import sh from "@socialhome/app-sdk";
import type { AppLook } from "@socialhome/app-sdk";
import { applyLook, wantsReducedMotion } from "./look.js";
import { num, t } from "./i18n.js";
import { toss } from "./random.js";
import type { Side } from "./random.js";
import { emptyTally, record, restAngle, spinEndAngle } from "./session.js";
import type { Tally } from "./session.js";
import { faceSvg } from "./faces.js";

const FADE_MS = 250;

const ui = {
  side: "heads" as Side,
  inAir: false,
  /** Whether a toss has landed yet (the result line shows it). */
  landed: false,
  tally: emptyTally() as Tally,
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// --- The screen (built once; texts refresh on language change) -----------

const root = document.getElementById("app-root")!;
const hint = el("p", "hint muted");
const stage = el("div", "stage");
const shadow = el("div", "coin-shadow");
const flight = el("div", "coin-flight");
const coin = el("div", "coin");
const headsFace = el("div", "face face-heads");
const tailsFace = el("div", "face face-tails");
headsFace.innerHTML = faceSvg("heads");
tailsFace.innerHTML = faceSvg("tails");
coin.append(headsFace, tailsFace);
flight.append(coin);
stage.append(shadow, flight);
// The coin is a pointer shortcut for the button below; screen readers and
// keyboards use the button, and the result line says the side.
stage.setAttribute("aria-hidden", "true");

const result = el("p", "result");
result.setAttribute("role", "status");
result.setAttribute("aria-live", "polite");
result.setAttribute("aria-atomic", "true");

const button = el("button", "btn primary toss");
button.type = "button";

const tallyBox = el("section", "tally");
const tallyTitle = el("h2", "tally-title");
const tallyLine = el("p", "tally-line");
const history = el("ol", "history");
const reset = el("button", "btn ghost small-btn");
reset.type = "button";
tallyBox.append(tallyTitle, tallyLine, history, reset);

root.replaceChildren(hint, stage, result, button, tallyBox);

function setRest(side: Side): void {
  coin.style.transform = `rotateX(${restAngle(side)}deg)`;
}
setRest(ui.side);

function renderTexts(): void {
  document.title = t("app.docTitle");
  const title = document.getElementById("app-title");
  if (title) title.textContent = t("app.title");
  root.setAttribute("aria-label", t("app.mainLabel"));
  hint.textContent = t("hint");
  button.textContent = ui.inAir ? t("btn.inAir") : ui.landed ? t("btn.again") : t("btn.toss");
  result.textContent = ui.inAir ? t("status.inAir") : ui.landed ? t(ui.side === "heads" ? "result.heads" : "result.tails") : t("status.ready");
  result.classList.toggle("is-result", ui.landed && !ui.inAir);
  result.classList.toggle("is-waiting", ui.inAir || !ui.landed);
  renderTally();
}

function renderTally(): void {
  const { heads, tails, recent } = ui.tally;
  tallyBox.hidden = heads + tails === 0;
  tallyTitle.textContent = t("tally.label");
  tallyLine.textContent = t("tally.line", { heads: num(heads), tails: num(tails) });
  history.setAttribute("aria-label", t("history.label"));
  history.replaceChildren(
    ...recent.map((side) => {
      const li = el("li", `mini mini-${side}`);
      li.innerHTML = faceSvg(side);
      li.append(el("span", "sr-only", t(side === "heads" ? "side.heads" : "side.tails")));
      li.title = t(side === "heads" ? "side.heads" : "side.tails");
      return li;
    }),
  );
  reset.textContent = t("btn.reset");
}

// --- One toss ----------------------------------------------------------------

function reducedMotion(): boolean {
  const system = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return wantsReducedMotion(document.documentElement.dataset["reducedMotion"], system);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canAnimate(e: Element): boolean {
  return typeof (e as HTMLElement).animate === "function";
}

/** Rise, spin and fall for *ms*, ending on *target*. */
function spin(from: Side, target: Side, ms: number): void {
  if (!canAnimate(coin)) return;
  const start = restAngle(from);
  const end = spinEndAngle(from, target, ms);
  coin.animate(
    [{ transform: `rotateX(${start}deg)` }, { transform: `rotateX(${end}deg)` }],
    { duration: ms, easing: "cubic-bezier(.25,.6,.35,1)", fill: "forwards" },
  );
  // How high it rises: up to the top of the frame (over the hint), at most
  // 170 px, at least 60 px; the 1.14 scale at the top grows it 7 % a side.
  const box = coin.getBoundingClientRect();
  const room = box.top - box.height * 0.07 - 8;
  const lift = -Math.round(Math.min(170, Math.max(60, room)));
  flight.animate(
    [
      { transform: "translateY(0) scale(1)", easing: "cubic-bezier(.2,.7,.4,1)" },
      { transform: `translateY(${lift}px) scale(1.14)`, offset: 0.22 },
      { transform: `translateY(${lift + 14}px) scale(1.12)`, offset: 0.5 },
      { transform: `translateY(${lift}px) scale(1.14)`, offset: 0.78, easing: "cubic-bezier(.6,0,.85,.4)" },
      { transform: "translateY(0) scale(1)", offset: 0.95 },
      { transform: "translateY(-10px) scale(1)", offset: 0.975 },
      { transform: "translateY(0) scale(1)" },
    ],
    { duration: ms },
  );
  shadow.animate(
    [
      { transform: "scale(1)", opacity: 0.55 },
      { transform: "scale(.55)", opacity: 0.2, offset: 0.22 },
      { transform: "scale(.6)", opacity: 0.25, offset: 0.5 },
      { transform: "scale(.55)", opacity: 0.2, offset: 0.78 },
      { transform: "scale(1)", opacity: 0.55, offset: 0.95 },
      { transform: "scale(1)", opacity: 0.55 },
    ],
    { duration: ms },
  );
}

/** Reduced motion: fade the coin out, wait, show the side, fade back in. */
async function fade(target: Side, ms: number): Promise<void> {
  if (canAnimate(coin)) coin.animate([{ opacity: 1 }, { opacity: 0.15 }], { duration: FADE_MS, fill: "forwards" });
  await sleep(Math.max(0, ms - FADE_MS));
  coin.getAnimations?.().forEach((a) => a.cancel());
  setRest(target);
  if (canAnimate(coin)) coin.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: FADE_MS });
}

async function tossCoin(): Promise<void> {
  if (ui.inAir) return;
  const { side, durationMs } = toss(); // decided before the coin leaves the hand
  const from = ui.side;
  const hadFocus = document.activeElement === button;
  ui.inAir = true;
  button.disabled = true;
  stage.classList.add("in-air");
  renderTexts();

  const reduce = reducedMotion();
  if (reduce) {
    await fade(side, durationMs);
  } else {
    spin(from, side, durationMs);
    await sleep(durationMs);
    coin.getAnimations?.().forEach((a) => a.cancel());
    setRest(side);
  }

  ui.side = side;
  ui.inAir = false;
  ui.landed = true;
  ui.tally = record(ui.tally, side);
  stage.classList.remove("in-air");
  button.disabled = false;
  renderTexts();
  if (!reduce) {
    result.classList.remove("pop");
    void result.offsetWidth; // restart the pop
    result.classList.add("pop");
  }
  if (hadFocus) button.focus();
}

button.addEventListener("click", () => void tossCoin());
stage.addEventListener("click", () => void tossCoin());
reset.addEventListener("click", () => {
  ui.tally = emptyTally();
  renderTally();
  result.textContent = t("announce.reset");
  button.focus();
});

// --- Boot ----------------------------------------------------------------------

function onLook(look: AppLook): void {
  applyLook(look, document.documentElement);
  renderTexts();
}

renderTexts();
if (sh) {
  // Speak to Social Home at once so the host shows the frame.
  sh.context()
    .then((ctx) => {
      onLook(ctx);
      sh!.onContextChange(onLook);
    })
    .catch(() => {
      // No host answer (opened on its own): keep English and the defaults.
    });
}
