import { lazy, Suspense, useEffect, useState } from "react";
import { INTRO_OPEN_EVENT, isIntroDone } from "./intro-trigger.js";

const LazyOnboardingIntro = lazy(() => import("./OnboardingIntro.js").then((module) => ({ default: module.OnboardingIntro })));

/** Why the intro chunk was loaded: a first visit to the map, or an explicit "Lihat pengenalan" request. */
export type IntroLoadReason = "none" | "auto" | "requested";

export interface OnboardingIntroGateProps {
  autoOpen?: boolean;
  /** Test hook for the initial state; the app always starts at "none". */
  initialReason?: IntroLoadReason;
}

/**
 * PERF-09c: renders nothing until the intro will actually be shown, then loads the dialog chunk. Returning visitors who
 * finished the intro never download it. A request that arrives before the chunk loads is carried over as `openOnMount`.
 */
export function OnboardingIntroGate({ autoOpen = false, initialReason = "none" }: OnboardingIntroGateProps) {
  const [reason, setReason] = useState<IntroLoadReason>(initialReason);

  useEffect(() => {
    if (autoOpen && !isIntroDone()) setReason((current) => (current === "none" ? "auto" : current));
  }, [autoOpen]);

  useEffect(() => {
    if (reason !== "none") return;
    function onOpenRequest() {
      setReason("requested");
    }
    window.addEventListener(INTRO_OPEN_EVENT, onOpenRequest);
    return () => window.removeEventListener(INTRO_OPEN_EVENT, onOpenRequest);
  }, [reason]);

  if (reason === "none") return null;
  return (
    <Suspense fallback={null}>
      <LazyOnboardingIntro autoOpen={autoOpen} openOnMount={reason === "requested"} />
    </Suspense>
  );
}
