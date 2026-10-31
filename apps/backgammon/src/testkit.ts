/**
 * Test helpers (imported only by *.test.ts): two apps playing each other
 * over the real message format, with fixed seeds.
 */

import type { Color } from "./rules.js";
import { buildChain } from "./dice.js";
import { canDouble, replay } from "./game.js";
import type { Entry, GameState, Setup } from "./game.js";
import { buildMessage, diceSource, judgeInbound } from "./inbound.js";
import type { InboundVerdict, LocalGame, Shown, WireMessage } from "./inbound.js";
import { flatten, nextSteps } from "./rules.js";
import type { Step } from "./rules.js";

export function seedOf(fill: number): Uint8Array {
  const s = new Uint8Array(32);
  for (let i = 0; i < 32; i++) s[i] = (fill * 31 + i * 7) & 0xff;
  return s;
}

/** One player's app, as far as the protocol goes. */
export class Player {
  setup: Setup | null = null;
  color: Color | null = null;
  chain: Uint8Array[] | null = null;
  theirTip: Uint8Array | null = null;
  theirShown: Shown | null = null;
  log: Entry[] = [];

  constructor(
    public sid: string,
    public role: "inviter" | "invitee",
    public seed: Uint8Array,
  ) {}

  /** The inviter starts: its colour and the setup. */
  invite(color: Color, cube = true, days = 0): WireMessage {
    this.setup = { inviter: color, cube, days };
    this.color = color;
    this.chain = buildChain(this.seed);
    return this.message();
  }

  local(): LocalGame {
    return {
      sid: this.sid,
      role: this.role,
      setup: this.setup,
      myColor: this.color,
      myChain: this.chain,
      theirTip: this.theirTip,
      theirShown: this.theirShown,
      log: this.log,
    };
  }

  dice() {
    return diceSource(this.sid, this.color!, this.chain!, this.theirShown);
  }

  state(): GameState | null {
    if (!this.setup || !this.theirTip) return null;
    return replay(this.setup, this.log, this.dice())?.state ?? null;
  }

  /** The link we must have shown now. */
  shown(): Shown | null {
    const st = this.state();
    const n = st ? st.reveals[this.color!] : this.role === "invitee" && this.theirTip ? 1 : 0;
    return n > 0 ? { n, link: this.chain![n] } : null;
  }

  message(extras: { claim?: boolean; refusedMs?: number } = {}): WireMessage {
    return buildMessage(
      { setup: this.setup!, myColor: this.color!, myTip: this.chain![0], theirTip: this.theirTip, shown: this.shown(), log: this.log },
      extras,
    );
  }

  /** Take a message the way the app does; returns the verdict. */
  receive(msg: unknown): InboundVerdict {
    const v = judgeInbound(this.local(), JSON.parse(JSON.stringify(msg)));
    if (v.kind === "invite") {
      this.setup = v.setup;
      this.color = v.myColor;
      this.theirTip = v.theirTip;
      this.chain = buildChain(this.seed);
    } else if (v.kind === "apply") {
      this.theirTip = v.theirTip;
      this.theirShown = v.theirShown;
      this.log = v.log;
    }
    return v;
  }

  /** Our next step, as an honest app would choose it (greedy moves). */
  autoStep(opts: { double?: boolean; take?: boolean } = {}): Entry {
    const st = this.state()!;
    if (st.phase === "start") return st.mover === this.color ? autoTurn(st) : "open";
    if (st.phase === "cube") return opts.take === false ? "drop" : "take";
    if (opts.double && canDouble(st)) return "double";
    return autoTurn(st);
  }

  play(e: Entry): WireMessage {
    this.log = [...this.log, e];
    return this.message();
  }
}

/** A whole legal turn: always the first next step offered. */
export function autoTurn(st: GameState): number[] {
  const steps: Step[] = [];
  for (;;) {
    const next = nextSteps(st.board, st.mover!, st.roll!, steps);
    if (next.length === 0) break;
    steps.push(next[0]);
  }
  return flatten(steps);
}

/** A new game up to the point where the inviter has to act. */
export function startGame(opts: { sid?: string; inviterColor?: Color; cube?: boolean; days?: number; seeds?: [number, number] } = {}) {
  const sid = opts.sid ?? "s-1";
  const [sa, sb] = opts.seeds ?? [1, 2];
  const a = new Player(sid, "inviter", seedOf(sa));
  const b = new Player(sid, "invitee", seedOf(sb));
  const m1 = a.invite(opts.inviterColor ?? "w", opts.cube ?? true, opts.days ?? 0);
  const v1 = b.receive(m1);
  if (v1.kind !== "invite") throw new Error(`invite: ${v1.kind}`);
  const v2 = a.receive(b.message());
  if (v2.kind !== "apply") throw new Error(`accept: ${v2.kind}`);
  return { a, b, sid };
}

/** Who acts now, of the two. */
export function actorOf2(a: Player, b: Player): Player {
  const st = a.state()!;
  return st.toMove === a.color ? a : b;
}

export function opponent(p: Player, a: Player, b: Player): Player {
  return p === a ? b : a;
}

