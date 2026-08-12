const KEY = "sprawl.player";

/**
 * Who this browser is, across reloads.
 *
 * Drafts belong to a player rather than to a socket, so this is what lets a
 * reload — or a dropped connection — come back to work still standing. Kept in
 * localStorage and unverified: it identifies, it does not authenticate, and
 * anyone can claim to be anyone until players have real accounts.
 */
export function playerId(): string {
  const stored = localStorage.getItem(KEY);
  if (stored) return stored;

  // The server reads this as a u64, so stay inside it.
  const bytes = new BigUint64Array(1);
  crypto.getRandomValues(bytes);
  const id = (bytes[0] >> 1n).toString();
  localStorage.setItem(KEY, id);
  return id;
}
