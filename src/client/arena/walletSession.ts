// [ARENA] Which wallet the current session belongs to, remembered locally.
//
// The session itself is authoritative and lives in the JWT: `provider: "wallet"`
// says this is a wallet session. But the token carries no address — `sub` is a
// one-way hash of it (`auth/identity.ts`), and `/users/@me` deliberately reports
// no identity at all, because populating its `user` block would light up the
// account-management UI this fork has no backend for.
//
// So the address has to come from somewhere else, and the obvious candidate —
// asking the extension via `getConnectedWallet()` — does not survive a reload.
// `mountWalletProvider()` runs at module scope while Phantom's auto-connect is
// asynchronous, so immediately after a page load it is usually still null. That
// raced badly enough to make a successful login look like a failed one: the
// session was real, and every part of the UI that could have said so was
// reading an extension that had not finished waking up.
//
// Storing it removes the race. This is a public key, not a secret — it is
// printed on lobby cards and written into every escrow — so localStorage is an
// appropriate home. It is a *cache of a display value*, never a claim of
// authentication: callers must still confirm `provider === "wallet"` from the
// token before treating it as a session. A stale entry left by a logout that
// failed to clear can therefore only ever be ignored, never believed.
const WALLET_ADDRESS_KEY = "arena_wallet_address";

/** Records the wallet a session was just minted for. */
export function rememberWalletAddress(address: string): void {
  try {
    localStorage.setItem(WALLET_ADDRESS_KEY, address);
  } catch {
    // Private mode, or storage disabled. The nav falls back to the connected
    // extension and, failing that, to the signed-out prompt — worse looking,
    // but never wrong about who is signed in.
  }
}

/** The remembered address, or null. Meaningless without a `wallet` provider claim. */
export function storedWalletAddress(): string | null {
  try {
    return localStorage.getItem(WALLET_ADDRESS_KEY);
  } catch {
    return null;
  }
}

export function forgetWalletAddress(): void {
  try {
    localStorage.removeItem(WALLET_ADDRESS_KEY);
  } catch {
    // Nothing to do: see above, a stale value is only ever ignored.
  }
}

// ---------------------------------------------------------------------------
// Which wallet APP, as opposed to which address
// ---------------------------------------------------------------------------
//
// A separate key, deliberately not folded into the address above. The address is
// a cache of a display value belonging to a session; this is a reconnect hint
// belonging to a browser, and the two have different lifetimes — signing out
// forgets the address, but the next visitor to this browser still has the same
// wallet installed and should not be asked to pick it again.
//
// It is even less of a claim than the address is: it names a piece of software,
// not a person. Nothing is granted on the strength of it. The only thing it
// decides is which registered wallet `mountWalletProvider()` offers its silent
// reconnect to, and a name that no longer matches anything in the registry is
// simply ignored.
const WALLET_NAME_KEY = "arena_wallet_name";

/** Records which wallet app the player last connected through. */
export function rememberWalletName(name: string): void {
  try {
    localStorage.setItem(WALLET_NAME_KEY, name);
  } catch {
    // Private mode. The cost is a picker that does not preselect, which is the
    // pre-existing behaviour rather than a broken one.
  }
}

/** The last wallet app connected in this browser, or null. */
export function storedWalletName(): string | null {
  try {
    return localStorage.getItem(WALLET_NAME_KEY);
  } catch {
    return null;
  }
}

export function forgetWalletName(): void {
  try {
    localStorage.removeItem(WALLET_NAME_KEY);
  } catch {
    // See above.
  }
}
