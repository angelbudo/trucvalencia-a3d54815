import type { Action, Card, MatchState, PlayerId } from "./types";
import { isCamaMatchPoint, legalActions } from "./engine";
import { bestEnvit, buildDeck, cardStrength, isRealCard, playerTotalEnvit } from "./deck";
import { teamOf } from "./types";
import type { PartnerAdvice } from "./botConsult";
import { pickFortSignalCard, pickMolestoCard, pickTresCard, type CardHint, type PlayStrengthHint } from "./playerIntents";
import { NEUTRAL_TUNING, type BotTuning } from "./profileAdaptation";

export interface BotHints {
  cardHint?: CardHint;
  playStrength?: PlayStrengthHint;
  silentTruc?: boolean;
  foldTruc?: boolean;
  /**
   * El company humà ha indicat "Truca!" — si és legal cantar truc i no
   * està en mode `silentTruc`, fes-ho immediatament.
   */
  forceTruc?: boolean;
  /**
   * El company humà ha indicat "Envida!" — si és legal cantar envit,
   * fes-ho immediatament sense considerar la força de la mà.
   */
  forceEnvit?: boolean;
  /**
   * Mode sincer: indica si algun rival ha mostrat força en aquesta ronda
   * dient "Vine a mi!" (vine-a-mi) o "Algo tinc" (tinc-bona). Quan és
   * `true`, mai es reserva una carta forta (manilla d'espases o manilla
   * d'oros) confiant que la mesa és inofensiva.
   */
  rivalShownStrength?: boolean;
  /**
   * El propi bot ha dit "Algo tinc" (tinc-bona) en aquesta ronda: confirma
   * que té almenys una carta Top. Activa la regla de la 1a baza
   * (`applyAlgoTincFirstBaza`).
   */
  saidAlgoTinc?: boolean;
}

/** Carta TOP del Truc: As d'espases, As de bastos, 7 d'espases, 7 d'oros. */
function isTopCard(c: Card): boolean {
  return (
    (c.rank === 1 && (c.suit === "espases" || c.suit === "bastos")) ||
    (c.rank === 7 && (c.suit === "espases" || c.suit === "oros"))
  );
}

/**
 * Perfil CONSERVADOR I SINCER (baza 2, havent guanyat la 1a):
 * el bot NOMÉS pot cantar truc si té força real (no farols):
 *   (A) A la mà: com a mínim un 3 + una TOP, o dues TOP.
 *   (B) A la mà: un 3 o una TOP, i el company ha senyalitzat "Algo tinc"/
 *       "Vine a mi" (partnerAdvice === "strong") sense haver jugat encara
 *       cap TOP, o "Tinc un tres" (partnerAdvice === "three") sense haver
 *       jugat encara cap 3.
 * Qualsevol altra situació (cartes mediocres, cap seña real) → NO truc.
 */
function partnerHasPlayedTop(
  r: import("./types").RoundState,
  player: PlayerId,
): boolean {
  const myTeam = teamOf(player);
  for (const t of r.tricks) {
    for (const tc of t.cards) {
      if (
        tc.player !== player &&
        teamOf(tc.player) === myTeam &&
        isTopCard(tc.card)
      ) {
        return true;
      }
    }
  }
  return false;
}
function partnerHasPlayedThree(
  r: import("./types").RoundState,
  player: PlayerId,
): boolean {
  const myTeam = teamOf(player);
  for (const t of r.tricks) {
    for (const tc of t.cards) {
      if (
        tc.player !== player &&
        teamOf(tc.player) === myTeam &&
        tc.card.rank === 3
      ) {
        return true;
      }
    }
  }
  return false;
}
function canCallTrucSecondTrickConservative(
  hand: Card[],
  partnerAdvice: PartnerAdvice,
  r: import("./types").RoundState,
  player: PlayerId,
): boolean {
  const tops = hand.filter(isTopCard);
  const hasThree = hand.some((c) => c.rank === 3);
  const hasTop = tops.length > 0;
  // (A) Força pura a la mà.
  if (hasThree && hasTop) return true;
  if (tops.length >= 2) return true;
  // (B) 3 o TOP + seña veraç i encara viva del company.
  const partnerStillHasTop =
    partnerAdvice === "strong" && !partnerHasPlayedTop(r, player);
  const partnerStillHasThree =
    partnerAdvice === "three" && !partnerHasPlayedThree(r, player);
  if ((partnerStillHasTop || partnerStillHasThree) && (hasTop || hasThree)) {
    return true;
  }
  return false;
}

/**
 * REGLA DE L'USUARI (matriu explícita) — Bot 3r a tirar en la 1a BAZA.
 *
 * Principi general: no malgastar cartes altes si el company ja té dominada
 * la baza; pressionar o assegurar quan el rival va guanyant.
 *
 * Precondicions: r.tricks.length === 1, la baza actual té exactament 2
 * cartes a la mesa, el bot encara no ha jugat en ella i li queden 3 cartes
 * a la mà.
 */
function applyThirdSeatFirstBaza(
  m: MatchState,
  player: PlayerId,
  _hints: BotHints,
): Action | null {
  const r = m.round;
  if (r.phase !== "playing") return null;
  if (r.tricks.length !== 1) return null;
  const trick = r.tricks[0];
  if (!trick || trick.cards.length !== 2) return null;
  if (r.turn !== player) return null;
  if (trick.cards.some((tc) => tc.player === player)) return null;
  const hand = r.hands[player] ?? [];
  if (hand.length !== 3) return null;

  const myTeam = teamOf(player);
  const partnerCard =
    trick.cards.find((tc) => tc.player !== player && teamOf(tc.player) === myTeam) ?? null;
  const oppCard = trick.cards.find((tc) => teamOf(tc.player) !== myTeam) ?? null;
  if (!partnerCard || !oppCard) return null;

  const legals = legalActions(m, player);
  const playActions = legals.filter(
    (a): a is Extract<Action, { type: "play-card" }> => a.type === "play-card",
  );
  if (playActions.length === 0) return null;
  const findPlay = (cardId: string): Action | null =>
    playActions.find((a) => a.cardId === cardId) ?? null;

  const partnerStr = cardStrength(partnerCard.card);
  const oppStr = cardStrength(oppCard.card);
  const mesaMax = Math.max(partnerStr, oppStr);
  const partnerWinsOrTies = partnerStr >= oppStr;
  const partnerPlayedTop = isTopCard(partnerCard.card);
  const partnerPlayedThree = partnerCard.card.rank === 3;
  const partnerDominant = partnerPlayedTop || partnerPlayedThree;
  const topOnTable = isTopCard(partnerCard.card) || isTopCard(oppCard.card);

  const tops = hand.filter(isTopCard);
  const threes = hand.filter((c) => c.rank === 3);

  const sortedAsc = [...hand].sort((a, b) => cardStrength(a) - cardStrength(b));
  const lowest = sortedAsc[0]!;

  // Regla 3 (descart): company ja va guanyant/empardant amb 3 o TOP → baixa.
  if (partnerWinsOrTies && partnerDominant) {
    const play = findPlay(lowest.id);
    if (play) return play;
  }

  // Regla 1: TOP que guanya la baza (strictament) → jugar la TOP més baixa
  // que guanye (no malgastar la més alta si no cal).
  const winningTops = tops.filter((c) => cardStrength(c) > mesaMax);
  if (winningTops.length > 0) {
    const t = winningTops.reduce((a, b) =>
      cardStrength(a) <= cardStrength(b) ? a : b,
    );
    const play = findPlay(t.id);
    if (play) return play;
  }

  // Regla 1.1: cap TOP a la mesa, el company no ha tirat un 3 guanyador/
  // empardador, i el bot té un 3 que guanya o emparda la mesa → tirar el 3.
  if (
    !topOnTable &&
    !(partnerPlayedThree && partnerWinsOrTies) &&
    threes.length > 0
  ) {
    const winningThree = threes.find((c) => cardStrength(c) >= mesaMax);
    if (winningThree) {
      const play = findPlay(winningThree.id);
      if (play) return play;
    }
  }

  // Regla 2: sense 3 ni TOP, però amb alguna carta que supere la mesa i el
  // rival va guanyant → tirar la MÉS ALTA que supere (pressió al 4t).
  if (tops.length === 0 && threes.length === 0 && !partnerWinsOrTies) {
    const beaters = hand.filter((c) => cardStrength(c) > mesaMax);
    if (beaters.length > 0) {
      const highest = beaters.reduce((a, b) =>
        cardStrength(a) >= cardStrength(b) ? a : b,
      );
      const play = findPlay(highest.id);
      if (play) return play;
    }
  }

  // Regla 3 (fallback): cap carta pot guanyar/empardar la mesa → descart baix.
  const fallback = findPlay(lowest.id);
  if (fallback) return fallback;
  return null;
}

/**
 * REGLA DE L'USUARI (matriu explícita) — Bot 3r a tirar en la 2a BAZA
 * havent guanyat el seu equip la 1a baza.
 *
 * Precondicions estrictes: r.tricks.length === 2, la baza actual té
 * exactament 2 cartes a la mesa, el bot encara no ha jugat en ella i li
 * queden EXACTAMENT 2 cartes a la mà.
 *
 * Retorna l'Action a executar (jugar carta — potser tapada — o cantar
 * truc) o null si la regla no aplica.
 */
function applyThirdSeatSecondBazaWonFirst(
  m: MatchState,
  player: PlayerId,
  hints: BotHints,
): Action | null {
  const r = m.round;
  if (r.phase !== "playing") return null;
  if (r.tricks.length !== 2) return null;
  const first = r.tricks[0];
  const trick = r.tricks[1];
  if (!first || !trick) return null;
  if (first.parda === true || first.winner === undefined) return null;
  const myTeam = teamOf(player);
  if (teamOf(first.winner) !== myTeam) return null;
  if (trick.cards.length !== 2) return null;
  if (r.turn !== player) return null;
  if (trick.cards.some((tc) => tc.player === player)) return null;
  const hand = r.hands[player] ?? [];
  if (hand.length !== 2) return null;

  const partnerCard = trick.cards.find((tc) => teamOf(tc.player) === myTeam) ?? null;
  const oppCard = trick.cards.find((tc) => teamOf(tc.player) !== myTeam) ?? null;
  if (!partnerCard || !oppCard) return null;

  const legals = legalActions(m, player);
  const playActions = legals.filter(
    (a): a is Extract<Action, { type: "play-card" }> => a.type === "play-card",
  );
  if (playActions.length === 0) return null;

  const findPlay = (cardId: string, covered = false): Action | null => {
    const exact = playActions.find(
      (a) => a.cardId === cardId && !!a.covered === covered,
    );
    if (exact) return exact;
    const any = playActions.find((a) => a.cardId === cardId);
    if (!any) return null;
    if (covered) return { type: "play-card", cardId, covered: true };
    return any;
  };

  const partnerStr = cardStrength(partnerCard.card);
  const oppStr = cardStrength(oppCard.card);
  const partnerWinsOrTies = partnerStr >= oppStr;
  const partnerPlayedTop = isTopCard(partnerCard.card);
  const partnerPlayedThree = partnerCard.card.rank === 3;
  const partnerPlayedTopOrThree = partnerPlayedTop || partnerPlayedThree;

  const tops = hand.filter(isTopCard);
  const threes = hand.filter((c) => c.rank === 3);
  const hasTop = tops.length > 0;
  const hasThree = threes.length > 0;
  const nTops = tops.length;
  const nThrees = threes.length;

  const sortedAsc = [...hand].sort((a, b) => cardStrength(a) - cardStrength(b));
  const lowest = sortedAsc[0]!;

  // Cartes TOP encara vives fora de la meua mà (per saber si la meua és
 // la més alta que queda per jugar en la partida).
  const TOP_ITEMS: Card[] = [
    { suit: "espases", rank: 1, id: "1-espases" },
    { suit: "bastos", rank: 1, id: "1-bastos" },
    { suit: "espases", rank: 7, id: "7-espases" },
    { suit: "oros", rank: 7, id: "7-oros" },
  ];
  const playedIds = new Set<string>();
  for (const t of r.tricks) for (const tc of t.cards) playedIds.add(tc.card.id);
  const myIds = new Set(hand.map((c) => c.id));
  let maxAliveTopOutside = -1;
  for (const top of TOP_ITEMS) {
    if (playedIds.has(top.id) || myIds.has(top.id)) continue;
    const s = cardStrength(top);
    if (s > maxAliveTopOutside) maxAliveTopOutside = s;
  }
  const myHighestTop = hasTop
    ? tops.reduce((a, b) => (cardStrength(a) >= cardStrength(b) ? a : b))
    : null;
  const myMaxTopStr = myHighestTop ? cardStrength(myHighestTop) : -1;
  const iHaveHighestAliveTop = hasTop && myMaxTopStr > maxAliveTopOutside;

  const lowestThree = hasThree
    ? threes.reduce((a, b) => (cardStrength(a) <= cardStrength(b) ? a : b))
    : null;
  const lowestOtherTop = (excluding: Card): Card | null => {
    const others = tops.filter((c) => c.id !== excluding.id);
    if (others.length === 0) return null;
    return others.reduce((a, b) => (cardStrength(a) <= cardStrength(b) ? a : b));
  };

  const trucNotDecided =
    r.trucState.kind !== "accepted" && r.trucState.kind !== "rejected";
  const canShoutTruc = (): Action | null => {
    if (!trucNotDecided || hints.silentTruc) return null;
    return (
      legals.find(
        (a) =>
          a.type === "shout" &&
          (a.what === "truc" || a.what === "retruc" || a.what === "quatre"),
      ) ?? null
    );
  };

  // Estat del truc per detectar l'excepció "joc fora acceptat" (Regla 4).
  const trucState = r.trucState;
  const jocForaAccepted =
    trucState.kind === "accepted" && trucState.level === 24;

  // =====================================================================
  // ARBRE DE DECISIÓ ÚNIC (3r a tirar, 2a baza, 1a baza guanyada).
  // Prioritat estricta de dalt a baix; mai un `else if` que puga trencar
  // una regla superior.
  // =====================================================================

  // ---- REGLA 0: el company ja va guanyant (o empardant) la baza actual
  // amb almenys un 3 → no pisar-lo ni gastar cartes altes: la MÉS BAIXA.
  // La posició (3r a tirar) es determina per trick.cards.length === 2.
  if (partnerWinsOrTies && partnerStr >= 70) {
    const play = findPlay(lowest.id);
    if (play) return play;
  }

  // ---- REGLA 1: rival guanya amb 3 i jo tinc 3 → EMPARDAR amb el 3.
  if (!partnerWinsOrTies && oppCard.card.rank === 3 && hasThree) {
    const play = findPlay(lowestThree!.id);
    if (play) return play;
  }

  // ---- REGLA 2: 2 cartes TOP → TRUC OBLIGATORI (si no cantat) + TAPAR.
  // Si tinc la TOP absoluta, tapo l'ALTRA TOP (guardo l'absoluta per a
  // la 3a); si no, tapo la més alta per amagar-la.
  else if (nTops === 2) {
    if (trucNotDecided) {
      const truc = canShoutTruc();
      if (truc) return truc;
    }
    const cardToCover = iHaveHighestAliveTop
      ? (lowestOtherTop(myHighestTop!) ?? myHighestTop!)
      : myHighestTop!;
    const act = findPlay(cardToCover.id, true);
    if (act) return act;
  }

  // ---- REGLA 3: TOP ABSOLUTA + un 3 → TAPAR el 3.
  // (Guardem la TOP absoluta per a la 3a; tapem el 3 per a no revelar-lo.)
  else if (iHaveHighestAliveTop && nTops === 1 && nThrees === 1) {
    const act = findPlay(threes[0]!.id, true);
    if (act) return act;
  }

  // ---- REGLA 4: TOP ABSOLUTA sola o amb carta baixa → EMBOSCADA.
  // Guardar la TOP absoluta per a la 3a i tirar la MÉS BAIXA. Única
  // excepció: si la mà està a JOC FORA acceptat, tanquem amb la TOP.
  else if (iHaveHighestAliveTop && nTops === 1 && nThrees === 0) {
    if (jocForaAccepted) {
      const play = findPlay(myHighestTop!.id);
      if (play) return play;
    }
    const play = findPlay(lowest.id);
    if (play) return play;
  }

  // ---- REGLA 5: 1 TOP NO absoluta (sense 3) → 50% TRUCAR + tirar TOP.
  else if (nTops === 1 && !iHaveHighestAliveTop && nThrees === 0) {
    if (trucNotDecided && !partnerWinsOrTies) {
      const truc = canShoutTruc();
      if (truc) return truc;
    }
    const play = findPlay(myHighestTop!.id);
    if (play) return play;
  }

  // ---- REGLA 5-bis: 1 TOP NO absoluta + 1 3.
  // Si company guanya/emparda → tirar la MÉS BAIXA (reservem 3 i TOP).
  // Si perdem → 50% truc + tirar la TOP.
  else if (nTops === 1 && !iHaveHighestAliveTop && nThrees >= 1) {
    if (partnerWinsOrTies) {
      const play = findPlay(lowest.id);
      if (play) return play;
    } else {
      if (trucNotDecided) {
        const truc = canShoutTruc();
        if (truc) return truc;
      }
      const play = findPlay(myHighestTop!.id);
      if (play) return play;
    }
  }

  // ---- REGLA 6: només 3 (sense TOP) → tirar el 3 SENSE TRUCAR.
  // Si el company ja va guanyant amb TOP/3, tirem la més baixa (no
  // malbaratar el 3).
  else if (!hasTop && hasThree) {
    if (partnerPlayedTopOrThree && partnerWinsOrTies) {
      const play = findPlay(lowest.id);
      if (play) return play;
    } else {
      const play = findPlay(lowestThree!.id);
      if (play) return play;
    }
  }

  // ---- REGLA 8 (rectificada): sense 3 ni TOP → PROHIBIT TRUCAR.
  //  · Si l'equip va perdent la 2a baza → tirar la MÉS ALTA.
  //  · Si el company ja guanya/emparda:
  //      - amb un 7 (bastos/copes) o superior (strength ≥ 60) → tirar la MÉS BAIXA.
  //      - amb un 6 o inferior (strength < 60) → tirar la MÉS ALTA per reforçar
  //        i assegurar la 2a baza.
  else if (!hasTop && !hasThree) {
    const highest = [...hand].sort((a, b) => cardStrength(b) - cardStrength(a))[0]!;
    if (!partnerWinsOrTies) {
      const play = findPlay(highest.id);
      if (play) return play;
    } else {
      const partnerReinforceable = partnerStr >= 70;
      const pick = partnerReinforceable ? lowest : highest;
      const play = findPlay(pick.id);
      if (play) return play;
    }
  }

  // Silenciar avisos de variables no usades en aquest bloc (poden
  // esdevenir útils per a futures regles i les deixem calculades).
  void partnerPlayedThree;

  return null;
}

/**
 * Aplica les regles de prioritat absoluta (early returns) abans de la
 * lògica genèrica de `botDecideInner`:
 *   · Regla #2: avantatge absolut de Truc en 2a baza (parda) o 3a baza.
 *   · Regla #3A: derrota inevitable a la baza actual → tirar la més baixa.
 *   · Regla #3B-1a: company guanyant amb carta TOP a la 1a baza → tirar la més baixa.
 *   · Regla #3B-2a: equip va 1-0 i company guanya 2a amb 3 o TOP → tirar la més baixa.
 *
 * Retorna l'Action prioritària o null si cap regla aplica (caldrà cridar
 * la lògica genèrica).
 */
function applyPriorityRules(
  m: MatchState,
  player: PlayerId,
  hints: BotHints,
): Action | null {
  const r = m.round;
  const myTeam = teamOf(player);
  const envitPendingMe =
    r.envitState.kind === "pending" && r.envitState.awaitingTeam === myTeam;
  const trucPendingMe =
    r.trucState.kind === "pending" && r.trucState.awaitingTeam === myTeam;
  if (envitPendingMe || trucPendingMe) return null;

  const actions = legalActions(m, player);
  if (actions.length === 0) return null;
  const canPlayCard = actions.some((a) => a.type === "play-card");
  if (!canPlayCard) return null;

  const hand = r.hands[player];
  if (!hand || hand.length === 0) return null;
  const curTrick = r.tricks[r.tricks.length - 1];

  // ===== Regla #2: avantatge absolut de Truc =====
  const inSecondParda =
    r.tricks.length === 2 && r.tricks[0]?.parda === true;
  const inThird = r.tricks.length === 3;
  if ((inSecondParda || inThird) && !hints.silentTruc) {
    const trucNotDecided =
      r.trucState.kind !== "accepted" && r.trucState.kind !== "rejected";
    if (trucNotDecided) {
      // Cas especial: 3a baza i sóc l'ÚLTIM en tirar (3 cartes ja a la
      // mesa). Aquí el resultat de la mà està totalment determinat per
      // la meua elecció de carta:
      //   · Si el meu company ja va guanyant ESTRICTAMENT la mesa,
      //     TINC PROHIBIT cantar truc/retruc/quatre: només tancar la
      //     baza tirant la més baixa (ho farà Regla #0 tot seguit).
      //   · Si el rival va guanyant (o empardant al company) i tinc
      //     una carta que GUANYA la baza, o que l'EMPARDA havent
      //     guanyat el meu equip la 1a, canto truc amb la garantia
      //     absoluta de guanyar la mà.
      if (inThird && curTrick && curTrick.cards.length === 3) {
        const tableCards = curTrick.cards;
        const tableBest = tableCards.reduce(
          (m, tc) => Math.max(m, cardStrength(tc.card)),
          -1,
        );
        const partnerCardInTable = tableCards.find(
          (tc) => tc.player !== player && teamOf(tc.player) === myTeam,
        )?.card;
        const opponentBestOnTable = tableCards
          .filter((tc) => teamOf(tc.player) !== myTeam)
          .reduce((m, tc) => Math.max(m, cardStrength(tc.card)), -1);
        const partnerStrictlyWinning =
          partnerCardInTable != null &&
          cardStrength(partnerCardInTable) > opponentBestOnTable;
        if (partnerStrictlyWinning) {
          // No cantem truc: caiem a Regla #0 (tirar la més baixa).
        } else {
          const t1 = r.tricks[0];
          const wonFirst =
            !!t1 &&
            t1.parda !== true &&
            t1.winner !== undefined &&
            teamOf(t1.winner!) === myTeam;
          const canWinTrick = hand.some((c) => cardStrength(c) > tableBest);
          const canTieTrick = hand.some((c) => cardStrength(c) === tableBest);
          const guaranteesHandWin = canWinTrick || (canTieTrick && wonFirst);
          if (guaranteesHandWin) {
            const escalations = ["joc-fora", "quatre", "retruc", "truc"] as const;
            for (const what of escalations) {
              const act = actions.find(
                (a) => a.type === "shout" && a.what === what,
              );
              if (act) return act;
            }
          }
        }
      } else {
        const playedIds = new Set<string>();
        for (const t of r.tricks) for (const tc of t.cards) playedIds.add(tc.card.id);
        const myIds = new Set(hand.map((c) => c.id));
        const outside = buildDeck().filter(
          (c) => !playedIds.has(c.id) && !myIds.has(c.id),
        );
        const outsideMax = outside.length > 0
          ? Math.max(...outside.map((c) => cardStrength(c)))
          : -1;
        const myMax = Math.max(...hand.map((c) => cardStrength(c)));
        if (myMax > outsideMax) {
          const escalations = ["joc-fora", "quatre", "retruc", "truc"] as const;
          for (const what of escalations) {
            const act = actions.find(
              (a) => a.type === "shout" && a.what === what,
            );
            if (act) return act;
          }
        }
      }
    }
  }


  // ===== Regla #3: descarte eficient (tirar la més baixa) =====
  if (curTrick) {
    const tableCards = curTrick.cards;
    const sortedAsc = [...hand].sort(
      (a, b) => cardStrength(a) - cardStrength(b),
    );
    const lowest = sortedAsc[0]!;
    const playLowest = actions.find(
      (a) => a.type === "play-card" && (a as any).cardId === lowest.id,
    );
    const tableLeader = tableCards.reduce(
      (best, tc) =>
        best === null || cardStrength(tc.card) > cardStrength(best.card)
          ? tc
          : best,
      null as { player: PlayerId; card: Card } | null,
    );
    const tableBest = tableLeader ? cardStrength(tableLeader.card) : -1;
    const partnerLeading =
      !!tableLeader &&
      tableLeader.player !== player &&
      teamOf(tableLeader.player) === myTeam;
    const partnerLeaderCard = partnerLeading ? tableLeader!.card : null;

    // Determinar si el company està GUANYANT ESTRICTAMENT la mesa (no
    // simplement empardant amb un rival). Només considerem "el company
    // ja la porta" quan la seua carta és estrictament més forta que
    // qualsevol carta rival a la mesa. Si empardat amb un rival, el
    // company NO va guanyant i el bot ha d'intentar guanyar/empardar.
    const partnerCardInTable = tableCards.find(
      (tc) => tc.player !== player && teamOf(tc.player) === myTeam,
    )?.card;
    const opponentBestOnTable = tableCards
      .filter((tc) => teamOf(tc.player) !== myTeam)
      .reduce((m, tc) => Math.max(m, cardStrength(tc.card)), -1);
    const partnerStrictlyWinning =
      partnerCardInTable != null &&
      cardStrength(partnerCardInTable) > opponentBestOnTable;
    const opponentWinningOrTying =
      partnerCardInTable == null ||
      opponentBestOnTable >= cardStrength(partnerCardInTable);

    const legalCardIdsForFirstTrick = new Set(
      actions
        .filter((a) => a.type === "play-card")
        .map((a) => (a as Extract<Action, { type: "play-card" }>).cardId),
    );
    const playableFirstTrick = hand.filter((c) =>
      legalCardIdsForFirstTrick.has(c.id),
    );

    // ===== Regla #-1 (PRIORITAT MÀXIMA): 1a baza i sóc l'ÚLTIM en tirar
    // (3 cartes ja a la mesa). Jerarquia GUANYAR > EMPARDAR > descarte:
    //   1) Si el company NO va guanyant estrictament la mesa, intentar
    //      GUANYAR amb la MÍNIMA carta que supere la mesa.
    //   2) Si no puc guanyar, EMPARDAR amb una carta d'igual valor.
    //   3) Si tampoc puc empardar, cau a les regles següents (tirar la
    //      més baixa a la Regla #0). =====
    if (
      r.tricks.length === 1 &&
      tableCards.length === 3 &&
      opponentWinningOrTying &&
      playableFirstTrick.length > 0
    ) {
      const winners = playableFirstTrick
        .filter((c) => cardStrength(c) > tableBest)
        .sort((a, b) => cardStrength(a) - cardStrength(b));
      if (winners.length > 0) {
        return { type: "play-card", cardId: winners[0]!.id };
      }
      const tiers = playableFirstTrick
        .filter((c) => cardStrength(c) === tableBest)
        .sort((a, b) => cardStrength(a) - cardStrength(b));
      if (tiers.length > 0) {
        return { type: "play-card", cardId: tiers[0]!.id };
      }
    }

    // ===== Regla #0 (PRIORITAT ABSOLUTA): si sóc l'ÚLTIM en tirar
    // d'esta baza (3 cartes ja a la mesa) i el meu company ja la
    // guanya ESTRICTAMENT (no empardant), tirar SEMPRE la més baixa. =====
    if (
      tableCards.length === 3 &&
      partnerStrictlyWinning &&
      playLowest
    ) {
      return playLowest;
    }

    // ===== Regla #0-ter (PRIORITAT ALTA): 1a baza i sóc el 3r en tirar
    // (2 cartes ja a la mesa) amb el rival guanyant o empardant al meu
    // company. Jerarquia estricta GUANYAR > EMPARDAR > descarte:
    //   1) GUANYAR la baza amb la MÍNIMA carta ≥ 3 (strength ≥ 70) que
    //      supere la mesa. Només usem un 3 o TOP si REALMENT guanya.
    //   2) EMPARDAR amb la MÍNIMA carta que iguale la mesa.
    //   3) Si no puc ni guanyar ni empardar, tirar la MÉS BAIXA
    //      (descarte: mai malbaratar un 3 ni una carta top). =====
    if (
      r.tricks.length === 1 &&
      tableCards.length === 2 &&
      opponentWinningOrTying &&
      playableFirstTrick.length > 0
    ) {
      const winners = playableFirstTrick
        .filter((c) => cardStrength(c) > tableBest && cardStrength(c) >= 70)
        .sort((a, b) => cardStrength(a) - cardStrength(b));
      if (winners.length > 0) {
        return { type: "play-card", cardId: winners[0]!.id };
      }
      // ===== TÀCTICA DE PRESSIÓ: no tinc cap 3 ni carta TOP (≥70) a la
      // mà, però sí tinc alguna carta que supera la mesa. Tirar la MÉS
      // ALTA d'eixes per forçar el 4t rival a gastar un 3/TOP si vol
      // guanyar la baza. =====
      const hasStrongInHand = playableFirstTrick.some(
        (c) => cardStrength(c) >= 70,
      );
      if (!hasStrongInHand) {
        const softWinners = playableFirstTrick
          .filter((c) => cardStrength(c) > tableBest)
          .sort((a, b) => cardStrength(b) - cardStrength(a));
        if (softWinners.length > 0) {
          return { type: "play-card", cardId: softWinners[0]!.id };
        }
      }
      const tiers = playableFirstTrick
        .filter((c) => cardStrength(c) === tableBest)
        .sort((a, b) => cardStrength(a) - cardStrength(b));
      if (tiers.length > 0) {
        return { type: "play-card", cardId: tiers[0]!.id };
      }
      const lowestPlayable = [...playableFirstTrick].sort(
        (a, b) => cardStrength(a) - cardStrength(b),
      )[0]!;
      return { type: "play-card", cardId: lowestPlayable.id };
    }

    // ===== Regla #0-quat (PRIORITAT ALTA): 1a baza i sóc el 3r en tirar
    // (2 cartes ja a la mesa) i el meu company ja guanya ESTRICTAMENT
    // la mesa AMB UNA CARTA DOMINANT (3 o TOP). Només aleshores té
    // sentit descartar la més baixa: si el company va guanyant amb una
    // carta feble, encara convé jugar TOP/3 per assegurar o pressionar
    // el 4t rival, i eixa decisió la resol `applyThirdSeatFirstBaza`. =====
    if (
      r.tricks.length === 1 &&
      tableCards.length === 2 &&
      partnerStrictlyWinning &&
      partnerCardInTable != null &&
      (partnerCardInTable.rank === 3 || isTopCard(partnerCardInTable)) &&
      playLowest
    ) {
      return playLowest;
    }



    // ===== Regla #0-bis (PRIORITAT ALTA): 1a baza i sóc el SEGON del
    // meu equip a tirar (el meu company ja ha jugat) mentre l'oponent
    // està guanyant la mesa. Jerarquia estricta i obligatòria:
    //   1) Guanyar amb la MÍNIMA carta que guanye la baza.
    //   2) Si no puc guanyar, EMPARDAR amb una carta d'igual valor.
    //   3) Si no puc ni guanyar ni empardar, tirar la MÉS BAIXA per
    //      conservar les cartes fortes per a futures bazas. =====
    if (
      r.tricks.length === 1 &&
      tableCards.length > 0 &&
      tableLeader
    ) {
      const partnerAlreadyPlayed = tableCards.some(
        (tc) => tc.player !== player && teamOf(tc.player) === myTeam,
      );
      const opponentLeading = teamOf(tableLeader.player) !== myTeam;
      if (partnerAlreadyPlayed && opponentLeading) {
        const legalCardIds = new Set(
          actions
            .filter((a) => a.type === "play-card")
            .map((a) => (a as Extract<Action, { type: "play-card" }>).cardId),
        );
        const playable = hand.filter((c) => legalCardIds.has(c.id));
        if (playable.length > 0) {
          // 1) Guanyar amb la mínima carta guanyadora.
          const winners = playable
            .filter((c) => cardStrength(c) > tableBest)
            .sort((a, b) => cardStrength(a) - cardStrength(b));
          if (winners.length > 0) {
            return { type: "play-card", cardId: winners[0]!.id };
          }
          // 2) Empardar amb qualsevol carta d'igual valor.
          const tiers = playable.filter(
            (c) => cardStrength(c) === tableBest,
          );
          if (tiers.length > 0) {
            return { type: "play-card", cardId: tiers[0]!.id };
          }
          // 3) La més baixa (conservar cartes fortes).
          const lowestPlayable = [...playable].sort(
            (a, b) => cardStrength(a) - cardStrength(b),
          )[0]!;
          return { type: "play-card", cardId: lowestPlayable.id };
        }
      }
    }

    // Cas A: derrota inevitable → tirar la més baixa.
    if (tableCards.length > 0 && playLowest) {
      const canWin = hand.some((c) => cardStrength(c) > tableBest);
      if (!canWin) return playLowest;
    }

    // Cas B-1a: 1a baza, company ja guanya amb carta TOP → tirar la més baixa.
    if (
      r.tricks.length === 1 &&
      partnerLeaderCard &&
      playLowest &&
      isTopCard(partnerLeaderCard)
    ) {
      return playLowest;
    }

    // Cas B-2a: 2a baza, hem guanyat la 1a (no parda) i company guanya
    // ara amb un 3 o una carta TOP → tirar la més baixa.
    if (r.tricks.length === 2 && partnerLeaderCard && playLowest) {
      const t1 = r.tricks[0];
      const wonFirst =
        !!t1 &&
        t1.parda !== true &&
        t1.winner !== undefined &&
        teamOf(t1.winner!) === myTeam;
      if (
        wonFirst &&
        (partnerLeaderCard.rank === 3 || isTopCard(partnerLeaderCard))
      ) {
        return playLowest;
      }
    }
  }

  return null;
}

