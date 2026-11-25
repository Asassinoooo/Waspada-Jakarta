import { useEffect, useState } from "react";
import { formatInstant } from "./display.js";
import { PageHeader } from "./ui/PageHeader.js";

if (typeof document !== "undefined") {
  void import("./download-page.css");
}

/**
 * MOBILE-REL-01: `#unduh`, the Android APK download page. It reads the committed `/mobile-release.json` (written by the
 * mobile-release workflow) from this origin, so there is no GitHub API call and no new CSP origin. Downloads are plain
 * navigations to the project's GitHub Release.
 */

export const RELEASE_MANIFEST_PATH = "/mobile-release.json";
const RELEASE_DOWNLOAD_PREFIX = "https://github.com/Asassinoooo/Waspada-Jakarta/releases/download/";
const RELEASE_PAGE_PREFIX = "https://github.com/Asassinoooo/Waspada-Jakarta/releases/";
export const ALL_RELEASES_URL = "https://github.com/Asassinoooo/Waspada-Jakarta/releases";

export type ReleaseAbi = "arm64-v8a" | "armeabi-v7a" | "x86_64";

export interface ReleaseFile {
  abi: ReleaseAbi;
  name: string;
  sizeBytes: number;
  sha256: string;
  url: string;
}

export interface MobileRelease {
  version: string;
  releasedAt: string;
  releaseUrl: string;
  files: ReleaseFile[];
}

const ABI_ORDER: readonly ReleaseAbi[] = ["arm64-v8a", "armeabi-v7a", "x86_64"];

const ABI_COPY: Record<ReleaseAbi, { title: string; hint: string }> = {
  "arm64-v8a": { title: "Android 64-bit (arm64)", hint: "Untuk hampir semua HP Android keluaran 2017 ke atas." },
  "armeabi-v7a": { title: "Android 32-bit (armeabi-v7a)", hint: "Untuk HP Android lama. Pakai ini bila file 64-bit gagal dipasang." },
  "x86_64": { title: "Emulator / Chromebook (x86_64)", hint: "Untuk emulator Android di komputer, bukan untuk HP." },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns null for anything that is not a well-formed release whose links point at this project's GitHub Release. */
export function parseMobileRelease(value: unknown): MobileRelease | null {
  if (!isRecord(value)) return null;
  const { version, released_at: releasedAt, release_url: releaseUrl, files } = value;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) return null;
  if (typeof releasedAt !== "string" || !Number.isFinite(Date.parse(releasedAt))) return null;
  if (typeof releaseUrl !== "string" || !releaseUrl.startsWith(RELEASE_PAGE_PREFIX)) return null;
  if (!Array.isArray(files)) return null;
  const parsed: ReleaseFile[] = [];
  for (const file of files) {
    if (!isRecord(file)) return null;
    const { abi, name, size_bytes: sizeBytes, sha256, url } = file;
    if (typeof abi !== "string" || !(ABI_ORDER as readonly string[]).includes(abi)) continue;
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]+\.apk$/u.test(name)) return null;
    if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return null;
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) return null;
    if (typeof url !== "string" || !url.startsWith(RELEASE_DOWNLOAD_PREFIX) || !url.endsWith("/" + name)) return null;
    parsed.push({ abi: abi as ReleaseAbi, name, sizeBytes, sha256, url });
  }
  if (parsed.length === 0) return null;
  parsed.sort((left, right) => ABI_ORDER.indexOf(left.abi) - ABI_ORDER.indexOf(right.abi));
  return { version, releasedAt, releaseUrl, files: parsed };
}

