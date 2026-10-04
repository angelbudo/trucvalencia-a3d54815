import { useState } from "react";
import { useLocation } from "react-router-dom";
import { X, Wrench } from "lucide-react";
import { AdminNoticeView } from "@/components/AdminNoticeDialog";
import {
  BanScreenView,
  AppealDialog,
  type BanVariant,
} from "@/components/OnlineBanGate";
import { EndGameOverlay } from "@/components/truc/EndGameOverlay";
import type { PlayerId } from "@/game/types";

type Preview = null | "ban_permanent" | "ban_temporary" | "ban_leaver" | "notice" | "endgame";

/**
 * Menú flotant per previsualitzar pantalles crítiques (baneig, avís
 * d'administrador, pantalla final).
 *
 * IMPORTANT: aquest catàleg renderitza els components REALS de producció
 * amb dades fictícies. No conté maquetes duplicades. Qualsevol canvi als
 * fitxers `OnlineBanGate.tsx`, `AdminNoticeDialog.tsx` o `EndGameOverlay.tsx`
 * s'ha de veure aquí automàticament.
 */
export function DebugMenu() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview>(null);
  const location = useLocation();
  const isHome = location.pathname === "/";

  const close = () => setPreview(null);

  return (
    <>
      {isHome && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="fixed top-5 left-5 w-14 h-14 rounded-full bg-zinc-700/80 hover:bg-zinc-600/90 text-zinc-100 border border-zinc-500/60 backdrop-blur-sm shadow-lg flex items-center justify-center transition-transform hover:scale-110 hover:border-zinc-400"
          style={{ zIndex: 9999 }}
          aria-label="Menú de depuració"
        >
          <Wrench className="w-6 h-6" />
        </button>
      )}

      {open && (
        <div
          className="fixed top-24 left-5 w-64 rounded-lg bg-zinc-900/95 border border-zinc-700 shadow-xl p-2 flex flex-col gap-1 text-zinc-100"
          style={{ zIndex: 9999 }}
        >
          <div className="px-2 py-1 text-xl font-bold text-center leading-tight text-zinc-400 border-b border-zinc-800 mb-1">
            Previsualitzar pantalles (component real)
          </div>
          <MenuItem label="🚫 Baneig temporal" onClick={() => { setPreview("ban_temporary"); setOpen(false); }} />
          <MenuItem label="⛔ Baneig permanent" onClick={() => { setPreview("ban_permanent"); setOpen(false); }} />
          <MenuItem label="⏱ Leaver penalty" onClick={() => { setPreview("ban_leaver"); setOpen(false); }} />
          <MenuItem label="📣 Avís admin" onClick={() => { setPreview("notice"); setOpen(false); }} />
          <MenuItem label="🏆 Pantalla final" onClick={() => { setPreview("endgame"); setOpen(false); }} />
        </div>
      )}

      {preview && preview.startsWith("ban_") && (
        <BanPreview variant={preview.slice(4) as BanVariant} onClose={close} />
      )}
      {preview === "notice" && <NoticePreview onClose={close} />}
      {preview === "endgame" && <EndGamePreview onClose={close} />}
    </>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      className="text-left px-2 py-1.5 rounded hover:bg-zinc-800 text-sm"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      className="fixed top-4 right-4 h-10 w-10 rounded-full bg-black/70 hover:bg-black text-white flex items-center justify-center border border-white/20 shadow-lg pointer-events-auto"
      style={{ zIndex: 10001 }}
      aria-label="Tancar previsualització"
    >
      <X className="w-5 h-5" />
    </button>
  );
}

/** Renderitza `BanScreenView` real amb dades fictícies. */
function BanPreview({ variant, onClose }: { variant: BanVariant; onClose: () => void }) {
  const [appealOpen, setAppealOpen] = useState(false);
  const sampleAt = Date.now() - 1000 * 60 * 30;
  const sampleReason =
    variant === "permanent"
      ? "i18n:strike.reason.perm.acoso"
      : "i18n:strike.reason.temp.llenguatge";


  const handleAppealClick = () => {
    // eslint-disable-next-line no-console
    console.log("[DebugMenu] Apelar sanción clic → obriendo AppealDialog", { variant });
    setAppealOpen(true);
  };

  return (
    <>
      <div className="fixed inset-0 overflow-y-auto" style={{ zIndex: 10000 }}>
        <BanScreenView
          variant={variant}
          reason={sampleReason}
          reasonAt={sampleAt}
          remainingMs={variant === "leaver" ? 6 * 3600 * 1000 : 83 * 60 * 1000}
          reportCount={2}
          banCount={1}
          onAppeal={handleAppealClick}
          onCloseApp={onClose}
        />
        <CloseButton onClose={onClose} />
      </div>
      {/* AppealDialog fora del wrapper fixed: Radix el porta al <body>,
          i li forcem z-index alt via prop `preview` per superar el wrapper. */}
      <AppealDialog
        open={appealOpen}
        onOpenChange={setAppealOpen}
        deviceId={null}
        userId={null}
        reason={`preview_${variant}`}
        preview
      />
    </>
  );
}


/** Renderitza `AdminNoticeView` real amb dades fictícies. */
function NoticePreview({ onClose }: { onClose: () => void }) {
  return (
    <>
      <AdminNoticeView
        open
        onOpenChange={(v) => { if (!v) onClose(); }}
        reason="i18n:strike.reason.warn.general"
        at={Date.now() - 1000 * 60 * 5}
        reportCount={2}
        banCount={1}
        bannedUntil={null}
        permanentBan={false}
      />
      <CloseButton onClose={onClose} />
    </>
  );
}

/** Renderitza `EndGameOverlay` real amb dades fictícies. */
function EndGamePreview({ onClose }: { onClose: () => void }) {
  const names: Record<PlayerId, string> = {
    0: "Tu",
    1: "Rival 1",
    2: "Company",
    3: "Rival 2",
  };
  return (
    <>
      <EndGameOverlay
        open
        winnerTeam="nos"
        playerNamesBySeat={names}
        camesWon={{ nos: 2, ells: 1 }}
        onNewGame={onClose}
        onAbandon={onClose}
      />
      <CloseButton onClose={onClose} />
    </>
  );
}

export default DebugMenu;
