import { describe, expect, it } from "vitest";
import { CHAIN_LENGTH, DICE_SUITE, buildChain, toB64url } from "./dice.js";
import { MAX_LOG, replay } from "./game.js";
import type { Entry } from "./game.js";
import {
  DAY_MS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RULES,
  catchUpFromOwnCopy,
  checkShown,
  isBgMessage,
  judgeInbound,
  parseEntry,
  parseLog,
} from "./inbound.js";
import type { WireMessage } from "./inbound.js";
import { Player, actorOf2, autoTurn, opponent, seedOf, startGame } from "./testkit.js";

/** Play honest steps until *until* says stop (or the game ends); every message goes through the judge. */
function playOn(a: Player, b: Player, steps: number, opts: { double?: boolean } = {}): void {
  for (let i = 0; i < steps; i++) {
    const st = a.state()!;
    if (st.phase === "over") return;
    const p = actorOf2(a, b);
    const msg = p.play(p.autoStep(opts));
    const v = opponent(p, a, b).receive(msg);
    if (v.kind !== "apply") throw new Error(`step ${i}: ${JSON.stringify(v)}`);
  }
}

const clone = (m: WireMessage): Record<string, unknown> => JSON.parse(JSON.stringify(m));

describe("messages", () => {
  it("carry the setup, both tips, the sender's newest link and the whole log", () => {
    const { a, b } = startGame();
    const m = b.message();
    expect(m).toMatchObject({ t: "bg", v: PROTOCOL_VERSION, rules: RULES, suite: DICE_SUITE, youPlay: "w", cube: true, days: 0, log: [] });
    expect(Object.keys(m.tips).sort()).toEqual(["b", "w"]);
    expect(m.shown).toEqual({ n: 1, link: toB64url(b.chain![1]) });
    // The inviter's first message: its tip only, no link.
    const first = new Player("s-9", "inviter", seedOf(5)).invite("b");
    expect(Object.keys(first.tips)).toEqual(["b"]);
    expect(first.shown).toBeUndefined();
    expect(isBgMessage(m)).toBe(true);
    expect(isBgMessage({ t: "go" })).toBe(false);
    expect(isBgMessage(null)).toBe(false);
    expect(a.state()!.phase).toBe("start");
  });

  it("parse entries strictly", () => {
    expect(parseEntry([13, 7, 8, 7])).toEqual([13, 7, 8, 7]);
    expect(parseEntry([])).toEqual([]);
    expect(parseEntry([13, 7, 8])).toBeNull();
    expect(parseEntry([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeNull();
    expect(parseEntry([26, 1])).toBeNull();
    expect(parseEntry([1.5, 0])).toBeNull();
    expect(parseEntry("double")).toBe("double");
    expect(parseEntry("redouble")).toBeNull();
    expect(parseEntry({ from: 1 })).toBeNull();
    expect(parseLog(new Array(MAX_LOG + 1).fill("take"))).toBeNull();
    expect(parseLog("x")).toBeNull();
  });

  it("stay far below Social Home's message limit even at the longest game", () => {
    const { a } = startGame();
    const log: Entry[] = new Array(MAX_LOG).fill([24, 18, 24, 18, 13, 7, 13, 7]);
    const msg = { ...a.message(), log, shown: { n: CHAIN_LENGTH, link: toB64url(a.chain![CHAIN_LENGTH]) } };
    expect(JSON.stringify(msg).length).toBeLessThan(MAX_MESSAGE_BYTES);
  });
});

describe("the handshake", () => {
  it("the invitee takes the setup and tip; the inviter takes the answer and the game starts", () => {
    const a = new Player("s-1", "inviter", seedOf(1));
    const b = new Player("s-1", "invitee", seedOf(2));
    const v1 = b.receive(a.invite("b", false, 3));
    expect(v1).toMatchObject({ kind: "invite", myColor: "w", setup: { inviter: "b", cube: false, days: 3 } });
    const v2 = a.receive(b.message());
    expect(v2).toMatchObject({ kind: "apply", accepted: true, added: [] });
    // The inviter's message again (nothing played) changes nothing.
    expect(b.receive(a.message())).toEqual({ kind: "stale" });
  });

  it("refuses an answer whose link isn't link 1 of its tip", () => {
    const a = new Player("s-1", "inviter", seedOf(1));
    const b = new Player("s-1", "invitee", seedOf(2));
    b.receive(a.invite("w"));
    const forged = clone(b.message());
    forged["shown"] = { n: 1, link: toB64url(buildChain(seedOf(9))[1]) };
    expect(judgeInbound(a.local(), forged)).toEqual({ kind: "refuse", reason: "dice" });
    const late = clone(b.message());
    delete late["shown"];
    expect(judgeInbound(a.local(), late)).toEqual({ kind: "refuse", reason: "dice" });
    const early = clone(b.message());
    early["shown"] = { n: 2, link: toB64url(b.chain![2]) };
    expect(judgeInbound(a.local(), early)).toEqual({ kind: "refuse", reason: "dice" });
  });

  it("refuses a first message that already carries moves or the invitee's tip", () => {
    const a = new Player("s-1", "inviter", seedOf(1));
    const b = new Player("s-1", "invitee", seedOf(2));
    const m = clone(a.invite("w"));
    m["log"] = [[24, 23]];
    expect(judgeInbound(b.local(), m)).toEqual({ kind: "refuse", reason: "setup" });
  });
});

describe("a whole game over the wire", () => {
  it("plays to the end on both sides with the same result", () => {
    for (const seeds of [[1, 2], [3, 4], [5, 6]] as [number, number][]) {
      const { a, b } = startGame({ seeds });
      playOn(a, b, 2000);
      const sa = a.state()!;
      const sb = b.state()!;
      expect(sa.phase).toBe("over");
      expect(sb.result).toEqual(sa.result);
      expect(sb.board).toEqual(sa.board);
    }
  });

  it("with the cube: a double, a take, and later the end", () => {
    const { a, b } = startGame({ seeds: [7, 8] });
    // Play until someone may double.
    while (a.state()!.phase !== "ask") playOn(a, b, 1);
    const p = actorOf2(a, b);
    const q = opponent(p, a, b);
    expect(q.receive(p.play("double"))).toMatchObject({ kind: "apply", added: ["double"] });
    // Neither side knows the roll while the double is open.
    expect(q.state()!.roll).toBeNull();
    expect(p.state()!.roll).toBeNull();
    expect(p.receive(q.play("take"))).toMatchObject({ kind: "apply" });
    expect(p.state()!.cube).toEqual({ value: 2, owner: q.color });
    // The take showed the taker's link: the doubler knows its roll now, the taker still doesn't.
    expect(p.state()!.roll).not.toBeNull();
    expect(q.state()!.roll).toBeNull();
    playOn(a, b, 4000);
    expect(a.state()!.phase).toBe("over");
    expect(a.state()!.result!.points % a.state()!.cube.value).toBe(0);
    expect(b.state()!.result).toEqual(a.state()!.result);
  });

  it("without the cube, a turn hands the next roller its roll in the same message", () => {
    const { a, b } = startGame({ seeds: [1, 2], cube: false });
    playOn(a, b, 3);
    const mover = actorOf2(a, b);
    const waiter = opponent(mover, a, b);
    expect(mover.state()!.phase).toBe("play");
    expect(mover.state()!.roll).not.toBeNull();
    expect(waiter.state()!.roll).toBeNull();
    // And the mover doesn't know the waiter's next roll either.
    const t = mover.state()!.turn;
    expect(mover.dice().roll(t + 1)).toBeNull();
  });

  it("with the cube: the roller asks for its roll, the other app shows it; nobody knows it before", () => {
    const { a, b } = startGame({ seeds: [1, 2] });
    while (a.state()!.phase !== "ask") playOn(a, b, 1);
    const p = actorOf2(a, b);
    const q = opponent(p, a, b);
    expect(p.state()!.roll).toBeNull();
    expect(p.dice().roll(p.state()!.turn)).toBeNull();
    expect(q.dice().roll(q.state()!.turn)).toBeNull();
    expect(q.receive(p.play("roll"))).toMatchObject({ kind: "apply", added: ["roll"] });
    expect(q.state()!.phase).toBe("dice");
    expect(q.state()!.toMove).toBe(q.color);
    expect(p.receive(q.play("show"))).toMatchObject({ kind: "apply", added: ["show"] });
    expect(p.state()!.roll).not.toBeNull();
    expect(q.state()!.roll).toBeNull();
  });
});

describe("tampering with the dice", () => {
  /** Set up a game in play and return the message the mover is about to send. */
  function midGame() {
    const { a, b } = startGame({ seeds: [11, 12] });
    playOn(a, b, 4);
    const p = actorOf2(a, b);
    const q = opponent(p, a, b);
    const msg = clone(p.play(p.autoStep()));
    return { p, q, msg };
  }

  it("a link from another chain (a made-up roll) is refused", () => {
    const { p, q, msg } = midGame();
    const n = (msg["shown"] as { n: number }).n;
    msg["shown"] = { n, link: toB64url(buildChain(seedOf(99))[n]) };
    expect(judgeInbound(q.local(), msg)).toEqual({ kind: "refuse", reason: "dice" });
    expect(p).toBeDefined();
  });

  it("reusing the last link for the next turn is refused", () => {
    const { q, msg } = midGame();
    const prev = q.theirShown!;
    msg["shown"] = { n: prev.n + 1, link: toB64url(prev.link) };
    expect(judgeInbound(q.local(), msg)).toEqual({ kind: "refuse", reason: "dice" });
  });

  it("showing a link late (holding back the next roll) or early is refused", () => {
    const { p, q, msg } = midGame();
    const n = (msg["shown"] as { n: number }).n;
    const late = { ...msg, shown: { n: n - 1, link: toB64url(p.chain![n - 1]) } };
    expect(judgeInbound(q.local(), late)).toEqual({ kind: "refuse", reason: "dice" });
    const early = { ...msg, shown: { n: n + 1, link: toB64url(p.chain![n + 1]) } };
    expect(judgeInbound(q.local(), early)).toEqual({ kind: "refuse", reason: "dice" });
  });

  it("the roller can't pick its numbers: a turn played with other dice is refused", () => {
    const { a, b } = startGame({ seeds: [13, 14], cube: false });
    playOn(a, b, 3);
    const p = actorOf2(a, b);
    const q = opponent(p, a, b);
    const st = p.state()!;
    // Try every other roll: any turn that only fits a different roll is illegal.
    let refused = 0;
    for (let x = 1; x <= 6; x++) {
      for (let y = x; y <= 6; y++) {
        if (`${[x, y]}` === `${[...st.roll!].sort()}`) continue;
        const fake = autoTurn({ ...st, roll: [x, y] });
        if (replay(p.setup!, [...p.log, fake], p.dice())) continue; // also legal with the real roll
        const v = judgeInbound(q.local(), { ...clone(p.message()), log: [...p.log, fake], shown: { n: st.turn + 1, link: toB64url(p.chain![st.turn + 1]) } });
        expect(v).toEqual({ kind: "refuse", reason: "illegal" });
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(10);
  });

  it("a roll or a double that gives away the roller's own link is refused", () => {
    const { a, b } = startGame({ seeds: [15, 16] });
    while (a.state()!.phase !== "ask") playOn(a, b, 1);
    const p = actorOf2(a, b);
    const q = opponent(p, a, b);
    const t = p.state()!.turn;
    for (const e of ["roll", "double"] as Entry[]) {
      const msg = clone(p.play(e));
      p.log = p.log.slice(0, -1);
      expect((msg["shown"] as { n: number }).n).toBe(t - 1);
      msg["shown"] = { n: t, link: toB64url(p.chain![t]) };
      expect(judgeInbound(q.local(), msg)).toEqual({ kind: "refuse", reason: "dice" });
    }
  });

  it("a show or a take that holds its link back is refused", () => {
    const { a, b } = startGame({ seeds: [17, 18] });
    while (a.state()!.phase !== "ask") playOn(a, b, 1);
    const p = actorOf2(a, b);
    const q = opponent(p, a, b);
    const t = p.state()!.turn;
    q.receive(p.play("roll"));
    const show = clone(q.play("show"));
    expect((show["shown"] as { n: number }).n).toBe(t);
    show["shown"] = { n: t - 1, link: toB64url(q.chain![t - 1]) };
    expect(judgeInbound(p.local(), show)).toEqual({ kind: "refuse", reason: "dice" });
    // "take" answers only a double.
    q.log = q.log.slice(0, -1);
    const take = clone(q.play("take"));
    expect(judgeInbound(p.local(), take)).toEqual({ kind: "refuse", reason: "illegal" });
  });

  it("a turn that holds back the next roller's link when it can't double is refused", () => {
    const { a, b } = startGame({ seeds: [19, 20], cube: false });
    playOn(a, b, 3);
    const p = actorOf2(a, b);
    const q = opponent(p, a, b);
    const msg = clone(p.play(p.autoStep()));
    const n = (msg["shown"] as { n: number }).n;
    expect(n).toBe(p.state()!.turn);
    msg["shown"] = { n: n - 1, link: toB64url(p.chain![n - 1]) };
    expect(judgeInbound(q.local(), msg)).toEqual({ kind: "refuse", reason: "dice" });
  });

  it("the inviter can't play the opening the invitee won, or show its link when it won", () => {
    // Find seeds where each side wins the opening.
    for (let s = 20; s < 40; s++) {
      const { a, b } = startGame({ seeds: [s, s + 100] });
      const st = a.state()!;
      const wrong: Entry = st.opening!.starter === a.color ? "open" : [24, 23, 13, 9];
      const msg = { ...clone(a.message()), log: [wrong], shown: { n: 1, link: toB64url(a.chain![1]) } };
      expect(judgeInbound(b.local(), msg)).toMatchObject({ kind: "refuse" });
    }
  });

  it("a tip changed after the start is refused", () => {
    const { a, b } = startGame();
    const msg = clone(a.message());
    (msg["tips"] as Record<string, string>)[a.color!] = toB64url(buildChain(seedOf(77))[0]);
    expect(judgeInbound(b.local(), msg)).toEqual({ kind: "refuse", reason: "setup" });
  });

  it("checks a shown link older than the newest one against what we derived", () => {
    const chain = buildChain(seedOf(3), 20);
    expect(checkShown(chain[0], { n: 9, link: chain[9] }, 4, chain[4])).toBe(true);
    expect(checkShown(chain[0], { n: 9, link: chain[9] }, 4, chain[5])).toBe(false);
  });
});

describe("the judge", () => {
  it("ignores a message it already has; refuses a rewrite, extra steps and steps for us", () => {
    const { a, b } = startGame({ seeds: [21, 22] });
    playOn(a, b, 4);
    const p = actorOf2(a, b);
    const q = opponent(p, a, b);
    expect(judgeInbound(q.local(), clone(p.message()))).toEqual({ kind: "stale" });
    // Their step, then one of ours made for us by them (a double on our turn).
    const step = p.autoStep();
    const forOurs = { ...clone(p.play(step)), log: [...p.log, "double"] };
    expect(judgeInbound(q.local(), forOurs)).toEqual({ kind: "refuse", reason: "wrong-player" });
    p.log = p.log.slice(0, -1);
    // A different history.
    const rewritten = clone(p.message());
    (rewritten["log"] as Entry[])[0] = (rewritten["log"] as Entry[])[0] === "open" ? [24, 23, 13, 9] : "open";
    expect(judgeInbound(q.local(), rewritten)).toEqual({ kind: "refuse", reason: "rewrite" });
    // Three new entries at once.
    const three = { ...clone(p.message()), log: [...p.log, "double", "take", "resign-w"] };
    expect(judgeInbound(q.local(), three)).toEqual({ kind: "refuse", reason: "too-many" });
  });

  it("refuses unknown keys, versions, rules and dice suites as unsupported", () => {
    const { a, b } = startGame();
    for (const change of [{ extra: 1 }, { v: 2 }, { rules: "nackgammon" }, { suite: "sha3-chain-v1" }]) {
      expect(judgeInbound(b.local(), { ...clone(a.message()), ...change })).toEqual({ kind: "unsupported" });
    }
  });

  it("refuses a different setup", () => {
    const { a, b } = startGame();
    for (const change of [{ cube: false }, { days: 2 }, { youPlay: a.color }]) {
      expect(judgeInbound(b.local(), { ...clone(a.message()), ...change })).toEqual({ kind: "refuse", reason: "setup" });
    }
    expect(judgeInbound(b.local(), { ...clone(a.message()), days: 4 })).toEqual({ kind: "refuse", reason: "malformed" });
  });

  it("never throws on junk", () => {
    const { b } = startGame();
    for (const junk of [null, 1, "x", [], { t: "bg" }, { t: "bg", v: 1, rules: RULES, suite: DICE_SUITE, tips: 5 }, { ...b.message(), shown: { n: "1" } }]) {
      expect(() => judgeInbound(b.local(), junk)).not.toThrow();
    }
  });

  it("takes a step and their resignation together (the step's message was replaced)", () => {
    const { a, b } = startGame({ seeds: [23, 24] });
    playOn(a, b, 3);
    const p = actorOf2(a, b);
    const q = opponent(p, a, b);
    p.play(p.autoStep());
    const msg = p.play(p.color === "w" ? "resign-w" : "resign-b");
    expect(q.receive(msg)).toMatchObject({ kind: "apply" });
    expect(q.state()!.result).toMatchObject({ winner: q.color, by: "resign" });
  });

  it("settles a resignation crossing a step: the resignation wins, both sides agree", () => {
    const { a, b } = startGame({ seeds: [25, 26] });
    playOn(a, b, 3);
    const p = actorOf2(a, b);
    const q = opponent(p, a, b);
    const before = q.log.length;
    const step = p.play(p.autoStep());
    const resign = q.play(q.color === "w" ? "resign-w" : "resign-b"); // q resigns before the step arrives
    expect(q.receive(step)).toEqual({ kind: "stale" });
    expect(p.receive(resign)).toMatchObject({ kind: "apply" });
    expect(p.log).toEqual(q.log);
    expect(q.log.length).toBe(before + 1);
    expect(p.state()!.result).toEqual(q.state()!.result);
    expect(q.state()!.result).toMatchObject({ winner: p.color, by: "resign" });
  });

  it("a take sent after seeing the doubler's resignation can't raise its price", () => {
    const { a, b } = startGame({ seeds: [7, 8] });
    while (a.state()!.phase !== "ask") playOn(a, b, 1);
    const p = actorOf2(a, b);
    const q = opponent(p, a, b);
    q.receive(p.play("double"));
    const resign = p.play(p.color === "w" ? "resign-w" : "resign-b");
    const take = q.play("take"); // q "races" a take against the resignation
    expect(p.receive(take)).toEqual({ kind: "stale" });
    expect(q.receive(resign)).toMatchObject({ kind: "apply" });
    expect(p.log).toEqual(q.log);
    expect(p.state()!.result!.cube).toBe(1);
    expect(q.state()!.result).toEqual(p.state()!.result);
  });

  it("both resigning at once: the inviter's resignation counts on both sides", () => {
    const { a, b } = startGame({ seeds: [29, 30], cube: false });
    playOn(a, b, 3);
    const ra = a.play(a.color === "w" ? "resign-w" : "resign-b");
    const rb = b.play(b.color === "w" ? "resign-w" : "resign-b");
    expect(a.receive(rb)).toEqual({ kind: "stale" });
    expect(b.receive(ra)).toMatchObject({ kind: "apply" });
    expect(a.log).toEqual(b.log);
    expect(a.state()!.result).toEqual(b.state()!.result);
    expect(a.state()!.result!.winner).toBe(b.color);
  });

  it("a step that ends the game stands against a late resignation", () => {
    const { a, b } = startGame({ seeds: [31, 32], cube: false });
    for (let i = 0; i < 4000 && a.state()!.phase !== "over"; i++) {
      const p = actorOf2(a, b);
      const q = opponent(p, a, b);
      const st = p.state()!;
      const win = st.phase === "play" && st.board[p.color!][0] >= 11;
      const msg = p.play(p.autoStep());
      if (win && p.state()!.phase === "over") {
        const late = q.play(q.color === "w" ? "resign-w" : "resign-b");
        expect(q.receive(msg)).toMatchObject({ kind: "apply" });
        expect(p.receive(late)).toEqual({ kind: "stale" });
        expect(q.state()!.result).toEqual(p.state()!.result);
        expect(p.state()!.result!.by).not.toBe("resign");
        return;
      }
      q.receive(msg);
    }
    throw new Error("no winning step found");
  });

  it("time claims: only with a clock, on the receiver's turn; a refusal is capped", () => {
    const { a, b } = startGame({ days: 1, seeds: [27, 28] });
    playOn(a, b, 2);
    const p = actorOf2(a, b);
    const q = opponent(p, a, b);
    expect(judgeInbound(p.local(), clone(q.message({ claim: true })))).toEqual({ kind: "claim" });
    expect(judgeInbound(q.local(), clone(p.message({ claim: true })))).toEqual({ kind: "refuse", reason: "claim" });
    expect(judgeInbound(q.local(), clone(p.message({ refusedMs: 99 * DAY_MS })))).toEqual({ kind: "claim-refused", leftMs: DAY_MS });
    const { a: c, b: d } = startGame({ seeds: [29, 30] });
    playOn(c, d, 2);
    const r = actorOf2(c, d);
    expect(judgeInbound(r.local(), { ...clone(opponent(r, c, d).message()), claim: true })).toEqual({ kind: "refuse", reason: "claim" });
  });

  it("catches up from our own saved copy when it is ahead", () => {
    const { a, b } = startGame({ seeds: [31, 32] });
    playOn(a, b, 3);
    const p = actorOf2(a, b);
    const before = [...p.log];
    p.play(p.autoStep());
    expect(catchUpFromOwnCopy(p.setup!, before, p.log, p.dice())).toEqual(p.log);
    expect(catchUpFromOwnCopy(p.setup!, p.log, before, p.dice())).toBeNull();
    expect(catchUpFromOwnCopy(p.setup!, before, [...before, "take"], p.dice())).toBeNull();
  });
});
