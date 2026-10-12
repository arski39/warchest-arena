// [ARENA] The bytes -> Transaction -> bytes shim for *injected* providers
// (Phantom's old builds and Trust Wallet), the one backend that still wants an
// object. The file keeps its original name; Trust's adapter takes the same
// web3.js Transaction Phantom's does.
//
// Lives in its own file, imported lazily at call time, for the reason the header
// of WalletProvider.ts gives: that module is in the MAIN chunk, and a value
// import of `@solana/web3.js` there would put 294 kB in front of every
// free-to-play player. By the time this runs, `onchainJoin.ts` has already
// pulled web3.js, so the dynamic import is a cache hit.
//
// `walletLogin()` never reaches this path -- it only signs messages -- which is
// what keeps its own documented "no web3.js" invariant intact.
import { Transaction } from "@solana/web3.js";

/** Wire bytes -> a Transaction an injected provider will accept. */
export function toLegacyTransaction(wire: Uint8Array): Transaction {
  return Transaction.from(wire);
}
