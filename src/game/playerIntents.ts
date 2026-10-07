import { teamOf, type Card, type PlayerId, type TrickCard } from "./types";
import { cardStrength } from "./deck";

export type CardHint = "fort" | "molesto" | "tres" | null;

/**
 * Pista de "força de joc" que el company humà transmet al bot
 * a través de les respostes del chat:
 *  - "low":  tira una carta baixa (jo, l'humà, tinc cartes bones de truc).
 *  - "high": tira una carta alta (l'humà no té res; salva la baza tu).
 *  - "free": tu decideixes segons la teua mà (l'humà té algo, però no
 *            necessàriament dominant).
 *  - "vine-a-vore": el jugador (qui rep la pista o qui ha respost) s'ha
 *            compromés a tindre 7 d'oros o un 3. Si la seua carta forta
 *            (7 oros o 3) guanya les cartes de la mesa, ha de jugar-la;
 *            si no, guarda-la per a una baza posterior i tira la més baixa.
 *            Excepció: si totes les cartes de la mesa són < 3 (str<70) i
 *            cap rival ha mostrat força, pot reservar el 7 d'oros i tirar
 *            el 3.
 *  - "vine-al-meu-tres": el jugador ha confirmat tindre un 3 amb context
 *            tàctic favorable (1a baza guanyada o rival ja ha dit "No tinc
 *            res"). Quan li toque, ha de tirar el 3 si guanya la mesa O
 *            si el seu equip ha guanyat la 1a baza i el 3 empata. Si no
 *            pot guanyar ni empatar, guarda el 3 i tira la més baixa.
 *  - "tinc-un-tres": el jugador ha respost "Tinc un 3" (només pot fer-ho
 *            si té un 3 i NO té cap top card: 7 oros, 7 espases, As bastos
 *            o As espases). Mateixa lògica de joc que "vine-al-meu-tres":
 *            tira el 3 si guanya la mesa o si el seu equip ha guanyat la
 *            1a baza i el 3 empata; si no, guarda el 3 i tira la més baixa.
 */
export type PlayStrengthHint = "low" | "high" | "free" | "vine-a-vore" | "vine-al-meu-tres" | "tinc-un-tres" | null;

/**
 * Intents per partida emesos pel jugador humà mitjançant el chat,
 * que afecten les decisions del seu company bot.
 *
 *  - cardHintByTrick[trickIdx]: indicació concreta de quina carta tirar.
 *  - playStrengthByTrick[trickIdx]: pista general de força a jugar.
 *  - silentByTrick[trickIdx]: el company NO ha de cantar truc en eixa baza.
 *  - foldNextTruc: el company ha de rebutjar el pròxim truc pendent.
 */
export interface PartnerIntents {
  cardHintByTrick: Record<number, CardHint>;
  playStrengthByTrick: Record<number, PlayStrengthHint>;
  silentByTrick: Record<number, boolean>;
  foldNextTruc: boolean;
  /**
   * Si l'humà ha dit "Truca!" al company, marquem aquest flag perquè
   * el bot company canti truc de manera proactiva la pròxima vegada
   * que sigui legal (i no estiga `silentByTrick`).
   */
  forceTrucNext: boolean;
  /**
   * Si l'humà ha dit "Envida!" al company, marquem aquest flag perquè
   * el bot company canti envit de manera proactiva la pròxima vegada
   * que sigui legal.
   */
  forceEnvitNext: boolean;
  /** "Tira la falta!": el company ha de cantar falta-envit (si és el 2n de la parella en la 1a baza). */
  forceFaltaNext?: boolean;
  /** "Au! Anem-se'n!": el company dona la mà per perduda (descart baix, sense truc). */
  gaveUpRound?: boolean;
}

export const emptyIntents = (): PartnerIntents => ({
  cardHintByTrick: {},
  playStrengthByTrick: {},
  silentByTrick: {},
  foldNextTruc: false,
  forceTrucNext: false,
  forceEnvitNext: false,
  forceFaltaNext: false,
  gaveUpRound: false,
});

/**
 * Tria una carta concreta segons la indicació "Fica algo fort!".
 * Prioritat: manilla d'oros (7 oros), manilla d'espases (7 espases),
 * As bastos. Si l'equip encara no ha guanyat la primera baza, també As espases.
 */
