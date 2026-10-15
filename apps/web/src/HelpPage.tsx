import { PrivacyPage } from "./PrivacyPage.js";
import { ReadGuide } from "./ReadGuide.js";
import type { PreferencesStorage } from "./preferences-store.js";

export interface HelpPageProps {
  section?: "panduan" | "privasi";
  showLocalPipeline?: boolean;
  storage?: PreferencesStorage | null;
  onCleared?: () => void;
}

export function HelpPage({ section, showLocalPipeline = false, storage, onCleared }: HelpPageProps) {
  return (
    <main id="main-content" tabIndex={-1} className="main-shell experience-page help-page">
      <header className="help-page__intro" aria-labelledby="help-page-title">
        <p className="experience-kicker">Bantuan · informasi dan kontrol</p>
        <h1 id="help-page-title">Panduan dan privasi</h1>
        <p className="experience-lead">
          Pelajari cara membaca laporan, data lokal browser, serta data akun yang disimpan layanan jika Anda masuk.
        </p>
        <nav className="help-page__navigation" aria-label="Bagian bantuan">
          <a href="#panduan" aria-current={section === "panduan" ? "location" : undefined}>Cara membaca laporan</a>
          <a href="#privasi" aria-current={section === "privasi" ? "location" : undefined}>Data dan privasi</a>
        </nav>
      </header>

      <ReadGuide embedded />
      <PrivacyPage embedded storage={storage} onCleared={onCleared} />

      <section id="pengelola" className="help-page__operator" aria-labelledby="operator-links-title">
        <p className="experience-kicker">Ruang contoh dan pengelola</p>
        <h2 id="operator-links-title">Untuk pengelola</h2>
        <p>Ruang administrator memerlukan akun administrator; tampilan tinjau memerlukan akun moderator atau administrator. Keduanya bersifat baca saja dan tidak memiliki kontrol untuk menyetujui atau menerbitkan laporan.</p>
        <nav aria-label="Tautan pengelola">
          <a href="#admin">Ruang administrator</a>
          <a href="#tinjau-bukti">Tinjau bukti · baca saja</a>
          {import.meta.env?.DEV === true && showLocalPipeline && (
            <a href="#pipeline-lokal">Inspektor proses lokal · pengembangan/demo</a>
          )}
        </nav>
      </section>
    </main>
  );
}
