import { afterEach, describe, expect, it } from "vitest";
import { fire, lockIn, newGame, resign } from "./game.js";
import type { Game } from "./game.js";
import { buildMessage, markSent, receive } from "./protocol.js";
import type { GameEvent } from "./protocol.js";
import type { Fleet } from "./rules.js";
import type { GameEntry } from "./lifecycle.js";
import { setLocale } from "./i18n.js";
import {
  announce,
  chipFor,
  lastEvent,
  lastShotAtMe,
  ownBoard,
  ownCellLabel,
  ownHits,
  progressFor,
  revealedBoard,
  statusFor,
  targetBoard,
  targetCellLabel,
  theirSunk,
  verdictFor,
} from "./view.js";

const SID = "view-test";
// Anna (challenger): carrier B2–F2, battleship H3–H6, cruiser A8–C8, submarine E5–E7, destroyer I9–J9.
const ANNA: Fleet = [[0, 11, "h"], [1, 27, "v"], [2, 70, "h"], [3, 44, "v"], [4, 88, "h"]];
// Ben (invitee): five ships on rows 1–5 from A.
const BEN: Fleet = [[0, 0, "h"], [1, 10, "h"], [2, 20, "h"], [3, 30, "h"], [4, 40, "h"]];

const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Side { game: Game; events: GameEvent[] }

function setup() {
  const A: Side = { game: lockIn(newGame(SID, "challenger", ANNA), new Uint8Array(32).fill(1)), events: [] };
  const B: Side = { game: newGame(SID, "invitee", BEN), events: [] };
  deliver(A, B);
  B.game = lockIn(B.game, new Uint8Array(32).fill(2));
  return { A, B };
}

function deliver(from: Side, to: Side): void {
  const m = wire(buildMessage(from.game));
  from.game = markSent(from.game);
  const v = receive(to.game, m);
  if (v.kind === "update") {
    to.game = v.game;
    to.events = v.events;
    if (v.reply) deliver(to, from);
  }
}

/** Ben fires at *b*, Anna answers, then Anna fires at *a* (if given). */
function turn(A: Side, B: Side, b: number, a?: number): void {
  B.game = fire(B.game, b);
  deliver(B, A);
  if (a !== undefined) {
    A.game = fire(A.game, a);
    deliver(A, B);
  }
}

const entry = (g: Game, name = "Ben"): GameEntry => ({
  sessionId: SID, opponentInstanceId: "i", opponentRef: "r", opponentIsLocal: false, opponentName: name, game: g,
});

afterEach(() => setLocale("en"));

describe("a game as Anna sees it", () => {
  it("before any shot: invite sent; Ben fires first", () => {
    const { A, B } = setup();
    expect(statusFor(entry(A.game))).toEqual({ title: "Invite sent", detail: "Ben fires first after placing their fleet." });
    expect(chipFor(entry(A.game)).text).toBe("Invite sent");
    expect(statusFor(entry(B.game, "Anna")).title).toBe("Your turn");
    expect(statusFor(entry(B.game, "Anna")).detail).toBe("You fire first. Pick a square in Anna's waters.");
  });

  it("reports shots, hits on our ships and sunk ships in plain words", () => {
    const { A, B } = setup();
    turn(A, B, 11, 99); // Ben hits Anna's carrier at B2; Anna misses at J10 (Ben answers at once)
    expect(lastEvent(entry(B.game, "Anna"))).toBe("Anna fired at J10: miss.");
    expect(statusFor(entry(B.game, "Anna")).detail).toBe("Anna fired at J10: miss. Pick a square in Anna's waters.");
    expect(statusFor(entry(A.game)).title).toBe("Ben's turn");
    expect(statusFor(entry(A.game)).detail).toBe("You fired at J10: miss.");
    B.game = fire(B.game, 88); // Ben hits the destroyer at I9; Anna's answer is on its way
    expect(statusFor(entry(B.game, "Anna")).detail).toBe("You fired at I9. Waiting for Anna's answer.");
    deliver(B, A);
    A.game = fire(A.game, 40);
    deliver(A, B); // Anna hits Ben's destroyer at A5
    turn(A, B, 89, 41); // Ben sinks Anna's destroyer; Anna sinks Ben's
    expect(lastEvent(entry(B.game, "Anna"))).toBe("Anna fired at B5 and sank your destroyer.");
    expect(lastEvent(entry(A.game))).toBe("You fired at B5 and sank Ben's destroyer.");
    expect(progressFor(entry(A.game))).toBe("You 2/17 hits · Ben 3/17 · You fired at B5 and sank Ben's destroyer.");
    expect(theirSunk(A.game)).toEqual(new Set([4]));
    expect(ownHits(A.game)).toEqual([1, 0, 0, 0, 2]);
  });

  it("draws both boards and labels every square", () => {
    const { A, B } = setup();
    turn(A, B, 11, 0);
    deliver(B, A);
    turn(A, B, 12);
    const target = targetBoard(A.game);
    expect(target[0]).toEqual({ kind: "hit" });
    expect(target[1]).toEqual({ kind: "none" });
    expect(targetCellLabel(A.game, 0, "Ben", false)).toBe("A1, hit");
    expect(targetCellLabel(A.game, 1, "Ben", true)).toBe("B1, not fired yet, aimed");
    A.game = fire(A.game, 1);
    expect(targetCellLabel(A.game, 1, "Ben", false)).toBe("B1, fired, waiting for the answer");
    const own = ownBoard(A.game);
    expect(own[11]).toEqual({ ship: 0, shot: "hit" });
    expect(own[0]).toEqual({ ship: -1, shot: "none" });
    expect(ownCellLabel(A.game, 12, "Ben")).toBe("C2, your carrier, hit, Ben's last shot");
    expect(ownCellLabel(A.game, 13, "Ben")).toBe("D2, your carrier");
    expect(ownCellLabel(A.game, 0, "Ben")).toBe("A1, water");
    expect(lastShotAtMe(A.game)).toBe(12);
    expect(revealedBoard(A.game)).toBeNull();
  });

  it("says it in German too", () => {
    const { A, B } = setup();
    turn(A, B, 11, 0);
    setLocale("de");
    expect(statusFor(entry(B.game, "Anna")).detail).toBe("Anna hat auf A1 geschossen: Treffer auf deinem Flugzeugträger. Wähle ein Feld im Gewässer von Anna.");
    expect(chipFor(entry(B.game, "Anna")).text).toBe("Du bist dran");
  });

  it("announces what happened, and whose turn it is", () => {
    const { A, B } = setup();
    B.game = fire(B.game, 11);
    deliver(B, A);
    const ann = announce(A.events, entry(A.game));
    expect(ann.polite).toEqual(["Ben fired at B2: hit on your carrier.", "Your turn."]);
  });
});

