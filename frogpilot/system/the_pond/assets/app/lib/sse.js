function drainEvents(buffer, onMessage) {
  const chunks = buffer.split("\n\n");
  const remainder = chunks.pop();

  for (const chunk of chunks) {
    const line = chunk.split("\n").find((candidate) => candidate.startsWith("data:"));
    if (!line) {
      continue;
    }

    try {
      onMessage(JSON.parse(line.slice(5).trim()));
    } catch (error) {
      console.error("Failed to parse SSE event:", error);
    }
  }

  return remainder;
}

// Opens a progressive Server-Sent Events stream over fetch and returns a handle whose close() aborts
// it. Built on fetch + AbortController rather than EventSource because these streams are one-shot (no
// auto-reconnect) and must tear down deterministically on unmount — the leak that plagued the old
// views (REWRITE_PLAN §3.4, §15.6). The trailing flush also recovers the final record the old reader
// dropped.
export function openStream(url, { onMessage, onDone, onError } = {}) {
  const controller = new AbortController();
  let closed = false;

  const run = async () => {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Stream failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = drainEvents(buffer, onMessage);
    }

    drainEvents(`${buffer}\n\n`, onMessage);
  };

  run()
    .then(() => {
      if (!closed) {
        onDone?.();
      }
    })
    .catch((error) => {
      if (!closed) {
        onError?.(error);
      }
    });

  return {
    close() {
      closed = true;
      controller.abort();
    },
  };
}
