import { useState } from "react";
import {
  browserPreferencesStorage,
  type PreferencesStorage,
} from "./preferences-store.js";
import {
  clearWaspadaLocalData,
  inspectWaspadaLocalData,
  type ClearLocalDataResult,
  type LocalDataPresence,
  type WaspadaLocalDataItem,
} from "./privacy-store.js";

export interface PrivacyPageProps {
  storage?: PreferencesStorage | null;
  onCleared?: () => void;
}

function presenceLabel(status: LocalDataPresence): string {
  switch (status) {
    case "present":
      return "Ada data tersimpan";
    case "absent":
      return "Belum tersimpan";
    case "unavailable":
      return "Tidak dapat diperiksa";
  }
}

function resultLabel(status: LocalDataPresence): string {
  switch (status) {
    case "present":
      return "Masih tersimpan";
    case "absent":
      return "Tidak tersimpan saat diperiksa";
    case "unavailable":
      return "Belum dapat dipastikan";
  }
}

function resultMessage(result: ClearLocalDataResult): string {
  switch (result.status) {
    case "cleared":
      return result.attempted.length > 0
        ? "Kunci data Waspada yang tercatat sekarang sudah tidak tersimpan di browser ini."
        : "Tidak ada kunci data Waspada yang masih tersimpan di browser ini."
    case "partial":
      return "Sebagian data sudah tidak tersimpan. Periksa hasil setiap item; reset belum selesai sepenuhnya."
    case "failed":
      return "Reset belum selesai. Sebagian data masih tersimpan atau belum dapat diperiksa."
    case "unavailable":
      return "Penyimpanan browser tidak tersedia. Status data tidak dapat dipastikan dan penghapusan belum terverifikasi."
  }
}

