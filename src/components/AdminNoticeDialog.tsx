import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ShieldAlert, Calendar } from "lucide-react";
import { usePlayerIdentity } from "@/hooks/usePlayerIdentity";
import { useAuthUserId } from "@/hooks/useAuthUserId";
import { useDeviceModeration } from "@/online/useDeviceModeration";
import { Dialog, DialogContent, DialogHeader, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";
import { resolveReasonText } from "@/i18n/useT";

const STORAGE_KEY = "truc:adminNoticeAck:v1";

function readAck(deviceId: string): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY}:${deviceId}`);
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}
function writeAck(deviceId: string, ts: number) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(`${STORAGE_KEY}:${deviceId}`, String(ts)); } catch { /* noop */ }
}

/** Recuadro destacado con el motivo del aviso. Reutilizado por el diálogo
 *  real y por el catálogo de previsualización. */
export function AdminNoticeReasonBox({ reason, at }: { reason: string; at: number | null }) {
  const t = useT();
  const dateStr = at ? new Date(at).toLocaleString() : "";
  const displayReason = resolveReasonText(reason, t);
  return (
    <div className="rounded-lg border-2 border-red-500/70 bg-red-950/40 p-3 my-3 shadow-inner">
      <div className="text-[11px] font-bold uppercase tracking-wider text-red-300 mb-1">
        {t("admin_notice.reason_label")}
      </div>
      <div className="text-zinc-100 text-base whitespace-pre-line leading-snug">
        {displayReason}
      </div>
      {dateStr && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-400 border-t border-red-500/30 pt-2">
          <Calendar className="w-3 h-3" aria-hidden="true" />
          <span>{t("admin_notice.issued_on")} <strong className="text-zinc-200">{dateStr}</strong></span>
        </div>
      )}
    </div>
  );
}

export interface AdminNoticeViewProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  reason: string;
  at: number | null;
  reportCount: number;
  banCount: number;
  bannedUntil: number | null;
  permanentBan: boolean;
}

/** Vista presentacional del diálogo "Aviso del Administrador".
 *  La usan tanto el diálogo real (AdminNoticeDialog) como el catálogo (DebugMenu). */
export function AdminNoticeView({
  open,
  onOpenChange,
  reason,
  at,
  reportCount,
  banCount,
  bannedUntil,
  permanentBan,
}: AdminNoticeViewProps) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md w-[calc(100%-3rem)] rounded-2xl border-2 border-red-600 bg-zinc-950 p-6 text-white shadow-[0_0_40px_-5px_rgba(239,68,68,0.6)]">
        <DialogHeader className="flex flex-col items-center justify-center w-full gap-2">
          <div className="flex items-center justify-center gap-2 flex-wrap text-red-400">
            <ShieldAlert className="w-7 h-7" aria-hidden="true" />
            <DialogPrimitive.Title asChild>
              <h1 className="text-xl font-bold text-center leading-tight">
                {t("admin_notice.title")}
              </h1>
            </DialogPrimitive.Title>
          </div>
        </DialogHeader>
        <AdminNoticeReasonBox reason={reason} at={at} />
        <div className="text-xs text-zinc-400 border-t border-zinc-800 pt-3">
          {t("admin_notice.reports_in_cycle")}: <strong>{reportCount}/3</strong>
          {" · "}{t("admin_notice.bans_consumed")}: <strong>{banCount}/3</strong>
          {bannedUntil && !permanentBan && (
            <> {" · "}{t("admin_notice.suspended_until")}: <strong>{new Date(bannedUntil).toLocaleString()}</strong></>
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="destructive" className="uppercase font-semibold tracking-wide">
            {t("admin_notice.ack")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Diàleg modal "Aviso del Administrador". S'obre automàticament quan arriba
 * un `last_notice` nou per al dispositiu actual. L'usuari ha de confirmar
 * per tancar-lo i el seu timestamp queda registrat a `localStorage` per no
 * reaparèixer.
 */
export function AdminNoticeDialog() {
  const { deviceId } = usePlayerIdentity();
  const userId = useAuthUserId();
  const mod = useDeviceModeration(deviceId || null, userId);
  const [open, setOpen] = useState(false);
  const [shownNotice, setShownNotice] = useState<string>("");
  const [shownAt, setShownAt] = useState<number | null>(null);

  useEffect(() => {
    if (!deviceId || !mod.loaded || !mod.lastNotice || !mod.lastNoticeAt) return;
    const ack = readAck(deviceId);
    if (mod.lastNoticeAt > ack) {
      setShownNotice(mod.lastNotice);
      setShownAt(mod.lastNoticeAt);
      setOpen(true);
    }
  }, [deviceId, mod.loaded, mod.lastNotice, mod.lastNoticeAt]);

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      if (deviceId && mod.lastNoticeAt) writeAck(deviceId, mod.lastNoticeAt);
      setOpen(false);
    }
  };

  return (
    <AdminNoticeView
      open={open}
      onOpenChange={handleOpenChange}
      reason={shownNotice}
      at={shownAt}
      reportCount={mod.reportCount}
      banCount={mod.banCount}
      bannedUntil={mod.bannedUntil}
      permanentBan={mod.permanentBan}
    />
  );
}

export default AdminNoticeDialog;