/**
 * Aplica límits estrictes de perfil conservador i sincer sobre l'acció
 * que ha decidit el bot:
 *
 *  · TRUC: prohibit cantar "quatre" o "joc-fora" tret que la victòria
 *    estiga matemàticament garantida (que ja s'ha resolt abans mitjançant
 *    Regla #2 de prioritat absoluta). Si arribem ací amb un d'aquests
 *    cants, degradem a "vull" (acceptar el truc actual) o "no-vull".
 *    Igualment, no s'accepta ("vull") mai un "joc-fora" del rival: com que
 *    Regla #2 no ha disparat, no tenim la victòria garantida i cal rebutjar.
 *
 *  · ENVIT: només es permet cantar "falta-envit" o acceptar-la ("vull"
 *    davant d'una falta pendent) si el bot té ≥33 d'envit I és mà del
 *    joc (`player === round.mano`). En qualsevol altre cas, es degrada
 *    a "renvit", "vull" (per a envit/renvit normals) o "no-vull".
 */
function enforceStrictConservativeLimits(
  m: MatchState,
  player: PlayerId,
  action: Action,
): Action | null {
  if (action.type !== "shout") return action;
  const r = m.round;
  const legal = legalActions(m, player);
  const findLegal = (what: string) =>
    legal.find((a) => a.type === "shout" && a.what === what) ?? null;

  const w = action.what;

  // ---- TRUC: prohibit "quatre" i "joc-fora" sense garantia matemàtica.
  if (w === "quatre" || w === "joc-fora") {
    return findLegal("vull") ?? findLegal("retruc") ?? findLegal("no-vull") ?? null;
  }

  // ---- TRUC: davant d'un "joc-fora" del rival, mai acceptar sense garantia.
  if (
    w === "vull" &&
    r.trucState.kind === "pending" &&
    r.trucState.level === 24
  ) {
    return findLegal("no-vull") ?? action;
  }

  // ---- ENVIT: "falta-envit" i "vull" (sobre falta pendent) requereixen
  // ≥33 d'envit I ser mà.
  // Ús de playerTotalEnvit: inclou cartes ja jugades (no cobertes) perquè
  // l'envit es calcula sobre les 3 cartes originals, no sobre les que resten.
  const myEnvit = playerTotalEnvit(r, player);
  const isMano = player === r.mano;
  const canFalta = myEnvit >= 33 && isMano;

  if (w === "falta-envit" && !canFalta) {
    return findLegal("renvit") ?? findLegal("vull") ?? findLegal("no-vull") ?? null;
  }

  if (
    w === "vull" &&
    r.envitState.kind === "pending" &&
    r.envitState.level === "falta" &&
    !canFalta
  ) {
    return findLegal("no-vull") ?? action;
  }

  return action;
}

/**
 * REGLA ESTRICTA (2a baza, el meu equip ha guanyat la 1a baza — no parda):
 * arbre de decisió definit per l'usuari amb prioritat absoluta sobre la
 * resta de lògica del bot en aquest context concret.
 *
 * Definicions:
 *   · Carta TOP: 7 oros, 7 espases, As bastos, As espases (`isTopCard`).
 *   · TOP absoluta: la carta viva de major força entre totes les que
 *     encara no s'han jugat (força > qualsevol carta fora de la meua mà).
 *
 *  Cas A — [3] + [Carta Top] (la Top NO és l'absoluta):
 *    · 50%: canta truc.
 *    · 50%: tira el 3 (només si assegura guanyar/empatar la baza).
 *    · Si canta truc i el rival "vull": si el rival que ha vullut ja ha
 *      tirat en aquesta 2a baza → tira la Top; si no → tira la més baixa
 *      (com a mínim el 3).
 *
 *  Cas B — [Dos cartes TOP] (cap és l'absoluta):
 *    · Canta truc SEMPRE. Després del "vull":
 *      – Rival ja ha tirat → Top més alta.
 *      – Rival encara no ha tirat → la més baixa.
 *
 *  Cas C — Tinc la Carta TOP absoluta: tapar la més baixa (única situació
 *    on tapem per no arriscar guanyar la baza).
 */
function applySecondTrickWonFirstStrict(
  m: MatchState,
  player: PlayerId,
  hints: BotHints,
): Action | null {
  const r = m.round;
  if (r.tricks.length !== 2) return null;
  const t1 = r.tricks[0];
  const trick2 = r.tricks[1];
  if (!t1 || !trick2 || t1.parda === true) return null;
  const myTeam = teamOf(player);
  const wonFirst =
    t1.winner !== undefined && teamOf(t1.winner!) === myTeam;
  if (!wonFirst) return null;

  const envitPendingMe =
    r.envitState.kind === "pending" && r.envitState.awaitingTeam === myTeam;
  const trucPendingMe =
    r.trucState.kind === "pending" && r.trucState.awaitingTeam === myTeam;
  if (envitPendingMe || trucPendingMe) return null;

  if (r.turn !== player) return null;
  const actions = legalActions(m, player);
  if (!actions.some((a) => a.type === "play-card")) return null;

  const hand = r.hands[player] ?? [];
  if (hand.length === 0) return null;
  const iPlayedHere = trick2.cards.some((tc) => tc.player === player);
  if (iPlayedHere) return null;

  const playedIds = new Set<string>();
  for (const t of r.tricks) for (const tc of t.cards) playedIds.add(tc.card.id);
  const myIds = new Set(hand.map((c) => c.id));
  const outside = buildDeck().filter(
    (c) => !playedIds.has(c.id) && !myIds.has(c.id),
  );
  const outsideMax = outside.length > 0
    ? Math.max(...outside.map((c) => cardStrength(c)))
    : -1;
  const myMax = Math.max(...hand.map((c) => cardStrength(c)));
  const haveAbsoluteTop = myMax > outsideMax;

  const sortedAsc = [...hand].sort(
    (a, b) => cardStrength(a) - cardStrength(b),
  );
  const lowest = sortedAsc[0]!;
  const topsInHand = hand.filter(isTopCard);
  const threeCard = hand.find((c) => c.rank === 3) ?? null;
  const highestTop = topsInHand.length > 0
    ? [...topsInHand].sort((a, b) => cardStrength(b) - cardStrength(a))[0]!
    : null;

  const trucState = r.trucState;
  const trucNotDecided =
    trucState.kind !== "accepted" && trucState.kind !== "rejected";
  const trucAccepted = trucState.kind === "accepted";
  void trucAccepted;

  const rivalPlayedInSecond = trick2.cards.some(
    (tc) => teamOf(tc.player) !== myTeam,
  );

  const tableCards = trick2.cards;
  const tableBest = tableCards.length > 0
    ? Math.max(...tableCards.map((tc) => cardStrength(tc.card)))
    : -1;

  // El 3 "assegura" guanyar/empardar només si sóc l'últim en tirar
  // aquesta baza (ningú més parlarà) i el 3 ≥ la millor de la mesa.
  const canAssureWithThree = (() => {
    if (!threeCard) return false;
    const iAmLast = tableCards.length === 3;
    if (!iAmLast) return false;
    return cardStrength(threeCard) >= tableBest;
  })();

  const canShoutTruc = actions.some(
    (a) => a.type === "shout" && a.what === "truc",
  );

  const postAcceptChoice = (): Action => {
    if (rivalPlayedInSecond && highestTop) {
      return { type: "play-card", cardId: highestTop.id };
    }
    return { type: "play-card", cardId: lowest.id };
  };

  // ---- Cas C: TOP absoluta (invencibilitat 100%) ----
  // Regla d'EMBOSCADA FERMA: SEMPRE guardem la TOP absoluta per a la 3a
  // baza i tirem la carta MÉS BAIXA en la 2a, encara que el truc ja
  // estiga acceptat (2 punts). Cedir la 2a baza incita el rival a cantar
  // RETRUC creient que pot remuntar; així podrem guanyar 3 o 4 punts en
  // lloc de només 2 si tanquem ara la mà.
  //
  // ÚNICA EXCEPCIÓ: si el rival ha pujat l'aposta a JOC FORA i estem
  // resolent aquella jugada (trucAccepted amb level === 24), llavors sí
  // tanquem la mà amb la TOP absoluta per assegurar els punts.
  if (haveAbsoluteTop && hand.length >= 2) {
    const jocForaAccepted =
      trucState.kind === "accepted" && trucState.level === 24;
    if (jocForaAccepted && highestTop) {
      return { type: "play-card", cardId: highestTop.id };
    }
    const lowestIsThreeOrTop = lowest.rank === 3 || isTopCard(lowest);
    if (lowestIsThreeOrTop) {
      return { type: "play-card", cardId: lowest.id, covered: true };
    }
    return { type: "play-card", cardId: lowest.id };
  }

  const hasTop = topsInHand.length > 0;
  const hasThree = !!threeCard;

  // ---- Cas B: dos TOP (cap absoluta) ----
  // Regla 2 de l'usuari: TRUC OBLIGATORI si no s'ha cantat. Una vegada
  // resolt el truc, triem la TOP a tirar AL DESCOBERT segons la posició
  // del rival que ha "parlat" a la 2a baza:
  //   - Si el rival JA ha jugat la seua carta en la 2a baza (parla/tira
  //     abans que el bot): tirem la TOP MÉS ALTA al descobert per
  //     assegurar la baza superant la carta ja exposada.
  //   - Si el rival encara NO ha jugat en la 2a baza (parla/tira després
  //     del bot): tirem la TOP MÉS BAIXA al descobert, reservant la més
  //     forta per a la 3a i obligant el rival a gastar la seua millor
  //     carta si vol superar-nos.
  if (topsInHand.length >= 2) {
    if (trucNotDecided && canShoutTruc && !hints.silentTruc) {
      return { type: "shout", what: "truc" };
    }
    const topsDesc = [...topsInHand].sort(
      (a, b) => cardStrength(b) - cardStrength(a),
    );
    const highestTopCard = topsDesc[0]!;
    const lowestTopCard = topsDesc[topsDesc.length - 1]!;
    const cardToPlay = rivalPlayedInSecond ? highestTopCard : lowestTopCard;
    return { type: "play-card", cardId: cardToPlay.id };
  }

  // ---- Cas A: 3 + TOP (TOP no absoluta) ----
  if (hasThree && hasTop) {
    if (trucNotDecided && canShoutTruc && !hints.silentTruc) {
      // 50% truc, 50% tirar el 3 (només si assegura guanyar/empardar).
      if (Math.random() < 0.5 || !canAssureWithThree) {
        return { type: "shout", what: "truc" };
      }
      return { type: "play-card", cardId: threeCard!.id };
    }
    if (canAssureWithThree) {
      return { type: "play-card", cardId: threeCard!.id };
    }
    return null;
  }

  // ---- Cas D: 1 TOP no absoluta, sense 3 ----
  // Mateixa filosofia que Cas B: si decidim jugar la TOP, 50% TRUCAR
  // primer (per maximitzar punts abans d'ensenyar-la) i 50% tirar-la
  // directament (jugada de control).
  if (hasTop && !hasThree && topsInHand.length === 1 && highestTop) {
    if (trucNotDecided && canShoutTruc && !hints.silentTruc) {
      if (Math.random() < 0.5) {
        return { type: "shout", what: "truc" };
      }
    }
    return { type: "play-card", cardId: highestTop.id };
  }


  // ---- Nova regla: 2n jugador del meu equip, sense TOP, amb 3 ----
  // Si el company ja ha jugat en aquesta 2a baza, no tinc cap TOP i sí un
  // 3, tire el 3 sempre que guanye o empate la mesa actual (no malgastar).
  if (!hasTop && hasThree) {
    const partnerPlayedInSecond = trick2.cards.some(
      (tc) => tc.player !== player && teamOf(tc.player) === myTeam,
    );
    if (partnerPlayedInSecond && cardStrength(threeCard!) >= tableBest) {
      return { type: "play-card", cardId: threeCard!.id };
    }
  }

  // ---- REGLA "Assegurar partida en Baza 2" (2n jugador de la parella
  // amb Baza 1 guanyada, sense TOP absoluta) ----
  // Activació: 2a baza, hem guanyat la 1a, sóc el 2n del meu equip a
  // tirar (company ja ha jugat) i NO tinc la carta TOP absoluta viva.
  // Comportament:
  //   1) Prohibit tirar una carta baixa que perda la baza si tinc opció
  //      d'evitar-ho.
  //   2) Preferentment tirar un 3 (guanyar/empardar).
  //   3) Si no, EMPARDAR la mesa amb la carta d'igual força mínima.
  //   4) Si tinc una carta superior i decidiria tirar-la, primer TRUC
  //      (si és legal, no decidit, i sense silentTruc).
  {
    const partnerPlayedInSecond = trick2.cards.some(
      (tc) => tc.player !== player && teamOf(tc.player) === myTeam,
    );
    if (partnerPlayedInSecond && !haveAbsoluteTop) {
      const legalCardIds = new Set(
        actions
          .filter((a) => a.type === "play-card")
          .map((a) => (a as Extract<Action, { type: "play-card" }>).cardId),
      );
      const playable = hand.filter((c) => legalCardIds.has(c.id));
      if (playable.length > 0 && tableCards.length > 0) {
        const leader = tableCards.reduce(
          (best, tc) =>
            best === null || cardStrength(tc.card) > cardStrength(best.card)
              ? tc
              : best,
          null as typeof tableCards[number] | null,
        );
        const partnerAlreadyWinning =
          !!leader && teamOf(leader.player) === myTeam;
        if (!partnerAlreadyWinning) {
          const winners = playable
            .filter((c) => cardStrength(c) > tableBest)
            .sort((a, b) => cardStrength(a) - cardStrength(b));
          const ties = playable.filter((c) => cardStrength(c) === tableBest);
          const threesPlayable = playable
            .filter((c) => c.rank === 3)
            .sort((a, b) => cardStrength(b) - cardStrength(a));

          // (4) Si hem de tirar una carta superior, primer canta TRUC.
          const needToPlayWinner =
            winners.length > 0 && ties.length === 0 && threesPlayable.length === 0;
          if (needToPlayWinner && trucNotDecided && canShoutTruc && !hints.silentTruc) {
            return { type: "shout", what: "truc" };
          }

          // (2) Preferentment un 3 si guanya o emparda la mesa.
          if (threesPlayable.length > 0 && cardStrength(threesPlayable[0]!) >= tableBest) {
            // Si el 3 supera la mesa (guanyadora), truc abans si és possible.
            if (
              cardStrength(threesPlayable[0]!) > tableBest &&
              trucNotDecided &&
              canShoutTruc &&
              !hints.silentTruc
            ) {
              return { type: "shout", what: "truc" };
            }
            return { type: "play-card", cardId: threesPlayable[0]!.id };
          }

          // (3) Empardar amb la carta d'igual força mínima.
          if (ties.length > 0) {
            const tieMin = [...ties].sort(
              (a, b) => cardStrength(a) - cardStrength(b),
            )[0]!;
            return { type: "play-card", cardId: tieMin.id };
          }

          // (1) Si no puc empardar ni tinc 3, però sí una carta superior,
          // tirar la mínima guanyadora (el truc ja s'hauria cantat dalt).
          if (winners.length > 0) {
            return { type: "play-card", cardId: winners[0]!.id };
          }
          // Si no puc guanyar ni empardar, caiem a lògica genèrica.
        }
      }
    }
  }

  return null;
}

/**
 * REGLA "PARDA TANCA LA MÀ" (2a baza — i 3a baza amb 1-1):
 *
 * El motor resol la mà així (vegeu `maybeFinishRound` a engine.ts):
 *   · Regla 3: si la 2a baza queda PARDA i la 1a no, guanya qui va
 *     guanyar la 1a. Per tant, si nosaltres vam guanyar la 1a, empatar
 *     la 2a tanca la mà a favor nostre immediatament.
 *   · Regla 5: amb 1-1 a les dues primeres, una 3a baza parda també dona
 *     la mà a qui va guanyar la 1a.
 *
 * Així, quan la millor carta de la mesa és d'un rival i tenim una carta
 * d'IGUAL força (l'empararem), hem de tirar-la: no importa si encara ens
 * queda una Carta TOP per jugar, perquè l'empat ja ens dona la mà. Les
 * demés regles comparaven només de manera estricta (carta pròpia > carta
 * rival) i per això, davant d'un 3 rival amb un altre 3 a la mà, acabaven
 * en un descart baix.
 *
 * S'aplica com a overriding FINAL sobre la decisió ja presa, perquè cap
 * regla de "guardar la TOP per a la 3a" ni de "descartar la més baixa"
 * puga deixar-la sense efecte.
 */
function applyPardaClosesHand(
  m: MatchState,
  player: PlayerId,
  decision: Action,
): Action {
  if (decision.type !== "play-card") return decision;
  const r = m.round;
  if (r.phase !== "playing") return decision;
  const myTeam = teamOf(player);

  // Condició prèvia: el nostre equip ha guanyat la 1a baza (no parda).
  const t1 = r.tricks[0];
  if (!t1 || t1.parda === true || t1.winner === undefined) return decision;
  if (teamOf(t1.winner) !== myTeam) return decision;

  // Baza en curs (l'última de `r.tricks`), on encara no hem jugat.
  const cur = r.tricks[r.tricks.length - 1];
  if (!cur || cur.cards.length === 0) return decision;
  if (cur.cards.some((tc) => tc.player === player)) return decision;

  // ¿Una parda en aquesta baza tanca la mà a favor nostre?
  const pardaWinsHand = (() => {
    if (r.tricks.length === 2) return true; // Regla 3
    if (r.tricks.length === 3) {
      const t2 = r.tricks[1];
      if (!t2) return false;
      // 1-1 sense pardes → Regla 5: la 3a parda dona la qui va guanyar la 1a.
      if (
        t2.parda !== true &&
        t2.winner !== undefined &&
        teamOf(t2.winner) !== myTeam
      ) {
        return true;
      }
      // 1a i 2a pardes → Regla 4: la 3a parda dona la mà de l'equip de la mà.
      if (t2.parda === true && teamOf(r.mano) === myTeam) return true;
    }
    return false;
  })();
  if (!pardaWinsHand) return decision;

  // Millor carta NO TAPADA de la mesa. Si la porta el company no el
  // pisquem (regla de l'usuari): només actuem quan la millor és d'un rival.
  const tableBest = cur.cards
    .filter((tc) => !tc.covered)
    .reduce((mx, tc) => Math.max(mx, cardStrength(tc.card)), -1);
  if (tableBest < 0) return decision;
  const rivalHoldsBest = cur.cards.some(
    (tc) =>
      !tc.covered &&
      teamOf(tc.player) !== myTeam &&
      cardStrength(tc.card) === tableBest,
  );
  if (!rivalHoldsBest) return decision;

  // La carta ja triada guanya o empata la mesa boca amunt? → no cal canviar.
  const chosen = (r.hands[player] ?? []).find((c) => c.id === decision.cardId);
  if (!decision.covered && chosen && cardStrength(chosen) >= tableBest) {
    return decision;
  }

  // Busquem una carta que EMPARDE exactament la mesa (força igual). Si
  // n'hi ha diverses, preferim un 3: és la que obliga el rival a gastar
  // una TOP si la vol batre.
  const legals = legalActions(m, player);
  const playableIds = new Set(
    legals
      .filter(
        (a): a is Extract<Action, { type: "play-card" }> =>
          a.type === "play-card" && !a.covered,
      )
      .map((a) => a.cardId),
  );
  const tiers = (r.hands[player] ?? [])
    .filter(
      (c) =>
        isRealCard(c) && playableIds.has(c.id) && cardStrength(c) === tableBest,
    )
    .sort((a, b) => (b.rank === 3 ? 1 : 0) - (a.rank === 3 ? 1 : 0));
  const tie = tiers[0];
  if (!tie) return decision;
  return { type: "play-card", cardId: tie.id };
}

/**
 * Regla "Algo tinc" (1a baza): si el bot ha dit "Algo tinc" i el seu company
 * ha jugat a la 1a baza una carta que NO és ni un 3 ni una Top, el bot ha de
 * jugar una Carta Top (prioritzant-la sobre el 3, que es reserva), sempre
 * que amb ella supere totes les cartes rivals (no tapades) de la mesa.
 * Si cap Top supera el rival, no s'intervé (lògica defensiva habitual).
 */
function applyAlgoTincFirstBaza(
  m: MatchState,
  player: PlayerId,
  hints: BotHints,
  decision: Action,
): Action {
  if (!hints.saidAlgoTinc || decision.type !== "play-card") return decision;
  const r = m.round;
  if (r.phase !== "playing" || r.tricks.length !== 1 || r.turn !== player) return decision;
  const trick = r.tricks[0];
  if (!trick || trick.cards.some((tc) => tc.player === player)) return decision;
  const myTeam = teamOf(player);
  const partnerCard = trick.cards.find(
    (tc) => teamOf(tc.player) === myTeam && tc.player !== player,
  );
  if (!partnerCard) return decision;
  if (partnerCard.card.rank === 3 || isTopCard(partnerCard.card)) return decision;

  const rivalMax = trick.cards
    .filter((tc) => !tc.covered && teamOf(tc.player) !== myTeam)
    .reduce((mx, tc) => Math.max(mx, cardStrength(tc.card)), -1);
  const winningTops = (r.hands[player] ?? [])
    .filter((c) => isTopCard(c) && cardStrength(c) > rivalMax)
    .sort((a, b) => cardStrength(a) - cardStrength(b));
  const chosen = winningTops[0];
  if (!chosen) return decision;
  const act = legalActions(m, player).find(
    (a) => a.type === "play-card" && a.cardId === chosen.id && !a.covered,
  );
  return act ?? decision;
}

export function botDecide(
  m: MatchState,
  player: PlayerId,
  partnerAdvice: PartnerAdvice = "neutral",
  hints: BotHints = {},
  tuning: BotTuning = NEUTRAL_TUNING,
  bluffRate: number = 0,
): Action | null {
  const decision = botDecideCore(m, player, partnerAdvice, hints, tuning, bluffRate);
  if (!decision) return decision;
  // La parda que tanca la mà té prioritat sobre qualsevol descart baix o
  // sobre "guardar la TOP" (vegeu `applyPardaClosesHand`).
  const parda = applyPardaClosesHand(m, player, decision);
  return applyAlgoTincFirstBaza(m, player, hints, parda);
}