function StorageItems({
  items,
  result,
}: {
  items: readonly WaspadaLocalDataItem[];
  result: boolean;
}) {
  return (
    <ul className="experience-storage-list">
      {items.map((item) => (
        <li className="experience-storage-item" key={item.id}>
          <div>
            <strong>{item.label}</strong>
            <p>{item.description}</p>
          </div>
          <span className="experience-storage-status">
            {result ? resultLabel(item.status) : presenceLabel(item.status)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PrivacyPage({ storage, onCleared }: PrivacyPageProps) {
  const [activeStorage] = useState<PreferencesStorage | null>(() =>
    storage === undefined ? browserPreferencesStorage() : storage,
  );
  const [items, setItems] = useState(() => inspectWaspadaLocalData(activeStorage));
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ClearLocalDataResult | null>(null);

  const refresh = () => {
    setItems(inspectWaspadaLocalData(activeStorage));
    setResult(null);
  };

  const clear = () => {
    const nextResult = clearWaspadaLocalData(activeStorage);
    setItems(nextResult.items);
    setResult(nextResult);
    setConfirming(false);
    if (nextResult.attempted.length > 0) onCleared?.();
  };

  return (
    <main id="main-content" className="main-shell experience-page privacy-page">
      <header className="experience-intro" aria-labelledby="privacy-title">
        <p className="experience-kicker">Kontrol privasi · tanpa akun</p>
        <h1 id="privacy-title">Data Waspada di browser ini</h1>
        <p className="experience-lead">
          Anda dapat memeriksa dua kunci lokal yang dikelola aplikasi dan menghapusnya
          tanpa menghapus data situs lain.
        </p>
      </header>

      <section className="experience-card experience-card--wide" aria-labelledby="privacy-local-title">
        <div className="experience-section-heading">
          <div>
            <p className="experience-kicker">Penyimpanan perangkat</p>
            <h2 id="privacy-local-title">Yang tersimpan di browser</h2>
          </div>
          <button className="experience-action experience-action--quiet" type="button" onClick={refresh}>
            Periksa lagi
          </button>
        </div>
        <p>
          Minat dapat berisi tempat, layanan, institusi, kelompok, atau kategori yang
          Anda pilih. Daftar minat dapat diperiksa dan diubah di halaman Ringkasan saya;
          daftar itu tidak disinkronkan ke perangkat lain.
        </p>
        <p>
          Kursor pembaruan hanya menjadi penanda buram untuk melanjutkan pemeriksaan.
          Ringkasan pembaruan disimpan sementara selama halaman digunakan; isi kursor
          tidak ditampilkan di sini.
        </p>
        <StorageItems items={items} result={false} />
      </section>

      <section className="experience-card experience-card--wide" aria-labelledby="privacy-network-title">
        <p className="experience-kicker">Permintaan jaringan</p>
        <h2 id="privacy-network-title">Apa yang dikirim dari browser</h2>
        <ul className="experience-list">
          <li>
            Saat memuat halaman atau laporan, permintaan web dapat membawa metadata
            koneksi seperti alamat IP, informasi browser, halaman yang diminta, dan waktu
            permintaan. Layanan atau penyedia hosting dapat memproses metadata ini;
            halaman ini tidak menghapus catatan mereka.
          </li>
          <li>
            Mengubah atau menyimpan minat tidak mengirimkannya. Minat yang dipilih baru
            dikirim jika Anda sendiri meminta briefing dan mode data persis “live”.
            Kontrak briefing saat ini menyatakan nilai minat tidak disimpan oleh rute itu.
          </li>
          <li>
            Pemeriksaan pembaruan mengirim kursor buram dan dapat memuat detail laporan
            publik untuk pencocokan di browser. Daftar minat tidak dikirim saat polling.
          </li>
          <li>
            Aplikasi ini tidak meminta lokasi perangkat yang presisi. Membaca laporan
            publik tidak memerlukan pendaftaran akun.
          </li>
        </ul>
      </section>

      <section className="experience-card experience-card--wide experience-reset" aria-labelledby="privacy-reset-title">
        <p className="experience-kicker">Penghapusan lokal</p>
        <h2 id="privacy-reset-title">Hapus data Waspada di browser ini</h2>
        <p>
          Tindakan ini hanya menyasar minat dan kursor pembaruan yang tercantum di atas.
          Data browser lain, laporan pada sumber, dan log layanan atau hosting tidak
          dihapus. Tidak ada penghapusan akun atau langganan notifikasi di sini.
        </p>

        {result && (
          <div
            className={"experience-reset-result" + (result.status === "cleared" ? " experience-reset-result--success" : " experience-reset-result--problem")}
            role={result.status === "cleared" ? "status" : "alert"}
            aria-live={result.status === "cleared" ? "polite" : "assertive"}
          >
            <p>{resultMessage(result)}</p>
            <StorageItems items={result.items} result />
          </div>
        )}

        {!confirming ? (
          <button
            className="experience-action experience-action--danger"
            type="button"
            onClick={() => setConfirming(true)}
          >
            Tinjau penghapusan data
          </button>
        ) : (
          <section className="experience-reset-confirm" aria-labelledby="privacy-confirm-title">
            <h3 id="privacy-confirm-title">Hapus dua kunci lokal Waspada?</h3>
            <p>
              Minat tersimpan dan kursor pembaruan akan dihapus jika browser mengizinkan.
              Kami akan memeriksa setiap kunci dan melaporkan jika ada yang masih tersimpan
              atau tidak dapat dipastikan.
            </p>
            <div className="experience-actions">
              <button
                className="experience-action experience-action--quiet"
                type="button"
                onClick={() => setConfirming(false)}
              >
                Batalkan
              </button>
              <button
                className="experience-action experience-action--danger"
                type="button"
                onClick={clear}
              >
                Ya, hapus data Waspada
              </button>
            </div>
          </section>
        )}
      </section>

      <nav className="experience-actions" aria-label="Tautan privasi">
        <a className="experience-action experience-action--primary" href="#jelajah">Kembali ke laporan</a>
        <a className="experience-action experience-action--quiet" href="#ringkasan-saya">Periksa minat tersimpan</a>
      </nav>
    </main>
  );
}
