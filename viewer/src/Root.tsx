import { useCallback, useEffect, useState } from "react";
import App from "./App";
import { Dashboard } from "./Dashboard";
import { fetchSites, runHref, type SiteList } from "./sites";

/** Any of these in the URL asks for the viewer: a run, a shot, a filter, a data file. */
const VIEWER_PARAMS = ["site", "run", "tile", "route", "q", "devices", "kinds", "mode", "data"];

const wantsViewer = (): boolean => {
  const p = new URLSearchParams(location.search);
  return VIEWER_PARAMS.some((k) => p.has(k));
};

/**
 * Dashboard or viewer. With more than one site and nothing named in the URL, the
 * page opens on the dashboard; a card opens that site's run, and the viewer's logo
 * comes back. Both moves are history entries, so Back and Forward work as expected.
 */
export function Root() {
  // undefined while `sites.json` is on its way; null when there isn't one.
  const [list, setList] = useState<SiteList | null | undefined>(undefined);
  const [viewer, setViewer] = useState(wantsViewer);

  useEffect(() => {
    void fetchSites().then(setList);
    const onPop = () => setViewer(wantsViewer());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const home = useCallback(() => {
    history.pushState(null, "", location.pathname);
    setViewer(false);
    // Crawls made since the page loaded should show up on the way back.
    void fetchSites().then((next) => next && setList(next));
  }, []);

  const open = useCallback((site: string, run: string) => {
    history.pushState(null, "", location.pathname + runHref(site, run));
    setViewer(true);
  }, []);

  const several = (list?.sites.length ?? 0) > 1;
  if (viewer) return <App onHome={several ? home : undefined} />;
  // A blank page for the moment `sites.json` takes, not a loader that restarts.
  if (list === undefined) return <div className="h-full bg-app" />;
  if (!list || !several) return <App />;
  return <Dashboard list={list} onOpen={open} />;
}
