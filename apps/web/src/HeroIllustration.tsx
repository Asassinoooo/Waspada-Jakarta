import React from "react";

export function HeroIllustration() {
  const riverMaskId = "landing-river-reveal-" + React.useId().replace(/:/g, "");
  return (
    <figure className="landing-art">
      <div className="landing-art__stage">
        <svg
          className="landing-art__svg"
          viewBox="0 0 620 400"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <mask id={riverMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="620" height="400">
              <rect x="0" y="0" width="620" height="400" fill="black" />
              <path
                className="landing-art__river-mask"
                d="M-24 309 C66 274 94 224 176 249 C250 272 265 328 349 298 C432 268 477 213 644 235"
                pathLength="1"
                fill="none"
                stroke="white"
                strokeWidth="86"
                strokeLinecap="round"
                strokeDasharray="1"
                strokeDashoffset="0"
              />
            </mask>
          </defs>

          <g className="landing-art__skyline">
            <path d="M20 267 V156 H62 V188 H94 V111 H143 V221 H171 V173 H208 V225 H240 V130 H289 V215 H316 V164 H351 V227 H389 V116 H432 V224 H468 V157 H508 V225 H544 V137 H592 V268Z" fill="#EAF0ED" />
            <path d="M50 181 H72 M108 134 H128 M256 154 H276 M401 140 H420 M485 178 H499 M556 159 H579" fill="none" stroke="#D5DEDB" strokeWidth="8" strokeLinecap="round" />
            <g className="landing-art__monas">
              <path d="M298 215 L308 106 L318 215 H336 V228 H280 V215Z" fill="#D5DEDB" />
              <path d="M305 108 L308 87 L312 104 L310 111Z" fill="#E7B448" />
            </g>
            <path d="M0 269 C112 245 210 252 310 248 C412 244 501 253 620 234 V315 H0Z" fill="#52676B" opacity=".38" />
          </g>

          <g className="landing-art__flyover">
            <path d="M-8 233 C82 177 154 180 244 218 C332 255 402 186 632 191" fill="none" stroke="#F4F7F5" strokeWidth="17" strokeLinecap="round" />
            <path d="M-8 233 C82 177 154 180 244 218 C332 255 402 186 632 191" fill="none" stroke="#18323A" strokeWidth="3" strokeLinecap="round" />
            <path d="M92 206 V267 M183 204 V269 M395 210 V265 M516 194 V253" fill="none" stroke="#F4F7F5" strokeWidth="7" strokeLinecap="round" />
            <path d="M78 267 H107 M169 269 H197 M381 265 H409 M502 253 H530" fill="none" stroke="#D5DEDB" strokeWidth="7" strokeLinecap="round" />
          </g>

          <path
            className="landing-art__river"
            d="M-24 309 C66 274 94 224 176 249 C250 272 265 328 349 298 C432 268 477 213 644 235"
            mask={"url(#" + riverMaskId + ")"}
            fill="none"
            stroke="#087B75"
            strokeWidth="74"
            strokeLinecap="round"
          />
          <path
            d="M-24 309 C66 274 94 224 176 249 C250 272 265 328 349 298 C432 268 477 213 644 235"
            mask={"url(#" + riverMaskId + ")"}
            fill="none"
            stroke="#F4F7F5"
            strokeWidth="4"
            strokeLinecap="round"
            opacity=".82"
          />
          <path
            d="M27 322 C132 281 165 264 228 293 M445 286 C494 253 539 243 594 247"
            fill="none"
            stroke="#EAF0ED"
            strokeWidth="3"
            strokeDasharray="4 12"
            strokeLinecap="round"
            opacity=".7"
          />
          <text x="36" y="58" fill="#F4F7F5" fontSize="16" fontFamily="inherit" letterSpacing="3">JAKARTA · LAPORAN · KONTEKS</text>
          <circle cx="560" cy="71" r="5" fill="#E7B448" />
        </svg>
        <div className="landing-art__index" aria-hidden="true">
          <span>JKT</span>
          <span>01 / 03</span>
        </div>
      </div>
      <figcaption>Ilustrasi Jakarta — bukan peta kejadian.</figcaption>
    </figure>
  );
}
