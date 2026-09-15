// [ARENA] Is anything currently relying on this session being the wallet it is?
//
// Extracted from `walletLogin.ts` because a second caller appeared and the two
// must not import each other: `WalletProvider.ts` needs the same predicate to
// decide what to do when a wallet reports that the player switched accounts in
// the extension, and `walletLogin.ts` already imports the provider.
//
// This is the objection `docs/Auth.md` recorded as the reason wallet login was
// deferred. A guest→wallet upgrade swaps `sub`, and therefore the persistentID,
// and therefore any `walletRegistry` binding and any in-flight `jti`-bound match
// signature. Restricting the swap to moments when nothing is bound dissolves the
// problem rather than managing it.
//
// Both checks read the DOM rather than importing from `Main.ts`: `src/client`'s
// entry module owns the game lifecycle and importing it here would be a cycle.
// `in-game` is set and cleared by `Main.ts` around a running match;
// `arena-wager-overlay` is the stake prompt, during which a `jti` has already
// been signed over.
//
// ⚠️ The selector names the STAKE prompt's overlay specifically. The wallet
// picker deliberately uses a different class, because a picker opened in order
// to sign in must not be the thing that makes signing in look forbidden.
export function sessionIsBound(): boolean {
  return (
    document.body.classList.contains("in-game") ||
    document.querySelector(".arena-wager-overlay") !== null
  );
}
