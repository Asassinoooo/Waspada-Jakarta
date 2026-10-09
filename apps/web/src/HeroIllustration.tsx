import React from "react";

export function HeroIllustration() {
  const riverMaskId = "landing-river-reveal-" + React.useId().replace(/:/g, "");
  const river = "M-32 302 C76 260 155 280 228 316 S365 338 436 309 S570 264 652 276";
  return (
    <figure className="landing-art">
      <div className="landing-art__stage">
        <svg
          className="landing-art__svg"
          viewBox="0 0 620 400"
          width="620"
          height="400"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <mask id={riverMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="620" height="400">
              <path
                className="landing-art__river-mask"
                d={river}
                fill="none"
                stroke="white"
                strokeWidth="104"
                strokeLinecap="round"
              />
            </mask>
          </defs>

          <text x="28" y="48" fill="var(--hujan-pagi)" fontSize="24" fontWeight="700" fontFamily="inherit" letterSpacing="3">JAKARTA</text>
          <path d="M28 62 H174" stroke="var(--beton)" strokeWidth="1" opacity=".45" />
          <path d="M160 143 C174 133 185 138 193 128 C203 117 219 122 228 133 H250" fill="none" stroke="var(--beton)" strokeWidth="2" strokeLinecap="round" opacity=".35" />
          <path d="M38 282 C132 259 198 277 286 269 S443 254 589 267 L620 291 V341 H0 V292Z" fill="var(--beton)" opacity=".16" />

          <g className="landing-art__skyline" strokeLinejoin="round">
            <path d="M28 270 V200 H57 V182 H91 V240 H119 V165 H146 V270 H397 V178 H420 V153 H458 V270 H575 V212 H594 V270Z" fill="var(--beton)" opacity=".42" />
            <path d="M42 270 V214 H90 V270 M104 270 V163 H117 V152 H140 V163 H153 V270 M171 270 V220 H231 V270 M376 270 V192 H411 V270 M442 270 V143 L465 131 H489 V270 M521 270 V181 H535 V163 H557 V181 H571 V270Z" fill="var(--hujan-pagi)" />
            <path d="M36 214 L66 191 L96 214Z M165 220 L201 199 L237 220Z" fill="var(--beton)" />
            <path d="M138 163 H153 V270 H138Z M476 138 H489 V270 H476Z M557 181 H571 V270 H557Z" fill="var(--beton)" />
            <path d="M55 229 V249 M77 229 V249 M116 180 V249 M130 180 V249 M184 234 V255 M201 234 V255 M218 234 V255 M388 207 V251 M400 207 V251 M454 158 V249 M466 151 V249 M533 196 V251 M546 196 V251" fill="none" stroke="var(--tinta-kota)" strokeWidth="3" opacity=".48" />
            <path d="M100 176 H155 M438 153 H490 M517 190 H573" fill="none" stroke="var(--tinta-kota)" strokeWidth="2" opacity=".5" />
          </g>

          <g className="landing-art__monas">
            <path d="M310 239 L316 132 H326 L332 239Z" fill="var(--hujan-pagi)" />
            <path d="M310 239 L316 132 H321 L317 239Z M307 122 H335 L331 132 H311Z" fill="var(--beton)" />
            <path d="M316 120 C308 114 320 111 320 100 C331 107 336 114 327 120Z" fill="var(--kuning-perhatian)" />
            <path d="M298 239 H344 V246 H354 V255 H288 V246 H298Z M280 258 H362 V267 H280Z" fill="var(--hujan-pagi)" />
            <path d="M307 245 H335 M297 253 H346" fill="none" stroke="var(--tinta-kota)" strokeWidth="2" opacity=".5" />
            <path d="M288 264 H354" stroke="var(--beton)" strokeWidth="2" />
          </g>

          <g mask={"url(#" + riverMaskId + ")"}>
            <path d={river} fill="none" stroke="var(--beton)" strokeWidth="90" strokeLinecap="round" />
            <path d={river} fill="none" stroke="var(--kali-teal)" strokeWidth="64" strokeLinecap="round" />
            <path d="M19 296 C73 277 113 282 152 296 M271 331 C320 345 375 332 406 318 M479 290 C525 277 565 275 611 280" fill="none" stroke="var(--hujan-pagi)" strokeWidth="2" strokeLinecap="round" opacity=".65" />
          </g>

          <g className="landing-art__flyover" fill="none">
            <path d="M62 255 V291 M178 274 V326 M404 268 V310 M535 241 V273" stroke="var(--beton)" strokeWidth="8" />
            <path d="M50 291 H74 M166 326 H190 M392 310 H416 M523 273 H547" stroke="var(--tinta-kota)" strokeWidth="4" strokeLinecap="round" />
            <path d="M-16 253 C82 229 129 270 219 278 S389 284 479 253 S559 234 636 235" stroke="var(--tinta-kota)" strokeWidth="22" />
            <path d="M-16 249 C82 225 129 266 219 274 S389 280 479 249 S559 230 636 231" stroke="var(--hujan-pagi)" strokeWidth="13" />
            <path d="M-16 249 C82 225 129 266 219 274 S389 280 479 249 S559 230 636 231" stroke="var(--tinta-kota)" strokeWidth="2" />
          </g>

          <g fill="var(--beton)">
            <path d="M35 343 L34 326 C17 326 14 318 23 313 C18 305 28 301 34 307 C40 294 53 299 51 311 C65 312 61 324 41 326 L42 343Z" />
            <path d="M561 338 L561 321 C546 324 538 316 546 309 C541 300 552 296 559 305 C565 291 579 294 577 307 C592 309 587 320 568 322 L568 338Z" />
          </g>

          <g className="landing-art__paper landing-art__paper--laporan">
            <path d="M211 92 L252 76 L240 103 L229 94 L223 106 L222 95Z" fill="var(--hujan-pagi)" />
            <path d="M222 95 L252 76 L229 94 L223 106Z" fill="var(--beton)" />
            <path d="M222 95 L252 76 L229 94" fill="none" stroke="var(--tinta-kota)" strokeWidth="1.5" strokeLinejoin="round" />
          </g>
          <g className="landing-art__paper landing-art__paper--bukti">
            <path d="M422 89 L466 69 L453 99 L441 91 L435 102 L434 92Z" fill="var(--beton)" />
            <path d="M434 92 L466 69 L441 91 L435 102Z" fill="var(--hujan-pagi)" />
            <path d="M434 92 L466 69 L441 91" fill="none" stroke="var(--tinta-kota)" strokeWidth="1.5" strokeLinejoin="round" />
          </g>
          <g className="landing-art__paper landing-art__paper--konteks">
            <path d="M519 120 L559 108 L545 133 L535 123 L528 135 L530 124Z" fill="var(--hujan-pagi)" />
            <path d="M530 124 L559 108 L535 123 L528 135Z" fill="var(--beton)" />
            <path d="M530 124 L559 108 L535 123" fill="none" stroke="var(--tinta-kota)" strokeWidth="1.5" strokeLinejoin="round" />
          </g>
        </svg>
        <div className="landing-art__index" aria-hidden="true">
          <span>Laporan</span>
          <span>Bukti</span>
          <span>Konteks</span>
        </div>
      </div>
      <figcaption>Ilustrasi Jakarta — bukan peta kejadian.</figcaption>
    </figure>
  );
}
