// [ARENA] new file — the wallets the sign-in picker offers when they are NOT
// installed, and how to get each one.
//
// Discovery (walletStandard.ts) only ever knows about wallets that are already
// in the browser. A first-time visitor with none sees an empty list, and on a
// phone nothing is ever "in the browser" -- Safari and Chrome inject no wallet
// outside the wallet's own in-app browser. So the picker also lists a few
// well-known wallets with a way in: an install page on desktop, and on mobile a
// universal link that reopens this page inside that wallet's in-app browser.
//
// Imports nothing, so it can sit in the main chunk at no cost and stay pure for
// tests.
//
// Adding a wallet: `name` is compared through walletKey(), so "Trust" and
// "Trust Wallet" are one wallet -- an installed copy must not also be offered
// for install. A mobile link needs a documented browse deeplink -- Backpack has
// none we could find, so on a phone it is not offered rather than offered as an
// install link that cannot help the tab the player is in.
//
// ⚠️ A mobile link only gets a player INTO a wallet's browser. Whether they can
// stake there depends on the wallet supporting this deployment's cluster:
// MetaMask documents Solana devnet in its extension only, and Trust Wallet
// documents no devnet at all. Signing in works regardless -- it is a message
// signature, which no cluster is involved in.
//
// No logos are bundled. A wallet's icon comes from the wallet itself once it is
// installed (pickerIcon); for one that is not, the picker draws a monogram in
// the brand colour. Shipping the marks would be redistributing third-party art,
// which needs each brand kit's terms checked first -- the same discipline
// `proprietary/` and the display font follow.

export interface KnownWallet {
  /** The name a player knows it by. Matched loosely; see walletKey(). */
  readonly name: string;
  /** Monogram background. A colour, not an asset. */
  readonly color: string;
  /** Monogram letter colour, chosen for contrast with `color`. */
  readonly ink: string;
  /** Desktop: where to get the browser extension. */
  readonly installUrl: string;
  /**
   * Mobile: a universal link opening `page` inside the wallet's in-app browser,
   * or null when the wallet documents none.
   */
  readonly browseLink: ((page: string, origin: string) => string) | null;
}

const enc = encodeURIComponent;

/**
 * The comparison key for a wallet name: lower-cased, with a trailing "wallet"
 * dropped. Wallets do not agree on whether the word is part of their name --
 * Trust's Solana adapter calls it "Trust", its store listing "Trust Wallet" --
 * and the two must dedupe or one wallet is listed twice.
 */
export function walletKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s*wallet$/, "");
}

/** Whether two wallet names are the same wallet. */
export function sameWallet(a: string, b: string): boolean {
  return walletKey(a) === walletKey(b);
}

export const KNOWN_WALLETS: readonly KnownWallet[] = [
  {
    name: "Phantom",
    color: "#ab9ff2",
    ink: "#000000",
    installUrl: "https://phantom.com/download",
    // docs.phantom.com/phantom-deeplinks/other-methods/browse
    browseLink: (page, origin) =>
      `https://phantom.app/ul/browse/${enc(page)}?ref=${enc(origin)}`,
  },
  {
    name: "MetaMask",
    color: "#f6851b",
    ink: "#000000",
    installUrl: "https://metamask.io/download/",
    // docs.metamask.io/metamask-connect/evm/guides/metamask-exclusive/use-deeplinks
    // documents `link.metamask.io/dapp/{dappUrl}` with one example, a bare host
    // ("app.uniswap.org") -- no protocol, not encoded. The fragment is left off:
    // the docs show none, and a universal link's fragment is not reliably
    // handed to the app.
    browseLink: (page) => {
      const u = new URL(page);
      return `https://link.metamask.io/dapp/${u.host}${u.pathname}${u.search}`;
    },
  },
  {
    name: "Solflare",
    color: "#ffef46",
    ink: "#000000",
    installUrl: "https://www.solflare.com/download/",
    // docs.solflare.com/solflare/technical/deeplinks/other-methods/browse
    browseLink: (page, origin) =>
      `https://solflare.com/ul/v1/browse/${enc(page)}?ref=${enc(origin)}`,
  },
  {
    name: "Trust",
    color: "#0500ff",
    ink: "#ffffff",
    installUrl: "https://trustwallet.com/download",
    // developer.trustwallet.com/developer/develop-for-trust/deeplinking
    // documents `open_url?coin_id=<slip44>&url=<url>` with Ethereum's 60 as the
    // only example. 501 is Solana's SLIP-44 index, so that the in-app browser
    // opens on Solana -- inferred, not documented.
    browseLink: (page) =>
      `https://link.trustwallet.com/open_url?coin_id=501&url=${enc(page)}`,
  },
  {
    name: "Backpack",
    color: "#e33e3f",
    ink: "#ffffff",
    installUrl: "https://backpack.app/downloads",
    browseLink: null,
  },
];

/** What clicking a not-installed wallet does. */
export type SuggestionAction =
  /** Mobile: leave for the wallet's in-app browser, in this tab. */
  | { readonly kind: "open"; readonly url: string }
  /** Desktop: the install page, in a new tab, leaving the picker open. */
  | { readonly kind: "install"; readonly url: string };

export interface WalletSuggestion {
  readonly name: string;
  readonly color: string;
  readonly ink: string;
  readonly action: SuggestionAction;
}

/**
 * The known wallets that are not among `detected`, with how to get each.
 *
 * `page` is the URL to come back to (on mobile, inside the wallet) and `origin`
 * the requesting site, both as the deeplink specs ask for them.
 */
export function suggestWallets(
  detected: readonly string[],
  mobile: boolean,
  page: string,
  origin: string,
): WalletSuggestion[] {
  const out: WalletSuggestion[] = [];
  for (const w of KNOWN_WALLETS) {
    if (detected.some((d) => sameWallet(d, w.name))) continue;
    const base = { name: w.name, color: w.color, ink: w.ink };
    if (mobile) {
      if (w.browseLink === null) continue;
      out.push({
        ...base,
        action: { kind: "open", url: w.browseLink(page, origin) },
      });
    } else {
      out.push({ ...base, action: { kind: "install", url: w.installUrl } });
    }
  }
  return out;
}
