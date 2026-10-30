/**
 * Two apps playing through messages only, with the mailbox's rules: a
 * message may be replaced by the sender's next one, and a held copy may
 * repeat one already seen. Honest pairs always finish and check out; every
 * kind of lie is caught at the moment the design says.
 */
import { describe, expect, it } from "vitest";
import { CELLS, FLEET_SQUARES, fleetBits, randomFleet, shipMap, placementCells } from "./rules.js";
import type { Fleet, Placement } from "./rules.js";
import { sealBoard, toB64url, fromB64url, LEAVES_BYTES } from "./seal.js";
import {
  answerShot,
  fire,
  firedBy,
  hitsByMe,
  hitsOnMe,
  lockIn,
  newGame,
  phase,
  resign,
  setFleet,
  shooterAt,
  shotCount,
} from "./game.js";
import type { Game, Role } from "./game.js";
import { MAX_MESSAGE_BYTES, buildMessage, canSend, isBsMessage, markSent, receive } from "./protocol.js";
import type { Verdict, WireMessage } from "./protocol.js";

const SID = "a1b2c3d4-e5f6-4000-8000-00000000beef";

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedBytes(rng: () => number): Uint8Array {
  return Uint8Array.from({ length: 32 }, () => Math.floor(rng() * 256));
}

interface Player {
  name: string;
  game: Game;
  /** Rewrites this player's outgoing messages (a changed app). */
  tamper?: (m: WireMessage, p: Player) => WireMessage;
}

function wire<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** The player's message as it leaves their app (marks the final as sent). */
function send(p: Player): WireMessage {
  expect(canSend(p.game)).toBe(true);
  let m = wire(buildMessage(p.game));
  if (p.tamper) m = p.tamper(m, p);
  p.game = markSent(p.game);
  return m;
}

function deliver(to: Player, msg: unknown): Verdict {
  const v = receive(to.game, wire(msg));
  if (v.kind === "update") to.game = v.game;
  return v;
}

const CLASSIC: Fleet = [
  [0, 11, "h"],
  [1, 27, "v"],
  [2, 70, "h"],
  [3, 44, "v"],
  [4, 88, "h"],
];

/** A challenger who has placed and locked in, and an invitee who has the first message. */
function setup(rng: () => number, opts: { fleetA?: Fleet; fleetB?: Fleet } = {}) {
  const A: Player = { name: "Anna", game: lockIn(newGame(SID, "challenger", opts.fleetA ?? randomFleet(rng)), seedBytes(rng)) };
  const B: Player = { name: "Ben", game: newGame(SID, "invitee", opts.fleetB ?? randomFleet(rng)) };
  const m1 = send(A);
  const v = deliver(B, m1);
  expect(v.kind).toBe("update");
  expect(v.kind === "update" && v.reply).toBe(false); // Ben hasn't locked in: nothing to send
  B.game = lockIn(B.game, seedBytes(rng));
  return { A, B, m1 };
}

interface RunOpts {
  /** Drop the "answer at once" message when the next one replaces it in the mailbox. */
  dropAnswers?: boolean;
  /** Deliver an old copy of each message again (a held message seen live). */
  duplicates?: boolean;
  /** How each player chooses a square. */
  choose?: (p: Player, rng: () => number) => number;
  maxShots?: number;
}

function randomTarget(p: Player, rng: () => number): number {
  const fired = firedBy(p.game, true);
  const free = [...Array(CELLS).keys()].filter((c) => !fired.has(c));
  return free[Math.floor(rng() * free.length)];
}

/**
 * Deliver *msg* from → to, then follow the replies. Returns every verdict.
 * With `dropAnswers`, a non-final reply is skipped when the replier fires
 * next (its next message carries the answer too, and replaces it).
 */
function flow(from: Player, to: Player, msg: WireMessage, opts: RunOpts, verdicts: Verdict[], last: Map<Player, WireMessage>): void {
  const v = deliver(to, msg);
  verdicts.push(v);
  if (opts.duplicates) {
    const older = last.get(from);
    if (older) {
      const dv = receive(to.game, wire(older));
      expect(dv.kind).toBe("stale");
    }
    const again = receive(to.game, wire(msg));
    expect(again.kind).toBe("stale");
  }
  last.set(from, msg);
  if (v.kind !== "update" || !v.reply) return;
  const reply = send(to);
  const replaced = opts.dropAnswers && !reply.end && phase(to.game) === "my-turn";
  if (replaced) return;
  flow(to, from, reply, opts, verdicts, last);
}