describe("chips and the end", () => {
  it("their turn shows since when", () => {
    const { A, B } = setup();
    turn(A, B, 11, 0);
    const now = A.game.updatedAt + 2 * 86400_000;
    expect(chipFor(entry(A.game), now)).toEqual({ text: "Ben's turn · 2 days ago", tone: "plain" });
    expect(chipFor(entry(A.game), A.game.updatedAt)).toEqual({ text: "Ben's turn", tone: "plain" });
  });

  it("a resign: won and checked for one, lost and checked for the other", () => {
    const { A, B } = setup();
    turn(A, B, 11, 0);
    B.game = resign(B.game);
    deliver(B, A);
    expect(chipFor(entry(A.game))).toEqual({ text: "You won · fleet checked ✓", tone: "ok" });
    expect(verdictFor(entry(A.game))).toMatchObject({ tone: "ok", title: "You won — Ben resigned" });
    expect(chipFor(entry(B.game, "Anna")).text).toBe("You lost");
    expect(verdictFor(entry(B.game, "Anna"))?.title).toBe("You resigned");
    expect(revealedBoard(A.game)?.[0]).toEqual({ ship: 0, shot: "hit" });
    expect(targetCellLabel(A.game, 1, "Ben", false)).toBe("B1, Ben's carrier");
  });

  it("a winner who hasn't shown the fleet yet", () => {
    const { A } = setup();
    const lost = { ...A.game, outcome: { kind: "lost" as const, how: "fleet" as const } };
    expect(chipFor(entry(lost)).text).toBe("Ben won · fleet not shown yet");
    expect(verdictFor(entry(lost))?.lines).toEqual(["Ben's fleet isn't shown yet, so this result isn't confirmed."]);
    const won = { ...A.game, outcome: { kind: "won" as const, how: "fleet" as const } };
    expect(chipFor(entry(won)).text).toBe("You won · not checked yet");
  });

  it("a void game says where, neutrally", () => {
    const { A } = setup();
    const v = { ...A.game, outcome: { kind: "void" as const, reason: "answer" as const, at: 33 } };
    expect(chipFor(entry(v))).toEqual({ text: "Void", tone: "bad" });
    expect(progressFor(entry(v))).toBe("Ben's answer for D4 didn't match the fleet Ben locked in at the start.");
    expect(verdictFor(entry(v))).toEqual({
      tone: "bad",
      title: "The game is void",
      lines: [
        "Ben's answer for D4 didn't match the fleet Ben locked in at the start.",
        "Nobody wins this game. This can be an older or changed copy of Battleships, not necessarily on purpose.",
      ],
      checks: [],
    });
    expect(announce([{ type: "over" }], entry(v)).assertive).toEqual([
      "The game is void: Ben's answer for D4 didn't match the fleet Ben locked in at the start.",
    ]);
    expect(targetCellLabel(v, 33, "Ben", false)).toBe("D4, not fired yet, the answer here didn't match");
    for (const reason of ["sunk", "reseal", "order", "seal", "fleet", "short", "them"] as const) {
      expect(progressFor(entry({ ...A.game, outcome: { kind: "void", reason, at: 0 } }))).toContain("Ben");
    }
  });

  it("placing: the invitee's chip and line", () => {
    const g = newGame(SID, "invitee", BEN);
    expect(chipFor(entry(g, "Anna"))).toEqual({ text: "Place your fleet", tone: "turn" });
    expect(progressFor(entry(g, "Anna"))).toBe("Anna invited you. Place your fleet to start.");
    expect(statusFor(entry(g, "Anna")).title).toBe("Place your fleet");
    expect(verdictFor(entry(g, "Anna"))).toBeNull();
  });

  it("an invitee without the challenger's seal waits for it", () => {
    const g = lockIn(newGame(SID, "invitee", BEN), new Uint8Array(32));
    expect(chipFor(entry(g, "Anna")).text).toBe("Waiting for Anna");
    expect(statusFor(entry(g, "Anna")).title).toBe("Waiting for Anna's fleet");
    expect(progressFor(entry(g, "Anna"))).toBe("Your fleet is locked in. Waiting for Anna's fleet.");
  });
});
