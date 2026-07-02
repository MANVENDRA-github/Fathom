import { readFile } from 'node:fs/promises';
import type { Hub } from './hub';
import type { NormalizedTrace } from '../../shared/schema';

/**
 * Replay a captured normalized trace as a live stream (for the hosted demo / offline).
 * Feeds one event at a time on an interval; timestamps are stamped "now" so it reads as live.
 * Honest: this is a replay, and the client labels it as such.
 */
export async function startReplay(hub: Hub, file: string, rateMs = 120): Promise<number> {
  const trace = JSON.parse(await readFile(file, 'utf8')) as NormalizedTrace;
  const events = trace.events ?? [];
  let i = 0;
  const timer = setInterval(() => {
    if (!events.length) return;
    hub.ingest([{ ...events[i % events.length], t: Date.now() }]);
    i++;
  }, rateMs);
  timer.unref();
  return events.length;
}