function play(A: Player, B: Player, rng: () => number, opts: RunOpts = {}): Verdict[] {
  const verdicts: Verdict[] = [];
  const last = new Map<Player, WireMessage>();
  const choose = opts.choose ?? randomTarget;
  for (let guard = 0; guard < (opts.maxShots ?? 400); guard++) {
    const shooter = [A, B].find((p) => phase(p.game) === "my-turn");
    if (!shooter) break;
    const other = shooter === A ? B : A;
    shooter.game = fire(shooter.game, choose(shooter, rng));
    flow(shooter, other, send(shooter), opts, verdicts, last);
  }
  return verdicts;
}

function expectHonestFinish(A: Player, B: Player): void {
  expect(phase(A.game)).toBe("over");
  expect(phase(B.game)).toBe("over");
  const [winner, loser] = A.game.outcome!.kind === "won" ? [A, B] : [B, A];
  expect(winner.game.outcome).toEqual({ kind: "won", how: "fleet" });
  expect(loser.game.outcome).toEqual({ kind: "lost", how: "fleet" });
  expect(hitsByMe(winner.game)).toBe(FLEET_SQUARES);
  expect(hitsOnMe(loser.game)).toBe(FLEET_SQUARES);
  // Both fleets revealed and checked; both sent exactly one final message.
  expect(A.game.check).toBe("ok");
  expect(B.game.check).toBe("ok");
  expect(A.game.sentFinal && B.game.sentFinal).toBe(true);
  expect(A.game.shots).toEqual(B.game.shots.map((s) => s)); // identical logs
}

// ---------------------------------------------------------------------------

describe("honest games", () => {
  it("the invitee fires first; a whole game ends with both fleets checked", () => {
    const rng = seeded(7);
    const { A, B } = setup(rng);
    expect(phase(A.game)).toBe("wait-seal");
    expect(phase(B.game)).toBe("my-turn");
    expect(shooterAt(0)).toBe("invitee");
    play(A, B, rng);
    expectHonestFinish(A, B);
  });

  it("200 random games, half with answers replaced in the mailbox and repeated held copies", { timeout: 60_000 }, () => {
    for (let s = 0; s < 200; s++) {
      const rng = seeded(1000 + s);
      const { A, B } = setup(rng);
      play(A, B, rng, { dropAnswers: s % 2 === 0, duplicates: s % 4 < 2 });
      expectHonestFinish(A, B);
    }
  });

  it("answers at once: miss, hit and sunk with the ship's squares", () => {
    const rng = seeded(3);
    const { A, B } = setup(rng, { fleetA: CLASSIC });
    // Ben fires at A1 (water), B2, C2, D2, E2, F2 (the carrier).
    const answers: string[] = [];
    for (const cell of [0, 11, 12, 13, 14, 15]) {
      B.game = fire(B.game, cell);
      const v = deliver(A, send(B));
      expect(v.kind === "update" && v.reply).toBe(true);
      const ev = v.kind === "update" ? v.events.find((e) => e.type === "fired") : undefined;
      answers.push(ev && ev.type === "fired" ? ev.ans : "?");
      const back = deliver(B, send(A));
      expect(back.kind).toBe("update");
      // Anna fires somewhere so it is Ben's turn again.
      A.game = fire(A.game, randomTarget(A, rng));
      deliver(B, send(A));
      deliver(A, send(B));
    }
    expect(answers).toEqual(["m", "h", "h", "h", "h", "s"]);
    const sunk = B.game.shots.find((s, k) => s.cell === 15 && shooterAt(k) === "invitee")!;
    expect(sunk.sunk).toEqual([0, 11, "h"]);
  });

  it("the challenger's seal arriving late: the invitee sends its seal and Anna answers with hers", () => {
    const rng = seeded(11);
    const A: Player = { name: "Anna", game: lockIn(newGame(SID, "challenger", randomFleet(rng)), seedBytes(rng)) };
    const B: Player = { name: "Ben", game: lockIn(newGame(SID, "invitee", randomFleet(rng)), seedBytes(rng)) };
    // M1 was lost: Ben waits, and sends his seal.
    expect(phase(B.game)).toBe("wait-seal");
    const mB = send(B);
    expect(mB.commit).toBeDefined();
    expect(mB.ack).toBeUndefined();
    const v = deliver(A, mB);
    expect(v.kind === "update" && v.reply).toBe(true);
    const mA = send(A);
    expect(mA.ack).toBe(B.game.root);
    const v2 = deliver(B, mA);
    expect(v2.kind === "update" && v2.reply).toBe(false); // no ping-pong
    expect(phase(B.game)).toBe("my-turn");
    play(A, B, rng);
    expectHonestFinish(A, B);
  });

  it("sends the leaves only until the other side acks them", () => {
    const rng = seeded(5);
    const { A, B } = setup(rng);
    B.game = fire(B.game, 0);
    const mB = send(B);
    expect(mB.commit).toBeDefined();
    expect(mB.ack).toBe(A.game.root);
    deliver(A, mB);
    expect(A.game.acked).toBe(true);
    const mA = send(A);
    expect(mA.commit).toBeUndefined();
    expect(mA.root).toBe(A.game.root);
    deliver(B, mA);
    B.game = { ...B.game };
    // Ben hasn't seen Anna's ack of his seal yet in his own first message, but now he has.
    expect(B.game.acked).toBe(true);
    expect(send(B).commit).toBeUndefined();
  });

  it("keeps every message far under Social Home's 64 KiB mailbox", () => {
    const rng = seeded(99);
    const { A, B } = setup(rng);
    let biggest = 0;
    const measure = (p: Player) => {
      const m = buildMessage(p.game);
      biggest = Math.max(biggest, JSON.stringify(m).length);
    };
    for (let guard = 0; guard < 400; guard++) {
      const shooter = [A, B].find((p) => phase(p.game) === "my-turn");
      if (!shooter) break;
      const other = shooter === A ? B : A;
      shooter.game = fire(shooter.game, randomTarget(shooter, rng));
      measure(shooter);
      flow(shooter, other, send(shooter), {}, [], new Map());
    }
    expect(biggest).toBeGreaterThan(4000);
    expect(biggest).toBeLessThan(12_000);
    expect(MAX_MESSAGE_BYTES).toBeLessThan(64 * 1024);
  });

  it("refuses local mistakes: firing twice at a square, out of turn, changing a locked fleet", () => {
    const rng = seeded(8);
    const { A, B } = setup(rng);
    expect(() => fire(A.game, 0)).toThrow(); // Ben fires first
    B.game = fire(B.game, 0);
    expect(() => fire(B.game, 1)).toThrow(); // one shot per turn
    deliver(A, send(B));
    deliver(B, send(A));
    A.game = fire(A.game, 5);
    deliver(B, send(A));
    deliver(A, send(B));
    expect(() => fire(B.game, 0)).toThrow(); // already fired there
    expect(() => setFleet(A.game, CLASSIC)).toThrow();
    expect(() => lockIn(A.game, new Uint8Array(32))).toThrow();
    expect(() => lockIn(newGame(SID, "invitee", CLASSIC), new Uint8Array(3))).toThrow();
  });
});

