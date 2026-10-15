import { useEffect, useState } from "react";
import type { AccountRole, AccountUser, AccountUserUpdate, SessionEnvelope } from "@waspada/worker/account-contracts";
import {
  AccountHttpError,
  accountClient,
  type AccountClient,
  type AccountReturnTarget,
} from "./account-client.js";

export type AccountSessionState =
  | { status: "loading"; session: null }
  | { status: "anonymous"; session: SessionEnvelope }
  | { status: "authenticated"; session: SessionEnvelope }
  | { status: "error"; session: null };

export interface AccountPageProps {
  screen: "login" | "onboarding" | "account";
  sessionState: AccountSessionState;
  returnTo?: AccountReturnTarget;
  isNarrowScreen: boolean;
  onRefreshSession: () => void;
  client?: AccountClient;
  confirmUpdate?: (user: AccountUser, update: AccountUserUpdate) => boolean;
}

function roleLabel(role: AccountRole): string {
  switch (role) {
    case "user": return "Pengguna";
    case "moderator": return "Moderator";
    case "admin": return "Administrator";
  }
}

function isHttpStatus(error: unknown, status: number): boolean {
  return error instanceof AccountHttpError && error.status === status;
}

export function adminUpdateErrorMessage(error: unknown): "conflict" | "authorization" | "unavailable" {
  if (isHttpStatus(error, 409)) return "conflict";
  if (isHttpStatus(error, 401) || isHttpStatus(error, 403)) return "authorization";
  return "unavailable";
}

function AccountFrame({ children, title, kicker = "Akun · Waspada Jakarta" }: { children: React.ReactNode; title: string; kicker?: string }) {
  return (
    <main id="main-content" tabIndex={-1} className="main-shell account-page">
      <header className="account-page__intro">
        <p className="experience-kicker">{kicker}</p>
        <h1>{title}</h1>
      </header>
      {children}
    </main>
  );
}

function SessionLoading({ label = "Memeriksa sesi akun…" }: { label?: string }) {
  return (
    <section className="state-panel state-panel--loading" role="status" aria-live="polite">
      <strong>{label}</strong>
      <span>Peta dan laporan publik tetap dapat dibuka selama pemeriksaan ini.</span>
    </section>
  );
}

function SessionUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="state-panel state-panel--error" role="alert">
      <strong>Status akun belum dapat diperiksa.</strong>
      <p>Fitur akun memerlukan layanan sesi. Peta dan laporan publik tetap tersedia.</p>
      <div className="account-actions">
        <button className="button button--quiet" type="button" onClick={onRetry}>Coba lagi</button>
        <a className="button button--primary" href="#jelajah">Buka peta dan laporan</a>
      </div>
    </section>
  );
}

