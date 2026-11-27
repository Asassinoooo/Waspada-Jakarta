// PERF-09: the access gate screen and the session placeholders. Loaded lazily (protected routes and the account pages).
import type { AccountSessionState } from "./AccountPages.js";
import { hasProtectedShellAccess, type ProtectedShell } from "./account-access.js";

export function SessionLoading({ label = "Memeriksa sesi akun…" }: { label?: string }) {
  return (
    <section className="state-panel state-panel--loading" role="status" aria-live="polite">
      <strong>{label}</strong>
      <span>Peta dan laporan publik tetap dapat dibuka selama pemeriksaan ini.</span>
      <div className="skeleton-stack" aria-hidden="true">
        <span className="skeleton" />
        <span className="skeleton skeleton--short" />
      </div>
    </section>
  );
}

export function SessionUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="state-panel state-panel--error" role="alert">
      <strong>Status akun belum dapat diperiksa.</strong>
      <p>Fitur akun memerlukan layanan sesi. Peta dan laporan publik tetap tersedia.</p>
      <div className="account-actions">
        <button className="button button--quiet" type="button" onClick={onRetry}>Coba lagi</button>
        <a className="button button--primary" href="#peta">Buka peta dan laporan</a>
      </div>
    </section>
  );
}

/**
 * Gate for protected screens. `isNarrowScreen` is accepted for callers but no longer changes the gate:
 * the admin workspace is responsive (UI-V2-C), and the server enforces the role on every request.
 */
export function AccountAccessGate({
  shell,
  sessionState,
  onRefreshSession,
}: {
  shell: ProtectedShell;
  sessionState: AccountSessionState;
  isNarrowScreen: boolean;
  onRefreshSession: () => void;
}) {
  if (sessionState.status === "loading") return <main id="main-content" tabIndex={-1} className="main-shell account-page"><SessionLoading label="Memeriksa izin sesi…" /></main>;
  if (sessionState.status === "error") return <main id="main-content" tabIndex={-1} className="main-shell account-page"><SessionUnavailable onRetry={onRefreshSession} /></main>;
  if (sessionState.status === "anonymous") {
    return <main id="main-content" tabIndex={-1} className="main-shell account-page">
      <section className="account-card" role="status">
        <h1>Sesi diperlukan</h1>
        <p>{shell === "admin" ? "Ruang administrator hanya tersedia untuk akun administrator yang masuk." : "Tampilan tinjau hanya tersedia untuk akun moderator atau administrator yang masuk."}</p>
        <div className="account-actions" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", alignItems: "flex-start" }}>
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            <a className="button button--quiet" href="#masuk">Masuk dengan nama pengguna</a>
            <a className="button button--quiet" href="#peta">Kembali ke layanan publik</a>
          </div>
        </div>
      </section>
    </main>;
  }
  if (!hasProtectedShellAccess(shell, sessionState.session)) {
    return <main id="main-content" tabIndex={-1} className="main-shell account-page">
      <section className="account-card" role="alert">
        <h1>Akses tidak tersedia</h1>
        <p>Sesi saat ini tidak memiliki peran yang diperlukan untuk membuka tampilan ini.</p>
        <div className="account-actions"><a className="button button--quiet" href="#akun">Lihat akun</a><a className="button button--primary" href="#peta">Kembali ke layanan publik</a></div>
      </section>
    </main>;
  }
  return null;
}