describe("resigning and the end", () => {
  it("a resign tells the other side, reveals, and both fleets check out", () => {
    const rng = seeded(21);
    const { A, B } = setup(rng);
    play(A, B, rng, { maxShots: 20 });
    B.game = resign(B.game);
    const m = send(B);
    expect(m.end?.result).toBe("resigned");
    expect(m.reveal).toBeDefined();
    const v = deliver(A, m);
    expect(A.game.outcome).toEqual({ kind: "won", how: "resign" });
    expect(A.game.check).toBe("ok");
    expect(v.kind === "update" && v.reply).toBe(true);
    const fin = send(A);
    expect(fin.end?.result).toBe("won");
    deliver(B, fin);
    expect(B.game.outcome).toEqual({ kind: "lost", how: "resign" });
    expect(B.game.check).toBe("ok");
    // Nothing is sent after the final message.
    expect(canSend(A.game)).toBe(false);
    expect(canSend(B.game)).toBe(false);
    expect(() => resign(A.game)).toThrow();
  });

  it("a resign that crosses our answer (their copy one step behind) still ends the game", () => {
    const rng = seeded(22);
    const { A, B } = setup(rng);
    B.game = fire(B.game, 0);
    deliver(A, send(B)); // Anna answers; the answer hasn't reached Ben yet
    B.game = resign(B.game);
    deliver(A, send(B));
    expect(A.game.outcome).toEqual({ kind: "won", how: "resign" });
    expect(A.game.check).toBe("ok");
  });

  it("a winner who never shows the fleet: the loser's check stays pending (never confirmed)", () => {
    const rng = seeded(23);
    const { A, B } = setup(rng);
    A.tamper = (m) => {
      const { reveal: _r, ...rest } = m;
      return rest as WireMessage;
    };
    B.tamper = A.tamper;
    play(A, B, rng);
    const loser = A.game.outcome?.kind === "lost" ? A : B;
    const winner = loser === A ? B : A;
    expect(loser.game.outcome).toEqual({ kind: "lost", how: "fleet" });
    expect(loser.game.check).toBe("pending");
    expect(winner.game.outcome).toEqual({ kind: "won", how: "fleet" });
  });

  it("never takes a win on the sender's word", () => {
    const rng = seeded(24);
    const { A, B } = setup(rng);
    B.game = fire(B.game, 0);
    const m = send(B);
    m.end = { result: "won" };
    const v = deliver(A, m);
    expect(v.kind).toBe("update");
    expect(A.game.outcome).toBeNull();
    const m2 = send(A);
    m2.end = { result: "lost" };
    deliver(B, m2);
    expect(B.game.outcome).toBeNull();
  });

  it("their app ending the game as void ends ours as void, and we still reveal", () => {
    const rng = seeded(25);
    const { A, B } = setup(rng);
    B.game = fire(B.game, 0);
    const m = send(B);
    m.end = { result: "void", reason: "answer", at: 3 };
    const v = deliver(A, m);
    expect(A.game.outcome).toEqual({ kind: "void", reason: "them" });
    expect(v.kind === "update" && v.reply).toBe(true);
    expect(send(A).reveal).toBeDefined();
  });

  it("over games take only the missing reveal; anything else is stale", () => {
    const rng = seeded(26);
    const { A, B } = setup(rng);
    play(A, B, rng);
    expect(receive(A.game, wire(buildMessage(B.game))).kind).toBe("stale");
    expect(receive(B.game, wire(buildMessage(A.game))).kind).toBe("stale");
  });
});

