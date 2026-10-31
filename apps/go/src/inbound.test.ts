import { describe, expect, it } from "vitest";
import {
  MAX_NEW,
  PROTOCOL_VERSION,
  RULES,
  buildMessage,
  catchUpFromOwnCopy,
  isGoMessage,
  judgeInbound,
  parseEntry,
  parseLog,
} from "./inbound.js";
import type { LocalGame } from "./inbound.js";
import { MAX_LOG, replay } from "./game.js";
import type { Entry } from "./game.js";
import type { Color, Size } from "./rules.js";

const at = (r: number, c: number): number => r * 9 + c;

/** A message as the opponent (playing `them`) would send it. */
function msg(log: Entry[], them: Color = "w", size: Size = 9, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...buildMessage(size, them, log), ...extra };
}

function local(log: Entry[], myColor: Color = "b", size: Size = 9): LocalGame {
  return { size, myColor, log };
}

const KO_SETUP: Entry[] = [at(0, 1), at(0, 2), at(1, 0), at(1, 1), at(2, 1), at(1, 3), at(8, 8), at(2, 2)];

function wallsGame(): Entry[] {
  const log: Entry[] = [];
  for (let r = 0; r < 9; r++) log.push(at(r, 4), at(r, 5));
  log.push("pass", at(0, 0), "pass", "pass");
  return log;
}

describe("messages", () => {
  it("carry the whole game, the receiver's colour and the rules", () => {
    expect(buildMessage(13, "b", [5])).toEqual({ t: "go", v: PROTOCOL_VERSION, rules: RULES, size: 13, youPlay: "w", log: [5] });
    expect(isGoMessage({ t: "go" })).toBe(true);
    expect(isGoMessage({ t: "bs" })).toBe(false);
    expect(isGoMessage(null)).toBe(false);
  });

  it("parse entries strictly", () => {
    expect(parseEntry(80, 9)).toBe(80);
    expect(parseEntry(81, 9)).toBeNull();
    expect(parseEntry(1.5, 9)).toBeNull();
    expect(parseEntry("pass", 9)).toBe("pass");
    expect(parseEntry("PASS", 9)).toBeNull();
    expect(parseEntry([1, 5], 9)).toEqual([1, 5]);
    expect(parseEntry([5, 1], 9)).toBeNull();
    expect(parseEntry([1, 1], 9)).toBeNull();
    expect(parseEntry({ p: 1 }, 9)).toBeNull();
    expect(parseLog(new Array(MAX_LOG + 1).fill("pass"), 9)).toBeNull();
    expect(parseLog("x", 9)).toBeNull();
  });
});

