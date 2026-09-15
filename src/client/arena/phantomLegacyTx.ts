// [ARENA] The bytes -> Transaction -> bytes shim for Phantom's *injected*
// provider, which is the one backend that still wants an object.
//
// Lives in its own file, imported lazily at call time, for the reason the header
// of WalletProvider.ts gives: that module is in the MAIN chunk, and a value
// import of `@solana/web3.js` there would put 294 kB in front of every
// free-to-play player. By the time this runs, `onchainJoin.ts` has already
// pulled web3.js, so the dynamic import is a cache hit.
//
// `walletLogin()` never reaches this path -- it only signs messages -- which is
// what keeps its own documented "no web3.js" invariant intact.
//
// This file is expected to become unreachable. Phantom's desktop extension has
// registered under Wallet Standard since 2022, so the injected path is a
// fallback for old builds and for the in-app browser, pending device testing.
import { Transaction } from "@solana/web3.js";

/** Wire bytes -> a Transaction the injected provider will accept. */
export function deserializeForPhantom(wire: Uint8Array): Transaction {
  return Transaction.from(wire);
}
