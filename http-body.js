/**
 * Read a request body as text, refusing anything over a caller-owned limit.
 *
 * On an oversized or broken upload the rest of the stream has to be consumed
 * before replying: an unread body left on a keep-alive socket is parsed as the
 * next request's start line. The loop drains it to the end while dropping the
 * chunks, so memory stays bounded.
 *
 * Shared rather than copied because the drain rule is the subtle part: two
 * spellings of it drift, and the one that drifts is the one that corrupts the
 * next request on the connection.
 * @param req - HTTP request.
 * @param max - largest body accepted, in bytes.
 * @returns the body, or `undefined` when it is too large or unreadable.
 */
export async function readBodyWithin(req, max) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) {
        tooLarge = true;
        chunks.length = 0;
        continue;
      }
      if (!tooLarge) chunks.push(chunk);
    }
  } catch {
    return undefined;
  }
  return tooLarge ? undefined : Buffer.concat(chunks).toString("utf8");
}
