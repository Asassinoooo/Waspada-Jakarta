import { useEffect, useRef, useState } from "react";
import { Dialog } from "./ui/Dialog.js";

import { INTRO_OPEN_EVENT, isIntroDone, markIntroDone } from "./intro-trigger.js";

export {
  INTRO_OPEN_EVENT,
  INTRO_STORAGE_KEY,
  introAutoOpenFor,
  isIntroDone,
  markIntroDone,
  openOnboardingIntro,
  resetIntroSessionForTests,
  type IntroStorage,
} from "./intro-trigger.js";

const INTRO_TITLE_ID = "onboarding-intro-title";

export interface IntroStep {
  title: string;
  paragraphs: readonly string[];
}

export const INTRO_STEPS: readonly IntroStep[] = [
  {
    title: "Apa itu Waspada Jakarta",
    paragraphs: [
      "Pahami Jakarta sebelum melangkah. Waspada Jakarta menampilkan informasi kejadian di Jakarta beserta buktinya, kesegaran datanya, dan relevansinya bagi Anda. Jelajah laporan publik tanpa akun.",
      "Ini bukan layanan darurat. Dalam keadaan darurat, hubungi 112.",
      "Kami tidak pernah menyatakan suatu area aman, dan tidak adanya laporan tidak membuktikan bahwa suatu tempat aman.",
    ],
  },
  {
    title: "Membaca peta dan bukti",
    paragraphs: [
      "Setiap titik di peta berasal dari sumber yang disebutkan. Buka detailnya untuk melihat jumlah sumber, waktu kejadian dibandingkan waktu terbit, dan status \"perlu pembaruan\".",
      "Jumlah laporan bukan bukti kebenaran.",
    ],
  },
  {
    title: "Simpan area Anda",
    paragraphs: [
      "Atur minat di Area saya untuk melihat pembaruan yang relevan dengan tempat dan topik yang Anda pilih.",
      "Minat disimpan di perangkat ini. Anda tidak perlu akun untuk mulai membaca.",
    ],
  },
];

export interface OnboardingIntroPanelProps {
  step: number;
  onSkip: () => void;
  onAdvance: () => void;
}

/** Presentational content of one intro step. */
export function OnboardingIntroPanel({ step, onSkip, onAdvance }: OnboardingIntroPanelProps) {
  const current = INTRO_STEPS[step] ?? INTRO_STEPS[0]!;
  const last = step >= INTRO_STEPS.length - 1;
  return (
    <div className="intro">
      <p className="eyebrow">Pengenalan singkat</p>
      <h2 id={INTRO_TITLE_ID} className="intro__title">{current.title}</h2>
      {current.paragraphs.map((paragraph) => (
        <p key={paragraph} className="intro__text">{paragraph}</p>
      ))}
      <ol className="intro__steps" aria-label="Langkah pengenalan">
        {INTRO_STEPS.map((item, index) => (
          <li
            key={item.title}
            className={index === step ? "intro__step intro__step--active" : "intro__step"}
            aria-current={index === step ? "step" : undefined}
          >
            <span className="visually-hidden">Langkah {index + 1} dari {INTRO_STEPS.length}</span>
          </li>
        ))}
      </ol>
      <div className="intro__actions">
        <button type="button" className="button button--quiet" onClick={onSkip}>Lewati</button>
        <button type="button" className="button button--primary" onClick={onAdvance}>{last ? "Mulai" : "Lanjut"}</button>
      </div>
    </div>
  );
}

export interface OnboardingIntroProps {
  /** True on the public map route only. The intro never opens automatically on admin, review or login screens. */
  autoOpen?: boolean;
  /** PERF-09c: open at once, for a "Lihat pengenalan" request that arrived while this chunk was loading. */
  openOnMount?: boolean;
}

export function OnboardingIntro({ autoOpen = false, openOnMount = false }: OnboardingIntroProps) {
  const [open, setOpen] = useState(openOnMount);
  const [step, setStep] = useState(0);
  const autoShown = useRef(false);

  useEffect(() => {
    if (!autoOpen || autoShown.current || openOnMount) return;
    autoShown.current = true;
    if (!isIntroDone()) {
      setStep(0);
      setOpen(true);
    }
  }, [autoOpen]);

  useEffect(() => {
    function onOpenRequest() {
      setStep(0);
      setOpen(true);
    }
    window.addEventListener(INTRO_OPEN_EVENT, onOpenRequest);
    return () => window.removeEventListener(INTRO_OPEN_EVENT, onOpenRequest);
  }, []);

  function dismiss() {
    markIntroDone();
    setOpen(false);
  }

  function advance() {
    if (step >= INTRO_STEPS.length - 1) {
      dismiss();
      return;
    }
    setStep(step + 1);
  }

  return (
    <Dialog open={open} onClose={dismiss} titleId={INTRO_TITLE_ID} className="intro-dialog">
      <OnboardingIntroPanel step={step} onSkip={dismiss} onAdvance={advance} />
    </Dialog>
  );
}
