/**
 * Centralised timings for all chat-bubble flows between bots and the
 * human player. Keeping these in one place avoids inconsistent delays
 * between questions, answers and follow-up questions (e.g. the
 * "quant-envit" flow used to drift because each step picked its own
 * constant).
 *
 * All values are in milliseconds. Any new chat flow MUST import from
 * here instead of redefining its own delays.
 */

// -----------------------------------------------------------------------------
// Base consult timings (used by every "ask partner before playing" flow)
// -----------------------------------------------------------------------------

/** Delay before the bot says its question (gives the table time to settle). */
export const CONSULT_QUESTION_DELAY_MS = 1000;

/** Delay before the (human-targeted) answer bubble is shown.
 *  Regla estricta: exactament 2 s des de la pregunta del company. */
export const CONSULT_ANSWER_DELAY_MS = 2000;

/** Answer delay used when both ends are bots: també 2 s exactes. */
export const CONSULT_BOT_ANSWER_DELAY_MS = 2000;

/** Delay before acting on a completed consult. Regla unificada: 1500 ms
 *  de "reflexió" des que el company respon (o des de qualsevol missatge
 *  del company) abans que el bot tire la carta o execute la seua acció
 *  final. Substitueix els antics 500 / 1000 ms barrejats. */
export const CONSULT_DECIDE_DELAY_MS = 1500;

// -----------------------------------------------------------------------------
// Bubble visual durations
// -----------------------------------------------------------------------------

/** Default lifetime of a chat bubble (must match `usePlayerChat`). */
export const DEFAULT_BUBBLE_DURATION_MS = 4500;

/** Bubble lifetime used for the rival-pair opening of the first trick. */
export const RIVAL_FIRST_TRICK_BUBBLE_MS = 4000;

/** Pre-question delay for the rival-pair opening of the first trick. */
export const RIVAL_FIRST_TRICK_PRE_QUESTION_DELAY_MS = 1000;

// -----------------------------------------------------------------------------
// Wait windows for partner / human inputs
// -----------------------------------------------------------------------------

/** Maximum time a bot waits for a partner reply before deciding. */
export const CONSULT_HUMAN_TIMEOUT_MS = 10000;

/** Finestra d'espera del segon bot d'una parella a la 1a baza quan NO té
 *  envit propi (<30). Regla estricta: 8000 ms exactes per donar temps al
 *  company a cantar envit abans que el bot tire carta. Si el bot té envit
 *  (≥30) i pot cantar-lo, aquesta espera es salta i actua immediatament
 *  (vegeu `mandatoryBotHasHighEnvit` a useTrucMatch.ts). */
export const SECOND_PLAYER_WAIT_MIN_MS = 8000;
export const SECOND_PLAYER_WAIT_MAX_MS = 8000;
export function randomSecondPlayerWaitMs(): number {
  return Math.floor(
    SECOND_PLAYER_WAIT_MIN_MS +
      Math.random() * (SECOND_PLAYER_WAIT_MAX_MS - SECOND_PLAYER_WAIT_MIN_MS + 1),
  );
}

/** Time the opening bot of a pair waits in silence (1st trick) for the
 *  partner's spontaneous info phrase before either playing on his own
 *  or asking "Què tens?" / "Puc anar a tu?". Independent del SECOND_PLAYER_WAIT:
 *  aquesta és una espera del PRIMER de la parella, no del segon. */
export const OPENER_WAIT_FOR_PARTNER_INFO_MS = 1500;

/** Temps mínim que el PRIMER bot de la parella espera a la 1a baza abans
 *  de tirar carta quan hi ha intercanvi amb el company. Regla unificada:
 *  1500 ms — mateix ritme que la resta de reaccions bot↔bot. */
export const FIRST_TRICK_OPENER_MIN_PLAY_MS = 1500;

/** Delay for a spontaneous info phrase during the partner's turn: exactly 3s. */
export const PEU_SPONTANEOUS_INFO_DELAY_MS = 3000;

/** Retard de l'emissor: quan un bot recomana "Envida!" al seu company,
 *  espera 1500 ms des que comença el torn del company abans de llançar
 *  el bocadillo. Aquest timer no ha d'esperar la finestra obligatòria
 *  de joc del peu-bot. */
export const PARTNER_BOT_INSTRUCTION_DELAY_MS = 1500;

/** General-purpose bot action delay (think time before playing a card). */
export const BOT_DELAY_MS = 1000;

