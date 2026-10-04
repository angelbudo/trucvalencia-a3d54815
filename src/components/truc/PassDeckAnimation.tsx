import { useEffect, useRef, useState } from "react";
import { PlayerId } from "@/game/types";
import { ORIGIN_BY_REL } from "./DealAnimation";
import { PlayingCard } from "./PlayingCard";
import { getMuted } from "@/lib/speech";
import { getAudioCtx } from "@/lib/audioContext";

/** So suau de paquet de cartes lliscant per la taula. */
function playPassDeckSound() {
  if (getMuted()) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const dur = 0.55;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.96300 * b1 + white * 0.2965164;
      b2 = 0.57000 * b2 + white * 1.0526913;
      const pink = (b0 + b1 + b2 + white * 0.1848) * 0.18;
      const t = i / len;
      // Atac suau, sosteniment durant el lliscament i caiguda al final.
      const env = Math.pow(t, 0.35) * Math.pow(1 - t, 1.1) * 3.0;
      data[i] = pink * env;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(900, now);
    bp.frequency.exponentialRampToValueAtTime(1600, now + dur * 0.85);
    bp.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0.09;
    noise.connect(bp);
    bp.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
    noise.stop(now + dur + 0.02);

    // Petit "tap" final quan el mazo arriba al repartidor.
    const tapStart = now + dur * 0.92;
    const tapDur = 0.06;
    const tapLen = Math.floor(ctx.sampleRate * tapDur);
    const tapBuf = ctx.createBuffer(1, tapLen, ctx.sampleRate);
    const tdata = tapBuf.getChannelData(0);
    for (let i = 0; i < tapLen; i++) {
      const t = i / tapLen;
      const env = Math.exp(-t * 30);
      const tone = Math.sin(2 * Math.PI * 95 * (i / ctx.sampleRate));
      tdata[i] = (tone * 0.7 + (Math.random() * 2 - 1) * 0.45) * env;
    }
    const tap = ctx.createBufferSource();
    tap.buffer = tapBuf;
    const tapGain = ctx.createGain();
    tapGain.gain.value = 0.5;
    tap.connect(tapGain);
    tapGain.connect(ctx.destination);
    tap.start(tapStart);
    tap.stop(tapStart + tapDur + 0.02);
  } catch {
    // Ignora errors silenciosament.
  }
}

/**
 * Rotació del mazo segons la posició relativa. Aquesta és una propietat
 * visual del mazo i no forma part dels punts d'origen del repartiment.
 * Les coordenades (x, y) es reutilitzen directament d'`ORIGIN_BY_REL`
 * de `DealAnimation`: el mazo aterra exactament on es genera la carta
 * inicial del repartiment per a cada jugador.
 */
const ROT_BY_REL: Record<0 | 1 | 2 | 3, string> = {
  0: "0deg",
  1: "-90deg",
  2: "180deg",
  3: "90deg",
};

interface PassDeckAnimationProps {
  /** Clau única — canvia entre repartiments. */
  passKey: string;
  /** El nou repartidor (qui rebrà el mazo). */
  dealer: PlayerId;
  /** Seient (0..3) en perspectiva inferior. Per defecte 0. */
  perspectiveSeat?: PlayerId;
  /** Notifica que l'animació ha acabat. */
  onComplete: () => void;
}

const FLY_DURATION_MS = 1300;
/** Nombre de cartes que dibuixem apilades per simular el mazo. */
const DECK_VISUAL_CARDS = 5;

/**
 * Anima un petit "mazo" (pila de cartes boca avall) que llisca des del
 * jugador situat a la dreta del repartidor (= dealer anterior, qui
 * acaba de repartir) cap al nou repartidor. En sentit antihorari per
 * a passar el torn de repartir, com es fa físicament.
 */
