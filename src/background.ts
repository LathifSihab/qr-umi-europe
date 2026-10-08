type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

/**
 * Runs a task after the response is sent, so the user doesn't wait for it.
 * Falls back to awaiting when there's no execution context (tests).
 */
export async function afterResponse(c: { executionCtx: WaitUntil }, task: Promise<unknown>): Promise<void> {
  let ctx: WaitUntil | undefined;
  try {
    ctx = c.executionCtx;
  } catch {}
  if (ctx) ctx.waitUntil(task.catch((err) => console.error("background task failed", err)));
  else await task;
}