/** Hold time of the central response flash ("Vull!" / "No vull"). Bots and
 *  round-end progressions must wait at least this long after a response
 *  shout before continuing, so the message is fully readable. */
export const SHOUT_FLASH_HOLD_MS = 1600;

/** Extra buffer after the flash hides before the next bot action, so the
 *  user clearly sees the cartel disappear before the table moves. */
export const SHOUT_FLASH_BUFFER_MS = 250;

/** Mandatory empty time after any central shout cartel disappears before the
 *  next central cartel may be shown. This is a hard visual invariant: the
 *  centre of the table must never contain two shout cartels at once. */
export const SHOUT_FLASH_GAP_MS = 1000;

/** Minimum spacing between visible table events (cards, shouts and effects). */
export const VISUAL_EVENT_GAP_MS = 1000;

/** Low-latency mode: at most this many bot actions are applied per tick. */
export const LOW_LATENCY_BOT_ACTIONS_PER_TICK = 1;

/** Delay before requesting the next bot tick, leaving animations time to play. */
export const LOW_LATENCY_BOT_TICK_MS = VISUAL_EVENT_GAP_MS;

/** Delay before requesting the new round (which triggers the dealKey and
 *  hence the collect → pass → deal animation chain).
 *
 *  Seqüència visual al final de mà (sense envit acceptat):
 *   - 0 ms: les cartes queden quietes a la mesa.
 *   - 1500 ms: apareixen els cartells de punts i el marcador es commiteja
 *     (gestionat per `TrucBoard` independentment d'aquest delay).
 *   - 1500 → 2500 ms: pausa visual obligatòria d'1 s amb cartes i punts
 *     ja visibles perquè l'usuari els llegisca abans de recollir.
 *   - 2500 ms: arriba el `dealKey` nou i comença la recollida fluida. */
export const LOW_LATENCY_ROUND_END_MS = 2500;

/** Mateixa seqüència però amb envit acceptat: després dels 1,5 s de cartes
 *  quietes es reprodueix la `EnvitReveal` (4,5 s, fins a 6000 ms), i en
 *  acabar la revelació es commitegen els cartells de punts. Es manté
 *  llavors una pausa visual d'1 s amb tot quiet abans de recollir.
 *  1500 + 4500 (reveal) + 1000 (pausa final) = 7000 ms. */
export const LOW_LATENCY_ENVIT_REVEAL_ROUND_END_MS = 7000;

/** How long the bot waits for the human to act on an envit window. */
export const BOT_WAIT_FOR_HUMAN_ENVIT_MS = 5000;

// -----------------------------------------------------------------------------
// "quant-envit" follow-up flow (Sincere mode, doubt zone)
// -----------------------------------------------------------------------------
//
// When a bot asks "Tens envit?" and the partner answers "si" while the
// asking bot sits in the doubtful zone (24-29), the bot follows up with
// "Quant envit tens?" to learn the exact value before deciding.
//
// To avoid the bubbles of question/answer/follow-up overlapping, every
// step of the chain uses delays that are >= CONSULT_ANSWER_DELAY_MS.

/** Delay between the partner's "si" and the bot's "Quant envit tens?". */
export const QUANT_ENVIT_FOLLOWUP_QUESTION_DELAY_MS = Math.max(
  CONSULT_QUESTION_DELAY_MS,
  CONSULT_ANSWER_DELAY_MS,
);

/** Delay between "Quant envit tens?" and the partner's "Tinc {n}". */
export const QUANT_ENVIT_FOLLOWUP_ANSWER_DELAY_MS = Math.max(
  CONSULT_BOT_ANSWER_DELAY_MS,
  CONSULT_ANSWER_DELAY_MS,
);

/** Delay between the partner's "Tinc {n}" and the finalize() decision. */
export const QUANT_ENVIT_FOLLOWUP_FINALIZE_DELAY_MS = Math.max(
  CONSULT_DECIDE_DELAY_MS,
  CONSULT_ANSWER_DELAY_MS,
);

/**
 * Bundled object form of the "quant-envit" follow-up timings, useful for
 * tests and future flows that want to depend on the whole chain at once.
 */
export const QUANT_ENVIT_FOLLOWUP_TIMINGS = {
  questionDelayMs: QUANT_ENVIT_FOLLOWUP_QUESTION_DELAY_MS,
  answerDelayMs: QUANT_ENVIT_FOLLOWUP_ANSWER_DELAY_MS,
  finalizeDelayMs: QUANT_ENVIT_FOLLOWUP_FINALIZE_DELAY_MS,
} as const;
