import { useEffect, useRef, type RefObject } from "react";

export type InfiniteScrollOptions = {
  /** Whether another page exists to load. */
  hasMore: boolean;
  /** True while a fetch is in flight (guards against double-loading). */
  loading: boolean;
  /** Fetches and appends the next page. */
  onLoadMore: () => void;
};

/**
 * Attaches an IntersectionObserver to a sentinel element; when it scrolls into
 * view and more data exists, `onLoadMore` fires. Returns the ref to put on the
 * sentinel (render it at the bottom of the list).
 */
export function useInfiniteScroll(
  options: InfiniteScrollOptions,
): RefObject<HTMLDivElement> {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !options.hasMore || options.loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && options.hasMore && !options.loading) {
          options.onLoadMore();
        }
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [options.hasMore, options.loading, options.onLoadMore]);

  return sentinelRef;
}
