import { createConversationListener, getConversationChannelName } from "./conversation-events";

// Rotate before the 300s Hobby/Fluid limit; each reconnection rechecks the session.
export async function openConversationStream(signal: AbortSignal, lifetimeMs = 240000) {
  const client = createConversationListener();
  const channel = getConversationChannelName();
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let ending: Promise<void> | undefined;

  const close = () => {
    if (closed) return ending;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(lifetime);
    signal.removeEventListener("abort", onAbort);
    client.off("notification", onNotification);
    ending = client.end().catch(() => {}).finally(() => {
      try { controller?.close(); } catch { /* Reader may already have cancelled. */ }
    });
    return ending;
  };
  const send = (event: string, data: unknown) => {
    if (closed || !controller) return;
    try {
      // Slow/disconnected readers reconnect and reload state instead of accumulating events.
      if ((controller.desiredSize ?? 1) <= 0) { void close(); return; }
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch { void close(); }
  };
  const onAbort = () => { void close(); };
  const onNotification = (message: { channel?: string; payload?: string }) => {
    if (message.channel === channel && message.payload) {
      // Delivery receipts update the history, not the conversation contents.
      try {
        if (JSON.parse(message.payload).type === "dispatch_status_updated") return;
      } catch { return; }
      // Never broadcast bodies, phone numbers, IDs or ownership to other users.
      send("conversation-update", { refresh: true });
    }
  };
  client.on("error", onAbort);
  client.on("end", onAbort);
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal.aborted) throw new Error("STREAM_ABORTED");
    await client.connect();
    await client.query(`LISTEN ${channel}`);
    if (closed || signal.aborted) throw new Error("STREAM_ABORTED");
    return new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        client.on("notification", onNotification);
        send("connected", { refresh: true });
        heartbeat = setInterval(() => send("keepalive", { at: Date.now() }), 15000);
        lifetime = setTimeout(() => { void close(); }, lifetimeMs);
      },
      async cancel() { await close(); },
    });
  } catch (error) {
    await close();
    throw error;
  }
}
