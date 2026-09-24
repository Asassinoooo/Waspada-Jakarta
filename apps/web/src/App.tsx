import { useEffect, useState } from "react";
import { getPublicContext, listEvents } from "./api-client.js";
import { EventFeed, type FeedStatus } from "./EventFeed.js";
import type { EventView, PublicContext } from "@waspada/worker/public-contracts";

export function App() {
  const [status, setStatus] = useState<FeedStatus>("loading");
  const [context, setContext] = useState<PublicContext | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([getPublicContext(), listEvents()])
      .then(([nextContext, page]) => {
        if (cancelled) return;
        setContext(nextContext);
        setEvents(page.data);
        setStatus("loaded");
      })
      .catch(() => {
        if (!cancelled) setStatus("unavailable");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return <EventFeed status={status} events={events} context={context} />;
}
