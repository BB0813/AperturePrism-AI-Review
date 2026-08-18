import { useEffect, useState } from "react";

/** Normalized hash route, e.g. "#/tasks" -> "/tasks", default "/". */
export function readHash(): string {
  const raw = window.location.hash.replace(/^#/, "");
  return raw.startsWith("/") ? raw : `/${raw}`;
}

/** Tracks the current hash route and reacts to manual navigation/back. */
export function useHashRoute(): string {
  const [route, setRoute] = useState<string>(() => readHash());
  useEffect(() => {
    const onChange = () => setRoute(readHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function stripSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/$/, "") : value;
}

/** The exact tab path for a given route (drops sub-paths). */
export function tabOf(route: string): string {
  return stripSlash(route.split("/").slice(0, 2).join("/"));
}

export function navigate(path: string): void {
  window.location.hash = path;
}