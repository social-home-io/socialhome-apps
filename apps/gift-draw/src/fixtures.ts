/** Shared test data (no production code imports this). */
import type { DrawStatus, GroupPlayer, GroupSession } from "@socialhome/app-sdk";

export const ANNA: GroupPlayer = { seat: 1, name: "Anna", household: null, isLocal: true, state: "seated" };
export const BEN: GroupPlayer = { seat: 2, name: "Ben", household: "Familie Okafor", isLocal: false, state: "seated" };
export const LENA: GroupPlayer = { seat: 3, name: "Lena", household: "Familie Okafor", isLocal: false, state: "seated" };
export const CLEO: GroupPlayer = { seat: 4, name: "Cleo", household: "Lund", isLocal: false, state: "seated" };

export function table(over: Partial<GroupSession> = {}): GroupSession {
  return {
    id: "t1",
    appId: "gift-draw",
    state: "lobby",
    me: 1,
    myState: "seated",
    host: 1,
    isHost: true,
    min: 3,
    max: 30,
    lateJoin: false,
    players: [ANNA, BEN, LENA, CLEO],
    ...over,
  };
}

export function status(over: Partial<DrawStatus> = {}): DrawStatus {
  return {
    id: "t1",
    state: "gathering",
    round: 0,
    again: 0,
    of: 4,
    settings: { name: "Wichteln 2026", budget: "about 20 €", day: "2026-12-24", pairs: [] },
    wish: "",
    hasResult: false,
    isHost: true,
    ...over,
  };
}