function botDecideCore(

  m: MatchState,
  player: PlayerId,
  partnerAdvice: PartnerAdvice = "neutral",
  hints: BotHints = {},
  tuning: BotTuning = NEUTRAL_TUNING,
  bluffRate: number = 0,

): Action | null {
  // Regles de prioritat absoluta (Regles #2 i #3): s'avaluen ABANS
  // que qualsevol lògica genèrica per evitar solapaments.
  const priority = applyPriorityRules(m, player, hints);
  // La Regla #2 (avantatge absolut de Truc) només s'activa quan el bot
  // té matemàticament garantida la baza guanyadora. Per tant, és
  // l'ÚNIC camí legítim per a cantar "quatre" o "joc-fora": qualsevol
  // altre camí que retorni aquestes accions s'ha de degradar a un
  // nivell més conservador (veure `enforceStrictConservativeLimits`).
  if (priority) return priority;

  // MATRIU EXPLÍCITA de l'usuari (3r a tirar en la 2a baza, havent guanyat
  // la 1a). Té prioritat absoluta sobre la resta de lògica.
  const thirdSeatMatrix = applyThirdSeatSecondBazaWonFirst(m, player, hints);
  if (thirdSeatMatrix) return thirdSeatMatrix;

  // MATRIU EXPLÍCITA de l'usuari (3r a tirar en la 1a baza). Prioritat
  // absoluta sobre la resta de lògica.
  const thirdSeatFirst = applyThirdSeatFirstBaza(m, player, hints);
  if (thirdSeatFirst) return thirdSeatFirst;

  // REGLA ESTRICTA (2a baza, equip ha guanyat la 1a): arbre de decisió
  // definit per l'usuari amb prioritat absoluta sobre la resta de lògica.
  const strictSecond = applySecondTrickWonFirstStrict(m, player, hints);
  // Perfil conservador/sincer: bloquejar cants de truc a la 2a baza si no
  // hi ha força real (mà + seña veraç del company). Veure
  // `canCallTrucSecondTrickConservative`.
  const gateBaza2Truc = (action: Action | null): Action | null => {
    if (
      action &&
      action.type === "shout" &&
      (action.what === "truc" || action.what === "retruc" || action.what === "quatre")
    ) {
      const r = m.round;
      const t1 = r.tricks[0];
      const inSecondWon =
        r.tricks.length === 2 &&
        !!t1 &&
        t1.parda !== true &&
        t1.winner !== undefined &&
        teamOf(t1.winner!) === teamOf(player);
      if (inSecondWon) {
        const hand = r.hands[player] ?? [];
        if (!canCallTrucSecondTrickConservative(hand, partnerAdvice, r, player)) {
          return null;
        }
      }
    }
    return action;
  };
  const gatedStrict = gateBaza2Truc(strictSecond);
  if (gatedStrict) return gatedStrict;


  let decision = botDecideInner(m, player, partnerAdvice, hints, tuning, bluffRate);
  if (!decision) return decision;
  decision = enforceStrictConservativeLimits(m, player, decision);
  if (!decision) return decision;

  // Perfil conservador/sincer: si el pipeline ha decidit cantar truc a la
  // 2a baza sense complir les condicions de força/seña, recalcula amb
  // silentTruc perquè el bot jugue la carta directament sense farolejar.
  {
    const gatedDecision = gateBaza2Truc(decision);
    if (gatedDecision === null) {
      const fallback = botDecideInner(
        m,
        player,
        partnerAdvice,
        { ...hints, silentTruc: true },
        tuning,
        bluffRate,
      );
      if (fallback) {
        const enforced = enforceStrictConservativeLimits(m, player, fallback);
        if (enforced) decision = enforced;
      }
    }
  }

  // Probabilitat global de cantar truc/retruc/quatre val. Si el bot decideix
  // cantar però perd el llançament, recalcula la decisió sense l'opció de
  // cantar truc (silentTruc=true) i juga normalment.
  if (decision.type === "shout" && !(decision as any).__forced) {
    const trucProb: Record<string, number> = {
      truc: 0.8,
      retruc: 0.6,
      quatre: 0.4,
    };
    const p = trucProb[decision.what as string];
    if (p !== undefined && Math.random() >= p) {
      const fallback = botDecideInner(
        m,
        player,
        partnerAdvice,
        { ...hints, silentTruc: true },
        tuning,
        bluffRate,
      );
      if (fallback) {
        const enforced = enforceStrictConservativeLimits(m, player, fallback);
        if (enforced) decision = enforced;
      }
    }
  }

  // Salvaguarda: en la 2a baza, si el meu equip ha guanyat la 1a i el bot
  // decideix tirar una carta "top" (manilla d'oros, manilla d'espases,
  // As bastos o As espases), ha de cantar TRUC abans en lloc de gastar la
  // carta sense pressionar. Només si el truc encara no està decidit i hi ha
  // acció legal de truc disponible i no s'ha demanat silenci.
  if (decision.type === "play-card") {
    const r = m.round;
    if (r.tricks.length === 2 && r.tricks[0] && r.tricks[0].parda !== true) {
      const myTeam = teamOf(player);
      const wonFirst =
        r.tricks[0].winner !== undefined && teamOf(r.tricks[0].winner!) === myTeam;
      if (wonFirst) {
        const hand = r.hands[player];
        const card = hand.find((c) => c.id === (decision as Extract<Action, { type: "play-card" }>).cardId);
        const isTop = (c?: Card) =>
          !!c &&
          ((c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
            (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")));
        if (isTop(card) && !(decision as any).covered && !hints.silentTruc) {
          const trucDecided = r.trucState.kind === "accepted" || r.trucState.kind === "rejected";
          // Perfil conservador/sincer: només força truc si compleix
          // les condicions reals de força/seña.
          if (
            !trucDecided &&
            canCallTrucSecondTrickConservative(hand, partnerAdvice, r, player)
          ) {
            const actionsAvail = legalActions(m, player);
            const trucAct = actionsAvail.find(
              (a) => a.type === "shout" && a.what === "truc",
            );
            if (trucAct) return trucAct;
          }
        }
      }
    }
  }

  // Salvaguarda: 2a baza, hem guanyat la 1a, sóc el 2n de la meua
  // parella (el company ja ha jugat) i el bot decideix tirar un 3 o
  // una carta top. Si el company ha senyalitzat carta bona
  // ("Algo tinc" → "strong") o un 3 ("Tinc un tres" → "three"),
  // cantar TRUC abans de jugar la carta. Si advice és "weak" /
  // "neutral" no es truca obligatòriament aquí.
  if (
    decision.type === "play-card" &&
    (partnerAdvice === "strong" || partnerAdvice === "three")
  ) {
    const r = m.round;
    const trick2 = r.tricks[1];
    if (
      r.tricks.length === 2 &&
      r.tricks[0] &&
      r.tricks[0].parda !== true &&
      trick2
    ) {
      const myTeam = teamOf(player);
      const wonFirst =
        r.tricks[0].winner !== undefined && teamOf(r.tricks[0].winner!) === myTeam;
      const partnerPlayedHere = trick2.cards.some(
        (tc) => teamOf(tc.player) === myTeam && tc.player !== player,
      );
      if (wonFirst && partnerPlayedHere && !(decision as any).covered && !hints.silentTruc) {
        const hand = r.hands[player];
        const card = hand.find(
          (c) => c.id === (decision as Extract<Action, { type: "play-card" }>).cardId,
        );
        const isTopCard = (c?: Card) =>
          !!c &&
          ((c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
            (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")));
        if (card && (card.rank === 3 || isTopCard(card))) {
          const trucDecided =
            r.trucState.kind === "accepted" || r.trucState.kind === "rejected";
          if (!trucDecided) {
            const actionsAvail = legalActions(m, player);
            const trucAct = actionsAvail.find(
              (a) => a.type === "shout" && a.what === "truc",
            );
            if (trucAct) return trucAct;
          }
        }
      }
    }
  }

  // Salvaguarda: 2a baza, hem PERDUT la 1a, sóc el 2n de la meua parella
  // (el company ja ha jugat), el meu equip encara no guanya la 2a baza i
  // el bot decideix tirar una carta top. Si el company ha senyalitzat
  // "Algo tinc" (partnerAdvice === "strong"), cantar TRUC abans de tirar.
  if (decision.type === "play-card" && partnerAdvice === "strong") {
    const r = m.round;
    const trick2L = r.tricks[1];
    if (
      r.tricks.length === 2 &&
      r.tricks[0] &&
      r.tricks[0].parda !== true &&
      trick2L
    ) {
      const myTeamL = teamOf(player);
      const lostFirstL =
        r.tricks[0].winner !== undefined &&
        teamOf(r.tricks[0].winner!) !== myTeamL;
      const partnerPlayedHereL = trick2L.cards.some(
        (tc) => teamOf(tc.player) === myTeamL && tc.player !== player,
      );
      if (lostFirstL && partnerPlayedHereL && !(decision as any).covered && !hints.silentTruc) {
        const leaderL = trick2L.cards.reduce(
          (best, tc) =>
            best === null || cardStrength(tc.card) > cardStrength(best.card)
              ? tc
              : best,
          null as typeof trick2L.cards[number] | null,
        );
        const myTeamWinsNowL = !!leaderL && teamOf(leaderL.player) === myTeamL;
        if (!myTeamWinsNowL) {
          const handL = r.hands[player];
          const cardL = handL.find(
            (c) => c.id === (decision as Extract<Action, { type: "play-card" }>).cardId,
          );
          const isTopL = (c?: Card) =>
            !!c &&
            ((c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
              (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")));
          if (isTopL(cardL)) {
            const trucDecidedL =
              r.trucState.kind === "accepted" || r.trucState.kind === "rejected";
            if (!trucDecidedL) {
              const actionsAvail = legalActions(m, player);
              const trucAct = actionsAvail.find(
                (a) => a.type === "shout" && a.what === "truc",
              );
              if (trucAct) return trucAct;
            }
          }
        }
      }
    }
  }

  // Salvaguarda "carta guanyadora reservada": en la 2a baza, si el meu
  // equip ha guanyat la 1a (no parda), el truc ja està acceptat (no podem
  // escalar més per la nostra banda) i a la mà tinc la carta més alta que
  // queda viva (guanyaria SEGUR la 3a baza si arribem) i alguna altra carta
  // més baixa, NO gaste el guanyador ara: jugue la baixa per a deixar
  // marge al rival a retrucar pensant que té opcions. Si el rival retruca,
  // direm "vull" i guanyarem més pedres; si no retruca, igualment guanyem
  // la mà perquè la carta reservada tanca la 3a.
  if (decision.type === "play-card") {
    const r = m.round;
    const t1 = r.tricks[0];
    const inSecond = r.tricks.length === 2;
    const myTeam = teamOf(player);
    const wonFirst =
      !!t1 &&
      t1.parda !== true &&
      t1.winner !== undefined &&
      teamOf(t1.winner!) === myTeam;
    const trucAccepted = r.trucState.kind === "accepted";
    const hand = r.hands[player];
    if (inSecond && wonFirst && trucAccepted && hand.length >= 2) {
      const chosenId = (decision as Extract<Action, { type: "play-card" }>).cardId;
      const chosen = hand.find((c) => c.id === chosenId);
      if (chosen) {
        const playedIds = new Set<string>();
        for (const t of r.tricks) for (const tc of t.cards) playedIds.add(tc.card.id);
        const myIds = new Set(hand.map((c) => c.id));
        const outside = buildDeck().filter(
          (c) => !playedIds.has(c.id) && !myIds.has(c.id),
        );
        const outsideMax = outside.length > 0
          ? Math.max(...outside.map((c) => cardStrength(c)))
          : -1;
        const sortedDesc = [...hand].sort(
          (a, b) => cardStrength(b) - cardStrength(a),
        );
        const myBest = sortedDesc[0]!;
        const myLowest = sortedDesc[sortedDesc.length - 1]!;
        const guaranteedWinners = hand.filter(
          (c) => cardStrength(c) > outsideMax,
        );
        // Nova regla: només reservar la carta més alta si és l'ÚNICA
        // carta garantida per a guanyar el truc. Si en tenim dues o més
        // garantides, no cal reservar cap: podem jugar la millor ara
        // sense por, ja que qualsevol de les restants tanca la 3a baza.
        const highestIsOnlyGuaranteed =
          guaranteedWinners.length === 1 &&
          guaranteedWinners[0]!.id === myBest.id;
        const chosenIsSoleGuaranteed =
          chosen.id === myBest.id && highestIsOnlyGuaranteed;
        if (chosenIsSoleGuaranteed && cardStrength(myLowest) < cardStrength(myBest)) {
          const actionsAvail = legalActions(m, player);
          const lowAct = actionsAvail.find(
            (a) => a.type === "play-card" && (a as any).cardId === myLowest.id,
          );
          if (lowAct) return lowAct;
        }

      }
    }
  }

  // Salvaguarda final: 2a baza, hem guanyat la 1a, sóc el 2n de la meua
  // parella (el company ja ha jugat en esta baza) i tinc un 3 a la mà.
  // OBLIGACIÓ: tirar el 3 (o una carta superior) en esta baza, mai
  // reservar-lo per a la 3a. Si la decisió actual juga una carta més
  // baixa que el 3, la sobreescric per a tirar el 3.
  if (decision.type === "play-card") {
    const r = m.round;
    const trick2f = r.tricks[1];
    if (
      r.tricks.length === 2 &&
      r.tricks[0] &&
      r.tricks[0].parda !== true &&
      trick2f
    ) {
      const myTeamF = teamOf(player);
      const wonFirstF =
        r.tricks[0].winner !== undefined &&
        teamOf(r.tricks[0].winner!) === myTeamF;
      const partnerPlayedHereF = trick2f.cards.some(
        (tc) => teamOf(tc.player) === myTeamF && tc.player !== player,
      );
      if (wonFirstF && partnerPlayedHereF) {
        const handF = r.hands[player];
        const threes = handF.filter((c) => c.rank === 3);
        if (threes.length > 0) {
          const chosenIdF = (decision as Extract<Action, { type: "play-card" }>).cardId;
          const chosenF = handF.find((c) => c.id === chosenIdF);
          const threeStr = cardStrength(threes[0]!);
          // Excepció: si el company ja està guanyant esta baza amb una
          // carta de força ≥ 3, no cal malgastar cap 3 nostre. Deixem la
          // decisió original (carta baixa) per reservar el 3 per a la 3a.
          const partnerCardF = trick2f.cards.find(
            (tc) => teamOf(tc.player) === myTeamF && tc.player !== player,
          );
          const leaderF = trick2f.cards.reduce(
            (best, tc) =>
              best === null || cardStrength(tc.card) > cardStrength(best.card)
                ? tc
                : best,
            null as typeof trick2f.cards[number] | null,
          );
          const partnerAlreadyWinning =
            !!partnerCardF &&
            !!leaderF &&
            leaderF.player === partnerCardF.player &&
            cardStrength(partnerCardF.card) >= threeStr;
          if (!partnerAlreadyWinning && (!chosenF || cardStrength(chosenF) < threeStr)) {
            // Tria el 3 més fort (per pal) si n'hi ha més d'un.
            const bestThree = [...threes].sort(
              (a, b) => cardStrength(b) - cardStrength(a),
            )[0]!;
            const actionsAvail = legalActions(m, player);
            const playThree = actionsAvail.find(
              (a) => a.type === "play-card" && (a as any).cardId === bestThree.id,
            );
            if (playThree) return playThree;
          }
        }
      }
    }
  }

  return decision;
}

function botDecideInner(
  m: MatchState,
  player: PlayerId,
  partnerAdvice: PartnerAdvice = "neutral",
  hints: BotHints = {},
  tuning: BotTuning = NEUTRAL_TUNING,
  bluffRate: number = 0,
): Action | null {
  const actions = legalActions(m, player);
  if (actions.length === 0) return null;

  const r = m.round;
  const hand = r.hands[player];
  const handStrength = avgStrength(hand);
  // IMPORTANT: usem playerTotalEnvit (mà + cartes ja jugades no cobertes)
  // per no infravalorar l'envit si algun bot decideix respondre després
  // d'haver jugat una carta. Amb 33 SEMPRE es detecta com a 33.
  const myEnvit = playerTotalEnvit(r, player);

  if (r.envitState.kind === "pending" && teamOf(player) === r.envitState.awaitingTeam) {
    // REGLA PRINCIPAL: si la cama està a "match-point" (algun equip a 1
    // punt de tancar la cama), l'envit val 1 punt sí o sí — querit o no
    // querit. Acceptar (vull) és sempre l'opció dominant: si guanyem
    // l'envit ens emportem 1; si el rebutgem, li regalem 1 al rival.
    // Perfil CONSERVADOR amb envit ≤30: mai accepta (tampoc al match-point).
    if (!(tuning.conservativeMode && myEnvit <= 30) && isCamaMatchPoint(m)) {
      const vull = actions.find((a) => a.type === "shout" && a.what === "vull");
      if (vull) return vull;
    }
    const isManoMe = r.mano === player;
    const trucStrength = estimateTrucStrength(hand);
    return decideEnvitResponse(actions, myEnvit, r.envitState.level, isManoMe, trucStrength, player, tuning, bluffRate, m, partnerAdvice);
  }
  if (r.trucState.kind === "pending" && teamOf(player) === r.trucState.awaitingTeam) {
    // Ordre del company humà: "Au, anem-se'n!" => rebutja el truc si és possible.
    if (hints.foldTruc) {
      const noVull = actions.find(a => a.type === "shout" && a.what === "no-vull");
      if (noVull) return noVull;
    }
    return decideTrucResponse(actions, hand, m, player, partnerAdvice, tuning, bluffRate);
  }

  // ---- OBLIGACIÓ ABSOLUTA: 2a baza, hem PERDUT la 1a, sóc l'últim de la
  // meua parella en tirar (el meu company ja ha tirat) i tinc alguna
  // carta que guanya a la millor jugada a la mesa → l'he de tirar SÍ
  // o SÍ. Aquesta regla té prioritat sobre tot (truc, tapar, reservar
  // manilles…) perquè perdre la 2a després d'haver perdut la 1a tanca
  // el truc i la mà.
  {
    const myTeamMust = teamOf(player);
    const firstTMust = r.tricks[0];
    const lostFirstMust =
      !!firstTMust &&
      firstTMust.parda !== true &&
      firstTMust.winner !== undefined &&
      teamOf(firstTMust.winner!) !== myTeamMust;
    const curTrickMust = r.tricks[r.tricks.length - 1];
    const inSecondTrickMust =
      r.tricks.length === 2 &&
      !!curTrickMust &&
      !curTrickMust.cards.some((tc) => tc.player === player);
    const partnerPlayedMust =
      !!curTrickMust &&
      curTrickMust.cards.some(
        (tc) => teamOf(tc.player) === myTeamMust && tc.player !== player,
      );
    if (lostFirstMust && inSecondTrickMust && partnerPlayedMust) {
      const tableBestMust = curTrickMust!.cards.reduce(
        (mx, tc) => Math.max(mx, cardStrength(tc.card)),
        -1,
      );
      const tableLeaderMust = curTrickMust!.cards.reduce(
        (best, tc) =>
          best === null || cardStrength(tc.card) > cardStrength(best.card)
            ? tc
            : best,
        null as { player: PlayerId; card: Card } | null,
      );
      const partnerWinsMust =
        !!tableLeaderMust && teamOf(tableLeaderMust.player) === myTeamMust;
      const allFourPlayedExceptMe = curTrickMust!.cards.length === 3;
      // Excepció: si el company guanya amb un 3, no defererim la decisió
      // — el bot pot superar el 3 per assegurar la baza si li convé.
      const partnerWinsWithThreeMust =
        partnerWinsMust && tableLeaderMust!.card.rank === 3;
      if (!(partnerWinsMust && allFourPlayedExceptMe && !partnerWinsWithThreeMust)) {
        const playActsMust = actions.filter(
          (a) => a.type === "play-card",
        ) as Extract<Action, { type: "play-card" }>[];
        const sortedAscMust = [...hand].sort(
          (a, b) => cardStrength(a) - cardStrength(b),
        );
        const winnersMust = sortedAscMust.filter(
          (c) => cardStrength(c) > tableBestMust,
        );
        if (winnersMust.length > 0) {
          // Si NO sóc l'absolut últim (queden rivals per tirar), preferisc
          // guanyar amb una carta MÉS FORTA que un 3 (strength > 70: As de
          // bastos, As d'espases, manilla d'espases o manilla d'oros) per
          // a no malgastar el 3. Només quan sóc l'absolut últim (4t en
          // tirar) i puc guanyar amb un 3 o menys, jugue la carta més
          // xicoteta que guanya — així economitze el top.
          let chosenMust: Card | null = winnersMust[0]!;
          if (!allFourPlayedExceptMe) {
            const topWinners = winnersMust.filter((c) => cardStrength(c) > 70);
            if (topWinners.length > 0) chosenMust = topWinners[0]!;
          }
          const matchAct = playActsMust.find(
            (a) => a.cardId === chosenMust!.id,
          );
          if (matchAct) return { type: "play-card", cardId: matchAct.cardId };
        }
      }
    }
  }

  // ---- OBLIGACIÓ ABSOLUTA (qualsevol posició): 2a baza, hem PERDUT la 1a.
  // L'emparde NO val (perdríem la ronda per la 1a). Si tinc a la mà una
  // carta que SUPERA la millor de la mesa i el meu equip NO va guanyant
  // ja la baza de forma "segura" (rival no iguala), TIRAR-LA obligatòriament
  // (la MÍNIMA que guanya). Aquesta regla té prioritat sobre "tapar",
  // "reservar top", "descarte eficient", etc.
  {
    const myTeamL2 = teamOf(player);
    const t1L2 = r.tricks[0];
    const lostFirstL2 =
      !!t1L2 &&
      t1L2.parda !== true &&
      t1L2.winner !== undefined &&
      teamOf(t1L2.winner!) !== myTeamL2;
    const curL2 = r.tricks[r.tricks.length - 1];
    const inSecondL2 =
      r.tricks.length === 2 &&
      !!curL2 &&
      !curL2.cards.some((tc) => tc.player === player);
    if (lostFirstL2 && inSecondL2 && curL2!.cards.length > 0) {
      const tableBestL2 = curL2!.cards.reduce(
        (mx, tc) => Math.max(mx, cardStrength(tc.card)),
        -1,
      );
      const leaderL2 = curL2!.cards.reduce(
        (best, tc) =>
          best === null || cardStrength(tc.card) > cardStrength(best.card)
            ? tc
            : best,
        null as { player: PlayerId; card: Card } | null,
      );
      const rivalTiesBestL2 = curL2!.cards.some(
        (tc) =>
          teamOf(tc.player) !== myTeamL2 &&
          cardStrength(tc.card) === tableBestL2,
      );
      const myTeamSafeLead =
        !!leaderL2 &&
        teamOf(leaderL2.player) === myTeamL2 &&
        !rivalTiesBestL2;
      if (!myTeamSafeLead) {
        const playActsL2 = actions.filter(
          (a) => a.type === "play-card",
        ) as Extract<Action, { type: "play-card" }>[];
        const winnersL2 = [...hand]
          .filter((c) => cardStrength(c) > tableBestL2)
          .sort((a, b) => cardStrength(a) - cardStrength(b));
        if (winnersL2.length > 0) {
          const match = playActsL2.find(
            (a) => a.cardId === winnersL2[0]!.id,
          );
          if (match) return { type: "play-card", cardId: match.cardId };
        }
      }
    }
  }

  // Regla estricta: 3a baza, tinc un 3 i el meu equip NO ha guanyat la 1a
  // → no canta truc/retruc/quatre val/joc fora sota cap concepte.
  const t1ThreeGuard = r.tricks[0];
  const lostFirstThreeGuard =
    !!t1ThreeGuard &&
    t1ThreeGuard.parda !== true &&
    t1ThreeGuard.winner !== undefined &&
    teamOf(t1ThreeGuard.winner!) !== teamOf(player);
  const skipTrucThreeRule =
    r.tricks.length === 3 &&
    lostFirstThreeGuard &&
    hand.some((c) => c.rank === 3);

  // ---- OBLIGACIÓ: sóc l'ÚLTIM a tirar en una baza DECISIVA i amb la
  //      meua millor carta guanyaria la baza → he de cantar truc/retruc/
  //      quatre val/joc fora obligatòriament abans de tirar.
  //      Baza decisiva = guanyar-la tanca la ronda al meu equip:
  //        · 3a baza (sempre decideix)
  //        · 2a baza si vam guanyar la 1a (2-0)
  //        · 2a baza si la 1a va quedar parda (parda + 2a → ronda)
  if (!hints.silentTruc && !skipTrucThreeRule) {
    const curTrickDec = r.tricks[r.tricks.length - 1];
    const allOthersPlayed =
      !!curTrickDec &&
      curTrickDec.cards.length === 3 &&
      !curTrickDec.cards.some((tc) => tc.player === player);
    if (allOthersPlayed) {
      const myTeamDec = teamOf(player);
      const tableBestStrDec = curTrickDec!.cards.reduce(
        (mx, tc) => Math.max(mx, cardStrength(tc.card)),
        -1,
      );
      const myBestDec = hand.length > 0
        ? [...hand].sort((a, b) => cardStrength(b) - cardStrength(a))[0]!
        : null;
      const wouldWin = !!myBestDec && cardStrength(myBestDec) > tableBestStrDec;
      const t1Dec = r.tricks[0];
      let isDecisive = false;
      if (r.tricks.length === 3) {
        isDecisive = true;
      } else if (r.tricks.length === 2 && t1Dec) {
        const wonFirstDec =
          t1Dec.parda !== true &&
          t1Dec.winner !== undefined &&
          teamOf(t1Dec.winner!) === myTeamDec;
        const firstWasParda = t1Dec.parda === true;
        if (wonFirstDec || firstWasParda) isDecisive = true;
      }
      if (wouldWin && isDecisive) {
        const trucEscalationsDec = new Set([
          "truc",
          "retruc",
          "quatre",
          "joc-fora",
        ]);
        const trucActDec = actions.find(
          (a) => a.type === "shout" && trucEscalationsDec.has(a.what),
        );
        if (trucActDec) return trucActDec;
      }
    }
  }

  // ---- OBLIGACIÓ: 2a baza després de PARDA en la 1a, o 3a baza (independent
  //      del resultat de la 1a). El bot ha de cantar truc/retruc/quatre val/
  //      joc fora abans de tirar segons les cartes que té i les que ja s'han
  //      jugat. Probabilitats per nivell: truc 80%, retruc 60%, quatre val 40%
  //      (per als casos no-obligatoris). Casos obligatoris: 100% (marquem la
  //      decisió com a `__forced` perquè el wrapper exterior no torne a
  //      aplicar la probabilitat de cant).
  {
    const isThird = r.tricks.length === 3;
    const isSecondAfterParda =
      r.tricks.length === 2 && r.tricks[0]?.parda === true;
    if ((isThird || isSecondAfterParda) && !hints.silentTruc && !skipTrucThreeRule) {
      const trucEscalations = new Set(["truc", "retruc", "quatre", "joc-fora"]);
      const trucAct = actions.find(
        (a) => a.type === "shout" && trucEscalations.has((a as any).what),
      ) as Extract<Action, { type: "shout" }> | undefined;
      if (trucAct && hand.length > 0) {
        const what = trucAct.what as string;
        const playedIds = new Set<string>();
        for (const t of r.tricks) for (const tc of t.cards) playedIds.add(tc.card.id);
        const myIds = new Set(hand.map((c) => c.id));
        const outside = buildDeck().filter(
          (c) => !playedIds.has(c.id) && !myIds.has(c.id),
        );
        const outsideMax = outside.length > 0
          ? Math.max(...outside.map((c) => cardStrength(c)))
          : -1;
        const myBest = [...hand].sort(
          (a, b) => cardStrength(b) - cardStrength(a),
        )[0]!;
        const hasHighestRemaining = cardStrength(myBest) > outsideMax;

        const hasCard = (rank: number, suit: string) =>
          hand.some((c) => c.rank === rank && c.suit === suit);
        const wasPlayed = (rank: number, suit: string) =>
          playedIds.has(`${rank}-${suit}`);

        const asEspPlayed = wasPlayed(1, "espases");
        const asBastPlayed = wasPlayed(1, "bastos");
        const sevenEspPlayed = wasPlayed(7, "espases");
        const sevenOrosPlayed = wasPlayed(7, "oros");

        const myTeam = teamOf(player);
        const t1 = r.tricks[0];
        const teamWonFirst =
          !!t1 &&
          t1.parda !== true &&
          t1.winner !== undefined &&
          teamOf(t1.winner!) === myTeam;
        const hasThree = hand.some((c) => c.rank === 3);
        const topFourPlayedCount = [
          sevenOrosPlayed,
          sevenEspPlayed,
          asEspPlayed,
          asBastPlayed,
        ].filter(Boolean).length;
        const trioBeyondSevenOrosPlayed = [
          sevenEspPlayed,
          asEspPlayed,
          asBastPlayed,
        ].filter(Boolean).length;

        const probLevel = (): number =>
          what === "truc" ? 0.8 : what === "retruc" ? 0.6 : what === "quatre" ? 0.4 : 0;

        let p = 0;
        let forced = false;

        if (hasHighestRemaining) {
          // Casos coberts: As espases sempre, As bastos quan no hi ha As esp,
          // 7 esp si As esp i As bast jugats, 7 oros si 7 esp + As esp + As
          // bast jugats, un 3 si totes les top jugades, etc. → obligatori.
          p = 1;
          forced = true;
        } else if (
          isThird &&
          teamWonFirst &&
          hasThree &&
          topFourPlayedCount === 4
        ) {
          p = 1;
          forced = true;
        } else if (
          isThird &&
          teamWonFirst &&
          hasThree &&
          topFourPlayedCount === 3
        ) {
          p = probLevel();
        } else if (
          hasCard(7, "oros") &&
          sevenEspPlayed &&
          asEspPlayed &&
          asBastPlayed
        ) {
          p = 1;
          forced = true;
        } else if (hasCard(7, "oros") && trioBeyondSevenOrosPlayed === 2) {
          p = probLevel();
        } else if (hasCard(7, "espases") && asEspPlayed && asBastPlayed) {
          p = 1;
          forced = true;
        } else if (
          hasCard(7, "espases") &&
          (asEspPlayed !== asBastPlayed)
        ) {
          p = probLevel();
        } else if (hasCard(1, "bastos")) {
          p = probLevel();
        }

        if (p > 0 && Math.random() < p) {
          if (forced) (trucAct as any).__forced = true;
          return trucAct;
        }
      }
    }
  }

  // ---- 2a baza, equip ja ha guanyat la 1a, només em queden cartes top
  //      (o un 3 + una carta top): NO consultar al company; en lloc d'això,
  //      o bé canto truc abans de tirar, o bé jugue tapada la carta més
  //      baixa que tinga (sense trucar). Mai gaste les cartes fortes en
  //      una baza que ja no necessitem guanyar.
  // "Carta top de truc" = manilla d'oros (7 oros), manilla d'espases (7 espases),
  // As bastos o As espases.
  {
    const r2 = r;
    const myTeam2 = teamOf(player);
    const firstTrick2 = r2.tricks[0];
    const firstTrickParda2 = !!firstTrick2 && firstTrick2.parda === true;
    const wonFirstTrick2 =
      !!firstTrick2 &&
      firstTrick2.winner !== undefined &&
      firstTrick2.parda !== true &&
      teamOf(firstTrick2.winner!) === myTeam2;
    const currentTrick2 = r2.tricks[r2.tricks.length - 1];
    const inSecondTrick =
      r2.tricks.length === 2 &&
      !!currentTrick2 &&
      !currentTrick2.cards.some((tc) => tc.player === player);
    if (inSecondTrick) {
      // Prioritat absoluta: si l'equip ja ha guanyat la 1a, sóc 3r a tirar
      // (hi ha 2 cartes a la mesa) i el company NO guanya, i tinc un 3
      // que supera la millor carta de la mesa, juga'l SEMPRE — encara que
      // tinga cartes top reservables. Tancar la 2a baza ací val més que
      // reservar manilles.
      if (wonFirstTrick2 && currentTrick2.cards.length === 2) {
        const tableBestStr = currentTrick2.cards.reduce(
          (mx, tc) => Math.max(mx, cardStrength(tc.card as any)),
          -1,
        );
        const tableLeader = currentTrick2.cards.reduce(
          (best, tc) =>
            best === null || cardStrength(tc.card as any) > cardStrength(best.card as any) ? tc : best,
          null as { player: PlayerId; card: Card } | null,
        );
        const partnerWins = !!tableLeader && teamOf(tableLeader.player) === myTeam2;
        if (!partnerWins) {
          const winningThree = hand.find(
            (c) => c.rank === 3 && cardStrength(c as any) > tableBestStr,
          );
          if (winningThree) {
            const playActs = actions.filter(
              (a) => a.type === "play-card",
            ) as Extract<Action, { type: "play-card" }>[];
            const matchAct = playActs.find((a) => a.cardId === winningThree.id);
            if (matchAct) return matchAct;
          }
        }
      }
      // Si la 1a baza s'ha empardat, MAI cobrir la carta: cal mirar de
      // guanyar la 2a (qui guanye la 2a guanya la mà). Es juga la carta
      // més alta disponible i no s'aplica la lògica de truc/tapar.
      if (firstTrickParda2) {
        const playActs = actions.filter(
          (a) => a.type === "play-card",
        ) as Extract<Action, { type: "play-card" }>[];
        if (playActs.length > 0 && hand.length > 0) {
          const sortedDesc = [...hand].sort(
            (a, b) => cardStrength(b as any) - cardStrength(a as any),
          );
          const highest = sortedDesc[0]!;
          const matchAct = playActs.find((a) => a.cardId === highest.id);
          if (matchAct) {
            return { type: "play-card", cardId: matchAct.cardId };
          }
        }
        // Si no podem trobar la jugada (cas anòmal), no apliquem truc/tapar:
        // deixem que la lògica posterior decideixi però sense cobrir.
      } else {
        const isTop = (c: { suit: string; rank: number }) =>
          (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
          (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"));
        const isThree = (c: { suit: string; rank: number }) => c.rank === 3;
        const allTop = hand.length > 0 && hand.every(isTop);
        const oneThreePlusTop =
          hand.length >= 2 &&
          hand.every((c) => isTop(c) || isThree(c)) &&
          hand.some(isTop) &&
          hand.some(isThree);
        // REGLA ESTRICTA: la reserva de cartes fortes / tapar la més
        // baixa en la 2a baza NOMÉS s'aplica si el meu equip ja ha
        // guanyat la 1a baza. Si l'ha guanyada el rival (o si per
        // qualsevol motiu no la tenim), NO podem tapar ni reservar:
        // hem d'anar a guanyar la 2a obligatòriament amb la millor
        // carta possible, altrament perdem la mà. Aquest bloc es salta
        // en eixe cas i la decisió cau a la lògica general (que trie
        // la carta guanyadora més convenient).
        const trigger = wonFirstTrick2 && (allTop || oneThreePlusTop);
        if (trigger) {
          const playActs = actions.filter(
            (a) => a.type === "play-card",
          ) as Extract<Action, { type: "play-card" }>[];
          const sortedDesc = [...hand].sort(
            (a, b) => cardStrength(b as any) - cardStrength(a as any),
          );
          const highest = sortedDesc[0]!;
          const lowest = sortedDesc[sortedDesc.length - 1]!;

          // Certesa matemàtica: tinc la carta MÉS ALTA que queda viva?
          // (Comparem la meua millor amb el màxim de fora, contant
          //  cartes ja jugades + les de la mà.)
          const playedIds = new Set<string>();
          for (const t of r2.tricks) for (const tc of t.cards) playedIds.add(tc.card.id);
          const myIds = new Set(hand.map((c) => c.id));
          const outside = buildDeck().filter(
            (c) => !playedIds.has(c.id) && !myIds.has(c.id),
          );
          const outsideMax = outside.length > 0
            ? Math.max(...outside.map((c) => cardStrength(c as any)))
            : -1;
          const haveMaxRemaining = cardStrength(highest as any) > outsideMax;

          const trucNotDecided =
            r2.trucState.kind !== "accepted" &&
            r2.trucState.kind !== "rejected";
          const opensTrick = currentTrick2.cards.length === 0;

          if (haveMaxRemaining) {
            // Certesa de guanyar → llibertat total. Per defecte,
            // conserva la millor i tira la més baixa tapada; opcional
            // truc segons la propensió.
            if (trucNotDecided && !hints.silentTruc) {
              const trucAct = actions.find(
                (a) => a.type === "shout" && a.what === "truc",
              );
              const pTruc = Math.min(1, 0.55 * tuning.callPropensity);
              if (trucAct && Math.random() < pTruc) return trucAct;
            }
            const matchAct = playActs.find((a) => a.cardId === lowest.id);
            if (matchAct) {
              return { type: "play-card", cardId: matchAct.cardId, covered: true };
            }
          } else {
            // No tinc certesa: OBLIGATORI trucar (o escalar) abans de
            // tirar cap carta, per forçar el rival.
            if (trucNotDecided && !hints.silentTruc) {
              const escalations = ["retruc", "truc"] as const;
              for (const what of escalations) {
                const act = actions.find(
                  (a) => a.type === "shout" && a.what === what,
                );
                if (act) return act;
              }
            }
            // Si el truc ja està resolt (o no es pot cantar), regla de
            // posició:
            //   · Obro la 2a baza      → tira la MÉS BAIXA (reserva alta per a 3a).
            //   · Jugo després del rival → tira la MÉS ALTA per tancar.
            const toPlay = opensTrick ? lowest : highest;
            const matchAct = playActs.find((a) => a.cardId === toPlay.id);
            if (matchAct) {
              return { type: "play-card", cardId: matchAct.cardId, covered: opensTrick };
            }
          }
        }

      }
    }
  }

  // ---- Rol "primer de la pareja a tirar" en la baza actual ----
  // Si en la baza actual ningú del meu equip ha tirat encara, sóc el
  // primer del meu equip a tirar. Cantar envit o truc en aquesta posició
  // sol ser una mala estratègia: el rival respon amb info completa i el
  // company encara no ha pogut donar pistes. Per defecte, evita-ho;
  // només ho fa de tant en tant per a no ser previsible.
  const currentTrickForRole = r.tricks[r.tricks.length - 1];
  const teammatePlayedInCurrentTrick = !!currentTrickForRole?.cards.some(
    tc => teamOf(tc.player) === teamOf(player) && tc.player !== player,
  );
  const isFirstOfTeamToPlay = !teammatePlayedInCurrentTrick;
  // Probabilitat base d'autoritzar el cant tot i ser el primer del equip
  // (≈ 15%). S'incrementa lleugerament si el perfil és més agressiu.
  const firstOfTeamBypass = Math.random() < 0.15 * tuning.callPropensity;

  // ---- Restricció dura per a "primer de la parella en la 1a baza" ----
  // Si soc el primer del meu equip a tirar en la PRIMERA baza, NO puc
  // envidar ni truquejar tret que tinga envit alt (≥31) i com a mínim
  // DUES cartes top de truc (As bastos, As espases, 7 espases o 7 oros).
  const isFirstTrickForRole = r.tricks.length === 1;
  const topCardsCount = hand.filter(
    (c) =>
      (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")) ||
      (c.rank === 7 && (c.suit === "espases" || c.suit === "oros")),
  ).length;
  const firstOfTeamFirstTrickAllowsCall =
    !isFirstOfTeamToPlay ||
    !isFirstTrickForRole ||
    (myEnvit >= 31 && topCardsCount >= 2);

  // ---- Estratègia "trampa" d'envit ----
  // Si sóc MÀ amb envit molt fort (≥31), sovint NO envide i espere que
  // ho faça el rival per a guanyar més pedres. El PEU (segon de la
  // parella) en canvi, si té envit (≥31), envida directament: no té
  // sentit esperar perquè ja és el seu torn d'envidar.
  const isMano = r.mano === player;
  const trapEnvit =
    (isMano && myEnvit >= 31) ||
    ((partnerAdvice === "strong" || partnerAdvice === "three") && myEnvit >= 28);

  const canEnvit = actions.some(a => a.type === "shout" && a.what === "envit");
  // Si el company humà ha indicat "Envida!", el bot canta envit
  // immediatament sense avaluar la força de la mà.
  if (canEnvit && hints.forceEnvit) {
    return { type: "shout", what: "envit" };
  }
  // ---- Perfil CONSERVADOR amb envit baix (≤30): regla de cants ----
  // Regla general: amb 30 punts d'envit o menys, el bot conservador NO
  // canta envit per iniciativa pròpia.
  // Excepció única: 1a baza (cap envit cantat encara a la ronda) i sóc
  // l'últim en parlar/tirar de la 1a baza (hi ha 3 cartes a la taula).
  const conservativeEnvitBlocked =
    tuning.conservativeMode === true && myEnvit <= 30;
  const conservativeEnvitLastSpeak =
    r.tricks.length === 1 &&
    r.envitState.kind === "none" &&
    (r.tricks[r.tricks.length - 1]?.cards.length ?? 0) === 3;
  const conservativeCanEnvit =
    canEnvit && (!conservativeEnvitBlocked || conservativeEnvitLastSpeak);
  // Estratègia: la MÀ (primer jugador de la pareja) NO envida proactivament.
  // En lloc d'envidar i encadenar truc (combo "Envit + Truc" que sol donar
  // pocs punts perquè el rival pot rebutjar el truc i quedar-se l'envit
  // baix), espera que envide el rival per a poder renvidar i guanyar més
  // pedres. Si la mà té cartes molt fortes, el millor és esperar i deixar
  // que els rivals canten primer per a poder pujar les apostes.
  // El PEU (segon de la parella) sí pot envidar amb envit alt: ja és el seu
  // torn i no encadenarà cap truc no desitjat.
  const envitAllowedForRole = !isMano;
  // Freno addicional: si sóc el primer del meu equip a tirar en aquesta
  // baza, normalment no envide (excepte el bypass aleatori).
  const envitAllowedByPosition = !isFirstOfTeamToPlay || firstOfTeamBypass;

  // Peu amb envit (≥31): envida sí o sí, sense consultar ni esperar.
  // Aquesta excepció es manté fins i tot si és el primer del equip a tirar:
  // tindre 31+ d'envit és una jugada segura que no depèn de l'ordre.
  if (conservativeCanEnvit && !isMano && myEnvit >= 31 && firstOfTeamFirstTrickAllowsCall) {
    return { type: "shout", what: "envit" };
  }
  // Mode honest (bluffRate === 0): només envida si realment té possibilitats
  // reals de guanyar l'envit (≥31). Si la mà és, envida; si és peu ja s'ha
  // tractat més amunt. Sense farols ni envits especulatius amb 27/30.
  // En mode honest la mà MAI envida proactivament (`envitAllowedForRole`).
  if (conservativeCanEnvit && envitAllowedForRole && envitAllowedByPosition && firstOfTeamFirstTrickAllowsCall && bluffRate === 0) {
    if (myEnvit >= 31) return { type: "shout", what: "envit" };
    // No fer cap altre envit en mode sincer.
  } else
  if (conservativeCanEnvit && envitAllowedForRole && envitAllowedByPosition && firstOfTeamFirstTrickAllowsCall && !trapEnvit) {
    if (myEnvit >= 30 && Math.random() < 0.8 * tuning.callPropensity) {
      return { type: "shout", what: "envit" };
    }
    if (myEnvit >= 27 && Math.random() < 0.3 * tuning.callPropensity) {
      return { type: "shout", what: "envit" };
    }
    // Bluff envit: només si el perfil ho permet (bluffRate > 0).
    if (bluffRate > 0 && myEnvit < 24 && Math.random() < bluffRate * tuning.bluffPropensity * tuning.callPropensity) {
      return { type: "shout", what: "envit" };
    }
  }
  // Amb trampa activa, de tant en tant igualment envida (per no ser previsible).
  // En mode sincer no s'aplica aquesta aleatorietat.
  if (conservativeCanEnvit && envitAllowedForRole && envitAllowedByPosition && firstOfTeamFirstTrickAllowsCall && trapEnvit && bluffRate > 0 && Math.random() < 0.12) {
    return { type: "shout", what: "envit" };
  }

  const canTruc = actions.some(a => a.type === "shout" && a.what === "truc");
  if (canTruc && !hints.silentTruc) {
    // Si el company humà ha indicat "Truca!", el bot canta truc
    // immediatament sense avaluar la força de la mà.
    if (hints.forceTruc) {
      const trucAct = actions.find(a => a.type === "shout" && a.what === "truc");
      if (trucAct) return trucAct;
    }
    // Freno: si sóc el primer del meu equip a tirar en aquesta baza,
    // normalment NO truque proactivament (excepte el bypass aleatori).
    // El truc oportunista de 3a baza dins `decideProactiveTruc` segueix
    // protegit per açò perquè és precisament la situació en què tinc la
    // millor carta i té sentit pujar.
    if ((!isFirstOfTeamToPlay || firstOfTeamBypass) && firstOfTeamFirstTrickAllowsCall && !skipTrucThreeRule) {
      const trucAction = decideProactiveTruc(m, player, hand, handStrength, partnerAdvice, tuning, bluffRate, hints);
      if (trucAction) return trucAction;
    }
  }

  const playActions = actions.filter(a => a.type === "play-card") as Extract<Action, { type: "play-card" }>[];
  if (playActions.length === 0) {
    return actions[0]!;
  }

  // Ordres del company humà sobre quina carta tirar
  if (hints.cardHint === "fort") {
    const myTeamWonFirst = r.tricks[0]?.winner !== undefined && teamOf(r.tricks[0]!.winner!) === teamOf(player);
    // Senyal "Fica algo fort": 1a baza → carta més alta; 2a → una Top
    // (pot pisar el company). Mai es desperdicia: si no guanya totes
    // les rivals de la mesa, s'ignora i s'aplica la lògica habitual.
    const fortTrickIdx = r.tricks.length - 1;
    const fortCurCards = r.tricks[fortTrickIdx]?.cards ?? [];
    const card = pickFortSignalCard(hand, fortTrickIdx, fortCurCards, player, myTeamWonFirst);
    if (card) {
      const match = playActions.find(a => a.cardId === card.id);
      if (match) return match;
    }
  }
  if (hints.cardHint === "molesto") {
    const card = pickMolestoCard(hand);
    if (card) {
      const match = playActions.find(a => a.cardId === card.id);
      if (match) return match;
    }
  }
  if (hints.cardHint === "tres") {
    const card = pickTresCard(hand);
    if (card) {
      const match = playActions.find(a => a.cardId === card.id);
      if (match) return match;
    }
  }

  return choosePlayCard(m, player, playActions, partnerAdvice, hints.playStrength ?? null, hints.rivalShownStrength ?? false);
}

function avgStrength(hand: Array<{ suit: string; rank: number }>): number {
  if (hand.length === 0) return 0;
  let s = 0;
  for (const c of hand) s += cardStrength(c as any);
  return s / hand.length;
}

function estimateTrucStrength(hand: Array<{ suit: string; rank: number }>): number {
  // 0..1 aprox. Cartes molt fortes (≥85: manilla d'oros, manilla d'espases,
  // As bastos, As espases) valen molt; el 3 val mitjà; resta poc.
  let s = 0;
  for (const c of hand) {
    const v = cardStrength(c as any);
    if (v >= 85) s += 0.5;          // topTrucCards fortes + asos
    else if (v >= 70) s += 0.3;     // tres
    else if (v >= 50) s += 0.12;    // 6 o 7 menor
    else s += 0.04;
  }
  return Math.min(1, s);
}

/**
 * Distribució discreta aproximada del valor d'envit del rival que ja ha
 * cantat al nivell donat. Cobreix de 20 a 40 (valors típics). Pesos
 * estimats segons l'agressivitat creixent: més nivell → distribució
 * desplaçada cap a valors alts.
 */
function opponentEnvitDistribution(level: 2 | 4 | "falta"): Map<number, number> {
  // Pesos relatius. Es normalitzen després.
  const dist = new Map<number, number>();
  const set = (v: number, w: number) => dist.set(v, (dist.get(v) ?? 0) + w);

  if (level === 2) {
    // Envit simple: la majoria envida amb 29-33; cua fins a 38; algun bluff baix.
    set(25, 0.3); set(26, 0.5); set(27, 0.8); set(28, 1.2);
    set(29, 2.0); set(30, 3.0); set(31, 3.2); set(32, 2.8);
    set(33, 2.2); set(34, 1.6); set(35, 1.0); set(36, 0.6); set(37, 0.4); set(38, 0.2);
  } else if (level === 4) {
    // Renvit: el rival ja ha pujat → mà més forta.
    set(28, 0.3); set(29, 0.5); set(30, 1.0); set(31, 1.8);
    set(32, 2.6); set(33, 3.0); set(34, 2.8); set(35, 2.2);
    set(36, 1.6); set(37, 1.0); set(38, 0.6); set(39, 0.3); set(40, 0.2);
  } else {
    // Falta-envit: típicament només es canta amb mà molt forta o desesperació.
    set(28, 0.4); set(29, 0.5); set(30, 0.8); set(31, 1.2);
    set(32, 1.8); set(33, 2.4); set(34, 2.6); set(35, 2.4);
    set(36, 2.0); set(37, 1.6); set(38, 1.2); set(39, 0.8); set(40, 0.5);
  }
  // Normalitza.
  let sum = 0;
  for (const w of dist.values()) sum += w;
  for (const [k, v] of dist) dist.set(k, v / sum);
  return dist;
}

/**
 * Probabilitat de guanyar l'envit donat el meu valor i si soc mà.
 * Mà guanya els empats.
 */
function envitWinProbability(myEnvit: number, level: 2 | 4 | "falta", isMano: boolean): number {
  const dist = opponentEnvitDistribution(level);
  let pWin = 0;
  for (const [oppVal, p] of dist) {
    if (myEnvit > oppVal) pWin += p;
    else if (myEnvit === oppVal && isMano) pWin += p;
  }
  return pWin;
}

function decideEnvitResponse(
  actions: Action[],
  myEnvit: number,
  level: 2 | 4 | "falta",
  isMano: boolean,
  trucStrength: number,
  player: PlayerId,
  tuning: BotTuning = NEUTRAL_TUNING,
  bluffRate: number = 0,
  m?: MatchState,
  partnerAdvice: PartnerAdvice = "neutral",
): Action {
  // Punts en joc per nivell (vull / no vull):
  //   envit (2): +2 si guanyem / -1 si perdem    → cost no-vull = 1 al rival
  //   renvit (4): +4 / -2                         → cost no-vull = 2
  //   falta:    +molts / -(1|2|4) segons history  → assumim cost no-vull = 2
  //
  // Anàlisi POSICIONAL (instrucció "Lógica posicional del Envido"):
  // determinem si el bot té prioritat de mà sobre el rival que porta
  // l'envit (el caller). Aquest flag substitueix el `isMano` cru per al
  // càlcul de pWin — l'empat guanya per a qui és mà sobre el portador de
  // l'envit. Precedeix qualsevol decisió de 'vull'/'no vull'.
  //   · Sóc mà sobre el caller  → em basta EMPATAR per guanyar.
  //   · Postre sobre el caller  → necessite SUPERAR estrictament.
  let manoOverCaller = isMano;
  if (m && m.round.envitState.kind === "pending") {
    const callerPos = m.round.envitState.calledBy;
    let pPos: PlayerId = m.round.mano;
    for (let i = 0; i < 4; i++) {
      if (pPos === player) { manoOverCaller = true; break; }
      if (pPos === callerPos) { manoOverCaller = false; break; }
      pPos = ((pPos + 1) % 4) as PlayerId;
    }
  }
  const pWin = envitWinProbability(myEnvit, level, manoOverCaller);

  // EV (en pedres) d'acceptar respecte rebutjar:
  //   EV_accept = pWin*win - (1-pWin)*lose
  //   EV_reject = -costRebuig  (perdem aquests punts segur)
  //   acceptem si EV_accept > EV_reject
  let win: number, lose: number, costRebuig: number;
  if (level === 2) { win = 2; lose = 2; costRebuig = 1; }
  else if (level === 4) { win = 4; lose = 4; costRebuig = 2; }
  else { win = 8; lose = 8; costRebuig = 2; } // falta: aproximació

  // Bonus per força de truc: si la mà és bona de joc, perdre l'envit "fa
  // menys mal" perquè recuperem amb el truc (+0.5/+1 pedra equivalent).
  const trucBonus = trucStrength >= 0.7 ? 1.0 : trucStrength >= 0.5 ? 0.5 : trucStrength <= 0.2 ? -0.5 : 0;

  const evAccept = pWin * win - (1 - pWin) * lose + trucBonus + tuning.envitAcceptDelta;
  const evReject = -costRebuig;

  // Pujar (renvit / falta-envit) val la pena només si la nostra prob. després
  // de pujar (que sol baixar perquè el rival rebutja amb mà mediocre i només
  // continua amb la millor) compensa el cost extra. Heurística: necessitem
  // pWin alta i un mínim absolut d'envit.
  const canRaise = actions.some(a => a.type === "shout" && (a.what === "renvit" || a.what === "falta-envit"));
  const raiseAction = actions.find(a => a.type === "shout" && (a.what === "renvit" || a.what === "falta-envit"));

  const log = (decision: string) => {
    // eslint-disable-next-line no-console
    console.log(
      `[bot envit] p${player} decision=${decision} level=${level} myEnvit=${myEnvit} mano=${isMano} ` +
      `pWin=${pWin.toFixed(2)} EV_accept=${evAccept.toFixed(2)} EV_reject=${evReject.toFixed(2)} ` +
      `trucStrength=${trucStrength.toFixed(2)} trucBonus=${trucBonus.toFixed(2)}`
    );
  };

  // ----- Perfil CONSERVADOR amb envit baix (≤30): mai acceptar -----
  // Regla estricta SENSE excepcions: davant d'un envit rival (envit,
  // renvit o falta-envit), amb 30 punts d'envit o menys el bot
  // conservador respon sempre "no-vull", independentment de la seua
  // posició a la taula o dels punts en joc.
  if (tuning.conservativeMode && myEnvit <= 30) {
    log("no-vull (conservador ≤30, sense excepcions)");
    return { type: "shout", what: "no-vull" };
  }

  // ----- Resposta a FALTA-ENVIT -----
  // Regla específica del jugador: davant d'una falta-envit, el bot només
  // pot acceptar si:
  //   · Té 33 d'envit i és "mà" respecte qui ha cantat la falta
  //     (és a dir, té prioritat de mà sobre el rival que va envidar la
  //     falta — guanyaria un eventual empat a 33).
  //   · Té 32 d'envit i és "mà" respecte qui ha cantat la falta:
  //     valora pel càlcul EV si accepta o rebutja.
  //   · Amb 31 o menys: SEMPRE rebutjar (no-vull).
  // Mai s'usa "renvit"/"falta-envit" com a resposta a una falta (no es pot
  // pujar més). La pregunta al company "Quant envit tens?" es gestiona
  // a la capa d'orquestració (useTrucMatch/rooms-rpc).
  if (level === "falta") {
    const vullAction = actions.find(
      (a) => a.type === "shout" && a.what === "vull",
    );
    const noVullAction: Action = { type: "shout", what: "no-vull" };
    // Determina si el bot té prioritat de mà sobre el rival que va cantar
    // la falta (recorre l'ordre mà → mà+1 → mà+2 → mà+3; el primer
    // trobat té prioritat en cas d'empat).
    let manoPriorityOverCaller = false;
    if (m && m.round.envitState.kind === "pending") {
      const caller = m.round.envitState.calledBy;
      let p: PlayerId = m.round.mano;
      for (let i = 0; i < 4; i++) {
        if (p === player) { manoPriorityOverCaller = true; break; }
        if (p === caller) { manoPriorityOverCaller = false; break; }
        p = ((p + 1) % 4) as PlayerId;
      }
    } else {
      manoPriorityOverCaller = isMano;
    }

    if (myEnvit <= 31) {
      log("no-vull (falta, ≤31)");
      return noVullAction;
    }
    if (myEnvit >= 33 && manoPriorityOverCaller && vullAction) {
      log("vull (falta, 33 amb mà sobre rival)");
      return vullAction;
    }
    if (myEnvit === 32 && manoPriorityOverCaller && vullAction) {
      if (evAccept > evReject) {
        log("vull (falta, 32 amb mà, EV+)");
        return vullAction;
      }
      log("no-vull (falta, 32 amb mà, EV-)");
      return noVullAction;
    }
    log("no-vull (falta, sense mà o sense vull)");
    return noVullAction;
  }

  // ----- Cas: el meu COMPANY ja ha rebutjat aquest envit (no-vull) -----
  // Si el meu company ja ha dit "no-vull" a aquest envit, no té sentit
  // consultar res. Apliquem la regla estricta:
  //   · Acceptem (vull) si tinc 31, 32 o 33 d'envit.
  //   · Renvidem (renvit / falta-envit) si tinc 33 d'envit, o bé 32 i
  //     sóc mà sobre el rival que va envidar.
  //   · Altrament: "no-vull".
  if (m && m.round.envitState.kind === "pending") {
    const partnerSeat = ((player + 2) % 4) as PlayerId;
    const rejected = m.round.envitState.rejectedBy ?? [];
    if (rejected.includes(partnerSeat)) {
      const renvitAct = actions.find(
        (a) => a.type === "shout" && (a.what === "renvit" || a.what === "falta-envit"),
      );
      const vullAct = actions.find(
        (a) => a.type === "shout" && a.what === "vull",
      );
      const noVullAct: Action = { type: "shout", what: "no-vull" };
      let manoPriorityOverCaller = false;
      const caller = m.round.envitState.calledBy;
      let p2: PlayerId = m.round.mano;
      for (let i = 0; i < 4; i++) {
        if (p2 === player) { manoPriorityOverCaller = true; break; }
        if (p2 === caller) { manoPriorityOverCaller = false; break; }
        p2 = ((p2 + 1) % 4) as PlayerId;
      }
      const wantsRaise =
        myEnvit >= 33 || (myEnvit === 32 && manoPriorityOverCaller);
      if (wantsRaise && renvitAct) {
        log("renvit (company ha rebutjat, 33 o 32+mà)");
        return renvitAct;
      }
      if (myEnvit >= 31 && vullAct) {
        log("vull (company ha rebutjat, 31/32/33)");
        return vullAct;
      }
      log("no-vull (company ha rebutjat, <31)");
      return noVullAct;
    }
  }

  // ----- Resposta OBLIGATÒRIA a un RENVIT (level === 4) amb 33 d'envit -----
  // Independentment del perfil (sincer/farol), si el rival ens canta el
  // renvit ("Vuelvo a envidar") i tenim 33 d'envit, MAI rebutgem:
  //   · Si sóc mà respecte qui ha cantat el renvit (prioritat de mà) →
  //     "Falta envit!" (guanyaríem qualsevol empat a 33).
  //   · Si NO sóc mà → "Vull!" (acceptem com a mínim).
  if (level === 4 && myEnvit >= 33) {
    let manoPriorityOverCaller33 = isMano;
    if (m && m.round.envitState.kind === "pending") {
      const caller33 = m.round.envitState.calledBy;
      let p33: PlayerId = m.round.mano;
      for (let i = 0; i < 4; i++) {
        if (p33 === player) { manoPriorityOverCaller33 = true; break; }
        if (p33 === caller33) { manoPriorityOverCaller33 = false; break; }
        p33 = ((p33 + 1) % 4) as PlayerId;
      }
    }
    const faltaActOblig = actions.find(
      (a) => a.type === "shout" && a.what === "falta-envit",
    );
    const vullActOblig = actions.find(
      (a) => a.type === "shout" && a.what === "vull",
    );
    if (manoPriorityOverCaller33 && faltaActOblig) {
      log("falta-envit (obligatori, renvit + 33 + mà)");
      return faltaActOblig;
    }
    if (vullActOblig) {
      log("vull (obligatori, renvit + 33)");
      return vullActOblig;
    }
  }

  // ----- Regla DURA universal d'envit segons nivell -----
  // Independentment del perfil (sincer/farol) o del mode (conservador o no):
  //
  //  · ENVIT (level 2):
  //      - myEnvit ≥ 31 → com a mínim "vull" (mai "no-vull").
  //      - myEnvit = 33 → pot pujar a "renvit" (Torne a envidar).
  //      - myEnvit = 32 i sóc mà sobre qui ha cantat → "renvit".
  //
  //  · RENVIT (level 4):
  //      - Només acceptem si tinc 33, o tinc 32 i sóc mà sobre qui ha
  //        tornat a envidar. Altrament, "no-vull".
  //      - Amb 33 i mà sobre el caller → "falta-envit" (ja gestionat més
  //        amunt al bloc obligatori).
  // Use a local alias so the type-narrowing of early returns doesn't strip
  // `4` from `level` for the unreachable-but-still-typechecked branches below.
  const lvl: 2 | 4 | "falta" = level;
  if (lvl === 2 || lvl === 4) {
    let manoPriorityOverCallerHard = isMano;
    if (m && m.round.envitState.kind === "pending") {
      const callerHard = m.round.envitState.calledBy;
      let pHard: PlayerId = m.round.mano;
      for (let i = 0; i < 4; i++) {
        if (pHard === player) { manoPriorityOverCallerHard = true; break; }
        if (pHard === callerHard) { manoPriorityOverCallerHard = false; break; }
        pHard = ((pHard + 1) % 4) as PlayerId;
      }
    }
    const renvitActHard = actions.find(
      (a) => a.type === "shout" && a.what === "renvit",
    );
    const faltaActHard = actions.find(
      (a) => a.type === "shout" && a.what === "falta-envit",
    );
    const vullActHard = actions.find(
      (a) => a.type === "shout" && a.what === "vull",
    );

    if (lvl === 2 && myEnvit >= 31) {
      if (myEnvit >= 33 && renvitActHard) {
        log("renvit (hard, 33)");
        return renvitActHard;
      }
      if (myEnvit === 32 && manoPriorityOverCallerHard && renvitActHard) {
        log("renvit (hard, 32 + mà)");
        return renvitActHard;
      }
      if (vullActHard) {
        log("vull (hard, ≥31)");
        return vullActHard;
      }
    }

    if (lvl === 4) {
      if (myEnvit >= 33 && manoPriorityOverCallerHard && faltaActHard) {
        log("falta-envit (hard, renvit + 33 + mà)");
        return faltaActHard;
      }
      if (myEnvit >= 33 && vullActHard) {
        log("vull (hard, renvit + 33)");
        return vullActHard;
      }
      if (myEnvit === 32 && manoPriorityOverCallerHard && vullActHard) {
        log("vull (hard, renvit + 32 + mà)");
        return vullActHard;
      }
      log("no-vull (hard, renvit sense 33 ni 32+mà)");
      return { type: "shout", what: "no-vull" };
    }
  }

  // ----- Mode SINCER (bluffRate === 0): regles dures d'envit -----
  // (es manté com a fallback; la regla universal de dalt ja cobreix ≥31.)
  if (bluffRate === 0) {
    const renvitAction = actions.find(
      (a) => a.type === "shout" && a.what === "renvit",
    );
    const faltaAction = actions.find(
      (a) => a.type === "shout" && a.what === "falta-envit",
    );
    const vullAction = actions.find(
      (a) => a.type === "shout" && a.what === "vull",
    );
    if (myEnvit >= 33 && isMano && level === 4 && faltaAction) {
      log("falta-envit (sincer, mà 33)");
      return faltaAction;
    }
    if (myEnvit >= 32 && level === 2 && renvitAction) {
      log("renvit (sincer, ≥32)");
      return renvitAction;
    }
    if (myEnvit >= 31 && vullAction) {
      log("vull (sincer, ≥31)");
      return vullAction;
    }
  }

  // ----- Guardia dura: envit petit (≤29) -----
  // Mai acceptem un envit amb 29 o menys: és un envit petit i la
  // probabilitat de guanyar és baixa. Rebutgem sempre amb "no-vull".
  if (myEnvit <= 29) {
    log("no-vull (envit petit ≤29)");
    return { type: "shout", what: "no-vull" };
  }

  // ----- Mode CONSERVADOR (regla dura) -----
  // Només acceptar envit si:
  //   (a) myEnvit ≥ 31 (31, 32 o 33+ → grans possibilitats reals), o
  //   (b) el meu equip ja ha guanyat la primera baza I tinc una "carta top"
  //       (manilla d'oros, manilla d'espases, As bastos, As espases) a la mà, o
  //   (c) el meu equip ja ha guanyat la primera baza I sé que el meu
  //       company té una carta top (deduït pel partnerAdvice "strong"
  //       després d'una pregunta directa: "vine-a-mi" / "tinc-bona" /
  //       "tens-mes-dun-tres" → "si"). Vegeu adviceFromAnswer.
  // En qualsevol altre cas: NO VULL (rebutjar).
  // No s'aplica a renvit/falta-envit pujats per nosaltres (canRaise) si
  // tenim envit molt alt — gestionat més avall.
  if (tuning.conservativeMode && m) {
    const myTeam = teamOf(player);
    const firstTrick = m.round.tricks[0];
    const wonFirstTrick =
      !!firstTrick &&
      firstTrick.winner !== undefined &&
      firstTrick.parda !== true &&
      teamOf(firstTrick.winner!) === myTeam;
    const hand = m.round.hands[player];
    const hasTopCard = hand.some(
      (c) =>
        (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
        (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")),
    );
    const partnerSignalsTop = (partnerAdvice === "strong" || partnerAdvice === "three");

    const conservativeAllow =
      myEnvit >= 31 ||
      (wonFirstTrick && (hasTopCard || partnerSignalsTop));

    if (!conservativeAllow) {
      log("no-vull (conservador)");
      return { type: "shout", what: "no-vull" };
    }
    // Si entrem aquí, podem continuar amb la lògica EV/raise normal,
    // però recordem: en general, conservador prefereix "vull" sense pujar.
  }

  if (canRaise && raiseAction) {
    // Instrucció "Envido posicional": només tornar/pujar l'envit si la
    // probabilitat REAL (ja calculada amb posició mà/postre sobre el
    // caller) supera el 75%. Si sóc postre, la regla d'empat perdedor
    // ja ha reduït pWin, així que la mateixa comprovació funciona.
    const raiseThreshold = 0.75;
    if (tuning.conservativeMode) {
      // Conservador: pujar amb mà forta (≥31). Màxim real = 33.
      if (level === 2 && pWin > raiseThreshold && myEnvit >= 31) {
        log(`pujar (${(raiseAction as any).what}) [conservador, pWin>${raiseThreshold}]`);
        return raiseAction;
      }
    } else {
      // Agressiu/equilibrat: pujar amb mà molt forta (32-33). Mai >33.
      if (level === 2 && pWin > raiseThreshold && myEnvit >= 32) {
        log(`pujar (${(raiseAction as any).what}) [pWin>${raiseThreshold}]`);
        return raiseAction;
      }
      if (level === 4 && pWin > raiseThreshold && myEnvit >= 33) {
        log(`pujar (${(raiseAction as any).what}) [pWin>${raiseThreshold}]`);
        return raiseAction;
      }
    }
  }

  // Instrucció "Envido posicional": ser conservador si sóc postre sobre
  // el caller i no arribe a >75% de probabilitat real d'èxit. Les regles
  // dures universals de dalt (≥31 → vull) ja s'han aplicat; aquí només
  // estem en la zona grisa (30 punts, o 31 sense mà en nivells alts).
  if (!manoOverCaller && pWin <= 0.75 && evAccept <= evReject + 0.5) {
    log("no-vull (postre sense >75%)");
    return { type: "shout", what: "no-vull" };
  }

  if (evAccept > evReject) {
    log("vull");
    return { type: "shout", what: "vull" };
  }
  if (
    bluffRate > 0 &&
    !tuning.conservativeMode &&
    level === 2 &&
    evAccept > evReject - 0.5 &&
    (isMano || trucStrength >= 0.6) &&
    Math.random() < bluffRate
  ) {
    log("vull (bluff)");
    return { type: "shout", what: "vull" };
  }
  log("no-vull");
  return { type: "shout", what: "no-vull" };
}

function decideTrucResponse(
  actions: Action[],
  hand: Array<{ suit: string; rank: number }>,
  m: MatchState,
  player: PlayerId,
  partnerAdvice: PartnerAdvice = "neutral",
  tuning: BotTuning = NEUTRAL_TUNING,
  bluffRate: number = 0,
): Action {
  const r = m.round;
  const myTeam = teamOf(player);
  // ==== VICTÒRIA 100% GARANTITZADA ====
  // Si tinc a la mà la carta més alta VIVA de truc (la més forta que
  // encara no s'ha jugat en tota la partida) i, donada la situació de
  // bazes, guanyar la resta de la mà està assegurat, MAI rebutjar el
  // truc: escalar al màxim legal (joc-fora > quatre > retruc) o "vull".
  if (r.trucState.kind === "pending") {
    const playedKeysG = new Set<string>();
    for (const t of r.tricks) for (const tc of t.cards) {
      playedKeysG.add(`${tc.card.rank}-${tc.card.suit}`);
    }
    const TOP_CARDS_G = [
      { rank: 1, suit: "espases" },
      { rank: 1, suit: "bastos" },
      { rank: 7, suit: "espases" },
      { rank: 7, suit: "oros" },
    ] as const;
    const aliveTopStrsG = TOP_CARDS_G
      .filter((t) => !playedKeysG.has(`${t.rank}-${t.suit}`))
      .map((t) => cardStrength({ rank: t.rank, suit: t.suit } as Card));
    const maxAliveTopStrG = aliveTopStrsG.length > 0 ? Math.max(...aliveTopStrsG) : -1;
    const iHaveMaxAliveTopG =
      maxAliveTopStrG > 0 &&
      (hand as Card[]).some((c) => cardStrength(c) === maxAliveTopStrG);
    if (iHaveMaxAliveTopG) {
      const t1G = r.tricks[0];
      const wonFirstG =
        !!t1G && t1G.parda !== true && t1G.winner !== undefined &&
        teamOf(t1G.winner!) === myTeam;
      const pardaFirstG = !!t1G && t1G.parda === true;
      const t2G = r.tricks[1];
      const wonSecondG =
        !!t2G && t2G.parda !== true && t2G.winner !== undefined &&
        teamOf(t2G.winner!) === myTeam;
      const pardaSecondG = !!t2G && t2G.parda === true;
      const trickIdxG = r.tricks.length; // 1, 2 o 3
      let guaranteedG = false;
      if (trickIdxG === 3) {
        // Tinc la carta més forta viva → guanye la 3a. Guanye la mà si
        // ja hem guanyat o empardat una baza prèvia.
        guaranteedG = wonFirstG || pardaFirstG || wonSecondG || pardaSecondG;
      } else if (trickIdxG === 2) {
        // Guanyaré la 2a. Si ja tenim la 1a (o parda), guanyem la mà.
        guaranteedG = wonFirstG || pardaFirstG;
      }
      if (guaranteedG) {
        const escalations = ["joc-fora", "quatre", "retruc"] as const;
        for (const what of escalations) {
          const act = actions.find((a) => a.type === "shout" && a.what === what);
          if (act) return act;
        }
        const vull = actions.find((a) => a.type === "shout" && a.what === "vull");
        if (vull) return vull;
      }
    }
  }
  // Regla absoluta: si l'equip que ha cantat el truc està a 1 punt de
  // tancar la cama (match point de cama), rebutjar el truc significa
  // donar-li el punt que necessita per guanyar la cama. Per tant, mai
  // dir "no vull": cal acceptar (vull) — o pujar si és legal i convé —
  // ja que només ganant la mà podem evitar perdre la cama.
  if (r.trucState.kind === "pending") {
    const callerTeam = teamOf(r.trucState.calledBy);
    const callerBones = m.scores[callerTeam].bones;
    const callerAtCamaMatchPoint = callerBones >= m.targetCama - 1;
    if (callerAtCamaMatchPoint) {
      const noVullIdx = actions.findIndex(
        (a) => a.type === "shout" && a.what === "no-vull",
      );
      if (noVullIdx >= 0) {
        const vull = actions.find(
          (a) => a.type === "shout" && a.what === "vull",
        );
        if (vull) return vull;
        const anyRaise = actions.find(
          (a) =>
            a.type === "shout" &&
            (a.what === "retruc" || a.what === "quatre" || a.what === "joc-fora"),
        );
        if (anyRaise) return anyRaise;
      }
    }
  }

  // Regla absoluta: 3a baza i sóc l'ÚLTIM en tirar (3 cartes ja a la
  // mesa). Si guanyaré la mà amb 100% de certesa (la meua carta
  // supera la mesa, o l'emparda i el meu equip ja va guanyar la 1a),
  // mai rebutjar el truc: sempre pujar si és legal, o "vull".
  if (r.trucState.kind === "pending" && r.tricks.length === 3) {
    const curT = r.tricks[2];
    if (curT && curT.cards.length === 3 && !curT.cards.some((tc) => tc.player === player)) {
      const tableBestT3 = curT.cards.reduce(
        (mx, tc) => Math.max(mx, cardStrength(tc.card)),
        -1,
      );
      const t1e = r.tricks[0];
      const wonFirstE =
        !!t1e &&
        t1e.parda !== true &&
        t1e.winner !== undefined &&
        teamOf(t1e.winner!) === myTeam;
      const canWinT3 = (hand as Card[]).some((c) => cardStrength(c) > tableBestT3);
      const canTieT3 = (hand as Card[]).some((c) => cardStrength(c) === tableBestT3);
      const guaranteedHandWin = canWinT3 || (canTieT3 && wonFirstE);
      if (guaranteedHandWin) {
        const escalations = ["joc-fora", "quatre", "retruc"] as const;
        for (const what of escalations) {
          const act = actions.find((a) => a.type === "shout" && a.what === what);
          if (act) return act;
        }
        const vull = actions.find((a) => a.type === "shout" && a.what === "vull");
        if (vull) return vull;
      }
    }
  }



  // Regla estricta: 3a baza, tinc un 3 i el meu equip NO ha guanyat la 1a.
  // No accepte ni pujue cap truc — sempre "No vull" si és possible.
  {
    const t1Guard = r.tricks[0];
    const lostFirstGuard =
      !!t1Guard &&
      t1Guard.parda !== true &&
      t1Guard.winner !== undefined &&
      teamOf(t1Guard.winner!) !== myTeam;
    if (
      r.tricks.length === 3 &&
      lostFirstGuard &&
      hand.some((c) => (c as any).rank === 3)
    ) {
      const noVull = actions.find(
        (a) => a.type === "shout" && a.what === "no-vull",
      );
      if (noVull) return noVull;
    }
  }

  // ---- Context tàctic avançat: posició, carta del company en mesa i
  //      possibilitat de "chafar" una carta top rival. Font: instrucció
  //      "Lógica avanzada de decisió de Truc/retruc".
  const partnerForCtx = ((player + 2) % 4) as PlayerId;
  const openTrickCtx = r.tricks[r.tricks.length - 1];
  const openTrickInProgress =
    !!openTrickCtx && openTrickCtx.winner === undefined;
  let iAmLastInOpenTrick = false;
  let partnerTopWinningOpenTrick = false;
  let canChafarOppTop = false;
  if (openTrickInProgress && openTrickCtx) {
    const alreadyPlayed = new Set(openTrickCtx.cards.map((tc) => tc.player));
    const remainingSeats = ([0, 1, 2, 3] as PlayerId[]).filter(
      (p) => !alreadyPlayed.has(p),
    );
    iAmLastInOpenTrick =
      remainingSeats.length === 1 && remainingSeats[0] === player;
    const partnerCardTC = openTrickCtx.cards.find(
      (tc) => tc.player === partnerForCtx,
    );
    if (partnerCardTC) {
      const partnerStr = cardStrength(partnerCardTC.card);
      const otherMaxStr = openTrickCtx.cards
        .filter((tc) => tc.player !== partnerForCtx)
        .reduce((mx, tc) => Math.max(mx, cardStrength(tc.card)), -1);
      // El company lidera la baza en curs amb una carta top (≥85).
      if (partnerStr >= otherMaxStr && partnerStr >= 85) {
        partnerTopWinningOpenTrick = true;
      }
    }
    const oppTopOnTable = openTrickCtx.cards.find(
      (tc) => teamOf(tc.player) !== myTeam && cardStrength(tc.card) >= 85,
    );
    if (oppTopOnTable) {
      const oppTopStr = cardStrength(oppTopOnTable.card);
      canChafarOppTop = (hand as Card[]).some(
        (c) => cardStrength(c) > oppTopStr,
      );
    }
  }

  // Inferència per senyals: si el company ja ha jugat la carta que promotia
  // (un 3 amb "Tinc un 3", o una top amb "Algo tinc"), degradem l'adviceBoost
  // — la promesa ja s'ha materialitzat i no s'aplica a les cartes restants.
  let partnerAdviceUsed = false;
  {
    const partnerPlayedCards: Card[] = [];
    for (const t of r.tricks) {
      for (const tc of t.cards) {
        if (tc.player === partnerForCtx) partnerPlayedCards.push(tc.card);
      }
    }
    if (partnerAdvice === "three") {
      if (partnerPlayedCards.some((c) => c.rank === 3)) partnerAdviceUsed = true;
    } else if (partnerAdvice === "strong") {
      if (partnerPlayedCards.some((c) => cardStrength(c) >= 85))
        partnerAdviceUsed = true;
    }
  }

  // ---- Regla estricta de seguretat: si el meu equip ha PERDUT la 1a baza,
  //      no acceptem cap truc sense una mà forta. Criteri obligatori:
  //      cal tenir com a mínim DUES cartes "Top" (força ≥ 85). Ara comptem
  //      també com a top efectiu la carta top del company que JA lidera la
  //      baza en curs (assegura el control d'aquesta baza).
  //      Un simple 3 (força 70) NO compta.
  {
    const t1Safety = r.tricks[0];
    const lostFirstSafety =
      !!t1Safety &&
      t1Safety.parda !== true &&
      t1Safety.winner !== undefined &&
      teamOf(t1Safety.winner!) !== myTeam;
    if (lostFirstSafety && r.trucState.kind === "pending") {
      const topTrucSafety = hand.filter(
        (c) => cardStrength(c as any) >= 85,
      ).length;
      const effectiveTopSafety =
        topTrucSafety + (partnerTopWinningOpenTrick ? 1 : 0);
      if (effectiveTopSafety < 2) {
        const noVullSafety = actions.find(
          (a) => a.type === "shout" && a.what === "no-vull",
        );
        if (noVullSafety) return noVullSafety;
      }
    }
  }


  // ---- OBLIGACIÓ: 3a baza i tinc la carta més alta de truc viva
  //      (cap carta de fora supera la meua millor) → guanye la baza segur
  //      i, per tant, la ronda. Si el rival ha trucat, he de pujar
  //      sempre que sigui legal; si no es pot pujar més, dir "vull".
  {
    const isThirdResp = r.tricks.length === 3;
    if (isThirdResp && hand.length > 0) {
      const playedIdsResp = new Set<string>();
      for (const t of r.tricks) for (const tc of t.cards) playedIdsResp.add(tc.card.id);
      const myIdsResp = new Set(hand.map((c) => (c as any).id));
      const outsideResp = buildDeck().filter(
        (c) => !playedIdsResp.has(c.id) && !myIdsResp.has(c.id),
      );
      const outsideMaxResp = outsideResp.length > 0
        ? Math.max(...outsideResp.map((c) => cardStrength(c)))
        : -1;
      const myBestResp = [...hand].sort(
        (a, b) => cardStrength(b as any) - cardStrength(a as any),
      )[0]!;
      const willWinThird = cardStrength(myBestResp as any) > outsideMaxResp;
      if (willWinThird) {
        const raiseForced = actions.find(
          (a) =>
            a.type === "shout" &&
            (a.what === "retruc" || a.what === "quatre" || a.what === "joc-fora"),
        );
        if (raiseForced) return raiseForced;
        const vullForced = actions.find(
          (a) => a.type === "shout" && a.what === "vull",
        );
        if (vullForced) return vullForced;
      }
    }
  }

  const myWinsSoFar = r.tricks.filter(t => t.winner !== undefined && teamOf(t.winner!) === myTeam).length;
  const oppWinsSoFar = r.tricks.filter(
    t => t.winner !== undefined && t.parda !== true && teamOf(t.winner!) !== myTeam,
  ).length;
  const topCards = hand.filter(c => cardStrength(c as any) >= 80).length;
  const goodCards = hand.filter(c => cardStrength(c as any) >= 60).length;
  // Cartes top de truc (les 4 més fortes, força ≥ 85): As espases (100),
  // As bastos (95), manilla d'espases (7 espases, 90), manilla d'oros
  // (7 oros, 85). Un 3 val 70.
  const topTrucCards = hand.filter(c => cardStrength(c as any) >= 85).length;
  const threes = hand.filter(c => (c as any).rank === 3).length;
  const adviceBoostRaw = (partnerAdvice === "strong" || partnerAdvice === "three") ? 25 : partnerAdvice === "weak" ? -20 : 0;
  // Si la carta promesa pel company ja s'ha jugat, la promesa no s'aplica
  // a la seua mà restant: degradem el bonus.
  const adviceBoost = partnerAdviceUsed ? Math.floor(adviceBoostRaw * 0.3) : adviceBoostRaw;
  // Bonus tàctics: carta top del company liderant la baza en curs +25;
  // ser l'últim en tirar amb possibilitat real de "chafar" una top rival +15.
  const partnerTopBonus = partnerTopWinningOpenTrick ? 25 : 0;
  const chafarBonus = iAmLastInOpenTrick && canChafarOppTop ? 15 : 0;
  const strength = avgStrength(hand) + myWinsSoFar * 30 + topCards * 15 + adviceBoost + partnerTopBonus + chafarBonus;
  const myEnvit = bestEnvit(hand as any);

  // Punts en joc segons el nivell del truc actual:
  //  - truc (2):     si vull = 2 pts, si no vull = 1 pt al rival
  //  - retruc (3):   si vull = 3 pts, si no vull = 2 pts al rival
  //  - quatre (4):   si vull = 4 pts, si no vull = 3 pts al rival
  //  - joc-fora (24): si vull = guanya tota la partida; si no vull = 4 pts
  const trucLevel = r.trucState.kind === "pending" ? r.trucState.level : 2;

  // Llindars segons el nivell: com més punts arrisques, més forta ha de ser
  // la mà per acceptar o pujar. strength típic: 30 (fluix) – 130+ (molt fort).
  let acceptStrength: number;
  let raiseStrength: number;
  if (trucLevel === 2) {        // truc → vull = 2 pts
    acceptStrength = 60;
    raiseStrength = 95;
  } else if (trucLevel === 3) { // retruc → vull = 3 pts
    acceptStrength = 75;
    raiseStrength = 105;
  } else if (trucLevel === 4) { // quatre val → vull = 4 pts
    acceptStrength = 90;
    raiseStrength = 120;
  } else {                       // joc-fora → vull = guanya tota la partida
    acceptStrength = 130;
    raiseStrength = 999;
  }

  // Apply profile-driven adjustments: a tighter human (low accept_threshold)
  // means our bluffs work — bot accepts with weaker hands too.
  acceptStrength = Math.max(30, acceptStrength + tuning.acceptThresholdDelta);
  raiseStrength = Math.max(60, raiseStrength + tuning.acceptThresholdDelta * 0.5);

  const canEnvit = actions.some(a => a.type === "shout" && a.what === "envit");
  if (canEnvit) {
    // Mode sincer (bluffRate === 0): contra-envit determinista. Només envida
    // si té possibilitats reals (≥31). Sense multiplicadors aleatoris.
    if (bluffRate === 0) {
      if (myEnvit >= 30) return { type: "shout", what: "envit" };
    } else {
    if (myEnvit >= 30 && Math.random() < 0.85 * tuning.callPropensity) return { type: "shout", what: "envit" };
    if (myEnvit >= 27 && Math.random() < 0.55 * tuning.callPropensity) return { type: "shout", what: "envit" };
    if (myEnvit >= 24 && Math.random() < 0.25 * tuning.callPropensity) return { type: "shout", what: "envit" };
    }
  }

  const raise = actions.find(a => a.type === "shout" && (a.what === "retruc" || a.what === "quatre" || a.what === "joc-fora"));
  const isRaiseJocFora = raise && raise.type === "shout" && raise.what === "joc-fora";

  // Cartes excel·lents.
  const hasBothTopAces =
    hand.some(c => c.rank === 1 && c.suit === "espases") &&
    hand.some(c => c.rank === 1 && c.suit === "bastos");

  // Mai pujar a "joc-fora" sense tindre la mà pràcticament guanyada.
  const canRaiseSafely = raise && (!isRaiseJocFora || (hasBothTopAces && myWinsSoFar >= 1));

  // ----- Regla dura: avaluació mínima de la mà segons el nivell -----
  // Si la mà no té cap carta de valor (cap 3 ni cap manilla), és gairebé
  // impossible guanyar el truc: cal rebutjar sempre, encara que el rival
  // canti truc nivell 2.
  // Calcula també les topTrucCards "efectives" (no jugades encara per cap rival
  // del meu equip, però simplificat: només les que jo tinc en mà).
  const hasAnyValuable = topTrucCards >= 1 || threes >= 1;

  // Si la mà no val res, mai acceptar pujades >= retruc.
  if (!hasAnyValuable && trucLevel >= 3) {
    return { type: "shout", what: "no-vull" };
  }
  // Per a un truc simple (nivell 2), si a més anem perdent la mà i no tenim
  // cap carta valuosa, també rebutgem.
  if (!hasAnyValuable && trucLevel === 2 && (oppWinsSoFar >= 1 || myWinsSoFar === 0)) {
    return { type: "shout", what: "no-vull" };
  }

  // Per a "joc-fora" cal una mà extraordinària: dos asos top o bé manilla +
  // baza ja guanyada. Sense això, rebutjar sempre.
  if (trucLevel === 24) {
    if (!hasBothTopAces && !(topTrucCards >= 1 && myWinsSoFar >= 1 && threes + topTrucCards >= 2)) {
      return { type: "shout", what: "no-vull" };
    }
  }

  // Per a "quatre van", exigim almenys una manilla o (3 + baza guanyada).
  if (trucLevel === 4) {
    if (topTrucCards === 0 && !(threes >= 1 && myWinsSoFar >= 1)) {
      return { type: "shout", what: "no-vull" };
    }
  }

  // Per a "retruc", exigim almenys un 3 o una manilla.
  if (trucLevel === 3 && topTrucCards === 0 && threes === 0) {
    return { type: "shout", what: "no-vull" };
  }

  // ----- Regla estricta d'acceptació de truc (nivell 2) -----
  // Per a acceptar el truc, es requereix una de les condicions següents:
  //   (A) Hem guanyat ≥1 baza I tinc com a mínim una carta top (≥85), o
  //       bé el meu company ja ha jugat una top en la baza en curs que
  //       lidera la mesa (assegura el control d'aquesta baza).
  //   (B) Tinc un 3 I estem en la 2a baza I el company m'ha confirmat
  //       força (partnerAdvice "three" o "strong") — SEMPRE que aquesta
  //       promesa NO s'haja gastat ja (partnerAdviceUsed).
  // Si cap es compleix, encara podem acceptar si la simulació Monte
  // Carlo dóna una probabilitat de guanyar el truc > 75 %.
  if (trucLevel === 2) {
    const inSecondTrickResp = r.tricks.length === 2;
    const partnerSaysGood = partnerAdvice === "three" || partnerAdvice === "strong";
    const effectiveTop = topTrucCards + (partnerTopWinningOpenTrick ? 1 : 0);
    const condA = myWinsSoFar >= 1 && effectiveTop >= 1;
    const condB = threes >= 1 && inSecondTrickResp && partnerSaysGood && !partnerAdviceUsed;
    if (!condA && !condB) {
      const winProb = estimateTrucWinProb(m, player, 300);
      if (winProb < 0.75) {
        const noVullAct = actions.find(
          (a) => a.type === "shout" && a.what === "no-vull",
        );
        if (noVullAct) return noVullAct;
      }
    }
  }


  // Regla dura: no pujar a retruc/quatre val si NO hem guanyat la 1a
  // baza, només em queda 1 carta (top o 3) i tampoc estem guanyant la 2a.
  let blockRaiseWeakHand = false;
  {
    const firstTrickResp = r.tricks[0];
    const wonFirstStrict =
      !!firstTrickResp && firstTrickResp.parda !== true &&
      firstTrickResp.winner !== undefined && teamOf(firstTrickResp.winner!) === myTeam;
    if (!wonFirstStrict && hand.length === 1) {
      const onlyCard = hand[0]!;
      const isTopOrThree =
        (onlyCard as any).rank === 3 ||
        ((onlyCard as any).rank === 7 && ((onlyCard as any).suit === "oros" || (onlyCard as any).suit === "espases")) ||
        ((onlyCard as any).rank === 1 && ((onlyCard as any).suit === "bastos" || (onlyCard as any).suit === "espases"));
      const secondTrickResp = r.tricks[1];
      let teamWinningSecond = false;
      if (secondTrickResp) {
        if (secondTrickResp.winner !== undefined && secondTrickResp.parda !== true) {
          teamWinningSecond = teamOf(secondTrickResp.winner!) === myTeam;
        } else if (secondTrickResp.cards.length > 0 && secondTrickResp.winner === undefined) {
          const leader = secondTrickResp.cards.reduce(
            (best, tc) =>
              best === null || cardStrength(tc.card as any) > cardStrength(best.card as any) ? tc : best,
            null as { player: PlayerId; card: Card } | null,
          );
          if (leader) teamWinningSecond = teamOf(leader.player) === myTeam;
        }
      }
      if (isTopOrThree && !teamWinningSecond) blockRaiseWeakHand = true;
    }
  }

  if (!blockRaiseWeakHand && canRaiseSafely && (hasBothTopAces || strength >= raiseStrength)) {
    return raise!;
  }
  if (!blockRaiseWeakHand && canRaiseSafely && topCards >= 2 && myWinsSoFar >= 1) {
    return raise!;
  }
  if (!blockRaiseWeakHand && canRaiseSafely && strength >= raiseStrength - 10 && Math.random() < 0.6) {
    return raise!;
  }

  // Si el rival ja ha guanyat alguna baza i la mà és fluixa, no acceptar
  // pujades cares: és tirar punts.
  if (oppWinsSoFar >= 1 && trucLevel >= 3 && strength < acceptStrength + 10) {
    return { type: "shout", what: "no-vull" };
  }

  if (strength >= acceptStrength) return { type: "shout", what: "vull" };
  if (myWinsSoFar >= 1 && goodCards >= 1 && trucLevel <= 3) return { type: "shout", what: "vull" };
  if (
    bluffRate > 0 &&
    strength >= acceptStrength - 10 &&
    trucLevel === 2 &&
    hasAnyValuable &&
    Math.random() < bluffRate * 2.5
  ) {
    return { type: "shout", what: "vull" };
  }
  if (partnerAdvice === "weak") return { type: "shout", what: "no-vull" };
  // Bluff residual només quan el cost és baix (truc nivell 2), tenim alguna
  // carta amb la qual defensar-nos i el perfil permet farolejar.
  if (
    bluffRate > 0 &&
    trucLevel === 2 &&
    hasAnyValuable &&
    Math.random() < bluffRate * tuning.bluffPropensity
  ) {
    return { type: "shout", what: "vull" };
  }
  return { type: "shout", what: "no-vull" };
}

function decideProactiveTruc(
  m: MatchState,
  player: PlayerId,
  hand: Array<{ suit: string; rank: number }>,
  handStrength: number,
  partnerAdvice: PartnerAdvice = "neutral",
  tuning: BotTuning = NEUTRAL_TUNING,
  bluffRate: number = 0,
  hints: BotHints = {},
): Action | null {
  const adviceBoost = (partnerAdvice === "strong" || partnerAdvice === "three") ? 20 : partnerAdvice === "weak" ? -15 : 0;
  handStrength = handStrength + adviceBoost;
  const r = m.round;
  const myTeam = teamOf(player);
  const oppTeam = myTeam === "nos" ? "ells" : "nos";

  const myWins = r.tricks.filter(t => t.winner !== undefined && teamOf(t.winner!) === myTeam).length;
  const oppWins = r.tricks.filter(t => t.winner !== undefined && teamOf(t.winner!) === oppTeam).length;

  // Cap baza encara resolta + cap carta jugada en la baza actual = inici
  // absolut de la ronda. En aquest punt NO té sentit cantar truc proactiu:
  // si tinc bones cartes, el millor és esperar que el rival truque per
  // poder retrucar i guanyar més pedres. "Truc i passe" en la 1a baza
  // pre-joc és una estratègia abusiva i dóna pocs punts.
  const currentTrick = r.tricks[r.tricks.length - 1];
  const noCardsPlayedYet =
    r.tricks.length === 1 && (!currentTrick || currentTrick.cards.length === 0);

  const topCards = hand.filter(c => cardStrength(c as any) >= 80).length;
  const goodCards = hand.filter(c => cardStrength(c as any) >= 60).length;
  // "Top de truc" segons l'usuari: manilla d'oros, manilla d'espases, As bastos, As espases.
  const hasTopTrucCard = hand.some(c =>
    (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
    (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")),
  );

  const myScoreObj = m.scores[myTeam];
  const oppScoreObj = m.scores[oppTeam];
  const myScore = Math.min(myScoreObj.males + myScoreObj.bones, 24);
  const oppScore = Math.min(oppScoreObj.males + oppScoreObj.bones, 24);
  const target = m.targetCama;
  const losingBig = oppScore - myScore >= 4;
  const winningBig = myScore - oppScore >= 4;
  const closeToWin = myScore >= target * 2 - 3;

  // Inici de la 1a baza: no truques mai proactivament excepte si vas
  // perdent molt i necessites punts ja (situació desesperada).
  if (noCardsPlayedYet && !losingBig) return null;

  // ---- Regla dura: no cantar truc/retruc/quatre val sense recolzament ----
  // Si NO hem guanyat la 1a baza, només em queda 1 carta i és top o 3, i
  // tampoc estem guanyant la 2a baza (cap baza guanyada per l'equip),
  // no cantem truc/retruc/quatre val: una sola carta forta no garanteix
  // res sense suport del company i sense bazas guanyades.
  {
    const firstTrick = r.tricks[0];
    const wonFirstStrict =
      !!firstTrick && firstTrick.parda !== true &&
      firstTrick.winner !== undefined && teamOf(firstTrick.winner!) === myTeam;
    if (!wonFirstStrict && hand.length === 1) {
      const onlyCard = hand[0]!;
      const isTopOrThree =
        onlyCard.rank === 3 ||
        (onlyCard.rank === 7 && (onlyCard.suit === "oros" || onlyCard.suit === "espases")) ||
        (onlyCard.rank === 1 && (onlyCard.suit === "bastos" || onlyCard.suit === "espases"));
      // L'equip "guanya la 2a baza" si la 2a baza s'ha resolt en favor
      // del meu equip (no parda i el winner és del meu equip), o bé,
      // si la 2a està en joc, el meu equip lidera la mesa actualment.
      const secondTrick = r.tricks[1];
      let teamWinningSecond = false;
      if (secondTrick) {
        if (secondTrick.winner !== undefined && secondTrick.parda !== true) {
          teamWinningSecond = teamOf(secondTrick.winner!) === myTeam;
        } else if (secondTrick.cards.length > 0 && secondTrick.winner === undefined) {
          const leader = secondTrick.cards.reduce(
            (best, tc) =>
              best === null || cardStrength(tc.card as any) > cardStrength(best.card as any) ? tc : best,
            null as { player: PlayerId; card: Card } | null,
          );
          if (leader) teamWinningSecond = teamOf(leader.player) === myTeam;
        }
      }
      if (!teamWinningSecond) return null;
    }
  }

  // ---- 2a baza: la 1a ha quedat PARDA ----
  // Si la 1a baza ha quedat empardada, qui guanye la 2a baza guanya el
  // truc d'aquesta mà. Per tant, si tinc cartes molt fortes a la mà i
  // encara no he tirat en la 2a baza, val la pena cantar truc abans:
  //   - As d'espases (força 100): truc OBLIGATORI (impossible perdre la 2a).
  //   - As de bastos (força 95):  truc molt probable (només el perd l'as d'espases).
  //   - 7 d'oros    (força 85):  truc opcional (encara pot ser superat per
  //     7 d'espases, As bastos o As espases).
  if (
    r.tricks.length === 2 &&
    r.tricks[0]?.parda === true &&
    currentTrick &&
    !currentTrick.cards.some((tc) => tc.player === player)
  ) {
    const hasAsEspases = hand.some((c) => c.rank === 1 && c.suit === "espases");
    const hasAsBastos = hand.some((c) => c.rank === 1 && c.suit === "bastos");
    const hasSetOros = hand.some((c) => c.rank === 7 && c.suit === "oros");
    const legal = legalActions(m, player);
    const trucActPard = legal.find(
      (a) => a.type === "shout" && a.what === "truc",
    );
    if (trucActPard && !hints.silentTruc) {
      let pTruc = 0;
      let trigger = "";
      if (hasAsEspases) {
        pTruc = 1;
        trigger = "2a-baza-parda-as-espases";
      } else if (hasAsBastos) {
        pTruc = 0.85;
        trigger = "2a-baza-parda-as-bastos";
      } else if (hasSetOros) {
        pTruc = 0.5;
        trigger = "2a-baza-parda-7-oros";
      }
      if (pTruc > 0) {
        pTruc *= tuning.callPropensity;
        if (Math.random() < pTruc) {
          // eslint-disable-next-line no-console
          console.log(
            `[bot truc 2a-baza-parda] p${player} truc trigger=${trigger} ` +
              `prob=${pTruc.toFixed(2)}`,
          );
          return trucActPard;
        }
      }
    }
  }





  // ---- Guarda 2a baza: hem PERDUT la 1a i NO tinc (3 + top) a la mà ----
  // Si el meu equip ha perdut la 1a baza i a la mà no em queden almenys
  // un 3 I una carta top (manilla d'oros, manilla d'espases, As bastos o
  // As espases), no canto truc proactivament en la 2a baza tret de:
  //   (A) Soc l'últim a tirar i el meu company ja guanya la 2a baza.
  //   (B) Puc guanyar la 2a baza tirant un 3 i encara em queda una carta
  //       top reservada per a la 3a.
  // En qualsevol altre cas, retorno null aquí mateix per evitar que la
  // resta de l'heurística canti truc en una situació clarament dolenta.
  if (r.tricks.length === 2) {
    const t0 = r.tricks[0];
    const lostFirst =
      !!t0 &&
      t0.parda !== true &&
      t0.winner !== undefined &&
      teamOf(t0.winner!) !== myTeam;
    if (lostFirst) {
      const isTopCard = (c: { suit: string; rank: number }) =>
        (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
        (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"));
      const hasThree = hand.some((c) => c.rank === 3);
      const hasTop = hand.some(isTopCard);
      const hasThreePlusTop = hasThree && hasTop;
      if (!hasThreePlusTop) {
        // Excepció (A): últim a tirar amb el company guanyant la mesa.
        let exceptionAllows = false;
        if (
          currentTrick &&
          currentTrick.cards.length === 3 &&
          !currentTrick.cards.some((tc) => tc.player === player)
        ) {
          const leader = currentTrick.cards.reduce(
            (best, tc) =>
              best === null || cardStrength(tc.card) > cardStrength(best.card) ? tc : best,
            null as { player: PlayerId; card: Card } | null,
          );
          if (leader && teamOf(leader.player) === myTeam) {
            exceptionAllows = true;
          }
        }
        // Excepció (B): puc guanyar la 2a amb un 3 i em queda una carta
        // top reservada per a la 3a baza. Només té sentit si encara tinc
        // 2 cartes (1 per la 2a, 1 per la 3a) i, amb el 3, supere la
        // millor carta ja jugada en la mesa.
        if (!exceptionAllows && hand.length >= 2 && hasThree && hasTop) {
          // Aquesta branca quedaria filtrada per `hasThreePlusTop`; la
          // deixe explícita perquè `lint` no es queixe i per claredat.
        }
        if (!exceptionAllows && hand.length >= 2 && hasThree) {
          // Comprova si en aquesta 2a baza, jugar un 3 guanyaria la mesa
          // (tenint en compte les cartes ja jugades pels rivals i el
          // company). Si sí, i a més em queda una carta top reservada,
          // permet trucar.
          const tableBest = currentTrick && currentTrick.cards.length > 0
            ? currentTrick.cards.reduce(
                (mx, tc) => Math.max(mx, cardStrength(tc.card)),
                -1,
              )
            : -1;
          // Un 3 té força 70: guanya si la millor de la mesa és <70.
          const threeWinsTable = tableBest < 70;
          const remainingTop = hand.some(isTopCard);
          if (threeWinsTable && remainingTop) {
            exceptionAllows = true;
          }
        }
        if (!exceptionAllows) return null;
      }
    }
  }

  // ---- 3a baza: últim de tots a tirar amb truc assegurat ----
  // Si soc l'últim dels 4 jugadors a tirar en la 3a baza (ja hi ha 3
  // cartes a la mesa), el meu equip ENCARA NO guanya el truc amb les
  // cartes jugades, i la meua carta:
  //   (a) supera la millor de la mesa -> guanyo la 3a baza, o
  //   (b) iguala la millor de la mesa -> faig parda la 3a baza,
  // llavors, si el resultat resultant del truc es victoria del meu equip,
  // canto truc DETERMINISTICAMENT abans de tirar (estic segur de
  // guanyar-lo, aixi que val la pena pujar la posta).
  if (
    r.tricks.length === 3 &&
    currentTrick &&
    currentTrick.cards.length === 3 &&
    !currentTrick.cards.some((tc) => tc.player === player) &&
    oppWins < 2 &&
    myWins < 2
  ) {
    const tableLeader = currentTrick.cards.reduce(
      (best, tc) =>
        best === null || cardStrength(tc.card) > cardStrength(best.card) ? tc : best,
      null as { player: PlayerId; card: Card } | null,
    );
    const tableBest = tableLeader ? cardStrength(tableLeader.card) : -1;
    const partnerWinsTable =
      tableLeader !== null && teamOf(tableLeader.player) === teamOf(player);

    const t0 = r.tricks[0]!;
    const t1 = r.tricks[1]!;
    const parda0 = t0.parda === true;
    const parda1 = t1.parda === true;
    const won0 = !parda0 && t0.winner !== undefined && teamOf(t0.winner!) === myTeam;
    const won1 = !parda1 && t1.winner !== undefined && teamOf(t1.winner!) === myTeam;

    // Guanya el meu equip el truc si la 3a te aquest resultat?
    const trucWinsForMyTeam = (outcome: "win" | "parda" | "loss"): boolean => {
      let myW = (won0 ? 1 : 0) + (won1 ? 1 : 0);
      let oppW =
        (!parda0 && t0.winner !== undefined && teamOf(t0.winner!) !== myTeam ? 1 : 0) +
        (!parda1 && t1.winner !== undefined && teamOf(t1.winner!) !== myTeam ? 1 : 0);
      const pardes = [parda0, parda1, false];
      if (outcome === "win") myW += 1;
      else if (outcome === "loss") oppW += 1;
      else pardes[2] = true;
      if (pardes[0] && pardes[1] && pardes[2]) return teamOf(r.mano) === myTeam;
      if (pardes[2] && myW === oppW) {
        if (parda0) return teamOf(r.mano) === myTeam;
        return won0;
      }
      if (!pardes[2]) {
        if (myW > oppW) return true;
        if (oppW > myW) return false;
        return teamOf(r.mano) === myTeam;
      }
      return false;
    };

    const myHandCards = r.hands[player] ?? [];
    if (myHandCards.length > 0) {
      const myBest = Math.max(...myHandCards.map((c) => cardStrength(c)));

      let outcome: "win" | "parda" | "loss";
      if (partnerWinsTable) outcome = "win";
      else if (myBest > tableBest) outcome = "win";
      else if (myBest === tableBest) outcome = "parda";
      else outcome = "loss";

      // "Encara no guanya el truc": si l'equip ja guanyes en el pitjor cas
      // (jo perdent la 3a), el truc ja esta fet i la regla no aplica.
      const teamAlreadyWinning = trucWinsForMyTeam("loss");

      if (!teamAlreadyWinning && (outcome === "win" || outcome === "parda")) {
        if (trucWinsForMyTeam(outcome)) {
          const legal = legalActions(m, player);
          // Limitació de seguretat: només pugem a retruc/quatre/joc-fora
          // si tenim certesa absoluta de guanyar la mà (outcome === "win",
          // no parda). Si no, ens limitem a cantar truc.
          const guaranteedWin = outcome === "win" && trucWinsForMyTeam("win");
          const escalation: Array<"truc" | "retruc" | "quatre" | "joc-fora"> =
            guaranteedWin
              ? ["truc", "retruc", "quatre", "joc-fora"]
              : ["truc"];
          let trucAct: Action | undefined;
          for (const w of escalation) {
            trucAct = legal.find((a) => a.type === "shout" && a.what === w);
            if (trucAct) break;
          }
          if (trucAct && !hints.silentTruc) {
            // Probabilitat 80% (abans determinista 100%): cantem truc abans
            // de tirar la carta guanyadora/parda en la 3a baza, però amb un
            // 20% de variabilitat per a no resultar mecànic.
            const p = 0.8;
            const decision = Math.random() < p ? "truc" : "passa";
            // eslint-disable-next-line no-console
            console.log(
              `[bot truc 3a-baza-determinista] p${player} ${decision} ` +
                `outcome=${outcome} myBest=${myBest} tableBest=${tableBest} ` +
                `won0=${won0} won1=${won1} parda0=${parda0} parda1=${parda1} ` +
                `guaranteedWin=${guaranteedWin} ` +
                `prob=${p.toFixed(2)}`,
            );
            if (decision === "truc") return trucAct;
          }
        }
      }
    }
  }


  // ---- 3a baza: truc oportunista amb carta guanyadora ----
  // Si estem a la 3a baza, el bot encara no ha jugat aquest torn, i el
  // resultat del truc encara no està decidit (no hem perdut 2 bazas), mira
  // si la millor carta de la mà és de les 1-2 més fortes que queden per
  // jugar (descomptant totes les cartes ja vistes a la mesa). Si és així,
  // val la pena cantar truc abans de tirar per intentar guanyar més pedres
  // — sabent que pot anar malament si el rival retruca i té una manilla
  // amagada superior.
  if (
    r.tricks.length === 3 &&
    currentTrick &&
    !currentTrick.cards.some(tc => tc.player === player) &&
    oppWins < 2 &&
    myWins < 2
  ) {
    // Identificadors únics de les cartes ja vistes a la mesa (en qualsevol
    // baza, incloses les jugades tapades — `cardStrength` no s'usa per a
    // identificar-les, sinó l'`id` propi de cada carta del deck). Així
    // evitem qualsevol error per cartes amb la mateixa força (ex: els 4
    // tres tenen força 70).
    const seenIds = new Set<string>();
    for (const t of r.tricks) {
      for (const tc of t.cards) {
        seenIds.add(tc.card.id);
      }
    }
    // Cartes a la mà del bot (queda 1 si ja ha jugat 2; aquí 1 normalment).
    const myHandCards = r.hands[player] ?? [];
    const myIds = new Set<string>(myHandCards.map((c) => c.id));
    const myStrengths = myHandCards.map((c) => cardStrength(c));
    const myBest = myStrengths.length > 0 ? Math.max(...myStrengths) : -1;

    // Reconstruïm el deck complet i en filtrem les vistes i les pròpies.
    // El que queda està repartit entre els altres 3 jugadors i és l'única
    // amenaça real per a la meua carta en aquesta baza.
    const fullDeck: Card[] = [];
    for (const suit of ["oros", "copes", "espases", "bastos"] as const) {
      for (const rank of [1, 3, 4, 5, 6, 7] as const) {
        if (rank === 1 && suit !== "espases" && suit !== "bastos") continue;
        fullDeck.push({ id: `${rank}-${suit}`, suit, rank });
      }
    }
    const remainingCards = fullDeck.filter(
      (c) => !seenIds.has(c.id) && !myIds.has(c.id),
    );

    // Invariant de seguretat: cap carta es pot perdre ni duplicar. Si
    // falla, considerem la situació "incoherent" i no apliquem l'heurística
    // (forcem strongerThanMe = ∞ perquè cap branca de cant s'activi).
    const invariantOk =
      seenIds.size + myIds.size + remainingCards.length === fullDeck.length;
    const strongerThanMe = invariantOk
      ? remainingCards.filter((c) => cardStrength(c) > myBest).length
      : Number.POSITIVE_INFINITY;

    // El meu equip ja porta avantatge de bazas? (1-0 a favor o 0-0)
    const winningTrickPosition = myWins >= oppWins;

    // Telemetria comuna a les dues branques de la 3a baza.
    const logTrucDecision = (
      trigger: string,
      probability: number,
      decision: "truc" | "passa",
    ) => {
      // eslint-disable-next-line no-console
      console.log(
        `[bot truc 3a-baza] p${player} ${decision} trigger=${trigger} ` +
          `strongerThanMe=${strongerThanMe} myWins=${myWins} oppWins=${oppWins} ` +
          `score=${myScore}-${oppScore} pos=${winningTrickPosition ? "ok" : "darrere"} ` +
          `prob=${probability.toFixed(2)}`,
      );
    };

    // Decidim segons quantes cartes em superen i la situació de partida.
    // strongerThanMe === 0 → la meua és la millor que queda: cant OBLIGATORI.
    // strongerThanMe === 1 → quasi-millor: truc selectiu.
    // strongerThanMe >= 2 → no tinc avantatge real: no truques per açò.
    if (strongerThanMe === 0) {
      // En l'última baza, si tinc la carta més alta de les que queden per
      // jugar, canto truc en un 80% dels casos abans de tirar-la (sempre
      // que siga legal i no estiga en mode silenci). El 20% restant
      // afegeix variabilitat per no resultar mecànic.
      const legal = legalActions(m, player);
      const trucAct = legal.find(
        (a) => a.type === "shout" && a.what === "truc",
      );
      if (trucAct && !hints.silentTruc) {
        const p = 0.8;
        const decision = Math.random() < p ? "truc" : "passa";
        logTrucDecision("3a-baza-millor", p, decision);
        if (decision === "truc") return trucAct;
      }
    }

    if (strongerThanMe === 1) {
      // Tinc la SEGONA carta més alta de les que queden per jugar. Aplica
      // la regla 80% només si la meua carta pot guanyar a totes les ja
      // jugades en aquesta 3a baza (o si el meu company ja les guanya,
      // cas en què igualment val la pena pujar la posta). Si encara no
      // hi ha cap carta a la mesa (sóc el primer de la baza), també
      // s'aplica perquè no puc perdre contra res ja vist.
      const ct = currentTrick;
      const tableCards = ct ? ct.cards : [];
      const myHandCards3 = r.hands[player] ?? [];
      const myBest3 = myHandCards3.length > 0
        ? Math.max(...myHandCards3.map((c) => cardStrength(c)))
        : -1;
      const tableLeader3 = tableCards.reduce(
        (best, tc) =>
          best === null || cardStrength(tc.card) > cardStrength(best.card) ? tc : best,
        null as { player: PlayerId; card: Card } | null,
      );
      const tableBest3 = tableLeader3 ? cardStrength(tableLeader3.card) : -1;
      const partnerWinsTable3 =
        tableLeader3 !== null && teamOf(tableLeader3.player) === teamOf(player);
      const beatsPlayed = tableCards.length === 0 || partnerWinsTable3 || myBest3 > tableBest3;

      if (beatsPlayed) {
        const legal = legalActions(m, player);
        const trucAct = legal.find(
          (a) => a.type === "shout" && a.what === "truc",
        );
        if (trucAct && !hints.silentTruc) {
          const p = 0.8;
          const decision = Math.random() < p ? "truc" : "passa";
          logTrucDecision("3a-baza-segona-millor-guanya-mesa", p, decision);
          if (decision === "truc") return trucAct;
        }
      } else {
        // Si no pot guanyar a les cartes ja jugades, manté l'heurística
        // anterior més conservadora.
        let p = winningTrickPosition ? 0.35 : 0.25;
        if (losingBig) p = winningTrickPosition ? 0.65 : 0.55;
        else if (closeToWin) p = winningTrickPosition ? 0.55 : 0.45;
        else if (winningBig) p = winningTrickPosition ? 0.15 : 0.1;
        p *= tuning.callPropensity;
        if (Math.random() < p) {
          logTrucDecision("3a-baza-quasi-millor", p, "truc");
          return { type: "shout", what: "truc" };
        }
        logTrucDecision("3a-baza-quasi-millor", p, "passa");
      }
      // Si no truca, segueix amb la lògica normal sota.
    }
  }

  // ---- 2a baza: últim a tirar (4t en l'ordre), el meu equip ja va 1-0 ----
  // Si soc l'últim a jugar la 2a baza, veig totes les cartes a la mesa,
  // el meu equip ja ha guanyat la 1a baza i podria:
  //   (a) guanyar la 2a ara amb la meua carta (tanco el truc 2-0), o
  //   (b) si el rival ja guanya la 2a, encara tinc una carta forta (≥80)
  //       per a la 3a baza i així imposar-me en la baza decisiva.
  // En tots dos casos, cantar truc abans de jugar és rendible: el rival
  // pot rebutjar (i ens emportem 1 pedra extra) o acceptar un truc que
  // tenim molt encarat.
  if (
    r.tricks.length === 2 &&
    currentTrick &&
    currentTrick.cards.length === 3 &&
    !currentTrick.cards.some(tc => tc.player === player) &&
    myWins >= 1 &&
    oppWins < 2
  ) {
    const myHand = r.hands[player] ?? [];
    const myBest = myHand.length > 0
      ? Math.max(...myHand.map((c) => cardStrength(c)))
      : -1;
    const tableBest = currentTrick.cards.reduce(
      (mx, tc) => Math.max(mx, cardStrength(tc.card)),
      -1,
    );
    const tableLeader = currentTrick.cards.reduce(
      (best, tc) =>
        best === null || cardStrength(tc.card) > cardStrength(best.card) ? tc : best,
      null as { player: PlayerId; card: Card } | null,
    );
    const partnerWinsTable =
      tableLeader !== null && teamOf(tableLeader.player) === teamOf(player);

    // Cas (a): puc guanyar la 2a → tanco el truc.
    const canWinNow = !partnerWinsTable && myBest > tableBest;
    // Cas (b): el rival guanya, però tinc reservada una carta forta per a
    // la 3a (només compta si en tinc 2 cartes encara —1 per la 2a, 1 per
    // la 3a— i l'altra és ≥80).
    let strongReserveFor3a = false;
    if (!canWinNow && myHand.length >= 2) {
      // Quina carta tirarem en la 2a? La més baixa per reservar la forta.
      const sortedHand = [...myHand].sort((a, b) => cardStrength(a) - cardStrength(b));
      const reserved = sortedHand[sortedHand.length - 1]!;
      strongReserveFor3a = cardStrength(reserved) >= 80;
    }

    if (canWinNow || strongReserveFor3a) {
      // Probabilitat de cantar truc segons cas i context.
      let p = canWinNow ? 0.7 : 0.4;
      if (losingBig) p += 0.15;
      else if (winningBig) p -= 0.25;
      if (closeToWin) p += 0.1;
      p = Math.max(0, Math.min(1, p * tuning.callPropensity));
      // Telemetria
      const probability = p;
      const decision: "truc" | "passa" = Math.random() < p ? "truc" : "passa";
      // eslint-disable-next-line no-console
      console.log(
        `[bot truc 2a-baza-4t] p${player} ${decision} ` +
          `canWinNow=${canWinNow} reserveFor3a=${strongReserveFor3a} ` +
          `myWins=${myWins} oppWins=${oppWins} score=${myScore}-${oppScore} ` +
          `prob=${probability.toFixed(2)}`,
      );
      if (decision === "truc") return { type: "shout", what: "truc" };
    }
  }

  // ---- Estratègia "trampa" de truc ----
  // Amb mà MOLT forta (>=2 tops, o tots dos asos), espera que truque el rival
  // per poder retrucar i guanyar més pedres. De tant en tant truca igualment
  // per a no ser predictible.
  const hasBothTopAces =
    hand.some(c => c.rank === 1 && c.suit === "espases") &&
    hand.some(c => c.rank === 1 && c.suit === "bastos");
  const veryStrongHand = topCards >= 2 || hasBothTopAces;

  if (veryStrongHand && !closeToWin) {
    // 80% espera (no truca), 20% truca per disfressar.
    // En mode honest, només si compleix la condició estricta (1a baza guanyada
    // o confirmació del company).
    if (bluffRate === 0) {
      const partnerStrong = (partnerAdvice === "strong" || partnerAdvice === "three");
      if (myWins < 1 && !partnerStrong) return null;
      // Sincer: amb mà molt forta, NORMALMENT espera que truque el rival
      // per poder retrucar i guanyar més punts. Només truca proactivament
      // si va perdent per molt (necessita punts ja) o si està a punt de
      // tancar la cama. Així no s'abusa del "Truc i passe".
      if (!losingBig) return null;
      return { type: "shout", what: "truc" };
    }
    if (Math.random() < 0.8) return null;
    return { type: "shout", what: "truc" };
  }

  // En mode honest (bluffRate === 0) només cantem truc si tenim una carta
  // forta de truc (manilla d'oros / manilla d'espases / As bastos / As
  // espases) i, a més, l'equip ja ha guanyat la 1a baza o el company ha
  // confirmat força. A més, per no abusar del "Truc i passe", només truca
  // proactivament en situacions clau (perdent per molt o a punt de tancar);
  // en cas contrari espera que truque el rival per poder retrucar.
  if (bluffRate === 0) {
    const partnerStrong = (partnerAdvice === "strong" || partnerAdvice === "three");
    if (!hasTopTrucCard) return null;
    if (myWins < 1 && !partnerStrong) return null;
    if (!losingBig && !closeToWin) return null;
    return { type: "shout", what: "truc" };
  }

  if (topCards >= 2 || (myWins >= 1 && handStrength > 75)) {
    if (Math.random() < 0.7 && !closeToWin) return null;
    return { type: "shout", what: "truc" };
  }

  if (handStrength > 70 || (myWins >= 1 && goodCards >= 2)) {
    const p = (losingBig ? 0.7 : 0.45) * tuning.callPropensity;
    if (Math.random() < p) return { type: "shout", what: "truc" };
    return null;
  }

  if (handStrength > 55 || (myWins >= 1 && goodCards >= 1)) {
    const p = (losingBig ? 0.35 : winningBig ? 0.1 : 0.2) * tuning.callPropensity;
    if (Math.random() < p) return { type: "shout", what: "truc" };
    return null;
  }

  if (bluffRate > 0 && oppWins === 0) {
    const p = (losingBig ? bluffRate * 1.2 : bluffRate * 0.5) * tuning.bluffPropensity;
    if (Math.random() < p) return { type: "shout", what: "truc" };
  }

  return null;
}

function choosePlayCard(
  m: MatchState,
  player: PlayerId,
  playActions: Extract<Action, { type: "play-card" }>[],
  partnerAdvice: PartnerAdvice = "neutral",
  playStrength: PlayStrengthHint = null,
  rivalShownStrength: boolean = false,
): Action {
  const r = m.round;
  const hand = r.hands[player];
  const trick = r.tricks[r.tricks.length - 1]!;
  const cards = playActions.map(a => hand.find(c => c.id === a.cardId)!).filter(Boolean);

  const sorted = [...cards].sort((a, b) => cardStrength(a) - cardStrength(b));
  const lowest = sorted[0]!;
  const highest = sorted[sorted.length - 1]!;
  const isTopTrucCard = (c: Card) =>
    (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
    (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"));

  // ---- REGLA: 2n de la parella + 2a baza + 1a guanyada + UNA sola
  // carta forta restant + rival ha jugat un 3 o una top que la meua
  // forta pot guanyar o empardar.
  // Comportament segons el que hagi contestat el company:
  //   · "No tinc res" (weak): tire la més alta (la carta forta).
  //   · "Tinc un tres" / "Algo tinc" (three/strong): tire la més alta
  //     EXCEPTE si és l'As d'Espases o la top més forta encara viva
  //     (cap rival ni jo l'hem jugada). En eixe cas reserve la
  //     dominant per a la 3a baza i tire l'altra (la més baixa).
  // Nota: el cant de TRUC abans de tirar quan el consell és
  // strong/three ja s'aplica al wrapper de botDecide.
  if (r.tricks.length === 2 && trick.cards.length >= 1 && cards.length >= 2) {
    const myTeamS = teamOf(player);
    const firstTrickS = r.tricks[0]!;
    const wonFirstS =
      firstTrickS.parda !== true &&
      firstTrickS.winner !== undefined &&
      teamOf(firstTrickS.winner!) === myTeamS;
    const partnerSeatS = ((player + 2) % 4) as PlayerId;
    const partnerPlayedHereS = trick.cards.some(
      (tc) => tc.player === partnerSeatS,
    );
    if (wonFirstS && partnerPlayedHereS) {
      const strongInHand = cards.filter(
        (c) => c.rank === 3 || isTopTrucCard(c),
      );
      const tableBestS = trick.cards.reduce(
        (mx, tc) => Math.max(mx, cardStrength(tc.card)),
        -1,
      );
      const tableHasThreeOrTop = trick.cards.some(
        (tc) => tc.card.rank === 3 || cardStrength(tc.card) >= 80,
      );
      const canBeatOrTie = cardStrength(highest) >= tableBestS;
      if (
        strongInHand.length === 1 &&
        tableHasThreeOrTop &&
        canBeatOrTie
      ) {
        const trucDecided =
          r.trucState.kind === "accepted" || r.trucState.kind === "rejected";
        if (partnerAdvice === "weak") {
          const matchHigh = playActions.find((a) => a.cardId === highest.id);
          if (matchHigh) return matchHigh;
        } else if (
          (partnerAdvice === "strong" || partnerAdvice === "three") &&
          trucDecided
        ) {
          // Calcula la top més forta que encara està viva (no jugada).
          const playedKeys = new Set<string>();
          for (const t of r.tricks) {
            for (const tc of t.cards) {
              playedKeys.add(`${tc.card.rank}-${tc.card.suit}`);
            }
          }
          const TOP_CARDS = [
            { rank: 1, suit: "espases" },
            { rank: 1, suit: "bastos" },
            { rank: 7, suit: "espases" },
            { rank: 7, suit: "oros" },
          ] as const;
          const aliveTopStrengths = TOP_CARDS.filter(
            (t) => !playedKeys.has(`${t.rank}-${t.suit}`),
          ).map((t) => cardStrength({ rank: t.rank, suit: t.suit } as Card));
          const highestAliveTopStr =
            aliveTopStrengths.length > 0 ? Math.max(...aliveTopStrengths) : -1;
          const highestIsAsEspases =
            highest.rank === 1 && highest.suit === "espases";
          const highestIsHighestAliveTop =
            cardStrength(highest) === highestAliveTopStr;
          if (highestIsAsEspases || highestIsHighestAliveTop) {
            const matchLow = playActions.find((a) => a.cardId === lowest.id);
            if (matchLow) return matchLow;
          }
          const matchHigh = playActions.find((a) => a.cardId === highest.id);
          if (matchHigh) return matchHigh;
        }
      }
    }
  }

  // ---- REGLA: 3r o 4t jugador en 1a baza SENSE tops ni 3s a la mà,
  // sent l'últim de la seua parella a tirar. Estratègia d'última posició:
  // si la meua carta més alta guanya o emparda la millor carta del rival
  // ja jugada, tire la MÉS ALTA per intentar endur-me la baza. Si ni la
  // meua millor pot igualar la del rival, descarte la MÉS BAIXA i guarde
  // les mediocres per a més avant.
  if (r.tricks.length === 1 && (trick.cards.length === 2 || trick.cards.length === 3)) {
    const myTeamNT = teamOf(player);
    const partnerAlreadyPlayed = trick.cards.some(
      (tc) => teamOf(tc.player) === myTeamNT && tc.player !== player,
    );
    // Per al 4t (3 cartes) el company sempre ha jugat; per al 3r només
    // apliquem la regla si el company ja ha jugat (som l'últim de la parella).
    if (trick.cards.length === 3 || partnerAlreadyPlayed) {
      const hasTopOrThree = cards.some(
        (c) => isTopTrucCard(c) || c.rank === 3,
      );
      if (!hasTopOrThree) {
        const rivalCardsNT = trick.cards.filter(
          (tc) => teamOf(tc.player) !== myTeamNT,
        );
        const rivalBestNT = rivalCardsNT.reduce(
          (mx, tc) => Math.max(mx, cardStrength(tc.card)),
          -1,
        );
        const pick = cardStrength(highest) >= rivalBestNT ? highest : lowest;
        const matchNT = playActions.find((a) => a.cardId === pick.id);
        if (matchNT) return matchNT;
      }
    }
  }

  // ---- REGLA PRINCIPAL (màxima prioritat): si soc l'ÚLTIM (4t) jugador
  // a tirar en la 1a baza, tinc l'OBLIGACIÓ absoluta de guanyar-la si
  // puc. Tira la carta MÉS BAIXA que supere la millor carta de la mesa.
  // Si cap carta meua guanya, prefereix deixar-la PARDA empatant amb la
  // mateixa força que la millor del rival; si tampoc puc empardar, tira
  // la més baixa. Aquesta regla té precedència sobre qualsevol altra.
  if (r.tricks.length === 1 && trick.cards.length === 3) {
    const tableBestStrFT = trick.cards.reduce(
      (mx, tc) => Math.max(mx, cardStrength(tc.card)),
      -1,
    );
    const winnersFT = sorted.filter((c) => cardStrength(c) > tableBestStrFT);
    if (winnersFT.length > 0) {
      const matchWinFT = playActions.find((a) => a.cardId === winnersFT[0]!.id);
      if (matchWinFT) return matchWinFT;
    }
    const tiersFT = sorted.filter((c) => cardStrength(c) === tableBestStrFT);
    if (tiersFT.length > 0) {
      const matchTieFT = playActions.find((a) => a.cardId === tiersFT[0]!.id);
      if (matchTieFT) return matchTieFT;
    }
    const matchLowFT = playActions.find((a) => a.cardId === lowest.id);
    if (matchLowFT) return matchLowFT;
  }

  // ---- REGLA PRINCIPAL (sempre): si cap de les meues cartes pot
  // GUANYAR (estrictament > ) la millor carta ja tirada en aquesta
  // baza, queda PROHIBIT desperdiciar una top o un 3 que ni guanya ni
  // emparda. Si el meu equip ja ha guanyat la 1a, i puc empardar la
  // baza actual, tire la carta més alta que emparda; si no, descarte
  // la més baixa que no siga top ni un 3 inútil. Aquesta regla té
  // precedència sobre qualsevol altra heurística posterior.
  if (trick.cards.length > 0) {
    const tableBestStrMain = trick.cards.reduce(
      (mx, tc) => Math.max(mx, cardStrength(tc.card)),
      -1,
    );
    const canBeatMain = cards.some((c) => cardStrength(c) > tableBestStrMain);
    if (!canBeatMain) {
      const myTeamMain = teamOf(player);
      const firstTrickMain = r.tricks[0];
      const teamWonFirstMain =
        !!firstTrickMain &&
        firstTrickMain.parda !== true &&
        firstTrickMain.winner !== undefined &&
        teamOf(firstTrickMain.winner!) === myTeamMain;
      if (teamWonFirstMain) {
        const pardaCards = sorted.filter((c) => cardStrength(c) === tableBestStrMain);
        const highestParda = pardaCards[pardaCards.length - 1];
        if (highestParda) {
          const matchPardaMain = playActions.find((a) => a.cardId === highestParda.id);
          if (matchPardaMain) return matchPardaMain;
        }
      }
      const safeDiscard = sorted.find(
        (c) => !isTopTrucCard(c) && !(c.rank === 3 && cardStrength(c) !== tableBestStrMain),
      );
      const fallback = safeDiscard ?? lowest;
      const matchLowMain = playActions.find((a) => a.cardId === fallback.id);
      if (matchLowMain) return matchLowMain;
    }
  }

  // ---- REGLA PRINCIPAL (sempre): si sóc l'ÚLTIM a tirar en la 1a o
  // la 2a baza i el meu COMPANY ja guanya la baza (la seua carta és
  // estrictament la millor a la mesa), tire OBLIGATÒRIAMENT la més
  // baixa. No té sentit cremar cartes bones quan el company ja guanya.
  if (trick.cards.length === 3 && r.tricks.length <= 2) {
    const myTeamLast = teamOf(player);
    const tableLeader = trick.cards.reduce(
      (best, tc) =>
        best === null || cardStrength(tc.card) > cardStrength(best.card)
          ? tc
          : best,
      null as { player: PlayerId; card: Card } | null,
    );
    if (tableLeader && teamOf(tableLeader.player) === myTeamLast) {
      // Comprovar que cap rival empata la millor carta (en cas d'empat
      // amb un rival, la baza no està guanyada pel company).
      const tableBestStrLast = cardStrength(tableLeader.card);
      const rivalTies = trick.cards.some(
        (tc) =>
          teamOf(tc.player) !== myTeamLast &&
          cardStrength(tc.card) === tableBestStrLast,
      );
      // Excepció: si el company guanya amb un 3, el bot NO té prohibit
      // jugar una carta que supere la del company. En eixe cas, eixim
      // d'aquesta regla i deixem que la lògica posterior decidisca.
      const partnerWinsWithThree = tableLeader.card.rank === 3;
      if (!rivalTies && !partnerWinsWithThree) {
        const matchLowLast = playActions.find((a) => a.cardId === lowest.id);
        if (matchLowLast) return matchLowLast;
      }
    }
  }

  // ---- REGLA: 2n de la parella + 3r a tirar en la 1a baza ----
  // Si soc el 2n del meu equip a tirar (3r jugador en la baza) en la 1a
  // baza, l'obligació de tirar una carta top o, en defecte, un 3 NOMÉS
  // s'aplica si eixa carta GUANYA o EMPARDA la millor carta ja jugada
  // i el meu company NO està ja guanyant la baza amb almenys un 3.
  // En cas contrari (cap top/3 guanya o emparda, o el company ja guanya
  // la baza amb ≥3), tire OBLIGATÒRIAMENT la més baixa.
  // Excepció: si la baza està parda amb un 3 i jo tinc l'As d'Espases,
  // també tire la més baixa (reserve l'As d'Espases).
  if (r.tricks.length === 1 && trick.cards.length === 2) {
    const myTeam2P = teamOf(player);
    const partnerCard2P = trick.cards.find(
      (tc) => teamOf(tc.player) === myTeam2P && tc.player !== player && !tc.covered,
    );
    if (partnerCard2P) {
      const isTopCard2P = (c: Card) =>
        (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
        (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"));
      const tableBest2P = trick.cards.reduce(
        (mx, tc) => Math.max(mx, cardStrength(tc.card)),
        -1,
      );
      // El company ja guanya la baza estrictament i amb almenys un 3?
      const partnerIsLeader =
        cardStrength(partnerCard2P.card) === tableBest2P;
      const partnerLeadsWithThreeOrTop =
        partnerIsLeader &&
        (partnerCard2P.card.rank === 3 || isTopCard2P(partnerCard2P.card));
      // Excepció parda amb un 3 + As d'Espases a la mà.
      const tableTopIsThree = trick.cards.some(
        (tc) => cardStrength(tc.card) === tableBest2P && tc.card.rank === 3,
      );
      const hasAsEspases = cards.some(
        (c) => c.rank === 1 && c.suit === "espases",
      );
      const skipForAsEspases = tableTopIsThree && hasAsEspases;

      if (partnerLeadsWithThreeOrTop || skipForAsEspases) {
        // Company ja guanya amb ≥3, o reservem As d'Espases: la més baixa.
        const matchLow = playActions.find((a) => a.cardId === lowest.id);
        if (matchLow) return matchLow;
      } else {
        // Tops meus que GUANYEN o EMPARDEN: la més baixa d'eixes.
        const topsWinOrTie = cards
          .filter((c) => isTopCard2P(c) && cardStrength(c) >= tableBest2P)
          .sort((a, b) => cardStrength(a) - cardStrength(b));
        if (topsWinOrTie.length > 0) {
          const pick = topsWinOrTie[0]!;
          const matchAct = playActions.find((a) => a.cardId === pick.id);
          if (matchAct) return matchAct;
        }
        // En defecte, un 3 que GUANYE o EMPARDE.
        const threesWinOrTie = cards
          .filter((c) => c.rank === 3 && cardStrength(c) >= tableBest2P)
          .sort((a, b) => cardStrength(a) - cardStrength(b));
        if (threesWinOrTie.length > 0) {
          const pick = threesWinOrTie[0]!;
          const matchAct = playActions.find((a) => a.cardId === pick.id);
          if (matchAct) return matchAct;
        }
        // Cap top ni 3 que guanye o emparde: la més baixa OBLIGATÒRIAMENT.
        const matchLow = playActions.find((a) => a.cardId === lowest.id);
        if (matchLow) return matchLow;
      }
    }
  }

  // ---- REGLA: 4t (últim) a tirar en la 1a baza ----
  // Si soc l'últim a jugar la 1a baza i tinc cartes INFERIORS (no top,
  // no 3) que GUANYEN la millor de la mesa, tire la més baixa d'eixes.
  // No cal cremar una top o un 3 si una carta menor ja guanya la baza;
  // així reserve les top/3 per a bazas posteriors.
  if (r.tricks.length === 1 && trick.cards.length === 3) {
    const tableBest4 = trick.cards.reduce(
      (mx, tc) => Math.max(mx, cardStrength(tc.card)),
      -1,
    );
    const isTopCard4 = (c: Card) =>
      (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
      (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"));
    const lowWinners4 = cards
      .filter(
        (c) => !isTopCard4(c) && c.rank !== 3 && cardStrength(c) > tableBest4,
      )
      .sort((a, b) => cardStrength(a) - cardStrength(b));
    if (lowWinners4.length > 0) {
      const pick = lowWinners4[0]!;
      const matchAct = playActions.find((a) => a.cardId === pick.id);
      if (matchAct) return matchAct;
    }
  }

  // ---- REGLA PRINCIPAL: 2n de la parella en la 2a baza, equip ja ha
  // guanyat la 1a baza. Si no em queda ni cap 3 ni cap carta top,
  // OBLIGATÒRIAMENT he de tirar la meua carta més alta sempre que
  // siga estrictament major que la del meu company. Si la més alta
  // no supera la del company, no apliquem aquesta regla.
  if (r.tricks.length === 2 && trick.cards.length >= 1) {
    const myTeam2T = teamOf(player);
    const firstTrick = r.tricks[0]!;
    const teamWonFirst =
      firstTrick.winner !== undefined && teamOf(firstTrick.winner) === myTeam2T;
    if (teamWonFirst) {
      const partnerCard2T = trick.cards.find(
        (tc) => teamOf(tc.player) === myTeam2T && tc.player !== player && !tc.covered,
      );
      if (partnerCard2T) {
        const isTopCard2T = (c: Card) =>
          (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
          (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"));
        const hasThreeOrTop = cards.some(
          (c) => c.rank === 3 || isTopCard2T(c),
        );
        if (!hasThreeOrTop) {
          if (cardStrength(highest) > cardStrength(partnerCard2T.card)) {
            const matchHigh2T = playActions.find((a) => a.cardId === highest.id);
            if (matchHigh2T) return matchHigh2T;
          }
        }
      }
    }
  }

  // ---- Regla: primer de la pareja a tirar amb cap carta ≥ 3 ----
  // Si el meu company encara no ha jugat en aquesta baza i totes les
  // meues cartes són estrictament menors que un 3 (cap 3, cap top
  // card; força màxima < 70), no té sentit cremar la més alta intentant
  // guanyar — sempre tira la més baixa per reservar les "mitjanes" per
  // a bazas posteriors.
  {
    const myTeamFirst = teamOf(player);
    const partnerHasPlayedHere = trick.cards.some(
      (tc) => teamOf(tc.player) === myTeamFirst && tc.player !== player,
    );
    if (!partnerHasPlayedHere) {
      const maxStr = cardStrength(highest);
      if (maxStr < 70) {
        return { type: "play-card", cardId: lowest.id };
      }
    }
  }

  // ---- Regla: 1r de la parella + ja hi ha un 3 a la mesa + company "Tinc un 3" ----
  // Si soc el primer del meu equip a tirar en la baza actual, el company
  // ha dit "Tinc un 3" (partnerAdvice === "three") i a la mesa ja hi ha
  // alguna carta de rang 3 jugada, OBLIGATÒRIAMENT he de tirar una
  // carta top (manilla d'oros, manilla d'espases, As bastos o As
  // espases). Excepció: si tinc l'As d'espases, juga la carta MÉS BAIXA
  // de la mà (reservar l'as).
  {
    const myTeamT3X = teamOf(player);
    const partnerPlayedT3X = trick.cards.some(
      (tc) => teamOf(tc.player) === myTeamT3X && tc.player !== player,
    );
    const threeOnTable = trick.cards.some((tc) => tc.card.rank === 3);
    if (!partnerPlayedT3X && partnerAdvice === "three" && threeOnTable) {
      const isTopX = (c: Card) =>
        (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
        (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"));
      const hasAsEspases = cards.some((c) => c.rank === 1 && c.suit === "espases");
      if (hasAsEspases) {
        const matchLow = playActions.find((a) => a.cardId === lowest.id);
        if (matchLow) return matchLow;
      } else {
        const tops = cards
          .filter(isTopX)
          .sort((a, b) => cardStrength(a) - cardStrength(b));
        if (tops.length > 0) {
          const pick = tops[0]!;
          const matchAct = playActions.find((a) => a.cardId === pick.id);
          if (matchAct) return matchAct;
        }
      }
    }
  }

  // ---- Regla: 1r de la parella en la 1a baza + company ha dit "Tinc un 3" ----
  // Si soc el primer del meu equip a tirar en la primera baza i el company
  // ha respost "Tinc un 3" (partnerAdvice === "three"), i jo tinc l'As
  // d'espases o l'As de bastos, juga'l en un 80% de les vegades
  // (prioritzant l'As d'espases si en tinc tots dos). En el 20% restant,
  // continua amb la lògica normal.
  {
    const isFirstTrickT3 = r.tricks.length === 1;
    const myTeamT3 = teamOf(player);
    const partnerPlayedT3 = trick.cards.some(
      (tc) => teamOf(tc.player) === myTeamT3 && tc.player !== player,
    );
    if (isFirstTrickT3 && !partnerPlayedT3 && partnerAdvice === "three") {
      const asEspases = cards.find((c) => c.rank === 1 && c.suit === "espases");
      const asBastos = cards.find((c) => c.rank === 1 && c.suit === "bastos");
      const pick = asEspases ?? asBastos;
      if (pick && Math.random() < 0.8) {
        const matchAct = playActions.find((a) => a.cardId === pick.id);
        if (matchAct) return matchAct;
      }
    }
  }

  // ---- Regla: 1r de la parella en la 1a baza + company "Tinc un 3" + 2 cartes top ----
  // Si soc el primer del meu equip a tirar en la 1a baza, el company ha
  // dit "Tinc un 3" (partnerAdvice === "three") i jo tinc 2 o més cartes
  // "top" (manilla d'oros, manilla d'espases, As bastos, As espases),
  // OBLIGATÒRIAMENT he de tirar la més alta. Així em quede 1 top + el
  // 3 del company per a les 2 bazas restants.
  {
    const isFirstTrickTop2 = r.tricks.length === 1;
    const myTeamTop2 = teamOf(player);
    const partnerPlayedTop2 = trick.cards.some(
      (tc) => teamOf(tc.player) === myTeamTop2 && tc.player !== player,
    );
    const iAmFirstToPlayTop2 = trick.cards.length === 0;
    if (
      isFirstTrickTop2 &&
      iAmFirstToPlayTop2 &&
      !partnerPlayedTop2 &&
      partnerAdvice === "three"
    ) {
      const isTop = (c: Card) =>
        (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
        (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"));
      const tops = cards.filter(isTop);
      if (tops.length >= 2) {
        const topHighest = [...tops].sort((a, b) => cardStrength(b) - cardStrength(a))[0]!;
        const matchAct = playActions.find((a) => a.cardId === topHighest.id);
        if (matchAct) return matchAct;
      }
    }
  }

  // ---- Regla "company guanya amb la 2a més alta i jo tinc la més alta" ----
  // Si el meu equip ja ha guanyat alguna baza anterior, el meu company
  // ja ha jugat en la baza actual i la seua carta és la 2a més alta
  // d'entre totes les cartes que encara queden en joc (mans restants +
  // cartes ja jugades en aquesta baza), i jo tinc la MÉS ALTA, llavors
  // sé del cert que el rival que falta (si en falta) no pot superar el
  // company. En aquest cas puc o bé jugar TAPADA la meua carta més
  // alta (per gastar-la sense revelar), o bé jugar una carta diferent
  // de la més alta (reservant-la). Aleatori 50/50.
  {
    const myTeam = teamOf(player);
    const wonAnyPrevTrick = r.tricks.slice(0, -1).some(
      (t) => t.parda !== true && t.winner !== undefined && teamOf(t.winner!) === myTeam,
    );
    const partnerCardInTrick = trick.cards.find(
      (tc) => teamOf(tc.player) === myTeam && tc.player !== player && !tc.covered,
    );
    if (wonAnyPrevTrick && partnerCardInTrick && cards.length >= 2) {
      // Conjunt de cartes "vives": cartes a totes les mans restants +
      // cartes jugades en aquesta baza (descobertes).
      const liveCards: Card[] = [];
      for (const pid of [0, 1, 2, 3] as PlayerId[]) {
        for (const c of r.hands[pid]) liveCards.push(c);
      }
      for (const tc of trick.cards) {
        if (!tc.covered) liveCards.push(tc.card);
      }
      const liveSorted = [...liveCards].sort(
        (a, b) => cardStrength(b) - cardStrength(a),
      );
      const top1 = liveSorted[0];
      const top2 = liveSorted[1];
      const partnerCard = partnerCardInTrick.card;
      const myHighestStr = cardStrength(highest);
      if (
        top1 && top2 &&
        myHighestStr === cardStrength(top1) &&
        cardStrength(partnerCard) === cardStrength(top2) &&
        cardStrength(top1) > cardStrength(top2)
      ) {
        const isTopCard = (c: Card) =>
          (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
          (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"));
        const topCount = hand.filter(isTopCard).length;
        const firstTrick = r.tricks[0];
        const wonFirstTrick =
          !!firstTrick &&
          firstTrick.parda !== true &&
          firstTrick.winner !== undefined &&
          teamOf(firstTrick.winner!) === myTeam;
        // Tapar només una carta top està permès quan en queden ≥2 i ja
        // s'ha guanyat la 1a baza. En qualsevol altre cas, mai tapem una
        // carta top. Si tapem (cas no obligatori), la carta tapada ha de
        // ser SEMPRE la més baixa de la mà.
        const canCoverTop = topCount >= 2 && wonFirstTrick;
        const lowestIsTop = isTopCard(lowest);
        const allowCover = !lowestIsTop || canCoverTop;
        const playNonHighest = !allowCover || Math.random() < 0.5;
        if (playNonHighest) {
          const others = sorted.filter((c) => c.id !== highest.id);
          const pick = others[0] ?? lowest;
          const matchAct = playActions.find((a) => a.cardId === pick.id);
          if (matchAct) return matchAct;
        }
        // Alternativa: tapar la carta MÉS BAIXA (no la més alta).
        if (allowCover) {
          const matchLow = playActions.find((a) => a.cardId === lowest.id);
          if (matchLow) return { type: "play-card", cardId: lowest.id, covered: true };
        }
      }
    }
  }

  // Regla universal: si sóc l'últim dels 4 jugadors a tirar en aquesta
  // baza i el meu company ja la guanya, no té cap sentit cremar una
  // carta bona. Tira sempre la més baixa per reservar les fortes per a
  // bazas posteriors.
  if (trick.cards.length === 3) {
    const tableLeader = trick.cards.reduce(
      (best, tc) =>
        best === null || cardStrength(tc.card) > cardStrength(best.card) ? tc : best,
      null as { player: PlayerId; card: Card } | null,
    );
    if (tableLeader && teamOf(tableLeader.player) === teamOf(player)) {
      // Excepció: si el company guanya amb un 3, NO forcem la més baixa;
      // el bot pot legítimament superar el 3 amb una carta més forta.
      if (tableLeader.card.rank !== 3) {
        return { type: "play-card", cardId: lowest.id };
      }
    }
    // Rival guanya la mesa: si tinc alguna carta que la supere, juga
    // SEMPRE la més baixa de les que guanyen. Si no en tinc cap però en
    // la 1a baza puc empatar (parda) amb una carta de la mateixa força
    // (típicament un 3 si el rival ha tret un 3), tira eixa carta —
    // millor parda que perdre la 1a baza per res.
    if (tableLeader) {
      const tableBest = cardStrength(tableLeader.card);
      const winners = sorted.filter((c) => cardStrength(c) > tableBest);
      if (winners.length > 0) {
        // En la 1a baza: preferència per top (≥ 80) abans que un 3, per
        // reservar el 3 per a la 3a. Si hi ha 2 o més tops guanyadors,
        // juga la MÉS ALTA d'eixes top (a diferència de la 2a baza, on
        // es juga la més baixa). Si cap top guanya, juga la més baixa.
        if (r.tricks.length === 1) {
          const winningTops = winners.filter((c) => cardStrength(c) >= 80);
          if (winningTops.length > 0) {
            const highestTop = winningTops[winningTops.length - 1]!;
            return { type: "play-card", cardId: highestTop.id };
          }
        }
        return { type: "play-card", cardId: winners[0]!.id };
      }
      if (r.tricks.length === 1) {
        const tiers = sorted.filter((c) => cardStrength(c) === tableBest);
        if (tiers.length > 0) {
          return { type: "play-card", cardId: tiers[0]!.id };
        }
      }
      return { type: "play-card", cardId: lowest.id };
    }
  }

  // ---- Obligació: si hem PERDUT la 1a baza i estem a la 2a, en posició
  // de 3r o 4t a tirar (ja hi ha 2 o 3 cartes a la mesa), guanyar la
  // baza és obligatori si és possible. Tira la carta MÉS BAIXA que
  // supere la millor carta jugada a la mesa. Aquesta regla té prioritat
  // sobre qualsevol compromís ("vine a mi", "tinc un tres", reservar
  // manilles, etc.) perquè perdre la 2a baza després d'haver perdut la
  // 1a significa perdre el truc directament.
  {
    const myTeam = teamOf(player);
    const firstT = r.tricks[0];
    const lostFirst =
      !!firstT &&
      firstT.parda !== true &&
      firstT.winner !== undefined &&
      teamOf(firstT.winner!) !== myTeam;
    if (
      lostFirst &&
      r.tricks.length === 2 &&
      (trick.cards.length === 2 || trick.cards.length === 3)
    ) {
      const tableBest = trick.cards.reduce(
        (mx, tc) => Math.max(mx, cardStrength(tc.card)),
        -1,
      );
      const tableBestPlayer = trick.cards.reduce(
        (best, tc) =>
          best === null || cardStrength(tc.card) > cardStrength(best.card)
            ? tc
            : best,
        null as { player: PlayerId; card: Card } | null,
      );
      const partnerWinsTable =
        tableBestPlayer !== null && teamOf(tableBestPlayer.player) === myTeam;
      // Excepció: si el company guanya amb un 3, no forcem la més baixa
      // — el bot pot superar el 3 amb una carta millor si li convé.
      if (
        trick.cards.length === 3 &&
        partnerWinsTable &&
        tableBestPlayer!.card.rank !== 3
      ) {
        return { type: "play-card", cardId: lowest.id };
      }
      const winners = sorted.filter((c) => cardStrength(c) > tableBest);
      if (winners.length > 0) {
        // Preferència: si entre les cartes guanyadores n'hi ha alguna
        // "top" (manilla d'oros, manilla d'espases, As bastos o As
        // espases — força ≥ 80), juga'n una en lloc d'un 3, per
        // reservar el 3 per a la 3a baza. Si en tinc 2 o més top que
        // guanyen, juga la MÉS BAIXA de les top. Si cap top guanya,
        // juga la carta guanyadora més baixa (típicament el 3).
        const winningTops = winners.filter((c) => cardStrength(c) >= 80);
        if (winningTops.length > 0) {
          return { type: "play-card", cardId: winningTops[0]!.id };
        }
        return { type: "play-card", cardId: winners[0]!.id };
      }
      return { type: "play-card", cardId: lowest.id };
    }
  }

  // ---- Obligació: si hem GUANYAT la 1a baza i estem a la 2a, en posició
  // de 3r a tirar (ja hi ha 2 cartes a la mesa), si tinc un 3 que supera
  // la millor carta jugada, juga'l SEMPRE — encara que tinga una carta
  // inferior que també guanyaria. Així assegurem la baza amb la carta
  // més forta possible (un 3) i evitem que el 4t rival ens supere amb
  // una carta intermèdia. Aquesta regla té prioritat sobre compromisos
  // de company ("vine a mi", "tinc un tres") i sobre la lògica de
  // reservar manilles, perquè guanyar la 2a baza després d'haver guanyat
  // la 1a tanca el truc immediatament.
  {
    const myTeam2 = teamOf(player);
    const firstT2 = r.tricks[0];
    const wonFirst2 =
      !!firstT2 &&
      firstT2.parda !== true &&
      firstT2.winner !== undefined &&
      teamOf(firstT2.winner!) === myTeam2;
    if (
      wonFirst2 &&
      r.tricks.length === 2 &&
      trick.cards.length === 2
    ) {
      const tableBest2 = trick.cards.reduce(
        (mx, tc) => Math.max(mx, cardStrength(tc.card)),
        -1,
      );
      const tableBestPlayer2 = trick.cards.reduce(
        (best, tc) =>
          best === null || cardStrength(tc.card) > cardStrength(best.card)
            ? tc
            : best,
        null as { player: PlayerId; card: Card } | null,
      );
      const partnerWinsTable2 =
        tableBestPlayer2 !== null && teamOf(tableBestPlayer2.player) === myTeam2;
      if (!partnerWinsTable2) {
        const winningThree2 = sorted.find(
          (c) => c.rank === 3 && cardStrength(c) > tableBest2,
        );
        if (winningThree2) {
          const matchAct = playActions.find((a) => a.cardId === winningThree2.id);
          if (matchAct) return matchAct;
        }
        // Cap 3 guanya la mesa, però en tinc algun → tira'l igualment
        // ara: l'ordre és NO guardar-se el 3 per a la 3a baza. Si en
        // tinc més d'un, tire el més baix per economitzar (el cas
        // "winning three" ja s'ha cobert dalt amb el 3 que guanya).
        const myThreesHere = sorted.filter((c) => c.rank === 3);
        if (myThreesHere.length > 0) {
          const lowestThree = myThreesHere[0]!;
          const matchAct = playActions.find((a) => a.cardId === lowestThree.id);
          if (matchAct) return matchAct;
        }
        // Sense 3 que guanye ni cap carta top a la mà: tira la més alta
        // per intentar guanyar (o almenys empardar) la 2a baza. Excepció:
        // si tinc el 6 i el 7 de bastos (o el 6 i el 7 de copes), juga
        // el 6 per empardar amb el 6 si ho aconsegueix; en cas contrari
        // continua amb la més alta.
        const isTopCardR = (c: Card) =>
          (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
          (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"));
        const hasTop = hand.some(isTopCardR);
        const hasThree = hand.some((c) => c.rank === 3);
        if (!hasTop && !hasThree) {
          for (const suit of ["bastos", "copes"] as const) {
            const six = sorted.find((c) => c.rank === 6 && c.suit === suit);
            const seven = sorted.find((c) => c.rank === 7 && c.suit === suit);
            if (six && seven && cardStrength(six) >= tableBest2) {
              const matchSix = playActions.find((a) => a.cardId === six.id);
              if (matchSix) return matchSix;
            }
          }
          // Tira la més alta NOMÉS si guanya (o emparda) la millor carta
          // ja jugada en aquesta baza. En cas contrari no té sentit
          // cremar-la — guarda-la per a la 3a baza i tira la més baixa.
          if (cardStrength(highest) >= tableBest2) {
            const matchHigh = playActions.find((a) => a.cardId === highest.id);
            if (matchHigh) return matchHigh;
          } else {
            const matchLow = playActions.find((a) => a.cardId === lowest.id);
            if (matchLow) return matchLow;
          }
        }
      }
    }
  }

  // Pista directa de força del company humà via chat.
  // "low"  → tira la carta més baixa (l'humà cobreix amb una bona).
  // "high" → tira la carta més alta (l'humà no té res, salva tu la baza).
  // "free" → segueix amb la lògica normal (no força res).
  // "vine-a-vore" → el bot mateix s'ha compromés a tindre 7 d'oros o un 3:
  //   ha de jugar eixa carta si guanya la mesa, sino guardar-la i tirar
  //   la més baixa. Excepció: totes les cartes de la mesa són < 3 (str<70)
  //   i cap rival ha mostrat força → pot reservar el 7 d'oros i tirar el 3.
  if (playStrength === "low") {
    return { type: "play-card", cardId: lowest.id };
  }
  if (playStrength === "high") {
    // El company ha dit "A tu!" / "No tinc res": demana que jo intente
    // guanyar la baza. En la 1a baza, si tinc una carta TOP (manilla
    // d'oros, manilla d'espases, As bastos o As espases) o un 3 que
    // guanyen o empardin la millor carta ja jugada en la mesa, juga
    // PREFERENTMENT la carta top; en defecte, juga el 3. Així no es
    // crema una carta forta innecessàriament: només es treu si serveix.
    const tableBest = trick.cards.length > 0
      ? trick.cards.reduce((mx, tc) => Math.max(mx, cardStrength(tc.card)), -1)
      : -1;
    if (r.tricks.length === 1) {
      const isTopCardATu = (c: Card) =>
        (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")) ||
        (c.rank === 7 && (c.suit === "espases" || c.suit === "oros"));
      // Cas especial "Pisar amb top després d'A tu + 3 del company":
      // si el company (que m'ha dit "A tu!") ha tirat un 3 a la mesa,
      // eixe 3 és la seua carta més baixa i em demana que agafe la
      // baza amb la màxima força possible. En aquest cas concret cal
      // tirar la TOP més ALTA que tinga, encara que supere el 3 del
      // propi company.
      const partnerId = ((player + 2) % 4) as PlayerId;
      const partnerPlayedThree = trick.cards.some(
        (tc) => tc.player === partnerId && tc.card.rank === 3,
      );
      // Cartes top que guanyen O empardin la mesa (tableBest = -1 si la
      // mesa està buida, en eixe cas qualsevol carta serveix).
      const winningTops = cards
        .filter((c) => isTopCardATu(c) && cardStrength(c) >= tableBest)
        .sort((a, b) => cardStrength(a) - cardStrength(b));
      if (winningTops.length > 0) {
        // Per defecte, la top més baixa que serveix; però si el company
        // ha tirat un 3, tirem la top MÉS ALTA per pisar amb força.
        const pick = partnerPlayedThree
          ? winningTops[winningTops.length - 1]!
          : winningTops[0]!;
        const matchAct = playActions.find((a) => a.cardId === pick.id);
        if (matchAct) return matchAct;
      }

      // En defecte, qualsevol 3 que guanye O empardi la mesa.
      const winningThrees = cards
        .filter((c) => c.rank === 3 && cardStrength(c) >= tableBest)
        .sort((a, b) => cardStrength(a) - cardStrength(b));
      if (winningThrees.length > 0) {
        const pick = winningThrees[0]!;
        const matchAct = playActions.find((a) => a.cardId === pick.id);
        if (matchAct) return matchAct;
      }
    }
    // Si la meua carta més alta no és suficient per a superar la millor
    // carta ja jugada en la mesa, no té sentit cremar-la — la guarde per
    // a una baza posterior i tire la més baixa.
    if (tableBest >= 0 && cardStrength(highest) <= tableBest) {
      return { type: "play-card", cardId: lowest.id };
    }
    // Si la baza ja està oberta i el meu equip va guanyant amb la carta
    // més alta, no cal cremar la millor; tira igualment alta perquè
    // l'humà ha demanat que jo me'n faça càrrec.
    return { type: "play-card", cardId: highest.id };
  }
  if (playStrength === "vine-a-vore") {
    // Cartes "compromeses": 7 d'oros (str=85) o qualsevol 3 (str=70).
    const committedCards = cards
      .filter((c) => (c.rank === 7 && c.suit === "oros") || c.rank === 3)
      .sort((a, b) => cardStrength(a) - cardStrength(b));
    if (committedCards.length > 0) {
      const tableBest = trick.cards.length > 0
        ? trick.cards.reduce((mx, tc) => Math.max(mx, cardStrength(tc.card)), -1)
        : -1;
      const tableBestPlayer = trick.cards.length > 0
        ? trick.cards.reduce(
            (best, tc) =>
              best === null || cardStrength(tc.card) > cardStrength(best.card)
                ? tc
                : best,
            null as { player: PlayerId; card: Card } | null,
          )
        : null;
      const partnerWinsTable =
        tableBestPlayer !== null && teamOf(tableBestPlayer.player) === teamOf(player);

      if (partnerWinsTable && tableBestPlayer!.card.rank !== 3) {
        // El company ja guanya: no cal cremar res. Tira la més baixa.
        // Excepció: si guanya amb un 3, deixem que la lògica posterior
        // valore si superar-lo amb una carta més forta.
        return { type: "play-card", cardId: lowest.id };
      }

      const winningCommitted = committedCards.find((c) => cardStrength(c) > tableBest);
      if (winningCommitted) {
        // Excepció: totes les cartes de la mesa són < 3 (str<70) i cap
        // rival ha mostrat força → si tinc el 7 d'oros, reserve'l i tire
        // el 3 si també guanya.
        const allWeak = trick.cards.every((tc) => cardStrength(tc.card) < 70);
        if (allWeak && !rivalShownStrength) {
          const three = committedCards.find(
            (c) => c.rank === 3 && cardStrength(c) > tableBest,
          );
          const has7Oros = committedCards.some((c) => c.rank === 7 && c.suit === "oros");
          if (three && has7Oros) {
            const matchAct = playActions.find((a) => a.cardId === three.id);
            if (matchAct) return matchAct;
          }
        }
        // Juga la carta compromesa més baixa que guanya la mesa.
        const matchAct = playActions.find((a) => a.cardId === winningCommitted.id);
        if (matchAct) return matchAct;
      }
      // Cap carta compromesa guanya la mesa: guarda-les per a una baza
      // posterior i tira la més baixa de les altres (o la més baixa
      // absoluta si totes són compromeses).
      const nonCommitted = cards
        .filter((c) => !((c.rank === 7 && c.suit === "oros") || c.rank === 3))
        .sort((a, b) => cardStrength(a) - cardStrength(b));
      const fallback = nonCommitted[0] ?? lowest;
      const matchAct = playActions.find((a) => a.cardId === fallback.id);
      if (matchAct) return matchAct;
    }
    // Sense cartes compromeses (cas anòmal): segueix amb la lògica normal.
  }
  if (playStrength === "vine-al-meu-tres" || playStrength === "tinc-un-tres") {
    // Compromís: el bot ha dit "Vine al meu tres" o "Tinc un 3" i té un 3.
    // Regles (mateixes per a les dues respostes):
    //   1) Si la mesa està buida (sóc primer): si el meu equip ha guanyat
    //      la 1a baza, tire un 3 per pressionar (assegure baza/parda).
    //      Si no, juga la lògica normal.
    //   2) Si la mesa té cartes:
    //      a) Si el meu company ja guanya, no cal cremar: més baixa.
    //      b) Si tinc un 3 que GUANYA la millor de la mesa → juga'l.
    //      c) Si el meu equip ha guanyat la 1a baza i el meu 3 EMPATA
    //         (str de la millor de la mesa = 70 = un altre 3) → juga el 3
    //         per assegurar la parda (que en aquesta 2a baza ens fa
    //         guanyar el truc).
    //      d) Si no pot guanyar ni empatar amb cap 3 → guarda els 3 i
    //         tira la més baixa no compromesa.
    const myThrees = cards
      .filter((c) => c.rank === 3)
      .sort((a, b) => cardStrength(a) - cardStrength(b));
    if (myThrees.length > 0) {
      const myTeam = teamOf(player);
      const firstTrick = r.tricks[0];
      const wonFirstTrick =
        !!firstTrick &&
        firstTrick.winner !== undefined &&
        firstTrick.parda !== true &&
        teamOf(firstTrick.winner!) === myTeam;

      if (trick.cards.length === 0) {
        // Sóc primer: tire un 3 si el meu equip ja va 1-0 (o si és la
        // primera baza, ja que el compromís ho exigeix com a posicionament).
        const pickThree = myThrees[0]!;
        const matchAct = playActions.find((a) => a.cardId === pickThree.id);
        if (matchAct) return matchAct;
      } else {
        const tableBest = trick.cards.reduce(
          (mx, tc) => Math.max(mx, cardStrength(tc.card)),
          -1,
        );
        const tableBestPlayer = trick.cards.reduce(
          (best, tc) =>
            best === null || cardStrength(tc.card) > cardStrength(best.card)
              ? tc
              : best,
          null as { player: PlayerId; card: Card } | null,
        );
        const partnerWinsTable =
          tableBestPlayer !== null && teamOf(tableBestPlayer.player) === teamOf(player);

        if (partnerWinsTable) {
          return { type: "play-card", cardId: lowest.id };
        }

        // Cap 3 té força > 70, per tant "winning" només si tableBest < 70.
        const winningThree = myThrees.find((c) => cardStrength(c) > tableBest);
        if (winningThree) {
          const matchAct = playActions.find((a) => a.cardId === winningThree.id);
          if (matchAct) return matchAct;
        }
        // Empat amb el 3 (algun rival també ha tirat un 3) i el meu equip
        // ja ha guanyat la 1a baza → empardar la baza ens dóna el truc.
        const tieingThree = myThrees.find((c) => cardStrength(c) === tableBest);
        if (tieingThree && wonFirstTrick) {
          const matchAct = playActions.find((a) => a.cardId === tieingThree.id);
          if (matchAct) return matchAct;
        }
        // Ni guanya ni empata útil: guarda el 3, tira la més baixa no-3.
        const nonThree = cards
          .filter((c) => c.rank !== 3)
          .sort((a, b) => cardStrength(a) - cardStrength(b));
        const fallback = nonThree[0] ?? lowest;
        const matchAct = playActions.find((a) => a.cardId === fallback.id);
        if (matchAct) return matchAct;
      }
    }
    // Sense 3 (cas anòmal): segueix lògica normal.
  }

  // ----- Regla mode sincer: compromís de "Vine a mi!" / "Algo tinc" -----
  // Si el jugador té una carta forta (str ≥ 80: manilla d'espases, manilla
  // d'oros, As bastos o As espases) i la baza ja està oberta:
  //   1) Si la carta forta GUANYA la millor de la mesa → juga-la.
  //      Excepció: totes les cartes de la mesa són < 3 (str < 70) i tinc
  //      una alternativa més feble (3 o manilla d'oros) que també guanyaria →
  //      reserve la carta forta per a una baza posterior.
  //   2) Si cap carta forta no guanya → guarda-les i tira la més baixa.
  // Aquesta regla té prioritat perquè honora el compromís implícit del
  // "Vine a mi!" o "Algo tinc" (manilla d'espases o manilla d'oros).
  // EXCEPCIÓ: si el meu COMPANY ha promés força ((partnerAdvice === "strong" || partnerAdvice === "three"):
  // "Vine a mi!", "Algo tinc", "Tinc un 3", "Vine al meu tres") és ell qui
  // ha de cremar la carta forta. Jo, com a parella, no quemo res — tire la
  // més baixa per reservar les meues bones per a bazas posteriors.
  if (trick.cards.length > 0 && (partnerAdvice === "strong" || partnerAdvice === "three")) {
    // OBLIGACIÓ: si sóc el primer de la meua parella a tirar (el company
    // encara no ha jugat en esta baza), el company m'ha dit que té un 3
    // (partnerAdvice === "three" / "strong") i a la mesa ja hi ha una
    // carta TOP (str ≥ 80) d'un rival que cap company NO supera, i jo
    // tinc una carta que la pot superar → tire eixa carta per a guanyar
    // la baza, en lloc de reservar la baixa.
    const myTeamCheck = teamOf(player);
    const partnerNotPlayed = !trick.cards.some(
      (tc) => teamOf(tc.player) === myTeamCheck && tc.player !== player,
    );
    if (partnerNotPlayed) {
      const tableBestPlayer = trick.cards.reduce(
        (best, tc) =>
          best === null || cardStrength(tc.card) > cardStrength(best.card)
            ? tc
            : best,
        null as { player: PlayerId; card: Card } | null,
      );
      const tableBestStr = tableBestPlayer
        ? cardStrength(tableBestPlayer.card)
        : -1;
      const rivalHasTop = trick.cards.some(
        (tc) => teamOf(tc.player) !== myTeamCheck && cardStrength(tc.card) >= 80,
      );
      if (rivalHasTop && tableBestStr >= 80) {
        const winners = cards
          .filter((c) => cardStrength(c) > tableBestStr)
          .sort((a, b) => cardStrength(a) - cardStrength(b));
        if (winners.length > 0) {
          const matchAct = playActions.find((a) => a.cardId === winners[0]!.id);
          if (matchAct) return matchAct;
        }
      }
    }
    return { type: "play-card", cardId: lowest.id };
  }
  if (trick.cards.length > 0) {
    // ----- 2a baza, 1a baza PERDUDA, sóc el 2n jugador global i el
    // company ha respost "No" (partnerAdvice === "weak") -----
    // Només gaste la meua carta més alta si mata la carta del rival que
    // hi ha a la mesa I eixa carta rival és, com a mínim, un 3 (str ≥ 70).
    // En qualsevol altre cas reserve la carta forta per a la 3a baza i
    // tire la més baixa.
    {
      const t1Prev = r.tricks[0];
      const lostFirstPrev =
        r.tricks.length === 2 &&
        !!t1Prev &&
        t1Prev.parda !== true &&
        t1Prev.winner !== undefined &&
        teamOf(t1Prev.winner!) !== teamOf(player);
      const rivalOnly =
        trick.cards.length === 1 &&
        teamOf(trick.cards[0]!.player) !== teamOf(player);
      if (lostFirstPrev && rivalOnly && partnerAdvice === "weak") {
        const rivalStr = cardStrength(trick.cards[0]!.card);
        const myTop = cards.reduce((a, b) =>
          cardStrength(b) > cardStrength(a) ? b : a,
        );
        if (rivalStr >= 70 && cardStrength(myTop) > rivalStr) {
          const act = playActions.find((a) => a.cardId === myTop.id);
          if (act) return act;
        }
        const act = playActions.find((a) => a.cardId === lowest.id);
        if (act) return act;
      }
    }
    const myTopCards = cards
      .filter((c) => cardStrength(c) >= 80)
      .sort((a, b) => cardStrength(a) - cardStrength(b));
    if (myTopCards.length > 0) {
      const tableBest = trick.cards.reduce(
        (mx, tc) => Math.max(mx, cardStrength(tc.card)),
        -1,
      );
      const tableBestPlayer = trick.cards.reduce(
        (best, tc) =>
          best === null || cardStrength(tc.card) > cardStrength(best.card)
            ? tc
            : best,
        null as { player: PlayerId; card: Card } | null,
      );
      const partnerWinsTable =
        tableBestPlayer !== null && teamOf(tableBestPlayer.player) === teamOf(player);

      if (!partnerWinsTable) {
        const winningTops = myTopCards.filter((c) => cardStrength(c) > tableBest);
        if (winningTops.length > 0) {
          // Reserve la carta forta NOMÉS si totes les cartes de la mesa
          // són < 3 (str < 70) I cap rival ha mostrat força (vine-a-mi /
          // tinc-bona) en aquesta ronda. Si algun rival ha senyalitzat
          // que té cartes fortes, juga la carta de força per assegurar
          // la baza —especialment crucial en la 1a baza.
          const allWeak = trick.cards.every((tc) => cardStrength(tc.card) < 70);
          if (allWeak && !rivalShownStrength) {
            const winningTopStr = cardStrength(winningTops[0]!);
            const reserve = cards
              .filter(
                (c) =>
                  cardStrength(c) < winningTopStr &&
                  cardStrength(c) > tableBest &&
                  (c.rank === 3 || (c.rank === 7 && c.suit === "oros")),
              )
              .sort((a, b) => cardStrength(a) - cardStrength(b))[0];
            if (reserve) {
              const matchAct = playActions.find((a) => a.cardId === reserve.id);
              if (matchAct) return matchAct;
            }
          }
          // OBLIGACIÓ: 2a baza, hem perdut la 1a i sóc el primer de la
          // meua pareja en obrir; el company ha respost "A tu" / "No"
          // (partnerAdvice === "weak"). Cal guanyar la baza obligatòriament
          // amb la MILLOR carta top que tinga, no la més baixa, per
          // assegurar que el rival que tira darrere no la supere.
          let chosenTop: Card = winningTops[0]!;
          const t1Lost = r.tricks[0];
          const lostFirstHere =
            r.tricks.length === 2 &&
            !!t1Lost &&
            t1Lost.parda !== true &&
            t1Lost.winner !== undefined &&
            teamOf(t1Lost.winner!) !== teamOf(player);
          if (lostFirstHere && partnerAdvice === "weak") {
            chosenTop = [...winningTops].sort(
              (a, b) => cardStrength(b) - cardStrength(a),
            )[0]!;
          }
          const matchAct = playActions.find((a) => a.cardId === chosenTop.id);
          if (matchAct) return matchAct;
        } else {
          return { type: "play-card", cardId: lowest.id };
        }
      }
    }
  }


  // Si yo soy el primero de mi pareja en tirar (o abro la baza),
  // aplica el consejo del compañero:
  //  - strong → tira baja para reservar la alta
  //  - weak   → tira alta para intentar ganar
  //  - neutral → comportamiento original
  if (trick.cards.length === 0) {
    // Si la 1a baza ha quedat parda, la 2a baza decideix el truc:
    // sempre tira la carta més alta per intentar guanyar-la.
    if (r.tricks.length === 2 && r.tricks[0]!.parda) {
      return { type: "play-card", cardId: highest.id };
    }

    // ----- 2a baza: hem guanyat la 1a → obrir amb un 3 si en tenim, si no la més baixa -----
    // Si el meu equip va 1-0 i no tinc el truc clarament guanyat (sense
    // els dos asos forts ni una carta dominant ja imbatible), obrir amb
    // un 3 pressiona els rivals: si volen guanyar la baza hauran de
    // cremar les seues millors cartes (manilles fortes i asos),
    // assegurant-nos més probabilitats de tancar el truc en la 3a baza
    // o per parda. Si no tenim cap 3, conservem les cartes fortes per
    // a la 3a baza i tirem la més baixa.
    if (r.tricks.length === 2 && !r.tricks[0]!.parda) {
      const myTeam = teamOf(player);
      const wonFirst =
        r.tricks[0]!.winner !== undefined && teamOf(r.tricks[0]!.winner!) === myTeam;
      if (wonFirst && partnerAdvice !== "weak") {
        const hasAsEspases = cards.some(c => c.rank === 1 && c.suit === "espases");
        const hasAsBastos = cards.some(c => c.rank === 1 && c.suit === "bastos");
        const trucWonAlready = hasAsEspases && hasAsBastos;
        // "Carta dominant assegurada": una carta ≥85 (As bastos/manilla
        // espases) i totes les superiors a ella ja s'han jugat.
        const myHighScore = cardStrength(highest);
        const playedHigher = r.tricks.some(t =>
          t.cards.some(tc => cardStrength(tc.card) > myHighScore),
        );
        const dominantSecured = myHighScore >= 90 && playedHigher;
        const myThrees = cards.filter(c => c.rank === 3);
        if (!trucWonAlready && !dominantSecured && myThrees.length >= 1) {
          // Si en té diversos, juga el de pal "fluix" (oros/copes) per
          // reservar els forts.
          const ordered = [...myThrees].sort((a, b) => cardStrength(a) - cardStrength(b));
          const pick = ordered[0]!;
          const matchAct = playActions.find(a => a.cardId === pick.id);
          if (matchAct) return matchAct;
        }
      }
      if (wonFirst) {
        return { type: "play-card", cardId: lowest.id };
      }
      // Hem perdut la 1a baza i sóc el primer de la pareja en obrir
      // la 2a. Si he preguntat "Tens més d'un tres?" al company:
      //  - resposta forta (té carta top) → tire la més baixa per
      //    reservar les meues fortes per a la 3a baza.
      //  - resposta dèbil (no té res) → tire una carta superior a
      //    un 3 (str > 70). Si en tinc dues "tops" (≥ 85), trie la
      //    més baixa d'eixes dues per reservar la millor per a la 3a.
      const lostFirst = !wonFirst && r.tricks[0]!.winner !== undefined;
      if (lostFirst) {
        if (partnerAdvice === "strong" || partnerAdvice === "three") {
          return { type: "play-card", cardId: lowest.id };
        }
        if (partnerAdvice === "weak") {
          const myTops = cards.filter((c) => cardStrength(c) >= 85);
          if (myTops.length >= 2) {
            const lowerTop = [...myTops].sort((a, b) => cardStrength(a) - cardStrength(b))[0]!;
            const matchAct = playActions.find((a) => a.cardId === lowerTop.id);
            if (matchAct) return matchAct;
          }
          const aboveThree = cards
            .filter((c) => cardStrength(c) > 70)
            .sort((a, b) => cardStrength(a) - cardStrength(b));
          if (aboveThree.length >= 1) {
            const pick = aboveThree[0]!;
            const matchAct = playActions.find((a) => a.cardId === pick.id);
            if (matchAct) return matchAct;
          }
          return { type: "play-card", cardId: highest.id };
        }
      }
    }

    if (partnerAdvice === "three") {
      // El company ha respost "Tinc un 3". Com a primer de la pareja en
      // obrir la 1a baza, tirar un as (bastos/espases) només és obligatori
      // quan la meua mà és prou forta: 2 cartes top, o 1 top + 1 tres.
      // Així assegurem la 1a baza i conservem força per a la 3a. Si en
      // tinc tots dos asos, tire el més baix (As bastos).
      const isTop = (c: Card) =>
        (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")) ||
        (c.rank === 7 && (c.suit === "espases" || c.suit === "oros"));
      const tops = cards.filter(isTop);
      const threes = cards.filter((c) => c.rank === 3);
      const handStrongEnough = tops.length >= 2 || (tops.length >= 1 && threes.length >= 1);
      const myAces = cards.filter(
        (c) => c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"),
      );
      if (r.tricks.length === 1 && handStrongEnough && myAces.length >= 1) {
        const acePick = myAces.sort((a, b) => cardStrength(a) - cardStrength(b))[0]!;
        const matchAct = playActions.find((a) => a.cardId === acePick.id);
        if (matchAct) return matchAct;
      }
      // Cas general: equivalent a "strong" — tira baixa per reservar.
      return { type: "play-card", cardId: lowest.id };
    }
    if (partnerAdvice === "strong") {
      return { type: "play-card", cardId: lowest.id };
    }
    if (partnerAdvice === "weak") {
      return { type: "play-card", cardId: highest.id };
    }
    if (r.tricks.length === 1) {
      // 1a baza: és crucial guanyar-la — si la guanyem i alguna de les
      // següents queda parda, guanyem el truc. Per defecte obrim amb la
      // carta més alta. Excepció: si tenim una carta dominant (≥80,
      // típicament manilla d'oros/espases o asos forts) i a més una altra
      // carta mig-alta (≥55), reservem la dominant i obrim amb la segona millor.
      const dominant = sorted[sorted.length - 1]!;
      const second = sorted[sorted.length - 2];
      const dominantScore = cardStrength(dominant);
      const secondScore = second ? cardStrength(second) : 0;
      if (dominantScore >= 80 && secondScore >= 55) {
        return { type: "play-card", cardId: second!.id };
      }
      return { type: "play-card", cardId: highest.id };
    }
    return { type: "play-card", cardId: highest.id };
  }

  let bestOnTable = -1;
  let bestPlayer: PlayerId | null = null;
  for (const tc of trick.cards) {
    const s = cardStrength(tc.card);
    if (s > bestOnTable) { bestOnTable = s; bestPlayer = tc.player; }
  }

  const partnerWinning = bestPlayer !== null && teamOf(bestPlayer) === teamOf(player);

  // ===== Regla prioritària: no malgastar cartes si l'equip ja està segur =====
  // Si el meu equip ja ha guanyat la 1a baza, o el meu company ja va
  // guanyant la baza actual, NO té sentit cremar una carta alta si amb
  // ella no guanye ni empardi la mesa. En eixe cas, tire SEMPRE la més
  // baixa. Aquesta regla preval per damunt de la resta d'heurístiques.
  // Excepció: si la 1a baza va quedar parda i estem a la 2a, no podem
  // permetre que ens passen per damunt — eixa baza decideix el truc i
  // cal jugar fort (la regla de més avall ho gestiona).
  {
    const teamWonFirst =
      r.tricks.length >= 2 &&
      r.tricks[0]!.winner !== undefined &&
      !r.tricks[0]!.parda &&
      teamOf(r.tricks[0]!.winner!) === teamOf(player);
    const firstWasParda =
      r.tricks.length >= 2 && r.tricks[0]!.parda === true;
    if (!firstWasParda && (teamWonFirst || partnerWinning)) {
      const matchAct = playActions.find((a) => a.cardId === lowest.id);
      if (matchAct) return matchAct;
    }
  }

  // Si la 1a baza ha quedat parda, la 2a baza decideix el truc:
  // sempre tira la carta més alta per intentar guanyar-la (fins i tot
  // si el company va guanyant la mesa actualment, perquè una carta
  // rival posterior podria superar-lo).
  if (r.tricks.length === 2 && r.tricks[0]!.parda) {
    return { type: "play-card", cardId: highest.id };
  }

  // ----- Regla: hem perdut la 1a baza, ara hem de guanyar la 2a -----
  // Si el meu equip ha perdut la 1a baza (no la vam empardar) i estem
  // jugant la 2a, no podem perdre m\u00e9s bazas: cal guanyar aquesta s\u00ed o
  // s\u00ed (i tamb\u00e9 la 3a). Casos especials:
  //   a) La 2a baza ja porta parda a la mesa (algun rival ha igualat la
  //      millor carta entre equips): si parda la 2a havent perdut la 1a,
  //      perdem el truc. Cal jugar una carta que SUPERE la millor de la
  //      mesa (no nom\u00e9s igualar-la). Si en tinc, juga la m\u00e9s baixa
  //      que guanya.
  //   b) Encara queden rivals per jugar i el meu equip no t\u00e9 una carta
  //      a la mesa que clarament guanya: prioritza jugar una carta
  //      guanyadora abans que reservar-la.
  if (r.tricks.length === 2 && !r.tricks[0]!.parda) {
    const myTeam = teamOf(player);
    const wonFirst =
      r.tricks[0]!.winner !== undefined && teamOf(r.tricks[0]!.winner!) === myTeam;
    if (!wonFirst) {
      // Hi ha parda entre equips a la mesa? (millor carta empatada en
      // for\u00e7a per cartes de l'equip rival)
      let tableParda = false;
      if (trick.cards.length >= 2 && bestPlayer !== null) {
        for (const tc of trick.cards) {
          if (
            tc.player !== bestPlayer &&
            teamOf(tc.player) !== teamOf(bestPlayer) &&
            cardStrength(tc.card) === bestOnTable
          ) {
            tableParda = true;
            break;
          }
        }
      }
      const winningCards = sorted.filter((c) => cardStrength(c) > bestOnTable);
      // (a) Parda a la mesa: hem d'intentar superar-la s\u00ed o s\u00ed.
      if (tableParda && winningCards.length > 0) {
        const pick = winningCards[0]!; // m\u00e9s baixa que guanya
        const matchAct = playActions.find((a) => a.cardId === pick.id);
        if (matchAct) return matchAct;
      }
      // (b) Si el meu company NO va guanyant clarament i tinc cartes que
      // superen la mesa, juga la m\u00e9s baixa que guanya. No reservem
      // cartes: si perdem la 2a tamb\u00e9, perdem el truc.
      if (!partnerWinning && winningCards.length > 0) {
        const pick = winningCards[0]!;
        const matchAct = playActions.find((a) => a.cardId === pick.id);
        if (matchAct) return matchAct;
      }
    }
  }

  // ----- Regla: 3r en l'ordre de la 1a baza amb 3 + carta top -----
  // Si soc el 3r en jugar de la primera baza (el meu company ha jugat
  // primer, el rival segon) i tinc tant un 3 com una carta TOP (As
  // bastos, As espases, 7 espases o 7 d'oros, str ≥ 80), i la carta
  // top supera la millor carta de la mesa: juga la top per assegurar
  // la 1a baza. Guanyar-la és cr\u00edtic, i tindre encara un 3 a la m\u00e0
  // garanteix joc fort per a les bazas restants. Aplica tant si el
  // company va guanyant (per blindar contra el 4t rival) com si no.
  if (r.tricks.length === 1 && trick.cards.length === 2 && (partnerAdvice !== "strong" && partnerAdvice !== "three")) {
    const isTopCard = (c: Card) =>
      (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")) ||
      (c.rank === 7 && (c.suit === "espases" || c.suit === "oros"));
    const myThrees = cards.filter((c) => c.rank === 3);
    const myTopCards = cards.filter(isTopCard).sort((a, b) => cardStrength(a) - cardStrength(b));
    if (myThrees.length >= 1 && myTopCards.length >= 1) {
      const winningTop = myTopCards.find((c) => cardStrength(c) > bestOnTable);
      if (winningTop) {
        const matchAct = playActions.find((a) => a.cardId === winningTop.id);
        if (matchAct) return matchAct;
      }
    }
  }

  // ----- Regla: 2n de la parella en jugar a la 1a baza -----
  // Si soc el 2n jugador de la meua parella a la 1a baza (el meu company
  // ja ha jugat ací), tire SEMPRE la meua MAJOR carta si guanya o emparda
  // la millor carta de la mesa. Si la meua major no arriba a empardar,
  // tire la més baixa per no cremar cartes útils. Aplica encara que no
  // tinga cap carta top ni cap 3. Excepció: si el meu equip ja té la
  // baza guanyada amb un 3 o una carta top (str ≥ 70) gràcies al company,
  // no cal sobreescriure: cau a la lògica posterior que reserva cartes.
  if (r.tricks.length === 1 && (partnerAdvice !== "strong" && partnerAdvice !== "three")) {
    const partnerSeat = ((player + 2) % 4) as PlayerId;
    const partnerHasPlayedHere = trick.cards.some((tc) => tc.player === partnerSeat);
    if (partnerHasPlayedHere) {
      const teamWinningWithThreeOrBetter =
        partnerWinning && bestOnTable >= 70;
      if (!teamWinningWithThreeOrBetter) {
        if (cardStrength(highest) >= bestOnTable) {
          const matchAct = playActions.find((a) => a.cardId === highest.id);
          if (matchAct) return matchAct;
        } else {
          const matchAct = playActions.find((a) => a.cardId === lowest.id);
          if (matchAct) return matchAct;
        }
      }
    }
  }

  if (partnerWinning) {
    return { type: "play-card", cardId: lowest.id };
  }

  // ----- 2a baza, vam guanyar la 1a, soc 2n de la parella: tirar un 3 -----
  // Si el meu equip ja va 1-0, la 2a baza està en marxa i el meu company
  // ja ha jugat ací (jo soc el 2n de la parella), tire un 3 NOMÉS si:
  //   · El meu 3 GUANYA o EMPARDA la millor carta de la mesa, I
  //   · El meu company NO està ja guanyant o empardant la baza amb
  //     almenys un 3 (rank 3 o carta top).
  // En cas contrari (3 no guanya/emparda, o el company ja garanteix la
  // baza amb ≥3), tire OBLIGATÒRIAMENT la carta més baixa.
  // Excepció: si la baza ja està parda amb un 3 a la mesa, tire la més
  // baixa (no té sentit gastar un 3 per fer una nova parda).
  if (
    r.tricks.length === 2 &&
    !r.tricks[0]!.parda &&
    trick.cards.length >= 1 &&
    partnerAdvice !== "weak"
  ) {
    const myTeam = teamOf(player);
    const wonFirst =
      r.tricks[0]!.winner !== undefined && teamOf(r.tricks[0]!.winner!) === myTeam;
    const partnerCard2T = trick.cards.find(
      (tc) => teamOf(tc.player) === myTeam && tc.player !== player && !tc.covered,
    );
    if (wonFirst && partnerCard2T) {
      const isTopCard2T = (c: Card) =>
        (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
        (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"));
      const hasAsEspases = cards.some(c => c.rank === 1 && c.suit === "espases");
      const hasAsBastos = cards.some(c => c.rank === 1 && c.suit === "bastos");
      const trucWonAlready = hasAsEspases && hasAsBastos;
      const myHighScore = cardStrength(highest);
      const playedHigher = r.tricks.some(t =>
        t.cards.some(tc => cardStrength(tc.card) > myHighScore),
      );
      const dominantSecured = myHighScore >= 90 && playedHigher;

      if (!trucWonAlready && !dominantSecured) {
        // Company ja guanya o emparda amb ≥3?
        const partnerLeadsWithThreeOrTop =
          cardStrength(partnerCard2T.card) >= bestOnTable &&
          (partnerCard2T.card.rank === 3 || isTopCard2T(partnerCard2T.card));
        // Parda amb un 3 a la mesa.
        const tableTopIsThree = trick.cards.some(
          (tc) => cardStrength(tc.card) === bestOnTable && tc.card.rank === 3,
        );
        const pardaWithThree = bestOnTable === 70 && tableTopIsThree;

        if (partnerLeadsWithThreeOrTop || pardaWithThree) {
          // Tira la més baixa OBLIGATÒRIAMENT.
          const matchLow = playActions.find(a => a.cardId === lowest.id);
          if (matchLow) return matchLow;
        } else {
          const myThrees = cards.filter(c => c.rank === 3);
          // El meu 3 (força 70) guanya si bestOnTable < 70; no entrem en
          // bestOnTable === 70 perquè ja s'ha gestionat com a parda above.
          if (myThrees.length >= 1 && bestOnTable < 70) {
            const ordered = [...myThrees].sort((a, b) => cardStrength(a) - cardStrength(b));
            const pick = ordered[0]!;
            const matchAct = playActions.find(a => a.cardId === pick.id);
            if (matchAct) return matchAct;
          }
        }
      }
    }
  }

  // ----- Regla específica: 2n de la parella en la 1a baza -----
  // Si soc el segon en jugar de la meua parella en la primera baza
  // (el company encara no ha jugat i la mesa té 1 carta, d'un rival),
  // he d'intentar guanyar la baza amb la carta de truc més alta possible
  // perquè guanyar la primera dóna avantatge davant un empat posterior.
  // Excepcions per no cremar la millor carta:
  //  a) Tinc As espases + As bastos → ja tinc el truc guanyat; tire baixa.
  //  b) Tinc As bastos + 7 espases i l'As espases ja s'ha jugat en aquesta
  //     ronda → l'As bastos és invencible; tire baixa.
  //  c) Tinc As espases i un 3, i la millor carta de la mesa és un 3 →
  //     podem empardar amb el 3 (reserve l'As espases).
  const partnerSeat = ((player + 2) % 4) as PlayerId;
  const partnerHasPlayedHere = trick.cards.some(tc => tc.player === partnerSeat);
  const isFirstTrick = r.tricks.length === 1;
  const iAmSecondOfPair = isFirstTrick && trick.cards.length === 1 && !partnerHasPlayedHere;
  if (iAmSecondOfPair && (partnerAdvice !== "strong" && partnerAdvice !== "three")) {
    const hasAsEspases = hand.some(c => c.rank === 1 && c.suit === "espases");
    const hasAsBastos = hand.some(c => c.rank === 1 && c.suit === "bastos");
    const has7Espases = hand.some(c => c.rank === 7 && c.suit === "espases");
    const myThrees = cards.filter(c => c.rank === 3);
    // Comprova si l'As espases ja ha eixit en alguna baza d'aquesta ronda
    // (només pot ser en aquesta mateixa primera baza, però ho generalitzem).
    const asEspasesPlayed = r.tricks.some(t =>
      t.cards.some(tc => tc.card.rank === 1 && tc.card.suit === "espases"),
    );

    // (a) Truc ja guanyat amb tots dos asos forts.
    const trucWonAlready = hasAsEspases && hasAsBastos;
    // (b) As bastos invencible perquè l'As espases ja s'ha jugat.
    const asBastosInvincible = hasAsBastos && has7Espases && asEspasesPlayed;

    if (!trucWonAlready && !asBastosInvincible) {
      // (c) Empardar amb el 3 si el rival ha jugat un 3 i jo tinc As espases.
      const tableTopIsThree = trick.cards[0]!.card.rank === 3;
      if (tableTopIsThree && hasAsEspases && myThrees.length >= 1) {
        const myThree = myThrees[0]!;
        const matchAct = playActions.find(a => a.cardId === myThree.id);
        if (matchAct) return matchAct;
      }
      // Carta de truc més alta (≥70) que supere la del rival.
      const trucCards = sorted.filter(c => cardStrength(c) >= 70);
      const winningTrucCards = trucCards.filter(c => cardStrength(c) > bestOnTable);
      if (winningTrucCards.length > 0) {
        // Agafa la més alta per assegurar la baza.
        const pick = winningTrucCards[winningTrucCards.length - 1]!;
        const matchAct = playActions.find(a => a.cardId === pick.id);
        if (matchAct) return matchAct;
      }
      // Si la meua carta més alta no supera la del rival, no la malgaste:
      // tire la més baixa per reservar les bones per a bazas següents.
      if (cardStrength(highest) <= bestOnTable) {
        return { type: "play-card", cardId: lowest.id };
      }
    }
  }

  // Si voy en tercer lugar (mi compañero aún no jugó) y tengo consejo:
  const partner = ((player + 2) % 4) as PlayerId;
  const partnerPlayed = trick.cards.some(tc => tc.player === partner);
  if (!partnerPlayed) {
    if ((partnerAdvice === "strong" || partnerAdvice === "three")) {
      return { type: "play-card", cardId: lowest.id };
    }
    if (partnerAdvice === "weak") {
      const winners = sorted.filter(c => cardStrength(c) > bestOnTable);
      if (winners.length > 0) {
        return { type: "play-card", cardId: highest.id };
      }
    }
  }

  const winners = sorted.filter(c => cardStrength(c) > bestOnTable);
  if (winners.length > 0) {
    return { type: "play-card", cardId: winners[0]!.id };
  }
  return { type: "play-card", cardId: lowest.id };
}

/**
 * Estimació probabilística de guanyar el truc en la situació actual.
 * Usa simulació Monte Carlo: reparteix aleatòriament les cartes
 * desconegudes entre el company i els dos rivals (respectant la mida
 * actual de cada mà), simula les bazas restants assumint que cada
 * jugador tira la seua carta més forta, i calcula la fracció de
 * trials en què el meu equip guanya el truc.
 */
function estimateTrucWinProb(
  m: MatchState,
  player: PlayerId,
  trials: number = 200,
): number {
  const r = m.round;
  const myTeam = teamOf(player);
  const myHand = (r.hands[player] ?? []) as Card[];

  let myWinsBase = 0;
  let oppWinsBase = 0;
  for (const t of r.tricks) {
    if (t.winner !== undefined) {
      if (t.parda) continue;
      if (teamOf(t.winner) === myTeam) myWinsBase++;
      else oppWinsBase++;
    }
  }
  if (myWinsBase >= 2) return 1;
  if (oppWinsBase >= 2) return 0;

  const playedIds = new Set<string>();
  for (const t of r.tricks) for (const tc of t.cards) playedIds.add(tc.card.id);
  const myIds = new Set(myHand.map((c) => c.id));
  const unknown = buildDeck().filter(
    (c) => !playedIds.has(c.id) && !myIds.has(c.id),
  );

  const others = ([0, 1, 2, 3] as PlayerId[]).filter((p) => p !== player);
  const handSizes: Record<number, number> = {};
  for (const p of others) handSizes[p] = (r.hands[p] ?? []).length;

  const curTrick = r.tricks[r.tricks.length - 1];
  const curIsOpen = !!curTrick && curTrick.winner === undefined;

  let wins = 0;
  for (let trial = 0; trial < trials; trial++) {
    const shuffled = [...unknown].sort(() => Math.random() - 0.5);
    const simHands: Record<number, Card[]> = {};
    simHands[player] = [...myHand];
    let idx = 0;
    for (const p of others) {
      const need = handSizes[p] ?? 0;
      simHands[p] = shuffled.slice(idx, idx + need);
      idx += need;
    }

    let myW = myWinsBase;
    let oppW = oppWinsBase;

    let startNextBaza = r.tricks.length;
    if (curIsOpen && curTrick) {
      const playedThisBaza = new Set<PlayerId>(curTrick.cards.map((tc) => tc.player));
      const remaining = ([0, 1, 2, 3] as PlayerId[]).filter(
        (p) => !playedThisBaza.has(p),
      );
      const allCards: { player: PlayerId; card: Card }[] = curTrick.cards.map(
        (tc) => ({ player: tc.player, card: tc.card }),
      );
      for (const p of remaining) {
        const h = simHands[p] ?? [];
        if (h.length === 0) continue;
        const top = h.reduce((a, b) => (cardStrength(a) >= cardStrength(b) ? a : b));
        allCards.push({ player: p, card: top });
        simHands[p] = h.filter((c) => c.id !== top.id);
      }
      if (allCards.length > 0) {
        const best = allCards.reduce((a, b) =>
          cardStrength(a.card) >= cardStrength(b.card) ? a : b,
        );
        const allBest = allCards.filter(
          (x) => cardStrength(x.card) === cardStrength(best.card),
        );
        const teamsBest = new Set(allBest.map((x) => teamOf(x.player)));
        if (teamsBest.size === 1) {
          if (teamOf(best.player) === myTeam) myW++;
          else oppW++;
        }
      }
      startNextBaza = r.tricks.length + 1;
    }

    for (let bi = startNextBaza; bi < 3; bi++) {
      const tableCards: { player: PlayerId; card: Card }[] = [];
      for (const p of [0, 1, 2, 3] as PlayerId[]) {
        const h = simHands[p] ?? [];
        if (h.length === 0) continue;
        const top = h.reduce((a, b) => (cardStrength(a) >= cardStrength(b) ? a : b));
        tableCards.push({ player: p, card: top });
        simHands[p] = h.filter((c) => c.id !== top.id);
      }
      if (tableCards.length === 0) break;
      const best = tableCards.reduce((a, b) =>
        cardStrength(a.card) >= cardStrength(b.card) ? a : b,
      );
      const allBest = tableCards.filter(
        (x) => cardStrength(x.card) === cardStrength(best.card),
      );
      const teamsBest = new Set(allBest.map((x) => teamOf(x.player)));
      if (teamsBest.size === 1) {
        if (teamOf(best.player) === myTeam) myW++;
        else oppW++;
      }
      if (myW >= 2 || oppW >= 2) break;
    }

    if (myW > oppW) wins++;
    else if (myW === oppW) {
      if (teamOf(r.mano) === myTeam) wins++;
    }
  }

  return wins / trials;
}
