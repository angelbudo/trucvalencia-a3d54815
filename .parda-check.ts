import { botDecide } from "./src/game/bot";
import type { Action, Card, MatchState, PlayerId, RoundState } from "./src/game/types";

const C = (rank: 1 | 3 | 4 | 5 | 6 | 7, suit: "oros" | "copes" | "espases" | "bastos"): Card => ({
  rank,
  suit,
  id: `${rank}-${suit}`,
});

function mkRound(partial: Partial<RoundState> & Pick<RoundState, "hands" | "tricks">): RoundState {
  return {
    mano: 0,
    turn: 0,
    trucState: { kind: "none", level: 0 },
    envitState: { kind: "none" },
    envitResolved: true,
    phase: "playing",
    log: [],
    ...partial,
  } as RoundState;
}

function mkMatch(r: RoundState): MatchState {
  return {
    scores: { nos: { males: 0, bones: 0 }, ells: { males: 0, bones: 0 } },
    camesWon: { nos: 0, ells: 0 },
    cames: 0,
    targetCama: 12,
    targetCames: 2,
    round: r,
    dealer: 3,
    history: [],
  };
}

const cardOf = (m: MatchState, p: PlayerId, id: string) =>
  m.round.hands[p].find((c) => c.id === id)!;

function run(name: string, m: MatchState, p: PlayerId, check: (a: Action | null) => boolean) {
  let ok = true;
  let last: Action | null = null;
  for (let i = 0; i < 30; i++) {
    last = botDecide(m, p);
    if (!check(last)) ok = false;
  }
  console.log(`${ok ? "PASS" : "FAIL"} — ${name} → ${JSON.stringify(last)}`);
}

// ---------- A: 2a baza, hem guanyat la 1a, rival guanya amb 3, tenim un 3 ----------
{
  const r = mkRound({
    hands: {
      0: [C(3, "bastos"), C(6, "copes")],
      1: [C(7, "oros"), C(4, "espases")],
      2: [C(5, "oros"), C(7, "copes")],
      3: [C(1, "espases"), C(5, "bastos")],
    },
    tricks: [
      {
        cards: [
          { player: 0, card: C(7, "espases") },
          { player: 1, card: C(4, "oros") },
          { player: 2, card: C(5, "copes") },
          { player: 3, card: C(6, "bastos") },
        ],
        winner: 0,
      },
      {
        cards: [
          { player: 2, card: C(4, "copes") },
          { player: 1, card: C(3, "oros") },
        ],
      },
    ],
    turn: 0,
  });
  const m = mkMatch(r);
  run("2a baza: rival amb 3 i bot amb 3 → ha d'empardar", m, 0, (a) => a?.type === "play-card" && a.cardId === "3-bastos");
}

// ---------- B: mateix però el bot a més té una TOP (i podria guanyar) ----------
{
  const r = mkRound({
    hands: {
      0: [C(3, "bastos"), C(7, "oros")],
      1: [C(4, "espases"), C(6, "copes")],
      2: [C(5, "oros"), C(7, "copes")],
      3: [C(1, "espases"), C(5, "bastos")],
    },
    tricks: [
      {
        cards: [
          { player: 0, card: C(7, "espases") },
          { player: 1, card: C(4, "oros") },
          { player: 2, card: C(5, "copes") },
          { player: 3, card: C(6, "bastos") },
        ],
        winner: 0,
      },
      {
        cards: [
          { player: 2, card: C(4, "copes") },
          { player: 1, card: C(3, "oros") },
        ],
      },
    ],
    turn: 0,
  });
  const m = mkMatch(r);
  run("2a baza: bot amb 3 + TOP → no tira la més baixa (guanya o empara)", m, 0, (a) => {
    if (a?.type !== "play-card") return false;
    const card = cardOf(m, 0, a.cardId);
    const strength = card.rank === 3 ? 70 : card.rank === 7 && card.suit === "oros" ? 85 : 0;
    return !a.covered && strength >= 70;
  });
}

// ---------- C: company guanya amb un 3 → NO el pisquem ----------
{
  const r = mkRound({
    hands: {
      0: [C(3, "bastos"), C(6, "copes")],
      1: [C(7, "oros"), C(4, "espases")],
      2: [C(5, "oros"), C(7, "copes")],
      3: [C(1, "espases"), C(5, "bastos")],
    },
    tricks: [
      {
        cards: [
          { player: 0, card: C(7, "espases") },
          { player: 1, card: C(4, "oros") },
          { player: 2, card: C(5, "copes") },
          { player: 3, card: C(6, "bastos") },
        ],
        winner: 0,
      },
      {
        cards: [
          { player: 2, card: C(3, "oros") },
          { player: 3, card: C(5, "bastos") },
        ],
      },
    ],
    turn: 0,
  });
  const m = mkMatch(r);
  run("2a baza: company guanya amb 3 → bot descarta la baixa", m, 0, (a) => a?.type === "play-card" && a.cardId === "6-copes");
}

// ---------- D: hem PERDUT la 1a → la regla no s'activa ----------
{
  const r = mkRound({
    hands: {
      0: [C(3, "bastos"), C(6, "copes")],
      1: [C(7, "oros"), C(4, "espases")],
      2: [C(5, "oros"), C(7, "copes")],
      3: [C(1, "espases"), C(5, "bastos")],
    },
    tricks: [
      {
        cards: [
          { player: 0, card: C(4, "oros") },
          { player: 1, card: C(7, "espases") },
          { player: 2, card: C(5, "copes") },
          { player: 3, card: C(6, "bastos") },
        ],
        winner: 1,
      },
      {
        cards: [
          { player: 1, card: C(3, "oros") },
          { player: 2, card: C(4, "copes") },
        ],
      },
    ],
    turn: 0,
  });
  const m = mkMatch(r);
  run("2a baza havent perdut la 1a → no força l'empare", m, 0, (a) => a !== null);
}

// ---------- E: 3a baza amb 1-1, rival guanya amb 3, tenim un 3 ----------
{
  const r = mkRound({
    hands: {
      0: [C(3, "bastos"), C(6, "copes")],
      1: [C(7, "oros"), C(4, "espases")],
      2: [C(5, "oros"), C(7, "copes")],
      3: [C(1, "espases"), C(5, "bastos")],
    },
    tricks: [
      {
        cards: [
          { player: 0, card: C(7, "espases") },
          { player: 1, card: C(4, "oros") },
          { player: 2, card: C(5, "copes") },
          { player: 3, card: C(6, "bastos") },
        ],
        winner: 0,
      },
      {
        cards: [
          { player: 1, card: C(1, "espases") },
          { player: 2, card: C(5, "oros") },
          { player: 3, card: C(4, "espases") },
          { player: 0, card: C(4, "copes") },
        ],
        winner: 1,
      },
      {
        cards: [
          { player: 1, card: C(3, "oros") },
          { player: 2, card: C(7, "copes") },
        ],
      },
    ],
    turn: 0,
  });
  const m = mkMatch(r);
  run("3a baza 1-1: rival amb 3 i bot amb 3 → ha d'empardar", m, 0, (a) => a?.type === "play-card" && a.cardId === "3-bastos");
}