export function formatMegabytes(bytes: number): string {
  return (bytes / 1_000_000).toLocaleString("id-ID", { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + " MB";
}

export type LoadState =
  | { status: "loading" }
  | { status: "loaded"; release: MobileRelease }
  | { status: "missing" }
  | { status: "unavailable" };

export async function loadMobileRelease(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<LoadState> {
  try {
    const response = await fetcher(RELEASE_MANIFEST_PATH, { cache: "no-cache", credentials: "omit" });
    if (response.status === 404) return { status: "missing" };
    if (!response.ok) return { status: "unavailable" };
    const release = parseMobileRelease(await response.json());
    return release === null ? { status: "missing" } : { status: "loaded", release };
  } catch {
    return { status: "unavailable" };
  }
}

function Sha({ value }: { value: string }) {
  return (
    <p className="download-file__sha">
      <span className="download-file__sha-label">SHA-256</span>
      <code translate="no">{value}</code>
    </p>
  );
}

export function ReleaseDownloads({ release }: { release: MobileRelease }) {
  const [primary, ...others] = release.files;
  if (!primary) return null;
  return (
    <section className="download-card" aria-labelledby="download-release-title">
      <div className="download-card__meta">
        <p className="download-card__kicker">Rilis terbaru</p>
        <h2 id="download-release-title" className="download-card__title">Versi {release.version}</h2>
        <p className="download-card__date">Dirilis <time dateTime={release.releasedAt}>{formatInstant(release.releasedAt)}</time></p>
      </div>

      <div className="download-file download-file--primary">
        <a className="button button--primary download-file__button" href={primary.url} rel="noopener">
          Unduh APK · {formatMegabytes(primary.sizeBytes)}
        </a>
        <p className="download-file__hint">{ABI_COPY[primary.abi].title}. {ABI_COPY[primary.abi].hint}</p>
        <Sha value={primary.sha256} />
      </div>

      {others.length > 0 && (
        <details className="download-card__others">
          <summary>File untuk perangkat lain ({others.length})</summary>
          <ul className="download-file-list">
            {others.map((file) => (
              <li className="download-file" key={file.abi}>
                <a href={file.url} rel="noopener">{ABI_COPY[file.abi].title} · {formatMegabytes(file.sizeBytes)}</a>
                <p className="download-file__hint">{ABI_COPY[file.abi].hint}</p>
                <Sha value={file.sha256} />
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="download-card__source">
        File diunduh dari <a href={release.releaseUrl} rel="noopener">halaman rilis GitHub proyek ini</a>.
      </p>
    </section>
  );
}

export function DownloadGuide() {
  return (
    <>
      <section className="download-section" aria-labelledby="download-install-title">
        <h2 id="download-install-title">Cara memasang</h2>
        <ol className="download-steps">
          <li><strong>Unduh file APK</strong> dengan tombol di atas, lewat browser di HP Android Anda.</li>
          <li><strong>Buka file</strong> dari notifikasi unduhan atau aplikasi File.</li>
          <li><strong>Izinkan pemasangan</strong> bila Android meminta: pilih <em>Setelan</em>, lalu aktifkan <em>Izinkan dari sumber ini</em> untuk browser yang Anda pakai.</li>
          <li><strong>Pasang</strong>, lalu buka Waspada Jakarta. Pembaruan berikutnya dipasang dengan cara yang sama, tanpa menghapus aplikasi lama.</li>
        </ol>
        <p className="download-note">Aplikasi ini belum ada di Play Store. Play Protect mungkin menampilkan peringatan karena aplikasinya baru; periksa SHA-256 file bila ingin memastikan file tidak berubah.</p>
      </section>

      <section className="download-section download-section--split" aria-labelledby="download-scope-title">
        <h2 id="download-scope-title">Apa yang dilakukan aplikasi</h2>
        <div className="download-scope">
          <div>
            <h3>Yang dilakukan</h3>
            <ul>
              <li>Menampilkan laporan kejadian di Jakarta yang sudah diterbitkan, lengkap dengan bukti, sumber, dan waktu.</li>
              <li>Memberi tanda bila laporan perlu diperbarui atau sudah lewat masa berlaku sumber.</li>
              <li>Memberi notifikasi di HP untuk area yang Anda pilih, bila Anda mengaktifkannya.</li>
            </ul>
          </div>
          <div>
            <h3>Yang tidak dilakukan</h3>
            <ul>
              <li>Bukan layanan darurat dan tidak mengirim bantuan.</li>
              <li>Tidak menyatakan suatu area bebas risiko. Tidak ada laporan bukan berarti tidak ada kejadian.</li>
              <li>Tidak melacak lokasi Anda.</li>
            </ul>
          </div>
        </div>
      </section>

      <aside className="download-emergency" role="note">
        <strong>Bukan aplikasi darurat.</strong> Dalam keadaan darurat, hubungi <a href="tel:112">112</a>.
      </aside>

      <section className="download-section" aria-labelledby="download-privacy-title">
        <h2 id="download-privacy-title">Privasi</h2>
        <p>Minat dan area yang Anda pilih disimpan di HP Anda. Aplikasi hanya membaca laporan publik dari layanan ini; akun bersifat pilihan. Lihat <a href="#privasi">Data dan privasi</a>.</p>
      </section>
    </>
  );
}

export function DownloadStatus({ state }: { state: LoadState }) {
  if (state.status === "loaded") return <ReleaseDownloads release={state.release} />;
  if (state.status === "loading") {
    return (
      <section className="state-panel state-panel--loading" role="status">
        <span className="loading-rule" aria-hidden="true" />
        <strong>Memuat info rilis…</strong>
      </section>
    );
  }
  if (state.status === "missing") {
    return (
      <section className="state-panel state-panel--compact" role="status">
        <strong>Belum ada rilis.</strong>
        <p>File APK belum diterbitkan. Cek kembali nanti, atau lihat <a href={ALL_RELEASES_URL} rel="noopener">halaman rilis GitHub</a>.</p>
      </section>
    );
  }
  return (
    <section className="state-panel state-panel--error" role="alert">
      <strong>Info rilis belum dapat dimuat.</strong>
      <p>Coba muat ulang halaman, atau buka <a href={ALL_RELEASES_URL} rel="noopener">halaman rilis GitHub</a> langsung.</p>
    </section>
  );
}

export function DownloadPage({ initialState }: { initialState?: LoadState }) {
  const [state, setState] = useState<LoadState>(initialState ?? { status: "loading" });
  useEffect(() => {
    if (initialState) return;
    let active = true;
    void loadMobileRelease().then((next) => { if (active) setState(next); });
    return () => { active = false; };
  }, [initialState]);

  return (
    <main id="main-content" tabIndex={-1} className="main-shell experience-page download-page">
      <div className="page-column">
        <PageHeader
          eyebrow="Aplikasi Android"
          title="Waspada Jakarta di HP Android"
          titleId="download-page-title"
          lead="Laporan kejadian yang sama dengan situs ini, dengan notifikasi untuk area pilihan Anda. Gratis, tanpa iklan."
        />
        <DownloadStatus state={state} />
        <DownloadGuide />
      </div>
    </main>
  );
}