function GoogleLogin({
  sessionState,
  returnTo,
  onRefreshSession,
  client,
}: {
  sessionState: AccountSessionState;
  returnTo: AccountReturnTarget;
  onRefreshSession: () => void;
  client: AccountClient;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loginAvailable = sessionState.status === "anonymous" && sessionState.session.google_login_available;
  const callbackFailed = typeof window !== "undefined" && (
    new URLSearchParams(window.location.search).get("login") === "failed" ||
    (window.location.hash.startsWith("#masuk?") && new URLSearchParams(window.location.hash.slice("#masuk?".length)).get("login") === "failed")
  );

  async function startLogin() {
    setWorking(true);
    setError(null);
    try {
      const url = await client.startGoogleLogin(returnTo);
      window.location.assign(url);
    } catch {
      setError("Google belum dapat membuka sesi masuk. Coba lagi atau lanjutkan tanpa akun.");
      setWorking(false);
    }
  }

  if (sessionState.status === "loading") return <SessionLoading />;
  if (sessionState.status === "error") return <SessionUnavailable onRetry={onRefreshSession} />;
  if (sessionState.status === "authenticated") {
    return (
      <section className="account-card" role="status">
        <h2>Anda sudah masuk</h2>
        <p>Profil akun tersedia. Lanjutkan ke halaman akun untuk melihat peran dan status onboarding.</p>
        <a className="button button--primary" href="#akun">Buka akun</a>
      </section>
    );
  }

  return (
    <div className="account-flow">
      <section className="account-card" aria-labelledby="login-title">
        <h2 id="login-title">Masuk dengan Google</h2>
        <p>Masuk bersifat opsional. Peta, laporan publik, riwayat, dan minat lokal tetap dapat digunakan tanpa akun.</p>
        {callbackFailed && <p className="account-message account-message--error" role="status">Proses masuk belum selesai. Tidak ada sesi baru yang dibuat; Anda dapat mencoba lagi.</p>}
        {error && <p className="account-message account-message--error" role="alert">{error}</p>}
        {loginAvailable
          ? <button className="button button--primary" type="button" onClick={() => void startLogin()} disabled={working}>{working ? "Membuka Google…" : "Lanjutkan dengan Google"}</button>
          : <p className="account-message" role="status">Masuk Google belum disiapkan pada layanan ini.</p>}
      </section>
      <section className="account-card account-card--quiet">
        <h2>Ingin melihat pengenalan singkat?</h2>
        <p>Tiga langkah berikut menjelaskan status laporan, minat lokal, dan privasi. Akun tidak diperlukan.</p>
        <a className="text-link" href="#mulai">Baca pengenalan</a>
      </section>
      <p className="account-privacy-link">Baca <a className="text-link" href="#privasi">panduan privasi</a> sebelum masuk.</p>
    </div>
  );
}

export const ACCOUNT_ONBOARDING_STEPS = [
  {
    title: "Status laporan punya arti berbeda",
    body: "Status kejadian, kesegaran informasi, dan keputusan peninjauan adalah hal yang terpisah. Informasi yang kedaluwarsa tidak membuktikan keadaan fisik sudah aman atau kejadian telah selesai.",
  },
  {
    title: "Minat tetap di browser Anda",
    body: "Anda dapat menyimpan kategori minat di perangkat ini untuk membuat ringkasan. Waspada tidak meminta lokasi perangkat dan tidak mengirim minat secara otomatis.",
  },
  {
    title: "Selesaikan pengenalan tanpa mengirim minat",
    body: "Untuk akun yang dibuat melalui Google resmi, layanan menyimpan issuer dan subject sebagai identitas akun, nama dan email, peran yang ditetapkan server, sesi akun, serta versi dan waktu penyelesaian pengenalan. Persetujuan pada demo lokal bersifat sintetis dan tidak menghubungi Google. Minat tetap di browser dan tidak dikirim saat masuk.",
  },
] as const;

function Onboarding({
  sessionState,
  onRefreshSession,
  client,
}: {
  sessionState: AccountSessionState;
  onRefreshSession: () => void;
  client: AccountClient;
}) {
  const [step, setStep] = useState(0);
  const [working, setWorking] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authenticatedUser = sessionState.status === "authenticated" ? sessionState.session.user : null;
  const csrfToken = sessionState.status === "authenticated" ? sessionState.session.csrf_token : null;
  const sessionUnavailable = sessionState.status === "error";

  if (sessionState.status === "loading") return <SessionLoading />;
  if (authenticatedUser?.onboarding_version === 1 || completed) {
    return (
      <section className="account-card" role="status">
        <h2>Pengenalan akun selesai</h2>
        <p>Versi pengenalan akun sudah tersimpan. Minat Anda tetap dikelola di browser.</p>
        <div className="account-actions">
          <a className="button button--primary" href="#akun">Buka akun</a>
          <a className="button button--quiet" href="#ringkasan-saya">Atur minat lokal</a>
        </div>
      </section>
    );
  }

  const current = ACCOUNT_ONBOARDING_STEPS[step];
  if (!current) return null;

  async function completeAccountOnboarding() {
    if (!csrfToken || working) return;
    setWorking(true);
    setError(null);
    try {
      await client.completeOnboarding(csrfToken);
      setCompleted(true);
      onRefreshSession();
    } catch (failure) {
      if (isHttpStatus(failure, 401) || isHttpStatus(failure, 403)) {
        setError("Sesi atau izin akun berubah. Periksa kembali sesi sebelum melanjutkan.");
        onRefreshSession();
      } else {
        setError("Pengenalan belum tersimpan. Anda dapat mencoba lagi; penyelesaian versi ini aman diulang.");
      }
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="account-flow">
      {sessionUnavailable && <p className="account-message" role="status">Status akun belum dapat diperiksa. Pengenalan tetap dapat dibaca sebagai tamu, tetapi penyelesaian akun belum dapat disimpan.</p>}
      <section className="account-card account-onboarding" aria-labelledby="onboarding-step-title">
        <div className="account-onboarding__progress" aria-label={`Langkah ${step + 1} dari ${ACCOUNT_ONBOARDING_STEPS.length}`}>
          <span>Langkah {step + 1} dari {ACCOUNT_ONBOARDING_STEPS.length}</span>
          <ol>
            {ACCOUNT_ONBOARDING_STEPS.map((item, index) => <li key={item.title} aria-current={index === step ? "step" : undefined}>{index + 1}</li>)}
          </ol>
        </div>
        <h2 id="onboarding-step-title">{current.title}</h2>
        <p>{current.body}</p>
        {step === 1 && (
          <p className="account-inline-note">Pengaturan minat tersimpan di browser dan dapat dibuka di tab baru agar pengenalan ini tetap terbuka: <a className="text-link" href="#ringkasan-saya" target="_blank" rel="noopener noreferrer">atur minat lokal</a>.</p>
        )}
        {step === 2 && <p className="account-inline-note">Baca rincian di <a className="text-link" href="#privasi">panduan privasi</a>.</p>}
        {error && <p className="account-message account-message--error" role="alert">{error}</p>}
        <div className="account-actions account-onboarding__actions">
          {step > 0 && <button className="button button--quiet" type="button" onClick={() => setStep((currentStep) => Math.max(0, currentStep - 1))} disabled={working}>Sebelumnya</button>}
          {step < ACCOUNT_ONBOARDING_STEPS.length - 1
            ? <button className="button button--primary" type="button" onClick={() => setStep((currentStep) => Math.min(ACCOUNT_ONBOARDING_STEPS.length - 1, currentStep + 1))}>Lanjut</button>
            : authenticatedUser
              ? <button className="button button--primary" type="button" onClick={() => void completeAccountOnboarding()} disabled={working}>{working ? "Menyimpan…" : "Selesaikan pengenalan akun"}</button>
              : <a className="button button--primary" href="#jelajah">Selesai, buka peta</a>}
        </div>
      </section>
      {sessionState.status === "anonymous" && (
        <section className="account-card account-card--quiet">
          <h2>Pengenalan ini opsional</h2>
          <p>Anda dapat berhenti kapan saja. Masuk dengan Google bila ingin menyimpan versi dan waktu penyelesaian pada akun.</p>
          <a className="text-link" href="#masuk?return_to=%23mulai">Masuk dengan Google</a>
        </section>
      )}
    </div>
  );
}

function defaultConfirmUpdate(user: AccountUser, update: AccountUserUpdate): boolean {
  if (typeof window === "undefined") return false;
  const state = update.active ? "mengaktifkan" : "menonaktifkan";
  return window.confirm(`Ubah ${user.display_name} menjadi ${roleLabel(update.role)} dan ${state}? Semua sesi akun ini akan dicabut jika perubahan berhasil.`);
}

function accountUpdatedMessage(user: AccountUser): string {
  return `Perubahan untuk ${user.display_name} tersimpan. Semua sesi akun tersebut telah dicabut.`;
}

function AdminUserRow({
  user,
  viewerId,
  csrfToken,
  client,
  confirmUpdate,
  onUpdated,
  onConflict,
  onAuthorizationFailure,
}: {
  user: AccountUser;
  viewerId: string;
  csrfToken: string;
  client: AccountClient;
  confirmUpdate: (user: AccountUser, update: AccountUserUpdate) => boolean;
  onUpdated: (user: AccountUser) => void;
  onConflict: () => void;
  onAuthorizationFailure: () => void;
}) {
  const [role, setRole] = useState<AccountRole>(user.role);
  const [active, setActive] = useState(user.active);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isSelf = user.id === viewerId;
  const dirty = role !== user.role || active !== user.active;

  useEffect(() => {
    setRole(user.role);
    setActive(user.active);
    setReason("");
    setMessage(null);
  }, [user]);

  async function save() {
    const update: AccountUserUpdate = { role, active, expected_version: user.version, reason: reason.trim() };
    if (isSelf || !dirty || update.reason.length < 1 || update.reason.length > 500 || saving) return;
    if (!confirmUpdate(user, update)) return;

    setSaving(true);
    setMessage(null);
    try {
      const updated = await client.updateUser(user.id, update, csrfToken);
      onUpdated(updated);
      setMessage(accountUpdatedMessage(updated));
    } catch (error) {
      const failure = adminUpdateErrorMessage(error);
      if (failure === "conflict") {
        setMessage("Perubahan ditolak karena versi akun berubah atau akun ini tidak dapat diubah. Daftar sedang dimuat ulang.");
        onConflict();
      } else if (failure === "authorization") {
        setMessage("Sesi atau izin administrator berubah. Memeriksa sesi kembali.");
        onAuthorizationFailure();
      } else {
        setMessage("Perubahan belum tersimpan. Periksa alasan dan coba lagi.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="account-user-row" aria-labelledby={`account-user-${user.id}`}>
      <div className="account-user-row__identity">
        <h3 id={`account-user-${user.id}`}>{user.display_name}</h3>
        <p>{user.email}</p>
        <span className="account-user-row__meta">{user.active ? "Aktif" : "Nonaktif"} · {roleLabel(user.role)} · pengenalan {user.onboarding_version === 1 ? "selesai" : "belum selesai"} · versi {user.version}</span>
      </div>
      {isSelf
        ? <p className="account-inline-note">Akun Anda tidak dapat diubah dari daftar ini.</p>
        : <div className="account-user-row__editor">
          <label>Peran
            <select value={role} onChange={(event) => setRole(event.currentTarget.value as AccountRole)} disabled={saving}>
              <option value="user">Pengguna</option>
              <option value="moderator">Moderator</option>
              <option value="admin">Administrator</option>
            </select>
          </label>
          <label className="account-checkbox"><input type="checkbox" checked={active} onChange={(event) => setActive(event.currentTarget.checked)} disabled={saving} /> Akun aktif</label>
          <label>Alasan perubahan
            <textarea value={reason} onChange={(event) => setReason(event.currentTarget.value)} maxLength={500} rows={2} disabled={saving} required />
          </label>
          <button className="button button--primary" type="button" onClick={() => void save()} disabled={saving || !dirty || reason.trim().length < 1}>{saving ? "Menyimpan…" : "Simpan perubahan"}</button>
        </div>}
      {message && <p className="account-message" role="status">{message}</p>}
    </article>
  );
}

function AdminUsersPanel({
  user,
  csrfToken,
  isNarrowScreen,
  client,
  confirmUpdate,
  onRefreshSession,
}: {
  user: AccountUser;
  csrfToken: string;
  isNarrowScreen: boolean;
  client: AccountClient;
  confirmUpdate: (user: AccountUser, update: AccountUserUpdate) => boolean;
  onRefreshSession: () => void;
}) {
  const [users, setUsers] = useState<readonly AccountUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "forbidden" | "unavailable">("idle");
  const [loadMore, setLoadMore] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (isNarrowScreen) return;
    const controller = new AbortController();
    let cancelled = false;
    setLoadState("loading");
    setUsers([]);
    setNextCursor(null);
    client.listUsers({ limit: 20, signal: controller.signal })
      .then((page) => {
        if (cancelled) return;
        setUsers(page.data);
        setNextCursor(page.next_cursor);
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isHttpStatus(error, 401) || isHttpStatus(error, 403)) {
          setLoadState("forbidden");
          onRefreshSession();
        } else {
          setLoadState("unavailable");
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, isNarrowScreen, onRefreshSession, reloadVersion]);

  async function loadNextPage() {
    if (!nextCursor || loadMore) return;
    const cursor = nextCursor;
    setLoadMore(true);
    setNotice(null);
    try {
      const page = await client.listUsers({ limit: 20, after: cursor });
      setUsers((current) => {
        const existing = new Set(current.map((item) => item.id));
        return [...current, ...page.data.filter((item) => !existing.has(item.id))];
      });
      setNextCursor(page.next_cursor);
    } catch (error) {
      if (isHttpStatus(error, 401) || isHttpStatus(error, 403)) onRefreshSession();
      setNotice(isHttpStatus(error, 409)
        ? "Daftar berubah saat dibuka. Muat ulang daftar untuk mencoba lagi."
        : "Daftar akun berikutnya belum dapat dimuat.");
    } finally {
      setLoadMore(false);
    }
  }

  function handleConflict() {
    setNotice("Server menolak versi perubahan yang lama. Daftar akun dimuat ulang sebelum perubahan berikutnya.");
    setReloadVersion((current) => current + 1);
  }

  function handleUpdated(updated: AccountUser) {
    setUsers((current) => current.map((item) => item.id === updated.id ? updated : item));
    setNotice(accountUpdatedMessage(updated));
  }

  if (isNarrowScreen) {
    return (
      <section className="account-card account-desktop-only" aria-labelledby="admin-accounts-title">
        <h2 id="admin-accounts-title">Pengelolaan akun tersedia di layar desktop</h2>
        <p>Daftar dan perubahan akun administrator hanya tersedia pada tampilan web desktop.</p>
        <a className="text-link" href="#beranda">Kembali ke layanan publik</a>
      </section>
    );
  }

  return (
    <section className="account-admin-users" aria-labelledby="admin-accounts-title">
      <div className="account-admin-users__heading">
        <div>
          <p className="experience-kicker">Administrator · akses akun</p>
          <h2 id="admin-accounts-title">Akun pengguna</h2>
        </div>
        {loadState !== "loading" && <button className="button button--quiet" type="button" onClick={() => setReloadVersion((current) => current + 1)}>Muat ulang</button>}
      </div>
      <p className="account-inline-note">Daftar dibatasi 20 akun per halaman. Setiap perubahan memerlukan alasan dan mencabut semua sesi akun sasaran. Akun Anda sendiri tidak dapat diubah.</p>
      {notice && <p className="account-message" role="status">{notice}</p>}
      {loadState === "loading" && <SessionLoading label="Memuat daftar akun…" />}
      {loadState === "forbidden" && <section className="state-panel state-panel--error" role="alert"><strong>Izin administrator berubah.</strong><p>Sesi akun diperiksa kembali sebelum daftar dibuka.</p></section>}
      {loadState === "unavailable" && <section className="state-panel state-panel--error" role="alert"><strong>Daftar akun belum dapat dimuat.</strong><p>Perubahan akun tidak dilakukan.</p><button className="button button--quiet" type="button" onClick={() => setReloadVersion((current) => current + 1)}>Coba lagi</button></section>}
      {loadState === "ready" && users.length === 0 && <p className="account-inline-note">Belum ada akun pada halaman ini.</p>}
      {loadState === "ready" && users.length > 0 && (
        <div className="account-user-list">
          {users.map((item) => <AdminUserRow
            key={item.id}
            user={item}
            viewerId={user.id}
            csrfToken={csrfToken}
            client={client}
            confirmUpdate={confirmUpdate}
            onUpdated={handleUpdated}
            onConflict={handleConflict}
            onAuthorizationFailure={onRefreshSession}
          />)}
        </div>
      )}
      {loadState === "ready" && nextCursor !== null && <button className="button button--quiet" type="button" onClick={() => void loadNextPage()} disabled={loadMore}>{loadMore ? "Memuat…" : "Muat 20 akun berikutnya"}</button>}
    </section>
  );
}

function AccountProfile({
  session,
  isNarrowScreen,
  client,
  confirmUpdate,
  onRefreshSession,
}: {
  session: SessionEnvelope;
  isNarrowScreen: boolean;
  client: AccountClient;
  confirmUpdate: (user: AccountUser, update: AccountUserUpdate) => boolean;
  onRefreshSession: () => void;
}) {
  const user = session.user;
  const csrfToken = session.csrf_token;
  const [logoutState, setLogoutState] = useState<"idle" | "working" | "error">("idle");

  if (!user || csrfToken === null) return <SessionUnavailable onRetry={onRefreshSession} />;
  const activeCsrfToken = csrfToken;

  async function logout() {
    if (logoutState === "working") return;
    setLogoutState("working");
    try {
      await client.logout(activeCsrfToken);
      onRefreshSession();
    } catch {
      setLogoutState("error");
      if (logoutState !== "error") onRefreshSession();
    }
  }

  return (
    <div className="account-flow">
      <section className="account-card" aria-labelledby="profile-title">
        <div className="account-profile__heading">
          <div>
            <p className="experience-kicker">Profil akun</p>
            <h2 id="profile-title">{user.display_name}</h2>
          </div>
          <span className="account-role-chip">{roleLabel(user.role)}</span>
        </div>
        <dl className="account-profile__facts">
          <div><dt>Email Google</dt><dd>{user.email}</dd></div>
          <div><dt>Status akun</dt><dd>{user.active ? "Aktif" : "Tidak aktif"}</dd></div>
          <div><dt>Pengenalan akun</dt><dd>{user.onboarding_version === 1 ? "Selesai" : "Belum selesai"}</dd></div>
          {user.onboarding_completed_at && <div><dt>Waktu selesai</dt><dd><time dateTime={user.onboarding_completed_at}>{new Date(user.onboarding_completed_at).toLocaleString("id-ID")}</time></dd></div>}
        </dl>
        {user.onboarding_version === 0 && <p className="account-message">Selesaikan pengenalan singkat untuk mencatat versi dan waktunya pada akun. Pilihan minat tetap lokal.</p>}
        {logoutState === "error" && <p className="account-message account-message--error" role="alert">Keluar belum dapat dipastikan. Periksa sesi akun kembali.</p>}
        <div className="account-actions">
          {user.onboarding_version === 0 && <a className="button button--quiet" href="#mulai">Selesaikan pengenalan</a>}
          <a className="button button--quiet" href="#ringkasan-saya">Atur minat lokal</a>
          <button className="button button--primary" type="button" onClick={() => void logout()} disabled={logoutState === "working"}>{logoutState === "working" ? "Keluar…" : "Keluar"}</button>
        </div>
      </section>
      <section className="account-card account-card--quiet">
        <h2>Peran ditetapkan oleh layanan</h2>
        <p>Peran di atas hanya dibaca dari sesi server. Peran tidak dapat dipilih saat masuk atau menyelesaikan pengenalan.</p>
        <a className="text-link" href="#privasi">Baca panduan privasi</a>
      </section>
      {user.role === "admin" && user.onboarding_version === 1 && (
        <AdminUsersPanel
          user={user}
          csrfToken={csrfToken}
          isNarrowScreen={isNarrowScreen}
          client={client}
          confirmUpdate={confirmUpdate}
          onRefreshSession={onRefreshSession}
        />
      )}
    </div>
  );
}

export function AccountPage({
  screen,
  sessionState,
  returnTo = "#akun",
  isNarrowScreen,
  onRefreshSession,
  client = accountClient,
  confirmUpdate = defaultConfirmUpdate,
}: AccountPageProps) {
  const title = screen === "login" ? "Masuk atau lanjutkan sebagai tamu" : screen === "onboarding" ? "Pengenalan singkat" : "Akun Anda";

  if (screen === "login") {
    return <AccountFrame title={title} kicker="Masuk · opsional">
      <GoogleLogin sessionState={sessionState} returnTo={returnTo} onRefreshSession={onRefreshSession} client={client} />
    </AccountFrame>;
  }

  if (screen === "onboarding") {
    return <AccountFrame title={title} kicker="Mulai · tiga langkah">
      <Onboarding sessionState={sessionState} onRefreshSession={onRefreshSession} client={client} />
    </AccountFrame>;
  }

  if (sessionState.status === "loading") return <AccountFrame title={title}><SessionLoading /></AccountFrame>;
  if (sessionState.status === "error") return <AccountFrame title={title}><SessionUnavailable onRetry={onRefreshSession} /></AccountFrame>;
  if (sessionState.status === "anonymous") {
    return <AccountFrame title={title}>
      <section className="account-card">
        <h2>Akun tidak diperlukan untuk membaca laporan</h2>
        <p>Masuk hanya menambahkan profil dan pengenalan akun. Minat serta preferensi tetap disimpan secara lokal.</p>
        <div className="account-actions">
          <a className="button button--primary" href="#masuk?return_to=%23akun">Masuk dengan Google</a>
          <a className="button button--quiet" href="#mulai">Lihat pengenalan</a>
        </div>
      </section>
    </AccountFrame>;
  }

  return <AccountFrame title={title}><AccountProfile
    session={sessionState.session}
    isNarrowScreen={isNarrowScreen}
    client={client}
    confirmUpdate={confirmUpdate}
    onRefreshSession={onRefreshSession}
  /></AccountFrame>;
}

export type ProtectedShell = "admin" | "review";

export function hasProtectedShellAccess(shell: ProtectedShell, session: SessionEnvelope): boolean {
  const user = session.user;
  if (session.status !== "authenticated" || user === null || !user.active) return false;
  if (shell === "admin") return user.role === "admin";
  return user.role === "moderator" || user.role === "admin";
}

export function AccountAccessGate({
  shell,
  sessionState,
  isNarrowScreen,
  onRefreshSession,
}: {
  shell: ProtectedShell;
  sessionState: AccountSessionState;
  isNarrowScreen: boolean;
  onRefreshSession: () => void;
}) {
  if (shell === "admin" && isNarrowScreen) {
    return <main id="main-content" tabIndex={-1} className="main-shell account-page">
      <section className="account-card account-desktop-only" role="status">
        <h1>Ruang administrator tersedia di layar desktop</h1>
        <p>Tampilan dashboard administrator hanya tersedia pada web desktop.</p>
        <div className="account-actions"><a className="button button--primary" href="#akun">Akun</a><a className="button button--quiet" href="#beranda">Kembali ke layanan publik</a></div>
      </section>
    </main>;
  }
  if (sessionState.status === "loading") return <main id="main-content" tabIndex={-1} className="main-shell account-page"><SessionLoading label="Memeriksa izin sesi…" /></main>;
  if (sessionState.status === "error") return <main id="main-content" tabIndex={-1} className="main-shell account-page"><SessionUnavailable onRetry={onRefreshSession} /></main>;
  if (sessionState.status === "anonymous") {
    const returnTo = shell === "admin" ? "%23admin" : "%23tinjau-bukti";
    return <main id="main-content" tabIndex={-1} className="main-shell account-page">
      <section className="account-card" role="status">
        <h1>Sesi diperlukan</h1>
        <p>{shell === "admin" ? "Ruang administrator hanya tersedia untuk akun administrator yang masuk." : "Tampilan tinjau hanya tersedia untuk akun moderator atau administrator yang masuk."}</p>
        <div className="account-actions"><a className="button button--primary" href={`#masuk?return_to=${returnTo}`}>Masuk dengan Google</a><a className="button button--quiet" href="#beranda">Kembali ke layanan publik</a></div>
      </section>
    </main>;
  }
  if (!hasProtectedShellAccess(shell, sessionState.session)) {
    return <main id="main-content" tabIndex={-1} className="main-shell account-page">
      <section className="account-card" role="alert">
        <h1>Akses tidak tersedia</h1>
        <p>Sesi saat ini tidak memiliki peran yang diperlukan untuk membuka tampilan ini.</p>
        <div className="account-actions"><a className="button button--quiet" href="#akun">Lihat akun</a><a className="button button--primary" href="#beranda">Kembali ke layanan publik</a></div>
      </section>
    </main>;
  }
  return null;
}