export function pickFortCard(
  hand: Card[],
  myTeamHasWonFirstTrick: boolean,
): Card | null {
  const order: Array<(c: Card) => boolean> = [
    (c) => c.rank === 7 && c.suit === "oros",
    (c) => c.rank === 7 && c.suit === "espases",
    (c) => c.rank === 1 && c.suit === "bastos",
  ];
  if (!myTeamHasWonFirstTrick) {
    order.push((c) => c.rank === 1 && c.suit === "espases");
  }
  for (const test of order) {
    const found = hand.find(test);
    if (found) return found;
  }
  return null;
}

/**
 * Tria una carta concreta segons la indicació "Fica algo que moleste!".
 * Prioritat: qualsevol 3, després 7 copes o 7 bastos.
 */
export function pickMolestoCard(hand: Card[]): Card | null {
  const tres = hand.find((c) => c.rank === 3);
  if (tres) return tres;
  const set = hand.find(
    (c) => c.rank === 7 && (c.suit === "copes" || c.suit === "bastos"),
  );
  if (set) return set;
  return null;
}

/**
 * Tria un 3 concret per la indicació "Vaig al teu tres!" del company,
 * que demana explícitament que es jugue un 3 a la pròxima baza.
 */
export function pickTresCard(hand: Card[]): Card | null {
  // Si en té més d'un, juga el de pal "fluix" (oros/copes) per guardar el fort.
  const ordered = hand
    .filter((c) => c.rank === 3)
    .sort((a, b) => cardStrength(a) - cardStrength(b));
  return ordered[0] ?? null;
}
// ================= Senyal "Fica algo fort" =================

/** Llindar de força a partir del qual una carta es considera "Top"
 *  (7 oros, 7 espases, As bastos, As espases). */
export const TOP_CARD_THRESHOLD = 85;

/** Carta més alta de la mà segons la força de truc. */
export function getHighestCard(hand: Card[]): Card | null {
  if (hand.length === 0) return null;
  return [...hand].sort((a, b) => cardStrength(b) - cardStrength(a))[0] ?? null;
}

/** Cartes Top de la mà, ordenades de més fluixa a més forta. */
export function getTopCards(hand: Card[]): Card[] {
  return hand
    .filter((c) => cardStrength(c) >= TOP_CARD_THRESHOLD)
    .sort((a, b) => cardStrength(a) - cardStrength(b));
}

/** `true` si `card` supera estrictament totes les cartes RIVALS (no
 *  tapades) ja jugades a la baza. Les cartes del company s'ignoren. */
export function canBeatTable(
  card: Card,
  currentTrickCards: TrickCard[],
  player: PlayerId,
): boolean {
  const myTeam = teamOf(player);
  const rivalMax = currentTrickCards
    .filter((tc) => !tc.covered && teamOf(tc.player) !== myTeam)
    .reduce((mx, tc) => Math.max(mx, cardStrength(tc.card)), -1);
  return cardStrength(card) > rivalMax;
}

/**
 * Tria la carta a jugar per la senyal "Fica algo fort" segons la baza:
 *  - 1a baza: la carta més alta, només si guanya totes les rivals.
 *  - 2a baza: la Top més fluixa que guanye totes les rivals (pot
 *    pisar el company).
 *  - 3a baza: comportament clàssic (`pickFortCard`), sense desperdiciar.
 * Retorna `null` si la instrucció s'ha d'anul·lar (no desperdiciar).
 */
export function pickFortSignalCard(
  hand: Card[],
  trickIdx: number,
  currentTrickCards: TrickCard[],
  player: PlayerId,
  myTeamHasWonFirstTrick: boolean,
): Card | null {
  if (trickIdx === 0) {
    const hi = getHighestCard(hand);
    return hi && canBeatTable(hi, currentTrickCards, player) ? hi : null;
  }
  if (trickIdx === 1) {
    return getTopCards(hand).find((c) => canBeatTable(c, currentTrickCards, player)) ?? null;
  }
  const c = pickFortCard(hand, myTeamHasWonFirstTrick);
  return c && canBeatTable(c, currentTrickCards, player) ? c : null;
}
