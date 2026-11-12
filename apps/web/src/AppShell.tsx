import { useEffect, useState } from "react";
import type { PublicContext } from "@waspada/worker/public-contracts";
import type { SessionEnvelope } from "@waspada/worker/account-contracts";
import type { Route } from "./App.js";
import { accountClient } from "./account-client.js";
import { hasProtectedShellAccess } from "./AccountPages.js";
import { openOnboardingIntro } from "./OnboardingIntro.js";
import { THEME_LABEL, ThemeToggle, nextThemePreference, setThemePreference, useThemePreference } from "./ThemeToggle.js";
import { Menu, type MenuItem } from "./ui/Menu.js";
import { Popover } from "./ui/Popover.js";

/** Below this width the theme choice moves into the account menu to keep the header on one row. */
export const COMPACT_HEADER_QUERY = "(max-width: 900px)";

export interface DatasetBadge {
  label: string;
  title: string;
  detail: string;
  tone: "warning" | "accent" | "neutral";
}

/**
 * One badge for the dataset mode. The wording matches the former banner so the honesty copy is unchanged.
 * `sourcePreview` is true on the workspace's source tab (UI-V2-C), which keeps its own demo label.
 */
export function datasetBadge(datasetMode: string | undefined, sourcePreview = false): DatasetBadge {
  if (sourcePreview && datasetMode === "demo") {
    return {
      label: "Data contoh",
      title: "DEMO SUMBER — pratinjau data publik; bukan peringatan Waspada",
      detail: "Data referensi dan laporan sumber ditampilkan terpisah dari kejadian sintetis.",
      tone: "warning",
    };
  }
  if (datasetMode === "demo") {
    return {
      label: "Data contoh",
      title: "DEMO — data sintetis; bukan peringatan langsung",
      detail: "Fixture presentasi tetap terpisah dari record API.",
      tone: "warning",
    };
  }
  if (datasetMode === "live") {
    return {
      label: "Langsung",
      title: "LIVE — record berasal dari dataset live API",
      detail: "Waktu dan kesegaran tercantum per record; cakupan mengikuti data API yang dimuat.",
      tone: "accent",
    };
  }
  return {
    label: "Status data",
    title: "Status dataset tidak tersedia.",
    detail: "Jenis dataset belum dapat diverifikasi.",
    tone: "neutral",
  };
}

export interface AccountMenuEntry {
  id: string;
  label: string;
  href?: string;
  action?: "intro" | "theme";
}

/**
 * Entries of the account menu. `session` is null while the session is unknown
 * (loading or unavailable). Admin and moderator entries appear only for those roles.
 * `themeLabel` is set only on compact screens, where the theme toggle is not in the header.
 */
export function accountMenuEntries(session: SessionEnvelope | null, themeLabel: string | null): AccountMenuEntry[] {
  const entries: AccountMenuEntry[] = [];
  if (session?.status === "authenticated") {
    entries.push({ id: "account", label: "Akun saya", href: "#akun" });
  } else if (session?.status === "anonymous") {
    entries.push({ id: "sign-in", label: "Masuk", href: "#masuk" });
  } else {
    entries.push({ id: "account", label: "Akun", href: "#akun" });
  }

  if (session !== null && hasProtectedShellAccess("admin", session)) {
    entries.push({ id: "admin", label: "Ruang kerja admin", href: "#admin/ringkasan" });
    entries.push({ id: "review", label: "Tinjau bukti", href: "#admin/tinjau" });
    entries.push({ id: "pipeline", label: "Alur agen", href: "#admin/alur" });
    entries.push({ id: "embedding", label: "Visualisasi 3D", href: "#admin/embedding" });
    entries.push({ id: "sources", label: "Sumber data", href: "#admin/sumber" });
  } else if (session !== null && hasProtectedShellAccess("review", session)) {
    entries.push({ id: "admin", label: "Ruang kerja admin", href: "#admin/tinjau" });
  }

  entries.push({ id: "help", label: "Bantuan", href: "#bantuan" });
  entries.push({ id: "privacy", label: "Privasi", href: "#privasi" });
  entries.push({ id: "about", label: "Tentang Waspada", action: "intro" });
  if (themeLabel !== null) entries.push({ id: "theme", label: `Tema: ${themeLabel}`, action: "theme" });
  return entries;
}

