import { useEffect, useRef, useState } from "react";
import { Dialog } from "./ui/Dialog.js";

export const INTRO_STORAGE_KEY = "waspada-jakarta:intro:v1";
export const INTRO_OPEN_EVENT = "waspada:open-intro";
const INTRO_TITLE_ID = "onboarding-intro-title";

export interface IntroStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// If browser storage cannot be read or written, the intro still shows once per page session.
let dismissedThisSession = false;

function defaultStorage(): IntroStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isIntroDone(storage: IntroStorage | null = defaultStorage()): boolean {
  if (dismissedThisSession) return true;
  try {
    return storage?.getItem(INTRO_STORAGE_KEY) === "done";
  } catch {
    return false;
  }
}

export function markIntroDone(storage: IntroStorage | null = defaultStorage()): void {
  dismissedThisSession = true;
  try {
    storage?.setItem(INTRO_STORAGE_KEY, "done");
  } catch {
    // Storage blocked: the module flag above still keeps the intro closed for this page session.
  }
}

/** Test hook: clears the per-session flag so each test starts from a fresh page session. */
export function resetIntroSessionForTests(): void {
  dismissedThisSession = false;
}

/** Opens the intro from anywhere in the app (help page, account menu). */
export function openOnboardingIntro(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(INTRO_OPEN_EVENT));
}

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

/** The intro opens automatically on the public map only. Admin, review, login, account and source screens never open it. */
export function introAutoOpenFor(screen: string): boolean {
  return screen === "discover";
}

export interface OnboardingIntroProps {
  /** True on the public map route only. The intro never opens automatically on admin, review or login screens. */
  autoOpen?: boolean;
}

export function OnboardingIntro({ autoOpen = false }: OnboardingIntroProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const autoShown = useRef(false);

  useEffect(() => {
    if (!autoOpen || autoShown.current) return;
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