describe("judgeInbound: one legal step of the opponent", () => {
  it("takes the opponent's move and rebuilds the board itself", () => {
    const v = judgeInbound(local([at(4, 4)]), msg([at(4, 4), at(2, 2)]));
    expect(v.kind).toBe("apply");
    if (v.kind === "apply") {
      expect(v.added).toEqual([at(2, 2)]);
      expect(v.state.toMove).toBe("b");
      expect(v.state.board[at(2, 2)]).toBe(2);
    }
  });

  it("a copy of what we have is stale", () => {
    expect(judgeInbound(local([at(4, 4)]), msg([at(4, 4)]))).toEqual({ kind: "stale" });
    expect(judgeInbound(local([at(4, 4), at(2, 2)]), msg([at(4, 4)]))).toEqual({ kind: "stale" });
  });

  it("refuses a move by the wrong player (our colour)", () => {
    // Black (us) to move: the message adds a black stone.
    expect(judgeInbound(local([at(4, 4), at(2, 2)]), msg([at(4, 4), at(2, 2), at(6, 6)]))).toEqual({
      kind: "refuse",
      reason: "wrong-player",
    });
    // Our resignation forged by them.
    expect(judgeInbound(local([at(4, 4), at(2, 2)]), msg([at(4, 4), at(2, 2), "resign-b"]))).toEqual({
      kind: "refuse",
      reason: "wrong-player",
    });
  });

  it("refuses two moves at once", () => {
    // Their move, a black move for us, and their next move.
    expect(judgeInbound(local([at(4, 4)]), msg([at(4, 4), at(2, 2), at(6, 6), at(2, 6)]))).toEqual({
      kind: "refuse",
      reason: "too-many",
    });
    // Two passes in a row by the same hand can't be: the second is ours.
    expect(judgeInbound(local([at(4, 4)]), msg([at(4, 4), "pass", "pass"]))).toEqual({ kind: "refuse", reason: "wrong-player" });
    expect(MAX_NEW).toBe(2);
  });

  it("takes a move followed by their resignation", () => {
    const v = judgeInbound(local([at(4, 4)]), msg([at(4, 4), at(2, 2), "resign-w"]));
    expect(v.kind === "apply" && v.state.result).toEqual({ winner: "b", by: "resign" });
  });

  it("refuses forged captures: a stone on a point that is still occupied", () => {
    // Black (us) has C7; White claims to have captured it and plays there.
    const ours: Entry[] = [at(2, 2), at(2, 3), at(4, 4)];
    expect(judgeInbound(local(ours), msg([...ours, at(2, 2)]))).toEqual({ kind: "refuse", reason: "illegal" });
    // A board or capture count in the message is never read.
    const v = judgeInbound(local(ours), msg([...ours, at(1, 2)], "w", 9, { captures: { w: 5 }, board: new Array(81).fill(2) }));
    expect(v.kind === "apply" && v.state.captures).toEqual({ b: 0, w: 0 });
  });

  it("refuses an illegal ko retake", () => {
    // We (Black) took the ko; White takes straight back.
    const ours: Entry[] = [...KO_SETUP, at(1, 2)];
    expect(judgeInbound(local(ours), msg([...ours, at(1, 1)]))).toEqual({ kind: "refuse", reason: "illegal" });
    // After a ko threat and answer, the retake is fine.
    const later: Entry[] = [...ours, at(8, 0), at(7, 8)];
    expect(judgeInbound(local(later), msg([...later, at(1, 1)])).kind).toBe("apply");
  });

  it("refuses suicide", () => {
    const ours: Entry[] = [at(0, 1), at(4, 4), at(1, 0)];
    expect(judgeInbound(local(ours), msg([...ours, at(0, 0)]))).toEqual({ kind: "refuse", reason: "illegal" });
  });

  it("refuses a rewritten history", () => {
    expect(judgeInbound(local([at(4, 4), at(2, 2)]), msg([at(4, 5), at(2, 2), at(3, 3)]))).toEqual({ kind: "refuse", reason: "rewrite" });
  });

  it("never takes the score from the message: a tampered result is ignored", () => {
    const log = wallsGame();
    const ours = [...log, [at(0, 0)]]; // we (Black) marked White's invader dead
    // White agrees (the same marking back) and claims to have won by 100.
    const v = judgeInbound(local(ours), msg([...ours, [at(0, 0)]], "w", 9, { result: { winner: "w", margin: 100 }, score: { w: 999 } }));
    expect(v.kind).toBe("apply");
    if (v.kind === "apply") expect(v.state.result).toMatchObject({ winner: "b", by: "score", margin: 1.5 });
    // A marking that isn't whole chains / stones is refused.
    expect(judgeInbound(local(ours), msg([...ours, [at(0, 1)]]))).toEqual({ kind: "refuse", reason: "illegal" });
  });

  it("takes a disagreement and a resume", () => {
    const ours = [...wallsGame(), [at(0, 0)]];
    const disagree = judgeInbound(local(ours), msg([...ours, []]));
    expect(disagree.kind === "apply" && disagree.state.phase).toBe("counting");
    const resumed = judgeInbound(local(ours), msg([...ours, "resume"]));
    expect(resumed.kind === "apply" && resumed.state.phase).toBe("play");
    expect(resumed.kind === "apply" && resumed.state.toMove).toBe("b");
  });

  it("refuses anything after the end", () => {
    const over: Entry[] = [at(4, 4), "resign-w"];
    expect(judgeInbound(local(over), msg([...over, at(2, 2)]))).toEqual({ kind: "refuse", reason: "illegal" });
  });

  it("refuses a log longer than a game can be, before replaying it", () => {
    const huge = new Array(MAX_LOG + 1).fill("pass");
    expect(judgeInbound(local([]), { ...msg([]), log: huge })).toEqual({ kind: "refuse", reason: "malformed" });
    const many = new Array(50).fill("pass");
    expect(judgeInbound(local([]), { ...msg([]), log: many })).toEqual({ kind: "refuse", reason: "too-many" });
  });
});

