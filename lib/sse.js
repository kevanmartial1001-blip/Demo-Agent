export function sseResponse(streamer) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(obj) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      }
      try {
        await streamer(send);
        controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"));
      } catch (e) {
        send({ type: "error", message: e?.message || String(e) });
      } finally { controller.close(); }
    }
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