// ---------------------------------------------------------------------------
// Lies
// ---------------------------------------------------------------------------

function lastAnswerAt(m: WireMessage, atSender: (k: number) => boolean): number {
  for (let k = m.shots.length - 1; k >= 0; k--) if (atSender(k) && m.shots[k].length >= 3) return k;
  return -1;
}

describe("a lie voids the game on the shot it happens", () => {
  it('a "miss" on a ship square', () => {
    const rng = seeded(31);
    const { A, B } = setup(rng, { fleetA: CLASSIC });
    let liedAt = -1;
    A.tamper = (m) => {
      // Anna says "miss" the first time Ben hits her.
      const k = lastAnswerAt(m, (i) => shooterAt(i) === "invitee");
      if (liedAt < 0 && k >= 0 && m.shots[k][1] !== "m") {
        liedAt = m.shots[k][0];
        m.shots[k] = [m.shots[k][0], "m", m.shots[k][2] as string];
      }
      return m;
    };
    play(A, B, rng, { choose: (p, r) => (p === B ? [11, 12, 0, 1, 2, 3, 4, 5][firedBy(p.game, true).size] ?? randomTarget(p, r) : randomTarget(p, r)) });
    expect(liedAt).toBe(11);
    expect(B.game.outcome).toEqual({ kind: "void", reason: "answer", at: 11 });
    // Ben voided at once: only one shot by Ben was answered.
    expect(firedBy(B.game, true).size).toBe(1);
    expect(B.game.sentFinal).toBe(true);
  });

  it('a "hit" on water', () => {
    const rng = seeded(32);
    const { A, B } = setup(rng, { fleetA: CLASSIC });
    A.tamper = (m) => {
      const k = lastAnswerAt(m, (i) => shooterAt(i) === "invitee");
      if (k >= 0 && m.shots[k][0] === 0) m.shots[k] = [0, "h", m.shots[k][2] as string];
      return m;
    };
    play(A, B, rng, { choose: (p, r) => (p === B && firedBy(p.game, true).size === 0 ? 0 : randomTarget(p, r)) });
    expect(B.game.outcome).toEqual({ kind: "void", reason: "answer", at: 0 });
  });

  it("an opening for another square, or a made-up one", () => {
    for (const bad of ["other", "random"] as const) {
      const rng = seeded(33);
      const { A, B } = setup(rng, { fleetA: CLASSIC });
      A.tamper = (m, p) => {
        const k = lastAnswerAt(m, (i) => shooterAt(i) === "invitee");
        if (k >= 0) {
          const salt =
            bad === "other" ? answerShot(p.game, (m.shots[k][0] + 1) % 100).salt! : toB64url(new Uint8Array(16).fill(9));
          m.shots[k] = [m.shots[k][0], m.shots[k][1] as "m", salt];
        }
        return m;
      };
      play(A, B, rng, { choose: (p, r) => (p === B && firedBy(p.game, true).size === 0 ? 0 : randomTarget(p, r)) });
      expect(B.game.outcome).toEqual({ kind: "void", reason: "answer", at: 0 });
    }
  });

  it("a seal replayed from another game doesn't open in this one", () => {
    const rng = seeded(34);
    const seed = seedBytes(rng);
    const A: Player = { name: "Anna", game: lockIn(newGame(SID, "challenger", CLASSIC), seed) };
    const old = sealBoard("an-older-game", seed, fleetBits(CLASSIC));
    A.game = { ...A.game, leaves: toB64url(old.leaves), root: toB64url(old.root) };
    const B: Player = { name: "Ben", game: newGame(SID, "invitee", randomFleet(rng)) };
    deliver(B, send(A));
    B.game = lockIn(B.game, seedBytes(rng));
    play(A, B, rng);
    expect(B.game.outcome?.kind).toBe("void");
    expect(B.game.outcome).toMatchObject({ reason: "answer" });
  });

  it("moving ships: a new seal mid-game, or a different root", () => {
    for (const how of ["commit", "root"] as const) {
      const rng = seeded(35);
      const { A, B } = setup(rng);
      play(A, B, rng, { maxShots: 6 });
      const m = send(A);
      if (how === "commit") {
        const other = sealBoard(SID, seedBytes(rng), fleetBits(randomFleet(rng)));
        m.commit = { suite: "sha256-cells-v1", leaves: toB64url(other.leaves) };
      } else {
        m.root = toB64url(new Uint8Array(32).fill(1));
      }
      deliver(B, m);
      expect(B.game.outcome).toEqual({ kind: "void", reason: "reseal" });
    }
  });

  it('"sunk" too early (the ship still has a square not hit)', () => {
    const rng = seeded(36);
    const { A, B } = setup(rng, { fleetA: CLASSIC });
    A.tamper = (m) => {
      const k = lastAnswerAt(m, (i) => shooterAt(i) === "invitee");
      if (k >= 0 && m.shots[k][0] === 11) m.shots[k] = [11, "s", m.shots[k][2] as string, [0, 11, "h"]];
      return m;
    };
    play(A, B, rng, { choose: (p, r) => (p === B && firedBy(p.game, true).size === 0 ? 11 : randomTarget(p, r)) });
    expect(B.game.outcome).toEqual({ kind: "void", reason: "sunk", at: 11 });
  });

  it('"hit" on a ship\'s last square (no "sunk") is caught at the reveal', () => {
    const rng = seeded(37);
    const { A, B } = setup(rng, { fleetA: CLASSIC });
    A.tamper = (m, p) => {
      const k = lastAnswerAt(m, (i) => shooterAt(i) === "invitee");
      if (k >= 0 && m.shots[k][0] === 89) {
        m.shots[k] = [89, "h", m.shots[k][2] as string];
        // The changed app keeps its own copy in line with what it said.
        p.game = { ...p.game, shots: p.game.shots.map((s, i) => (i === k ? { cell: 89, ans: "h", salt: s.salt } : s)) };
      }
      return m;
    };
    // Ben sinks the destroyer (I9, J9) first, then everything else.
    const order = [88, 89, ...[...Array(100).keys()].filter((c) => c !== 88 && c !== 89)];
    play(A, B, rng, { choose: (p, r) => (p === B ? order[firedBy(p.game, true).size] : randomTarget(p, r)) });
    // Not void during play; Ben may well win, and Anna's reveal then shows the lie.
    expect(B.game.outcome).toEqual({ kind: "void", reason: "sunk", at: 89 });
  });

  it("the wrong ship named as sunk is caught at the reveal", () => {
    const rng = seeded(38);
    const { A, B } = setup(rng, { fleetA: CLASSIC });
    A.tamper = (m) => {
      for (const s of m.shots) if (s.length === 4 && s[3][0] === 2) s[3] = [3, s[3][1], s[3][2]]; // cruiser → "submarine"
      return m;
    };
    const order = [70, 71, 72, ...[...Array(100).keys()].filter((c) => c < 70 || c > 72)];
    play(A, B, rng, { choose: (p, r) => (p === B ? order[firedBy(p.game, true).size] : randomTarget(p, r)) });
    expect(B.game.outcome?.kind).toBe("void");
    expect(B.game.outcome).toMatchObject({ reason: "sunk" });
  });

  it("a short fleet (16 squares sealed) can't win and is void once every square is fired at", () => {
    const rng = seeded(39);
    // Anna (the liar, challenger) seals her board without J9.
    const seed = seedBytes(rng);
    const A: Player = { name: "Anna", game: lockIn(newGame(SID, "challenger", CLASSIC), seed) };
    const bits = fleetBits(CLASSIC);
    bits[89] = 0;
    const forged = sealBoard(SID, seed, bits);
    A.game = { ...A.game, leaves: toB64url(forged.leaves), root: toB64url(forged.root) };
    A.tamper = (m, p) => {
      for (let k = 0; k < m.shots.length; k++) {
        if (shooterAt(k) === "invitee" && m.shots[k][0] === 89 && m.shots[k].length >= 3) {
          m.shots[k] = [89, "m", m.shots[k][2] as string];
          p.game = { ...p.game, shots: p.game.shots.map((s, i) => (i === k ? { cell: 89, ans: "m", salt: s.salt } : s)) };
        }
      }
      return m;
    };
    const B: Player = { name: "Ben", game: newGame(SID, "invitee", randomFleet(rng)) };
    deliver(B, send(A));
    B.game = lockIn(B.game, seedBytes(rng));
    // Ben fires A1, B1, … in order with J9 last; Anna fires at Ben's water first.
    const benOrder = [...[...Array(100).keys()].filter((c) => c !== 89), 89];
    const water = (g: Game) => {
      const map = shipMap(g.fleet);
      return [...Array(100).keys()].sort((x, y) => Number(map[x] >= 0) - Number(map[y] >= 0));
    };
    const benWater = water(B.game);
    play(A, B, rng, {
      choose: (p) => (p === B ? benOrder : benWater)[firedBy(p.game, true).size],
    });
    expect(B.game.outcome).toEqual({ kind: "void", reason: "short" });
    expect(hitsByMe(B.game)).toBe(16);
  });

  it("a revealed fleet that isn't the seal, or isn't the five ships", () => {
    for (const how of ["moved", "illegal", "garbage"] as const) {
      const rng = seeded(40);
      const { A, B } = setup(rng);
      const realFleet = A.game.fleet;
      A.tamper = (m) => {
        if (!m.reveal) return m;
        if (how === "moved") m.reveal.fleet = randomFleet(rng);
        if (how === "illegal") m.reveal.fleet = [...realFleet.slice(0, 4), [4, realFleet[0][1], realFleet[0][2]]];
        if (how === "garbage") (m.reveal as unknown as Record<string, unknown>)["seed"] = "nope";
        return m;
      };
      play(A, B, rng);
      expect(B.game.outcome?.kind).toBe("void");
      const want = { moved: "seal", illegal: "fleet", garbage: "seal" }[how];
      expect(B.game.outcome).toMatchObject({ reason: want });
    }
  });

  it("a shot fired without holding our seal (no ack)", () => {
    const rng = seeded(41);
    const { A, B } = setup(rng);
    B.game = fire(B.game, 4);
    const m = send(B);
    delete m.ack;
    deliver(A, m);
    expect(A.game.outcome).toEqual({ kind: "void", reason: "order", at: 4 });
  });
});

