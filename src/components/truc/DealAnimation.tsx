import { useEffect, useRef, useState } from "react";
import { PlayerId, nextPlayer } from "@/game/types";
import { PlayingCard } from "./PlayingCard";
import { getMuted } from "@/lib/speech";
import { getAudioCtx } from "@/lib/audioContext";

/**
 * So realista d'una carta lliscant i caient sobre la taula.
 * Combina:
 *  - "Swoosh": soroll rosa filtrat amb un sweep de freqüència (lliscament).
 *  - "Tap": un click greu i curt amb una mica de fusta (impacte sobre la taula).
 * Petita variació aleatòria perquè cada repartiment soni diferent.
 */
function playDealSound() {
  if (getMuted()) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;

    // Bus màster molt suau (volum global molt baix).
    const master = ctx.createGain();
    master.gain.value = 0.045;
    master.connect(ctx.destination);

    // ---- SWOOSH suau (lliscament de paper, sense impacte) ----
    const swooshDur = 0.18 + Math.random() * 0.05;
    const noiseLen = Math.floor(ctx.sampleRate * swooshDur);
    const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const ndata = noiseBuf.getChannelData(0);
    // Soroll rosa per a un timbre càlid i poc agressiu.
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < noiseLen; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.96300 * b1 + white * 0.2965164;
      b2 = 0.57000 * b2 + white * 1.0526913;
      const pink = (b0 + b1 + b2 + white * 0.1848) * 0.16;
      // Envolupant simètrica i suau (fade-in / fade-out): sense pic dur.
      const t = i / noiseLen;
      const env = Math.sin(Math.PI * t) ** 1.6;
      ndata[i] = pink * env;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;

    // Filtre passa-banda amb sweep suau, en un rang més greu/càlid.
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.6;
    bp.frequency.setValueAtTime(380, now);
    bp.frequency.exponentialRampToValueAtTime(1100, now + swooshDur * 0.85);

    // Talla els aguts perquè soni més "abrigat".
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1600;

    const swooshGain = ctx.createGain();
    swooshGain.gain.value = 0.55;

    noise.connect(bp);
    bp.connect(lp);
    lp.connect(swooshGain);
    swooshGain.connect(master);

    noise.start(now);
    noise.stop(now + swooshDur + 0.02);
  } catch {
    // Ignora errors silenciosament.
  }
}

/** Posicions destí indexades per posició relativa des del jugador local. */
const TARGETS_BY_REL: Record<0 | 1 | 2 | 3, { x: string; y: string; rot: string }> = {
  0: { x: "50%", y: "92%", rot: "0deg" },
  1: { x: "100%", y: "42%", rot: "90deg" },
  2: { x: "50%", y: "22%", rot: "180deg" },
  3: { x: "0%", y: "42%", rot: "-90deg" },
};
// Punts d'origen del repartiment: situats DINS del tapete, just on
// aquest jugador deixa les seues cartes a la mesa. Així el vol és curt
// i no envaeix avatars (a dalt) ni la botonera (a baix).
export const ORIGIN_BY_REL: Record<0 | 1 | 2 | 3, { x: string; y: string }> = {
  0: { x: "50%", y: "72%" },
  1: { x: "92%", y: "46%" },
  2: { x: "50%", y: "26%" },
  3: { x: "8%", y: "46%" },
};

interface DealAnimationProps {
  /** Clau que canvia cada vegada que es reparteix una nova mà. */
  dealKey: string;
  dealer: PlayerId;
  mano: PlayerId;
  onCardLanded: (player: PlayerId, indexInHand: number) => void;
  onComplete: () => void;
  /** Seient (0..3) que es mostra a baix. Per defecte 0. */
  perspectiveSeat?: PlayerId;
}

interface FlyingCard {
  id: string;
  player: PlayerId;
  indexInHand: number;
  startedAt: number;
  arrivedAt: number;
  arrived: boolean;
}

const STAGGER_MS = 280;
const FLY_DURATION_MS = 1520;
/** Distància (en px) que recorre el mazo cap al centre de la mesa
 *  abans de començar a repartir. */