export function PassDeckAnimation({
  passKey,
  dealer,
  perspectiveSeat = 0,
  onComplete,
}: PassDeckAnimationProps) {
  const [phase, setPhase] = useState<"start" | "fly">("start");
  const completedRef = useRef(false);

  const relOf = (p: PlayerId) => (((p - perspectiveSeat) + 4) % 4) as 0 | 1 | 2 | 3;
  // L'origen és el jugador anterior al dealer (qui li passa el mazo).
  const prevDealer = (((dealer - 1) + 4) % 4) as PlayerId;
  const originPos = ORIGIN_BY_REL[relOf(prevDealer)];
  const targetPos = ORIGIN_BY_REL[relOf(dealer)];
  const originRot = ROT_BY_REL[relOf(prevDealer)];
  const targetRot = ROT_BY_REL[relOf(dealer)];

  useEffect(() => {
    completedRef.current = false;
    const raf = window.requestAnimationFrame(() => {
      setPhase("fly");
      playPassDeckSound();
    });
    const t = window.setTimeout(() => {
      if (completedRef.current) return;
      completedRef.current = true;
      onComplete();
    }, FLY_DURATION_MS + 120);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passKey]);

  // IMPORTANT: la posició base també ha d'usar vw/vh (no %). Amb barra
  // de scroll vertical, 100vw ≠ 100% del contenidor `fixed inset-0`; si
  // barregem "%" per a la base i "vw" per al delta, el mazo salta ~15px
  // en el handoff amb `DealAnimation`. Mantenim tot en vw/vh.
  const pctToVw = (v: string) => v.replace("%", "vw");
  const pctToVh = (v: string) => v.replace("%", "vh");
  const dx = `calc(${pctToVw(targetPos.x)} - ${pctToVw(originPos.x)})`;
  const dy = `calc(${pctToVh(targetPos.y)} - ${pctToVh(originPos.y)})`;

  const flyTransform = `translate(-50%, -50%) translate(${dx}, ${dy}) rotate(${targetRot})`;
  const restTransform = `translate(-50%, -50%) rotate(${originRot})`;

  const containerStyle: React.CSSProperties = {
    left: pctToVw(originPos.x),
    top: pctToVh(originPos.y),
    // `translateZ(0)` força una capa de composició pròpia al GPU, cosa
    // que evita micro-vibracions per arrodoniment subpíxel en el
    // handoff amb `DealAnimation`.
    transform: (phase === "fly" ? flyTransform : restTransform) + " translateZ(0)",
    willChange: "transform",
    backfaceVisibility: "hidden",
    transition:
      phase === "fly"
        ? `transform ${FLY_DURATION_MS}ms cubic-bezier(0.45, 0.05, 0.35, 1)`
        : "none",
  };

  return (
    <div
      className="fixed inset-0 z-40 pointer-events-none overflow-y-hidden overflow-x-visible"
      style={{ contain: "layout size" }}
    >
      <div className="absolute will-change-transform" style={containerStyle}>
        {/* Pila de cartes lleugerament desplaçades per simular volum. */}
        {/* Marc rígid 44×64 (mateixa mida que `size="sm"` i que les
            cartes en mà). El bounding box del mazo no depén del
            contingut ni del nombre de cartes visibles: sempre ocupa el
            mateix rectangle ancorat al centre via `translate(-50%,-50%)`. */}
        <div className="relative" style={{ width: 44, height: 64 }}>
          {Array.from({ length: DECK_VISUAL_CARDS }).map((_, i) => {
            // Totes les cartes apilades exactament al mateix punt
            // (0,0) sense offset ni rotació. Així el bounding box del
            // mazo és idèntic al de `DealAnimation` (que també apila
            // totes les cartes al mateix punt en repòs) i no hi ha
            // cap salt visual d'1-2px en el moment del handoff entre
            // les dues animacions.
            const cardStyle: React.CSSProperties = {
              position: "absolute",
              left: 0,
              top: 0,
            };
            return (
              <div key={i} style={cardStyle} className="card-shadow rounded-card bg-transparent">
                <PlayingCard faceDown size="sm" />
              </div>
            );
          })}
        </div>

      </div>
    </div>
  );
}