describe("messages that are refused, stale or unknown", () => {
  function midGame() {
    const rng = seeded(51);
    const { A, B } = setup(rng);
    play(A, B, rng, { maxShots: 10 });
    return { A, B, rng };
  }

  it("ignores anything that isn't a Battleships message", () => {
    expect(isBsMessage({ t: "bs" })).toBe(true);
    expect(isBsMessage({ type: "move" })).toBe(false);
    expect(isBsMessage(null)).toBe(false);
    const { A } = midGame();
    expect(receive(A.game, null)).toEqual({ kind: "refuse", reason: "malformed" });
    expect(receive(A.game, { t: "chess" })).toEqual({ kind: "refuse", reason: "malformed" });
  });

  it("says 'update Battleships' for an unknown version, rules or seal suite", () => {
    const { A, B } = midGame();
    const m = send(B);
    expect(receive(A.game, { ...m, v: 2 })).toEqual({ kind: "unsupported" });
    expect(receive(A.game, { ...m, rules: "salvo" })).toEqual({ kind: "unsupported" });
    expect(receive(A.game, { ...m, commit: { suite: "sha3-cells-v2", leaves: "" } })).toEqual({ kind: "unsupported" });
  });

  it("refuses malformed messages", () => {
    const { A, B } = midGame();
    const m = send(B);
    const bad: unknown[] = [
      { ...m, sid: "another-game" },
      { ...m, shots: "x" },
      { ...m, n: m.n + 1 },
      { ...m, shots: [[0], [1], ...m.shots.slice(2)] }, // an unanswered shot before the last
      { ...m, shots: [...m.shots, [m.shots[0][0]]] }, // the same square twice by one side
      { ...m, shots: [[100]] },
      { ...m, end: "over" },
      { ...m, end: { result: "draw" } },
      { ...m, ack: 5 },
      { ...m, root: 5 },
      { ...m, commit: 3 },
      { ...m, commit: { suite: "sha256-cells-v1", leaves: "short" } },
    ];
    for (const b of bad) expect(receive(A.game, wire(b))).toEqual({ kind: "refuse", reason: "malformed" });
  });

  it("refuses bad shapes of answers: a missing salt, a wrong sunk, an echo with a salt", () => {
    const rng = seeded(52);
    const { A, B } = setup(rng, { fleetA: CLASSIC });
    B.game = fire(B.game, 0);
    deliver(A, send(B));
    const m = send(A); // Anna's answer to A1 is shot 0, "at the sender"
    const shot0 = m.shots[0];
    for (const s of [[0, "m"], [0, "x", shot0[2]], [0, "s", shot0[2]], [0, "s", shot0[2], [9, 0, "h"]], [0, "m", shot0[2], 1]]) {
      expect(receive(B.game, { ...wire(m), shots: [s] })).toEqual({ kind: "refuse", reason: "malformed" });
    }
    // Ben's own message echoing Anna's answer may not carry a salt.
    deliver(B, m);
    const mb = send(B);
    expect(receive(A.game, { ...wire(mb), shots: [[0, "m", shot0[2]]], n: 1 })).toEqual({ kind: "refuse", reason: "malformed" });
  });

  it("refuses a changed past, a forged answer of ours, and more than one step", () => {
    const { A, B } = midGame();
    const next = shooterAt(B.game.shots.length) === "invitee" ? B : A;
    const other = next === A ? B : A;
    const free = randomTarget(next, seeded(1));
    next.game = fire(next.game, free);
    const m = send(next);
    // A changed square in the past.
    const changed = wire(m);
    changed.shots[0] = [((changed.shots[0][0] as number) + 1) % 100, ...(changed.shots[0].slice(1) as [])] as never;
    expect(receive(other.game, changed)).toMatchObject({ kind: "refuse" });
    // Our answer to their shot, forged.
    const forged = wire(m);
    const k = forged.shots.findIndex((_, i) => shooterAt(i) === (next === B ? "invitee" : "challenger"));
    forged.shots[k] = [forged.shots[k][0], forged.shots[k][1] === "m" ? "h" : "m"] as never;
    expect(receive(other.game, forged)).toEqual({ kind: "refuse", reason: "rewrite" });
    // Two shots at once.
    const two = wire(m);
    const extra = randomTarget(next, seeded(2));
    two.shots = [...two.shots.slice(0, -1), [two.shots[two.shots.length - 1][0], "m"] as never, [extra === free ? (extra + 1) % 100 : extra]];
    two.n = two.shots.length;
    expect(receive(other.game, two).kind).toBe("refuse");
  });

  it("refuses a new shot by us (they can't fire our shots) and a shot while their copy is behind", () => {
    const rng = seeded(53);
    const { A, B } = setup(rng);
    B.game = fire(B.game, 0);
    deliver(A, send(B));
    // Anna has answered; a message from Ben that adds shot 1 (Anna's turn) is a rewrite.
    const m = send(B);
    m.shots = [[0], [5]];
    m.n = 2;
    expect(receive(A.game, m)).toEqual({ kind: "refuse", reason: "malformed" });
  });

  it("treats older copies and repeats as stale", () => {
    const { A, B } = midGame();
    const older = buildMessage(B.game);
    // Move on one turn.
    play(A, B, seeded(3), { maxShots: 1 });
    expect(receive(A.game, wire(older)).kind).toBe("stale");
    const now = buildMessage(B.game);
    expect(receive(A.game, wire(now)).kind).toBe("stale");
  });

  it("refuses an answer to our shot when we hold no seal for them", () => {
    const rng = seeded(54);
    const { A, B } = setup(rng);
    B.game = fire(B.game, 0);
    deliver(A, send(B));
    deliver(B, send(A));
    A.game = fire(A.game, 3);
    deliver(B, send(A));
    const m = send(B);
    const forgetful = { ...A.game, theirLeaves: null, theirRoot: null };
    delete m.commit;
    delete m.root;
    expect(receive(forgetful, m)).toEqual({ kind: "refuse", reason: "rewrite" });
  });
});

