import type { SpanDetail } from '@shared/schema';

/**
 * Fetch one span's full detail (incl. raw attributes) from the Fathom server (M2 drill-down).
 * Returns null on 404 (span evicted from the ring) or any transport error — the caller then
 * shows just the normalized fields it already holds. Only meaningful in live mode; static
 * replay data has no ids and no server behind it.
 */
export async function fetchSpanDetail(server: string, id: string): Promise<SpanDetail | null> {
  try {
    const res = await fetch(`${server}/traces/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as SpanDetail;
  } catch {
    return null;
  }
}
