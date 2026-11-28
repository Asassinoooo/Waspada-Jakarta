/**
 * BRAND-01 "Tugu": Monas drawn as the letter i for informasi; the flame is the dot.
 * Drawn on the 64-unit grid of docs/design/logo/a-tugu.svg. The tile colour comes from the
 * surrounding .brand-mark; the monument uses currentColor and the flame uses --brand-flame.
 */
export function BrandMark() {
  return (
    <svg className="brand-mark__svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path
        className="brand-mark__flame"
        d="M32.8 6.8c.45 2.9 3.5 4.7 3.5 8.1a4.3 4.3 0 0 1-8.6 0c0-2.35 1.45-3.7 2.5-4.85.2 1.25.7 2.05 1.6 2.5.35-1.9.75-3.8 1-5.75z"
      />
      <path fill="currentColor" d="M25.9 21.2H38.1L35.1 24.2L36.3 47.2H49.7L45.8 52.2H18.2L14.3 47.2H27.7L28.9 24.2Z" />
      <rect fill="currentColor" x="11.5" y="53.6" width="41" height="2.8" rx="1.2" />
    </svg>
  );
}
