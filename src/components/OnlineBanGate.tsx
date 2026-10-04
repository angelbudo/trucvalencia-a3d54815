import { useEffect, useState, type ReactNode } from "react";
import { ShieldAlert, Clock, Megaphone, Calendar } from "lucide-react";
import { usePlayerIdentity } from "@/hooks/usePlayerIdentity";
import { useAuthUserId } from "@/hooks/useAuthUserId";
import { useDeviceModeration } from "@/online/useDeviceModeration";
import { useLeaverPenalty } from "@/online/useLeaverPenalty";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useT, resolveReasonText } from "@/i18n/useT";

/** Recuadro destacado con el motivo del baneo y la fecha de emisión. */
export function BanReasonBox({ reason, at, tone = "red", label }: { reason: string; at: number | null; tone?: "red" | "amber"; label?: string }) {
  const t = useT();
  const border = tone === "amber" ? "border-amber-500/70 bg-amber-950/40" : "border-red-500/70 bg-red-950/40";
  const labelCls = tone === "amber" ? "text-amber-300" : "text-red-300";
  const divider = tone === "amber" ? "border-amber-500/30" : "border-red-500/30";
  const dateStr = at ? new Date(at).toLocaleString() : "";
  const resolvedLabel = label ?? t("ban.reason_label");
  const displayReason = resolveReasonText(reason, t);
  return (
    <div className={`rounded-lg border-2 ${border} p-3 mb-4 shadow-inner`}>
      <div className={`text-[11px] font-bold uppercase tracking-wider ${labelCls} mb-1`}>
        {resolvedLabel}
      </div>
      <div className="text-zinc-100 text-base whitespace-pre-line leading-snug">
        {displayReason}
      </div>
      {dateStr && (
        <div className={`mt-2 flex items-center gap-1.5 text-[11px] text-zinc-400 border-t ${divider} pt-2`}>
          <Calendar className="w-3 h-3" aria-hidden="true" />
          <span>{t("ban.issued_on")} <strong className="text-zinc-200">{dateStr}</strong></span>
        </div>
      )}
    </div>
  );
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function closeApp() {
  try {
    window.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      window.location.replace("about:blank");
    } catch {
      /* ignore */
    }
  }, 100);
}

/** Diàleg d'apel·lació DSA: l'usuari escriu un missatge que arriba a
 *  la bandeja del super-admin (taula `admin_alerts`, kind='appeal'). */
