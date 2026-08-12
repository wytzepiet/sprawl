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

  // 48 bits, not 64. The server holds this as a u64, but it comes back through
  // JSON as a double: anything past 2^53 is rounded on arrival, so a client
  // would be comparing its own id against a value neither side agreed on.
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  const id = (bytes[0] * 0x10000 + (bytes[1] & 0xffff)).toString();
  localStorage.setItem(KEY, id);
  return id;
}
