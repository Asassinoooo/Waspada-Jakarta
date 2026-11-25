// PERF-09b: the feed's default filters, which App uses when the feed filters are cleared. They live apart from EventFeed.tsx,
// the feed component that no route renders, so importing the constant does not import that component.
import type { Category, FreshnessStatus, Lifecycle } from "@waspada/worker/public-contracts";

export interface FeedFilters {
  category: Category | "all";
  lifecycle: Lifecycle | "all";
  freshness: FreshnessStatus | "all";
}

export const DEFAULT_FEED_FILTERS: FeedFilters = {
  category: "all",
  lifecycle: "all",
  freshness: "all",
};
