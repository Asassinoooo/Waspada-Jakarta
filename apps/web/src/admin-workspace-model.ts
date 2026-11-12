/*
 * Admin workspace model (UI-V2-C). Pure functions only, so App.tsx can map hashes to tabs without loading
 * the lazy workspace chunk, and node:test can cover role and routing rules directly.
 *
 * Hiding a tab is presentation only. Every server guard (moderatorSurfaceDenial, role checks in the
 * Worker and in the L4 gate) still decides what data a tab can read or change.
 */

export const ADMIN_TAB_IDS = ["ringkasan", "tinjau", "alur", "embedding", "akun", "sumber"] as const;
export type AdminTab = (typeof ADMIN_TAB_IDS)[number];

/** `admin` tabs need the administrator role. `moderator` tabs open for moderators and administrators. */
export type AdminTabAccess = "admin" | "moderator";

export interface AdminTabDefinition {
  id: AdminTab;
  label: string;
  title: string;
  access: AdminTabAccess;
  /** Optional one-step link to another tab. Shown only when the viewer may open that tab. */
  next?: AdminTab;
  nextLabel?: string;
}

export const ADMIN_TAB_DEFINITIONS: readonly AdminTabDefinition[] = [
  { id: "ringkasan", label: "Ringkasan", title: "Ringkasan laporan dan tahap", access: "admin", next: "tinjau", nextLabel: "Tinjau bukti" },
  { id: "tinjau", label: "Tinjau bukti", title: "Tinjau bukti dan moderasi", access: "moderator", next: "alur", nextLabel: "Alur agen" },
  { id: "alur", label: "Alur agen", title: "Alur agen dari sumber sampai terbit", access: "moderator" },
  { id: "embedding", label: "Embedding 3D", title: "Peta embedding 3D", access: "moderator" },
  { id: "akun", label: "Akun & peran", title: "Akun dan peran pengguna", access: "admin" },
  { id: "sumber", label: "Demo sumber", title: "Pratinjau sumber (demo)", access: "admin" },
];

/** Tabs whose canvas needs a wide screen. Below 900px they show an empty state instead. */
const WIDE_SCREEN_TABS: ReadonlySet<AdminTab> = new Set<AdminTab>(["alur", "embedding"]);

/** Legacy hashes that still resolve to the workspace, each with the tab it opens. */
const LEGACY_ADMIN_HASHES: ReadonlyMap<string, AdminTab> = new Map<string, AdminTab>([
  ["#admin", "ringkasan"],
  ["#admin-workspace", "ringkasan"],
  ["#tinjau-bukti", "tinjau"],
  ["#alur-agen", "alur"],
  ["#visualisasi-3d", "embedding"],
  ["#embedding-3d", "embedding"],
  ["#demo-sumber", "sumber"],
]);

export function parseAdminTab(value: string): AdminTab | null {
  return (ADMIN_TAB_IDS as readonly string[]).includes(value) ? value as AdminTab : null;
}

/**
 * Tab opened by a hash, or null when the hash is not an admin hash. `#admin/<unknown>` opens
 * the overview, as it did before the tabs existed. A query string after the tab is ignored.
 */
export function adminWorkspaceTabFromHash(hash: string): AdminTab | null {
  if (hash.startsWith("#admin/")) {
    const tab = hash.slice("#admin/".length).split("?")[0] ?? "";
    return parseAdminTab(tab) ?? "ringkasan";
  }
  return LEGACY_ADMIN_HASHES.get(hash) ?? null;
}

export function adminTabHash(tab: AdminTab): string {
  return `#admin/${tab}`;
}

export interface AdminTabViewer {
  role: "user" | "moderator" | "admin";
  active: boolean;
}

/** Tabs the viewer may see. Users, inactive accounts and anonymous visitors get none. */
export function adminTabsFor(viewer: AdminTabViewer | null): readonly AdminTabDefinition[] {
  if (viewer === null || !viewer.active) return [];
  if (viewer.role === "admin") return ADMIN_TAB_DEFINITIONS;
  if (viewer.role === "moderator") return ADMIN_TAB_DEFINITIONS.filter((tab) => tab.access === "moderator");
  return [];
}

/** The requested tab when the viewer may open it, otherwise the viewer's first allowed tab (or null). */
export function resolveAdminTab(requested: AdminTab, allowed: readonly AdminTab[]): AdminTab | null {
  if (allowed.includes(requested)) return requested;
  return allowed[0] ?? null;
}

/** The one-step link shown in the header. It is withheld when the viewer cannot open the target tab. */
export function adminPrimaryAction(tab: AdminTab, allowed: readonly AdminTab[]): { label: string; href: string } | null {
  const definition = ADMIN_TAB_DEFINITIONS.find((item) => item.id === tab);
  if (!definition?.next || !definition.nextLabel || !allowed.includes(definition.next)) return null;
  return { label: definition.nextLabel, href: adminTabHash(definition.next) };
}

/** Whether the tab's canvas is withheld on narrow screens (below 900px). */
export function tabNeedsWideScreen(tab: AdminTab): boolean {
  return WIDE_SCREEN_TABS.has(tab);
}

/** Gate copy for a tab that is not open to the viewer: admin-only tabs name the administrator role. */
export function adminGateShell(tab: AdminTab): "admin" | "review" {
  return ADMIN_TAB_DEFINITIONS.find((item) => item.id === tab)?.access === "admin" ? "admin" : "review";
}
