import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import type { PublicContext } from "@waspada/worker/public-contracts";
import type { SessionEnvelope } from "@waspada/worker/account-contracts";
import { AdminAccountsPanel } from "./AccountPages.js";
import { datasetBadge } from "./AppShell.js";
import {
  ADMIN_TAB_DEFINITIONS,
  adminPrimaryAction,
  adminTabHash,
  adminTabsFor,
  resolveAdminTab,
  tabNeedsWideScreen,
  type AdminTab,
} from "./admin-workspace-model.js";
import { nextThemePreference, setThemePreference, THEME_LABEL, useThemePreference } from "./ThemeToggle.js";
import { Menu, type MenuItem } from "./ui/Menu.js";
import { Popover } from "./ui/Popover.js";
import { TabPanel, Tabs, type TabItem } from "./ui/Tabs.js";

// Each heavy tab loads only when it opens: three.js with the embedding view, @xyflow/react with the flow,
// and the source map with the demo source tab. Akun is already part of the main chunk through AccountPages.
const AdminDashboard = lazy(() => import("./AdminDashboard.js"));
const ModeratorReview = lazy(() => import("./ModeratorReview.js").then((module) => ({ default: module.ModeratorReview })));
const PipelineFlow = lazy(() => import("./pipeline-flow-entry.js"));
const Embedding3DVisualization = lazy(() =>
  import("./Embedding3DVisualization.js").then((module) => ({ default: module.Embedding3DVisualization })),
);
const AdminSourceTab = lazy(() => import("./AdminSourceTab.js"));

function TabIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const TAB_ICONS: Record<AdminTab, ReactNode> = {
  ringkasan: <TabIcon><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="4" rx="1.5" /><rect x="13" y="10" width="7" height="10" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /></TabIcon>,
  tinjau: <TabIcon><path d="M12 3.5 5.5 6v5.3c0 4.2 2.8 7.5 6.5 9.2 3.7-1.7 6.5-5 6.5-9.2V6L12 3.5Z" /><path d="m9 12 2 2 4-4" /></TabIcon>,
  alur: <TabIcon><circle cx="6" cy="6" r="2.4" /><circle cx="18" cy="12" r="2.4" /><circle cx="6" cy="18" r="2.4" /><path d="M8.2 7.1 15.8 11M8.2 16.9l7.6-3.8" /></TabIcon>,
  embedding: <TabIcon><path d="M12 3.5 19.5 7.7v8.6L12 20.5l-7.5-4.2V7.7L12 3.5Z" /><path d="M12 11.5 19.5 7.7M12 11.5v9M12 11.5 4.5 7.7" /></TabIcon>,
  akun: <TabIcon><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19c.7-3 2.8-4.5 5.5-4.5s4.8 1.5 5.5 4.5" /><circle cx="17" cy="9" r="2.3" /><path d="M16.5 14.6c2.3.2 3.7 1.6 4.2 4" /></TabIcon>,
  sumber: <TabIcon><path d="M12 20.5s-6-5.1-6-10a6 6 0 1 1 12 0c0 4.9-6 10-6 10Z" /><circle cx="12" cy="10.5" r="2.2" /></TabIcon>,
};

function TabLoading({ label }: { label: string }) {
  return (
    <section className="admin-ws__loading" role="status" aria-live="polite">
      <p>{label}</p>
      <span className="skeleton admin-ws__skeleton admin-ws__skeleton--wide" aria-hidden="true" />
      <span className="skeleton admin-ws__skeleton" aria-hidden="true" />
      <span className="skeleton admin-ws__skeleton admin-ws__skeleton--short" aria-hidden="true" />
    </section>
  );
}

function NarrowScreenNotice({ canOpenReview }: { canOpenReview: boolean }) {
  return (
    <section className="empty-state admin-ws__narrow" role="status">
      <p className="empty-state__title">Buka di layar yang lebih lebar untuk tampilan ini.</p>
      {canOpenReview && <a className="text-link" href="#admin/tinjau">Buka tinjau bukti</a>}
    </section>
  );
}

export interface AdminWorkspaceProps {
  /** Tab from the hash. The workspace falls back to the viewer's first allowed tab when it is not open to them. */
  initialTab: AdminTab;
  /** Authenticated session. App checks the moderator or administrator role before it renders the workspace. */
  session: SessionEnvelope;
  context: PublicContext | null;
  isNarrowScreen: boolean;
  onRefreshSession: () => void;
}

/**
 * Administrator workspace (UI-V2-C): one `<main>` with a tab rail and one mounted panel. A tab a viewer may
 * not open is never mounted or fetched. The server still checks every request.
 */