const CENTER_DISTANCE_PX = 80;
/** Durada de la fase de centrat pre-reparto. Curta i amb `ease-out`
 *  perquè no hi haja sensació de "parada" abans que arranquen les
 *  cartes: el mazo llisca al centre i, en el mateix moment que arriba,
 *  la primera carta ja està volant cap al jugador mano. */
const CENTER_MS = 390;
/** Solapament: la primera carta comença a volar aquests ms abans que el
 *  centrat acabe del tot, de manera que no hi haja cap frame mort entre
 *  les dues fases. Valor petit perquè el mazo encara es percep quiet al
 *  centre quan la carta ja s'ha desprès. */
const DEAL_OVERLAP_MS = 90;
const DEAL_START_MS = Math.max(0, CENTER_MS - DEAL_OVERLAP_MS);

export function DealAnimation({
  dealKey,
  dealer,
  mano,
  onCardLanded,
  onComplete,
  perspectiveSeat = 0,
}: DealAnimationProps) {
  const [cards, setCards] = useState<FlyingCard[]>([]);
  const [centered, setCentered] = useState(false);
  const completedRef = useRef(false);

  // Mantenim els callbacks en refs perquè el cleanup defensiu (que es
  // dispara si el component es desmunta o el dealKey canvia abans de
  // completar l'animació) puga cridar-los sense haver-los inclòs com a
  // dependències de l'efecte (cosa que el reiniciaria contínuament).
  const onCardLandedRef = useRef(onCardLanded);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCardLandedRef.current = onCardLanded;
    onCompleteRef.current = onComplete;
  }, [onCardLanded, onComplete]);

  useEffect(() => {
    completedRef.current = false;
    setCentered(false);
    // Genera l'ordre de repartiment: 12 cartes (4 jugadors x 3),
    // començant pel mano i en sentit horari.
    const list: FlyingCard[] = [];
    let p: PlayerId = mano;
    const handIdx: Record<PlayerId, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (let i = 0; i < 12; i++) {
      list.push({
        id: `${dealKey}-${i}`,
        player: p,
        indexInHand: handIdx[p]++,
        startedAt: DEAL_START_MS + i * STAGGER_MS,
        arrivedAt: DEAL_START_MS + i * STAGGER_MS,
        arrived: false,
      });
      p = nextPlayer(p);
    }
    setCards(list);

    const timeouts: number[] = [];
    // Fase 2: dispara el centrat al següent frame perquè el CSS transition
    // pugui interpolar des de l'estat inicial (offset 0).
    const raf = window.requestAnimationFrame(() => setCentered(true));
    list.forEach((c) => {
      // So "whoosh" quan la carta surt volant
      timeouts.push(
        window.setTimeout(() => {
          playDealSound();
        }, c.startedAt),
      );
      timeouts.push(
        window.setTimeout(() => {
          onCardLandedRef.current(c.player, c.indexInHand);
          setCards((prev) =>
            prev.map((x) => (x.id === c.id ? { ...x, arrived: true } : x)),
          );
        }, c.arrivedAt),
      );
    });
    const totalMs = DEAL_START_MS + (list.length - 1) * STAGGER_MS + FLY_DURATION_MS + 80;
    timeouts.push(
      window.setTimeout(() => {
        if (completedRef.current) return;
        completedRef.current = true;
        onCompleteRef.current();
      }, totalMs),
    );
    return () => {
      window.cancelAnimationFrame(raf);
      timeouts.forEach((t) => window.clearTimeout(t));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealKey]);

  const relOf = (p: PlayerId) => (((p - perspectiveSeat) + 4) % 4) as 0 | 1 | 2 | 3;
  const origin = ORIGIN_BY_REL[relOf(dealer)];

  // Converteix "50%" → "50vw" / "72%" → "72vh" per poder animar via
  // `transform: translate(...)` sense modificar `left`/`top`. Així el
  // navegador no ha de recalcular layout i el mazo (pila d'origen) no
  // fa cap salt de subpíxel a mig repartiment.
  const pctToVw = (v: string) => v.replace("%", "vw");
  const pctToVh = (v: string) => v.replace("%", "vh");
  // IMPORTANT: la posició base també ha d'usar vw/vh (no %). Amb barra
  // de scroll vertical, 100vw ≠ 100% del contenidor `fixed inset-0` (la
  // diferència són ~15px). Si base usa "%" i el delta usa "vw", en el
  // handoff amb `PassDeckAnimation` (que ara també usa vw/vh) el mazo
  // fa un salt horitzontal. Mantenir tot en vw/vh elimina la fuga.
  const originLeft = pctToVw(origin.x);
  const originTop = pctToVh(origin.y);

  // Rotació de repòs del mazo al lloc del repartidor. Ha de coincidir
  // amb la rotació final de `PassDeckAnimation` (ROT_BY_REL) perquè no
  // hi haja cap salt d'angle en el moment en què el mazo deixa de
  // "traspassar-se" i comença a "repartir".
  const REST_ROT_BY_REL: Record<0 | 1 | 2 | 3, string> = {
    0: "0deg",
    1: "-90deg",
    2: "180deg",
    3: "90deg",
  };
  const restRot = REST_ROT_BY_REL[relOf(dealer)];

  // Vector de centrat: 80px des de l'origen del mazo cap al centre del
  // viewport (aproximació del centre de la mesa). Es calcula amb les
  // dimensions reals de la finestra perquè el desplaçament sigui
  // exactament de 80px en píxels, independent de l'aspect ratio.
  const centerOffset = (() => {
    if (typeof window === "undefined") return { x: 0, y: 0 };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ox = (parseFloat(origin.x) / 100) * vw;
    const oy = (parseFloat(origin.y) / 100) * vh;
    const dx = vw / 2 - ox;
    const dy = vh / 2 - oy;
    const len = Math.hypot(dx, dy) || 1;
    return {
      x: (dx / len) * CENTER_DISTANCE_PX,
      y: (dy / len) * CENTER_DISTANCE_PX,
    };
  })();
  const offX = centered ? centerOffset.x : 0;
  const offY = centered ? centerOffset.y : 0;
  // Inclinació de -25° sincronitzada amb la traslació de centrat. Es
  // manté durant tota la fase de repartiment perquè el mazo conservi
  // la mateixa orientació fins que desapareix.
  const tiltDeg = centered ? -25 : 0;

  return (
    <div
      className="fixed inset-0 z-40 pointer-events-none overflow-y-hidden overflow-x-visible"
      style={{ contain: "layout size" }}
    >
      {cards.map((c) => {
        const target = TARGETS_BY_REL[relOf(c.player)];
        // Desplaçament relatiu (target − origin) expressat en vw/vh.
        const dx = `calc(${pctToVw(target.x)} - ${pctToVw(origin.x)})`;
        const dy = `calc(${pctToVh(target.y)} - ${pctToVh(origin.y)})`;
        const style: React.CSSProperties = c.arrived
          ? {
              left: originLeft,
              top: originTop,
              transform: `translate(-50%, -50%) translate(${dx}, ${dy}) rotate(${target.rot}) scale(0.92)`,
              opacity: 0,
              transition: `transform ${FLY_DURATION_MS}ms ease-out, opacity 120ms ease-out ${FLY_DURATION_MS - 120}ms`,
            }
          : {
              left: originLeft,
              top: originTop,
              // `translateZ(0)` promou la carta a la seua pròpia capa
              // de composició, evitant micro-vibracions d'1-2px per
              // arrodoniment subpíxel en el handoff amb `PassDeckAnimation`.
              transform: `translate(-50%, -50%) translate(${offX}px, ${offY}px) rotate(calc(${restRot} + ${tiltDeg}deg)) scale(1) translateZ(0)`,
              opacity: 1,
              transition: `transform ${CENTER_MS}ms ease-out`,
              transformOrigin: "center center",
              animationDelay: `${c.startedAt}ms`,
            };
        return (
          <div
            key={c.id}
            className="absolute will-change-transform"
            style={style}
          >
            {/* Marc rígid 44×64: mateixes dimensions que les cartes en
                mà (`size="sm"`) i que el mazo de `PassDeckAnimation`.
                Així el bounding box del mazo és idèntic en tot moment
                (repòs → traspàs → repartiment) i no hi ha cap salt de
                subpíxel per canvi de contingut. */}
            <div
              className="card-shadow rounded-card bg-transparent"
              style={{ width: 44, height: 64 }}
            >
              <PlayingCard faceDown size="sm" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
