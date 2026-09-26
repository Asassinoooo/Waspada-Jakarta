import type { EventPage, EventView } from "../../contracts/public-api.js";
import {
  parsePublicEventListQuery,
  type PublicEventListQueryRequest,
} from "./public-event-list-query.js";
import type {
  PublicEventListCursor,
  PublicEventListProjectionService,
} from "./public-event-list-projection-service.js";
import type { PublicEventListCursorCodec } from "./public-event-list-cursor.js";

export interface PublicEventListPageService {
  read(search: URLSearchParams): Promise<EventPage>;
}

export type PublicEventListPageServiceErrorCode =
  | "INVALID_REQUEST"
  | "PUBLIC_EVENT_LIST_READ_FAILED";

const errorMessages: Record<PublicEventListPageServiceErrorCode, string> = {
  INVALID_REQUEST: "The public event list request is invalid.",
  PUBLIC_EVENT_LIST_READ_FAILED: "The public event list could not be read.",
};

/** Stable page-service errors never expose query, cursor, or port details. */
export class PublicEventListPageServiceError extends Error {
  constructor(readonly code: PublicEventListPageServiceErrorCode) {
    super(errorMessages[code]);
    this.name = "PublicEventListPageServiceError";
  }
}

/**
 * Composes the accepted parser, authenticated cursor codec, and current-public
 * Layer 4 list projection into the unchanged public EventPage contract.
 */
export function createPublicEventListPageService(ports: {
  readonly projection: PublicEventListProjectionService;
  readonly cursorCodec: PublicEventListCursorCodec;
}): PublicEventListPageService {
  return {
    async read(search): Promise<EventPage> {
      let query: PublicEventListQueryRequest;
      try {
        query = parsePublicEventListQuery(search);
      } catch {
        fail("INVALID_REQUEST");
      }

      let cursor: PublicEventListCursor | undefined;
      if (query.cursorToken !== null) {
        try {
          cursor = (await ports.cursorCodec.decode(query.cursorToken, query.filters)).cursor;
        } catch {
          fail("INVALID_REQUEST");
        }
      }

      let data: EventView[];
      let nextCursor: PublicEventListCursor | null;
      try {
        const result = await ports.projection.read({
          limit: query.limit,
          filters: query.filters,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (!Array.isArray(result.events) || result.events.length > query.limit) {
          fail("PUBLIC_EVENT_LIST_READ_FAILED");
        }
        data = Array.from(result.events);
        nextCursor = result.nextCursor;
      } catch {
        fail("PUBLIC_EVENT_LIST_READ_FAILED");
      }

      if (nextCursor === null) {
        return { data, page: { next_cursor: null, cursor_expires_at: null } };
      }

      try {
        const issued = await ports.cursorCodec.issue(nextCursor, query.filters);
        return {
          data,
          page: {
            next_cursor: issued.token,
            cursor_expires_at: issued.expiresAt,
          },
        };
      } catch {
        fail("PUBLIC_EVENT_LIST_READ_FAILED");
      }
    },
  };
}

function fail(code: PublicEventListPageServiceErrorCode): never {
  throw new PublicEventListPageServiceError(code);
}