describe("their copy of the past", () => {
  it("refuses a changed answer to one of our earlier shots", () => {
    const rng = seeded(55);
    const { A, B } = setup(rng, { fleetA: CLASSIC });
    play(A, B, rng, { maxShots: 8 });
    const next = phase(A.game) === "my-turn" ? A : B;
    const other = next === A ? B : A;
    next.game = fire(next.game, randomTarget(next, rng));
    const m = send(next);
    // The first shot the receiver fired, answered by the sender: flip it.
    const k = m.shots.findIndex((_, i) => shooterAt(i) === other.game.role && m.shots[i].length >= 3);
    m.shots[k] = [m.shots[k][0], m.shots[k][1] === "m" ? "h" : "m", m.shots[k][2] as string] as never;
    expect(receive(other.game, m)).toEqual({ kind: "refuse", reason: "rewrite" });
  });

  it("an older copy that lacks their own answer to our latest shot is stale", () => {
    const rng = seeded(56);
    const { A, B } = setup(rng);
    B.game = fire(B.game, 0);
    const before = send(B); // shot 0, unanswered
    deliver(A, before);
    deliver(B, send(A));
    A.game = fire(A.game, 1);
    deliver(B, send(A));
    const answered = send(B); // Ben answered Anna's shot 1
    deliver(A, answered);
    // A held copy of Ben's message from before he answered: behind, stale.
    const old = wire(answered);
    old.shots = [old.shots[0], [old.shots[1][0]]];
    expect(receive(A.game, old).kind).toBe("stale");
  });
});