describe("judgeInbound: setup", () => {
  it("the invitee takes size and colours from the first message", () => {
    const fresh: LocalGame = { size: null, myColor: null, log: [] };
    const v = judgeInbound(fresh, msg([], "b", 13));
    expect(v).toMatchObject({ kind: "apply", size: 13, myColor: "w", log: [], added: [] });
    // The inviter (Black) already played its first stone.
    const v2 = judgeInbound(fresh, msg([at(4, 4)], "b", 9));
    expect(v2).toMatchObject({ kind: "apply", size: 9, myColor: "w", added: [at(4, 4)] });
    // …but nothing more than one step.
    expect(judgeInbound(fresh, msg([at(4, 4), at(3, 3)], "b", 9))).toEqual({ kind: "refuse", reason: "wrong-player" });
  });

  it("refuses a different size or colour later", () => {
    expect(judgeInbound(local([at(4, 4)], "b", 9), msg([at(4, 4)], "w", 13))).toEqual({ kind: "refuse", reason: "setup" });
    expect(judgeInbound(local([at(4, 4)], "b", 9), msg([at(4, 4)], "b", 9))).toEqual({ kind: "refuse", reason: "setup" });
  });

  it("refuses bad sizes, colours and shapes; flags an unknown version", () => {
    expect(judgeInbound(local([]), { ...msg([]), size: 10 })).toEqual({ kind: "refuse", reason: "malformed" });
    expect(judgeInbound(local([]), { ...msg([]), youPlay: "x" })).toEqual({ kind: "refuse", reason: "malformed" });
    expect(judgeInbound(local([]), { ...msg([]), log: [{ p: 1 }] })).toEqual({ kind: "refuse", reason: "malformed" });
    expect(judgeInbound(local([]), "nope")).toEqual({ kind: "refuse", reason: "malformed" });
    expect(judgeInbound(local([]), { t: "chess" })).toEqual({ kind: "refuse", reason: "malformed" });
    expect(judgeInbound(local([]), { ...msg([]), v: 2 })).toEqual({ kind: "unsupported" });
    expect(judgeInbound(local([]), { ...msg([]), rules: "japanese" })).toEqual({ kind: "unsupported" });
  });
});

describe("judgeInbound: a resignation crossing a step", () => {
  it("they resigned while our move was on its way: our move, then their resignation", () => {
    const shared: Entry[] = [at(4, 4), at(2, 2)];
    const v = judgeInbound(local([...shared, at(6, 6)]), msg([...shared, "resign-w"]));
    expect(v.kind === "apply" && v.log).toEqual([...shared, at(6, 6), "resign-w"]);
    expect(v.kind === "apply" && v.state.result).toEqual({ winner: "b", by: "resign" });
  });

  it("we resigned while their move was on its way: their move, then our resignation", () => {
    const shared: Entry[] = [at(4, 4)];
    const v = judgeInbound(local([...shared, "resign-b"]), msg([...shared, at(2, 2)]));
    expect(v.kind === "apply" && v.log).toEqual([...shared, at(2, 2), "resign-b"]);
    expect(v.kind === "apply" && v.state.result).toEqual({ winner: "w", by: "resign" });
  });

  it("our agreement ended the game before their resignation: keep ours", () => {
    const log = wallsGame();
    // Black proposes, White disagrees with [], Black agrees with [] — over.
    const mine: Entry[] = [...log, [at(0, 0)], [], []];
    expect(replay(9, mine)?.state.phase).toBe("over");
    expect(judgeInbound(local(mine), msg([...log, [at(0, 0)], [], "resign-w"]))).toEqual({ kind: "stale" });
  });

  it("anything else that parts from our log is a rewrite", () => {
    const shared: Entry[] = [at(4, 4)];
    expect(judgeInbound(local([...shared, "resign-b"]), msg([...shared, at(2, 2), at(3, 3)]))).toEqual({ kind: "refuse", reason: "rewrite" });
    expect(judgeInbound(local([...shared, "resign-b"]), msg([...shared, at(4, 4)]))).toEqual({ kind: "refuse", reason: "illegal" });
  });
});

describe("catchUpFromOwnCopy", () => {
  it("takes our own saved log only when it extends the screen's", () => {
    expect(catchUpFromOwnCopy(9, [at(4, 4)], [at(4, 4), at(2, 2)])).toEqual([at(4, 4), at(2, 2)]);
    expect(catchUpFromOwnCopy(9, [at(4, 4)], [at(4, 5), at(2, 2)])).toBeNull();
    expect(catchUpFromOwnCopy(9, [at(4, 4)], [at(4, 4)])).toBeNull();
    expect(catchUpFromOwnCopy(9, [at(4, 4)], [at(4, 4), at(4, 4)])).toBeNull();
    expect(catchUpFromOwnCopy(9, [], "x")).toBeNull();
  });
});