export function AdminWorkspace({ initialTab, session, context, isNarrowScreen, onRefreshSession }: AdminWorkspaceProps) {
  const viewer = session.user === null ? null : { role: session.user.role, active: session.user.active };
  const tabs = adminTabsFor(viewer);
  const allowedIds = tabs.map((tab) => tab.id);
  const [selected, setSelected] = useState<AdminTab>(initialTab);
  const active = resolveAdminTab(selected, allowedIds);
  const theme = useThemePreference();

  // Tab changes replace the hash rather than push it, so the route and session do not re-run on each click.
  useEffect(() => {
    if (active === null || typeof window === "undefined") return;
    const hash = adminTabHash(active);
    if (window.location.hash !== hash) window.history.replaceState(window.history.state, "", hash);
  }, [active]);

  if (active === null) return null;

  const definition = ADMIN_TAB_DEFINITIONS.find((item) => item.id === active);
  const primary = adminPrimaryAction(active, allowedIds);
  const badge = datasetBadge(context?.dataset_mode, active === "sumber");
  const tabItems: TabItem[] = tabs.map((tab) => ({ id: tab.id, label: tab.label, icon: TAB_ICONS[tab.id] }));
  const menuItems: MenuItem[] = [
    { id: "peta", label: "Kembali ke peta", href: "#peta" },
    { id: "akun", label: "Akun saya", href: "#akun" },
    { id: "bantuan", label: "Bantuan", href: "#bantuan" },
    { id: "theme", label: `Tema: ${THEME_LABEL[theme]}`, onSelect: () => setThemePreference(nextThemePreference(theme)) },
  ];

  function renderTab(tab: AdminTab): ReactNode {
    if (isNarrowScreen && tabNeedsWideScreen(tab)) return <NarrowScreenNotice canOpenReview={allowedIds.includes("tinjau")} />;
    switch (tab) {
      case "ringkasan":
        return <Suspense fallback={<TabLoading label="Memuat ringkasan…" />}><AdminDashboard /></Suspense>;
      case "tinjau":
        return <Suspense fallback={<TabLoading label="Memuat tinjau bukti…" />}><ModeratorReview /></Suspense>;
      case "alur":
        return <Suspense fallback={<TabLoading label="Memuat alur agen…" />}><PipelineFlow /></Suspense>;
      case "embedding":
        return <Suspense fallback={<TabLoading label="Memuat visualisasi 3D…" />}><Embedding3DVisualization /></Suspense>;
      case "akun":
        return <AdminAccountsPanel session={session} onRefreshSession={onRefreshSession} />;
      case "sumber":
        return <Suspense fallback={<TabLoading label="Memuat demo sumber…" />}><AdminSourceTab datasetMode={context?.dataset_mode ?? null} /></Suspense>;
    }
  }

  return (
    <div className="app-shell admin-ws">
      <a className="skip-link" href="#main-content">Lewati ke konten utama</a>
      <header className="admin-ws__header">
        <div className="admin-ws__identity">
          <a className="admin-ws__home" href="#peta">Waspada Jakarta</a>
          <h1 className="admin-ws__title">Ruang kerja</h1>
          <p className="admin-ws__tab-title">{definition?.title}</p>
        </div>
        <div className="admin-ws__actions">
          {primary !== null && <a className="button button--primary admin-ws__primary" href={primary.href}>{primary.label}</a>}
          <Popover
            triggerClassName={`site-header__badge badge${badge.tone === "warning" ? " badge--warning" : badge.tone === "accent" ? " badge--accent" : ""}`}
            triggerContent={<><span className="site-header__badge-dot" aria-hidden="true" /><span className="site-header__badge-label">{badge.label}</span></>}
            panelClassName="site-header__status"
          >
            <p className="site-header__status-title"><strong>{badge.title}</strong></p>
            <p className="site-header__status-detail">{badge.detail}</p>
          </Popover>
          <Menu
            triggerClassName="button button--quiet admin-ws__more"
            triggerContent={<><span aria-hidden="true">⋯</span><span className="visually-hidden">Aksi lain</span></>}
            items={menuItems}
            align="end"
          />
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="admin-ws__body" aria-label="Ruang kerja admin">
        <div className="admin-ws__rail">
          <Tabs
            idPrefix="admin"
            label="Bagian ruang kerja"
            tabs={tabItems}
            value={active}
            onChange={(id) => setSelected(id as AdminTab)}
            orientation={isNarrowScreen ? "horizontal" : "vertical"}
          />
        </div>
        <div className="admin-ws__panels">
          {tabs.map((tab) => (
            <TabPanel key={tab.id} idPrefix="admin" id={tab.id} active={tab.id === active}>
              {tab.id === active ? renderTab(tab.id) : null}
            </TabPanel>
          ))}
        </div>
      </main>
    </div>
  );
}

export default AdminWorkspace;