export function AppealDialog({
  open,
  onOpenChange,
  deviceId,
  userId,
  reason,
  preview = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  deviceId: string | null;
  userId: string | null;
  reason: string;
  /** Cuando es true, no envía nada al backend (modo catálogo). */
  preview?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const onSubmit = async () => {
    const msg = text.trim();
    if (msg.length < 5) {
      toast.error(t("appeal.too_short"));
      return;
    }
    if (preview) {
      toast.success(t("appeal.sent_ok"));
      setText("");
      onOpenChange(false);
      return;
    }
    setSending(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc("submit_moderation_appeal", {
        p_device_id: deviceId,
        p_user_id: userId,
        p_reason: reason,
        p_message: msg,
      });
      if (error) throw error;
      toast.success(t("appeal.sent_ok"));
      setText("");
      onOpenChange(false);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      toast.error(m || t("appeal.sent_err"));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md w-[calc(100%-3rem)] rounded-2xl border-2 border-primary bg-popover p-6 text-foreground"
        style={preview ? { zIndex: 10002 } : undefined}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center justify-center gap-2 text-primary text-xl font-bold">
            <Megaphone className="w-7 h-7 text-primary" aria-hidden="true" />
            {t("appeal.title")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-left w-full">
            {t("appeal.description")}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
          rows={6}
          placeholder={t("appeal.placeholder")}
          className="bg-background border-border text-foreground"
        />
        <div className="text-xs text-muted-foreground text-right">{text.length}/2000</div>
        <DialogFooter className="flex flex-col sm:flex-col sm:space-x-0">
          <Button
            onClick={onSubmit}
            disabled={sending || text.trim().length < 5}
            className="w-full mb-2 uppercase font-semibold tracking-wide"
          >
            {sending ? t("appeal.sending") : t("appeal.send")}
          </Button>
          <Button
            variant="secondary"
            className="w-full uppercase font-semibold tracking-wide"
            onClick={() => onOpenChange(false)}
            disabled={sending}
          >
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


export type BanVariant = "permanent" | "temporary" | "leaver";

export interface BanScreenViewProps {
  variant: BanVariant;
  reason: string;
  reasonAt: number | null;
  /** Tiempo restante en ms para variante temporary/leaver. */
  remainingMs?: number;
  reportCount?: number;
  banCount?: number;
  /** Callback opcional para "Cerrar app". Por defecto llama a window.close. */
  onCloseApp?: () => void;
  /** Callback opcional para abrir apelación. Si no se pasa, el botón queda inactivo. */
  onAppeal?: () => void;
}

/** Vista presentacional pura de las pantallas de baneo/leaver.
 *  La usa tanto la producción (OnlineBanGate) como el catálogo (DebugMenu). */
export function BanScreenView({
  variant,
  reason,
  reasonAt,
  remainingMs = 0,
  reportCount = 0,
  banCount = 0,
  onCloseApp,
  onAppeal,
}: BanScreenViewProps) {
  const t = useT();
  const handleClose = onCloseApp ?? closeApp;

  if (variant === "leaver") {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-zinc-950 text-white">
        <div className="max-w-md w-full border-2 border-amber-500 rounded-xl p-6 bg-zinc-900 shadow-[0_0_40px_-5px_rgba(245,158,11,0.5)]">
          <div className="flex flex-col items-center justify-center w-full gap-2 text-amber-400 mb-3">
            <div className="flex items-center justify-center gap-2 flex-wrap">
              <Clock className="w-7 h-7" aria-hidden="true" />
              <h1 className="text-xl font-bold text-center leading-tight">{t("leaver.title")}</h1>
            </div>
          </div>
          <p className="text-amber-300 font-semibold mb-2">{t("leaver.reason")}</p>
          <p className="text-zinc-100 mb-4">{t("leaver.body")}</p>
          <div className="text-center text-3xl font-mono tracking-wider text-amber-300 mb-4">
            {formatRemaining(remainingMs)}
          </div>
          <Button
            variant="outline"
            className="w-full mb-2 border-amber-500 text-amber-300 hover:bg-amber-500/10 hover:text-amber-200 uppercase font-semibold tracking-wide"
            onClick={() => onAppeal?.()}
          >
            <Megaphone className="w-4 h-4 mr-2" />
            {t("appeal.button")}
          </Button>
          <Button variant="secondary" className="w-full uppercase font-semibold tracking-wide" onClick={handleClose}>
            {t("ban.close_app")}
          </Button>
        </div>
      </main>
    );
  }

  const body =
    variant === "permanent"
      ? t("ban.permanent")
      : t("ban.temporary", { n: Math.max(0, 3 - banCount) });

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-zinc-950 text-white">
      <div className="max-w-md w-full border-2 border-red-600 rounded-xl p-6 bg-zinc-900 shadow-[0_0_40px_-5px_rgba(239,68,68,0.6)]">
        <div className="flex flex-col items-center justify-center w-full gap-2 text-red-400 mb-3">
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <ShieldAlert className="w-7 h-7" aria-hidden="true" />
            <h1 className="text-xl font-bold text-center leading-tight">{t("ban.title")}</h1>
          </div>
        </div>
        <p className="text-zinc-100 mb-3">{body}</p>
        <BanReasonBox reason={reason} at={reasonAt} tone="red" />
        {variant === "temporary" && (
          <div className="text-center text-3xl font-mono tracking-wider text-red-300 mb-4">
            {formatRemaining(remainingMs)}
          </div>
        )}
        <div className="text-xs text-zinc-400 border-t border-zinc-800 pt-3 mb-4">
          {t("ban.cycle", { r: reportCount, b: banCount })}
        </div>
        <Button
          variant="outline"
          className="w-full mb-2 border-amber-500 text-amber-300 hover:bg-amber-500/10 hover:text-amber-200 uppercase font-semibold tracking-wide"
          onClick={() => onAppeal?.()}
        >
          <Megaphone className="w-4 h-4 mr-2" />
          {t("appeal.button")}
        </Button>
        <Button variant="secondary" className="w-full uppercase font-semibold tracking-wide" onClick={handleClose}>
          {t("ban.close_app")}
        </Button>
      </div>
    </main>
  );
}

/** Bloqueja l'accés online si el dispositiu o la cuenta tenen un baneig
 *  (moderació per comportament) o una suspensió per abandonament reiterat
 *  de partides. Els dos sistemes són independents: el leaver penalty mai
 *  acumula cap al baneig permanent. */
export function OnlineBanGate({ children }: { children: ReactNode }) {
  const { deviceId } = usePlayerIdentity();
  const userId = useAuthUserId();
  const mod = useDeviceModeration(deviceId || null, userId);
  const leaver = useLeaverPenalty(deviceId || null, userId);
  const t = useT();
  const [now, setNow] = useState<number>(() => Date.now());
  const [appealOpen, setAppealOpen] = useState(false);

  const anyTemporary =
    (mod.isBanned && !mod.permanentBan) || leaver.isBanned;

  useEffect(() => {
    if (!anyTemporary) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [anyTemporary]);

  if (!mod.isBanned && !leaver.isBanned) return <>{children}</>;

  const appealReason = mod.permanentBan
    ? "ban_permanent"
    : mod.isBanned
      ? "ban_temporary"
      : "leaver_penalty";

  const dialog = (
    <AppealDialog
      open={appealOpen}
      onOpenChange={setAppealOpen}
      deviceId={deviceId || null}
      userId={userId}
      reason={appealReason}
    />
  );

  const noReason = t("ban.no_reason");

  // Prioritat: baneig permanent > baneig de moderació > suspensió per abandonament.
  if (mod.permanentBan) {
    return (
      <>
        <BanScreenView
          variant="permanent"
          reason={mod.lastNotice || noReason}
          reasonAt={mod.lastNoticeAt}
          reportCount={mod.reportCount}
          banCount={mod.banCount}
          onAppeal={() => setAppealOpen(true)}
        />
        {dialog}
      </>
    );
  }

  if (mod.isBanned) {
    const remaining = mod.bannedUntil ? Math.max(0, mod.bannedUntil - now) : 0;
    return (
      <>
        <BanScreenView
          variant="temporary"
          reason={mod.lastNotice || noReason}
          reasonAt={mod.lastNoticeAt}
          remainingMs={remaining}
          reportCount={mod.reportCount}
          banCount={mod.banCount}
          onAppeal={() => setAppealOpen(true)}
        />
        {dialog}
      </>
    );
  }

  const remainingLeaver = leaver.bannedUntil
    ? Math.max(0, leaver.bannedUntil - now)
    : 0;
  return (
    <>
      <BanScreenView
        variant="leaver"
        reason=""
        reasonAt={null}
        remainingMs={remainingLeaver}
        onAppeal={() => setAppealOpen(true)}
      />
      {dialog}
    </>
  );
}

export default OnlineBanGate;