function useAccountSession(refreshKey: number): SessionEnvelope | null {
  const [session, setSession] = useState<SessionEnvelope | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    accountClient.getSession(controller.signal)
      .then((next) => setSession(next))
      .catch(() => {
        if (!controller.signal.aborted) setSession(null);
      });
    return () => controller.abort();
  }, [refreshKey]);
  return session;
}

function useMediaMatch(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function ChevronIcon() {
  return (
    <svg className="site-header__chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Icons only show on phones (see app-shell.css). They are decorative; the link text names each destination.
function NavIcon({ kind }: { kind: "map" | "bell" | "star" }) {
  const paths = {
    map: "M12 21s-6-5.2-6-10.2a6 6 0 1 1 12 0C18 15.8 12 21 12 21Zm0-8.2a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2Z",
    bell: "M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Zm4 4.5a2 2 0 0 0 4 0",
    star: "m12 3.8 2.5 5.1 5.6.8-4 3.9.9 5.6L12 16.6l-5 2.6.9-5.6-4-3.9 5.6-.8L12 3.8Z",
  } as const;
  return (
    <svg className="primary-nav__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={paths[kind]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface SiteHeaderProps {
  route: Route;
  context?: PublicContext | null;
  /** Changes on each hash navigation so the account state is re-read after sign-in or sign-out. */
  sessionKey?: number;
}

export function SiteHeader({ route, context = null, sessionKey = 0 }: SiteHeaderProps) {
  const compact = useMediaMatch(COMPACT_HEADER_QUERY);
  const theme = useThemePreference();
  const session = useAccountSession(sessionKey);
  const badge = datasetBadge(context?.dataset_mode);
  const menuItems: MenuItem[] = accountMenuEntries(session, compact ? THEME_LABEL[theme] : null).map((entry) => ({
    id: entry.id,
    label: entry.label,
    href: entry.href,
    onSelect: entry.action === "intro"
      ? openOnboardingIntro
      : entry.action === "theme"
        ? () => setThemePreference(nextThemePreference(theme))
        : undefined,
  }));

  const onMap = route.screen === "discover";
  const onUpdates = route.screen === "updates";
  const onArea = route.screen === "preferences";

  return (
    <>
      <a className="skip-link" href="#main-content">Lewati ke konten utama</a>
      <header className="site-header">
        <a className="brand" href="#peta" aria-label="Waspada Jakarta, ke peta">
          <span className="brand-mark" aria-hidden="true">WJ</span>
          <span className="brand__text">
            <strong>Waspada Jakarta</strong>
            <small>Informasi dengan jejak sumber</small>
          </span>
        </a>
        <nav className="primary-nav" aria-label="Navigasi utama">
          <a href="#peta" aria-current={onMap ? "page" : undefined}><NavIcon kind="map" /><span>Peta</span></a>
          <a href="#pembaruan" aria-current={onUpdates ? "page" : undefined}><NavIcon kind="bell" /><span>Pembaruan</span></a>
          <a href="#ringkasan-saya" aria-current={onArea ? "page" : undefined}><NavIcon kind="star" /><span>Area saya</span></a>
        </nav>
        <div className="site-header__tools">
          <Popover
            triggerClassName={`site-header__badge badge${badge.tone === "warning" ? " badge--warning" : badge.tone === "accent" ? " badge--accent" : ""}`}
            triggerContent={<><span className="site-header__badge-dot" aria-hidden="true" /><span className="site-header__badge-label">{badge.label}</span></>}
            panelClassName="site-header__status"
          >
            <p className="site-header__status-title"><strong>{badge.title}</strong></p>
            <p className="site-header__status-detail">{badge.detail}</p>
          </Popover>
          {!compact && <ThemeToggle className="site-header__theme" />}
          <Menu
            triggerClassName="button button--quiet site-header__account"
            triggerContent={<>Akun<ChevronIcon /></>}
            items={menuItems}
            align="end"
          />
        </div>
      </header>
    </>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <span>Data dari sumber publik dan laporan warga; bukan layanan darurat. Darurat: 112.</span>
      <nav className="site-footer__links" aria-label="Tautan bawah">
        <a href="#bantuan">Bantuan</a>
        <a href="#privasi">Privasi</a>
      </nav>
    </footer>
  );
}
