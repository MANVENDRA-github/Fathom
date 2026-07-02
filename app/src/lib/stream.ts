import type { StreamMessage, TraceEvent } from '@shared/schema';

export interface StreamHandlers {
  onSnapshot?: (events: TraceEvent[]) => void;
  onSpan?: (event: TraceEvent) => void;
  onJudge?: (id: string, judgeScore: number) => void;
  onOpen?: () => void;
  onError?: () => void;
}

/** Connect to the Fathom server's SSE stream. Returns a disconnect fn. */
export function connectStream(url: string, h: StreamHandlers): () => void {
  const es = new EventSource(url);
  es.onopen = () => h.onOpen?.();
  es.onerror = () => h.onError?.();
  es.onmessage = (ev) => {
    let msg: StreamMessage;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot') h.onSnapshot?.(msg.events);
    else if (msg.type === 'span') h.onSpan?.(msg.event);
    else if (msg.type === 'judge') h.onJudge?.(msg.id, msg.judgeScore);
  };
  return () => es.close();
}
