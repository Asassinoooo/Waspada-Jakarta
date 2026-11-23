import { useEffect, useState } from "react";
import {
  notificationPermission,
  NOTIFY_CHANGE_EVENT,
  readNotifyEnabled,
  writeNotifyEnabled,
  type NotifyPermission,
} from "./interest-notifications.js";
import type { PreferencesStorage } from "./preferences-store.js";

export const NOTIFY_INTRO =
  "Kami memberi tahu saat laporan yang cocok dengan minat Anda terbit atau diperbarui. Pencocokan dilakukan di browser ini; minat Anda tidak dikirim ke layanan.";
export const NOTIFY_TAB_NOTE = "Notifikasi hanya berjalan selama tab Waspada Jakarta terbuka dan berhenti saat tab ditutup.";
export const NOTIFY_NOT_EMERGENCY = "Ini bukan peringatan darurat. Dalam keadaan darurat, hubungi 112.";

export interface NotificationSettingsProps {
  storage: PreferencesStorage | null;
  /** True when at least one interest is saved; notifications have nothing to match without one. */
  hasInterests: boolean;
  /** The updates feed serves live data only. */
  live: boolean;
  /** Test seam for the browser permission. */
  permission?: NotifyPermission;
}

type Status = "unsupported" | "not-live" | "no-interests" | "denied" | "off" | "on";

function statusOf(permission: NotifyPermission, enabled: boolean, hasInterests: boolean, live: boolean): Status {
  if (permission === "unsupported") return "unsupported";
  if (!live) return "not-live";
  if (!hasInterests) return "no-interests";
  if (permission === "denied") return "denied";
  return enabled && permission === "granted" ? "on" : "off";
}

/** NOTIFY-01: the "Area saya" notification switch. Off until the person turns it on and the browser allows it. */
export function NotificationSettings({ storage, hasInterests, live, permission: permissionOverride }: NotificationSettingsProps) {
  const [permission, setPermission] = useState<NotifyPermission>(() => permissionOverride ?? notificationPermission());
  const [enabled, setEnabled] = useState(() => readNotifyEnabled(storage));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => setEnabled(readNotifyEnabled(storage));
    window.addEventListener(NOTIFY_CHANGE_EVENT, sync);
    return () => window.removeEventListener(NOTIFY_CHANGE_EVENT, sync);
  }, [storage]);

  const status = statusOf(permission, enabled, hasInterests, live);

  async function turnOn() {
    setBusy(true);
    setMessage(null);
    let next = permission;
    if (next === "default" && typeof window !== "undefined" && window.Notification) {
      try {
        const answer = await window.Notification.requestPermission();
        next = answer === "granted" || answer === "denied" ? answer : "default";
      } catch {
        next = notificationPermission();
      }
    }
    setPermission(next);
    if (next === "granted") {
      if (writeNotifyEnabled(storage, true)) {
        setEnabled(true);
        setMessage("Notifikasi aktif untuk tab ini.");
      } else {
        setMessage("Pengaturan tidak dapat disimpan di browser ini.");
      }
    } else if (next === "denied") {
      setMessage("Browser menolak izin notifikasi.");
    }
    setBusy(false);
  }

  function turnOff() {
    writeNotifyEnabled(storage, false);
    setEnabled(false);
    setMessage("Notifikasi dimatikan.");
  }

  return (
    <section className="notify-card" aria-labelledby="notify-title" data-status={status}>
      <div className="notify-card__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      </div>
      <div className="notify-card__body">
        <div className="notify-card__head">
          <h2 id="notify-title">Notifikasi area saya</h2>
          <span className={`notify-card__state notify-card__state--${status === "on" ? "on" : "off"}`}>
            {status === "on" ? "Aktif" : "Mati"}
          </span>
        </div>
        <p>{NOTIFY_INTRO}</p>
        <p className="notify-card__note">{NOTIFY_TAB_NOTE} {NOTIFY_NOT_EMERGENCY}</p>

        {status === "unsupported" && <p className="notify-card__hint">Browser ini tidak mendukung notifikasi.</p>}
        {status === "not-live" && <p className="notify-card__hint">Notifikasi hanya tersedia untuk data langsung, bukan data contoh.</p>}
        {status === "no-interests" && <p className="notify-card__hint">Simpan minimal satu minat di bawah agar ada yang bisa dicocokkan.</p>}
        {status === "denied" && (
          <p className="notify-card__hint">
            Notifikasi diblokir di pengaturan browser. Izinkan notifikasi untuk situs ini dari ikon di sebelah alamat, lalu muat ulang halaman.
          </p>
        )}

        <div className="notify-card__actions">
          {status === "on" ? (
            <button type="button" className="button button--quiet" onClick={turnOff}>
              Matikan notifikasi
            </button>
          ) : (
            <button
              type="button"
              className="button"
              onClick={() => void turnOn()}
              disabled={busy || status !== "off"}
            >
              {busy ? "Meminta izin…" : "Aktifkan notifikasi"}
            </button>
          )}
        </div>
        {message && <p className="notify-card__message" role="status">{message}</p>}
      </div>
    </section>
  );
}
