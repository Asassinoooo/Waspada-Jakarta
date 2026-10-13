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
          Pelajari cara membaca laporan dan periksa data Waspada yang tersimpan di browser ini.
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
        <h2 id="operator-links-title">Tautan operator</h2>
        <p>Ruang ini menampilkan contoh baca saja; tidak ada antrean atau tindakan moderator.</p>
        <nav aria-label="Tautan operator">
          <a href="#admin">Pengelola · demo</a>
          <a href="#tinjau-bukti">Tinjau bukti · demo · baca saja</a>
          {showLocalPipeline && <a href="#pipeline-lokal">Inspektor proses lokal · pengembangan/demo</a>}
        </nav>
      </section>
    </main>
  );
}
