import { PrivacyPage } from "./PrivacyPage.js";
import { openOnboardingIntro } from "./OnboardingIntro.js";
import { ReadGuide } from "./ReadGuide.js";
import type { PreferencesStorage } from "./preferences-store.js";
import { PageHeader } from "./ui/PageHeader.js";

export interface HelpPageProps {
  section?: "panduan" | "privasi";
  showLocalPipeline?: boolean;
  storage?: PreferencesStorage | null;
  onCleared?: () => void;
}

/** `#bantuan`, `#panduan` and `#privasi` share this screen. Its one primary action is "Mulai jelajah" at the end of the guide. */
export function HelpPage({ section, showLocalPipeline = false, storage, onCleared }: HelpPageProps) {
  return (
    <main id="main-content" tabIndex={-1} className="main-shell experience-page help-page">
      <div className="page-column">
        <PageHeader
          eyebrow="Bantuan · informasi dan kontrol"
          title="Panduan dan privasi"
          titleId="help-page-title"
          lead="Pelajari cara membaca laporan, data lokal browser, serta data akun yang disimpan layanan jika Anda masuk."
          action={<button type="button" className="button button--quiet" onClick={() => openOnboardingIntro()}>Lihat pengenalan lagi</button>}
        />
        <nav className="help-page__navigation" aria-label="Bagian bantuan">
          <a href="#panduan" aria-current={section === "panduan" ? "location" : undefined}>Cara membaca laporan</a>
          <a href="#privasi" aria-current={section === "privasi" ? "location" : undefined}>Data dan privasi</a>
        </nav>

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
      </div>
    </main>
  );
}
