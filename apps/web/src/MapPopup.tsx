import type { Ref } from "react";
import type { EventView } from "@waspada/worker/public-contracts";
import { isDismissKey } from "./ui/a11y.js";
import { Sheet } from "./ui/Sheet.js";
import {
  areaText,
  categoryText,
  eventTimeText,
  freshnessText,
  lifecycleText,
  publishedAtText,
  sourceCountText,
  sourceNamesOf,
  type PublishedMarker,
} from "./published-events.js";

/** Popup box width on desktop, used to keep it inside the map. */
export const POPUP_WIDTH_PX = 320;
const POPUP_EDGE_PX = 8;
/** Above this y the popup opens upward, otherwise downward. The toolbar sits at the top-left. */
const ABOVE_THRESHOLD_PX = 360;

export interface PopupAnchor {
  left: number;
  top: number;
  placement: "above" | "below";
}

/** Where the anchored popup sits for a marker at point (x, y) in a map of the given size. Pure. */
export function popupAnchor(point: { x: number; y: number }, width: number, height: number): PopupAnchor {
  const half = POPUP_WIDTH_PX / 2;
  const minLeft = Math.min(half + POPUP_EDGE_PX, width / 2);
  const maxLeft = Math.max(width - half - POPUP_EDGE_PX, width / 2);
  const left = Math.min(maxLeft, Math.max(minLeft, point.x));
  const top = Math.min(height - POPUP_EDGE_PX, Math.max(POPUP_EDGE_PX, point.y));
  return { left, top, placement: top >= ABOVE_THRESHOLD_PX ? "above" : "below" };
}

/** Used when the selected event has no marker. The popup sits at the bottom centre of the map. */
export function unmappedPopupAnchor(width: number, height: number): PopupAnchor {
  return { left: width / 2, top: Math.max(POPUP_EDGE_PX, height - POPUP_EDGE_PX), placement: "above" };
}

export interface MapPopupProps {
  event: EventView;
  marker: PublishedMarker | null;
  titleId: string;
  copyMessage: string | null;
  onClose: () => void;
  onViewDetail: () => void;
  onCopyLink: () => void;
}

function locationNote(marker: PublishedMarker | null): string {
  if (marker === null) return "Lokasi belum dipetakan dari sumber.";
  return marker.role === "approximate_place" ? "Titik lokasi perkiraan dari sumber." : "Titik lokasi dari sumber.";
}

/** Shared body for the anchored popup (desktop) and the peek sheet (phone). It carries no radius or circle. */
function MapPopupBody({ event, marker, titleId, copyMessage, onClose, onViewDetail, onCopyLink }: MapPopupProps) {
  const sourceCount = sourceNamesOf(event).length;
  return (
    <>
      <header className="map-popup__head">
        <span className="badge">{categoryText(event.category)}</span>
        <button type="button" className="button button--quiet button--sm map-popup__close" aria-label="Tutup laporan" onClick={onClose}>
          Tutup
        </button>
      </header>
      <h2 id={titleId} className="map-popup__title">{event.title}</h2>
      <dl className="map-popup__facts">
        <div>
          <dt>Waktu kejadian</dt>
          <dd>{eventTimeText(event)}</dd>
        </div>
        <div>
          <dt>Diterbitkan</dt>
          <dd>{publishedAtText(event)}</dd>
        </div>
        <div>
          <dt>Lokasi</dt>
          <dd>{areaText(event)}</dd>
        </div>
      </dl>
      <p className="map-popup__status">
        <span className="badge">{freshnessText(event.freshness.status)}</span>
        <span className="map-popup__lifecycle">{lifecycleText(event.lifecycle)}</span>
      </p>
      <p className="map-popup__sources">
        <strong>{sourceCountText(sourceCount)}</strong>
        <span className="muted"> · Jumlah sumber bukan bukti kebenaran.</span>
      </p>
      <p className="map-popup__note muted">{locationNote(marker)}</p>
      <div className="map-popup__actions">
        <button type="button" className="button button--primary" onClick={onViewDetail}>
          Lihat detail
        </button>
        <button type="button" className="button button--quiet" onClick={onCopyLink}>
          Salin tautan
        </button>
      </div>
      {copyMessage !== null && <p className="map-popup__copy" role="status">{copyMessage}</p>}
    </>
  );
}

export interface AnchoredMapPopupProps extends MapPopupProps {
  anchor: PopupAnchor;
  rootRef?: Ref<HTMLElement>;
}

/**
 * Desktop popup anchored to its marker. It is not modal: Escape closes it, and focus moves into it
 * when the user opens it (the map home handles the focus call).
 */
export function AnchoredMapPopup({ anchor, rootRef, ...body }: AnchoredMapPopupProps) {
  const offset = anchor.placement === "above" ? "map-popup--above" : "map-popup--below";
  return (
    <section
      ref={rootRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={body.titleId}
      tabIndex={-1}
      className={`map-popup map-popup--anchored ${offset}`}
      style={{ left: anchor.left, top: anchor.top }}
      onKeyDown={(event) => {
        if (!isDismissKey(event.key)) return;
        event.preventDefault();
        body.onClose();
      }}
    >
      <MapPopupBody {...body} />
    </section>
  );
}

/** Phone popup: a short bottom sheet that leaves the map visible and tappable behind it (see map-home.css). */
export function PeekMapPopup(props: MapPopupProps) {
  return (
    <Sheet open onClose={props.onClose} titleId={props.titleId} className="map-popup map-popup--peek">
      <MapPopupBody {...props} />
    </Sheet>
  );
}