describe("our saved copy one step behind", () => {
  it("catches up from their message when it echoes our answer, worked out again here", () => {
    const rng = seeded(57);
    const { A, B } = setup(rng, { fleetA: CLASSIC });
    B.game = fire(B.game, 11);
    const saved = A.game; // Anna's store before she answered
    deliver(A, send(B));
    deliver(B, send(A)); // Ben has Anna's answer ("hit")
    // Anna reopens from her saved copy; Ben's latest message holds her answer.
    const v = receive(saved, wire(buildMessage(B.game)));
    expect(v.kind).toBe("update");
    if (v.kind !== "update") return;
    expect(v.game.shots).toEqual(A.game.shots);
    expect(v.reply).toBe(false);
  });

  it("refuses an echo that isn't the answer our fleet gives", () => {
    const rng = seeded(58);
    const { A, B } = setup(rng, { fleetA: CLASSIC });
    B.game = fire(B.game, 11);
    const saved = A.game;
    deliver(A, send(B));
    deliver(B, send(A));
    const m = wire(buildMessage(B.game));
    m.shots[0] = [11, "m"];
    expect(receive(saved, m)).toEqual({ kind: "refuse", reason: "rewrite" });
  });
});

describe("game helpers", () => {
  it("replaces a draft fleet only while it is legal and unlocked", () => {
    const rng = seeded(62);
    const g = newGame(SID, "invitee", randomFleet(rng));
    expect(setFleet(g, CLASSIC).fleet).toEqual(CLASSIC);
    expect(() => setFleet(g, CLASSIC.slice(0, 4))).toThrow();
    expect(() => lockIn({ ...g, fleet: CLASSIC.slice(0, 4) }, seedBytes(rng))).toThrow();
  });

  it("counts shots per side", () => {
    const rng = seeded(63);
    const { A, B } = setup(rng);
    play(A, B, rng, { maxShots: 5 });
    expect(shotCount(B.game)).toEqual({ mine: 3, theirs: 2 });
    expect(shotCount(A.game)).toEqual({ mine: 2, theirs: 3 });
  });

  it("phases: place → wait-seal → turns → over", () => {
    const rng = seeded(61);
    const g = newGame(SID, "challenger", CLASSIC);
    expect(phase(g)).toBe("place");
    expect(phase(lockIn(g, seedBytes(rng)))).toBe("wait-seal");
  });

  it("answers from the fleet and opens the square", () => {
    const g = lockIn(newGame(SID, "challenger", CLASSIC), new Uint8Array(32).fill(4));
    const leaves = fromB64url(g.leaves, LEAVES_BYTES)!;
    for (const c of [0, 11, 89]) {
      const a = answerShot(g, c);
      const salt = fromB64url(a.salt, 16)!;
      const s = sealBoard(SID, new Uint8Array(32).fill(4), fleetBits(CLASSIC));
      expect(salt).toEqual(s.salts[c]);
      expect(leaves.length).toBe(LEAVES_BYTES);
    }
    expect(answerShot(g, 0).ans).toBe("m");
    expect(answerShot(g, 11).ans).toBe("h");
    expect(() => answerShot(newGame(SID, "invitee", CLASSIC), 0)).toThrow();
  });

  it("every placement's squares are covered by the classic fleet bits", () => {
    const bits = fleetBits(CLASSIC);
    for (const p of CLASSIC) for (const c of placementCells(p as Placement)!) expect(bits[c]).toBe(1);
  });

  it("roles: shooter parity", () => {
    const roles: Role[] = [0, 1, 2, 3].map(shooterAt);
    expect(roles).toEqual(["invitee", "challenger", "invitee", "challenger"]);
  });
});
