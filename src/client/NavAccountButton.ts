import { UserMeResponse } from "../core/ApiSchemas";
import { hasLinkedIdentity } from "./AccountIdentity";
import { getDiscordAvatarUrl, translateText } from "./Utils";

// Renders the persistent top-nav account button from the resolved /users/@me
// response: a linked identity shows its avatar/badge, everything else shows the
// signed-out prompt. Extracted from Main.ts so the identity precedence — which
// now includes Steam — is unit-testable in jsdom.
export function updateAccountNavButton(
  userMeResponse: UserMeResponse | false,
  // [ARENA] The address of a wallet session, or null. Passed in rather than read
  // here because it is two facts from two places: the token's `provider` claim
  // (this is a wallet session, not a guest who merely has an extension
  // connected for staking) and WalletProvider's connected adapter (the address
  // itself). /users/@me deliberately reports neither — putting the wallet in its
  // `user` block would light up the account-management UI this fork has no
  // backend for.
  walletAddress: string | null = null,
) {
  const button = document.getElementById("nav-account-button");
  if (!button) return;

  const avatarEl = document.getElementById("nav-account-avatar") as
    | (HTMLImageElement & { _navToken?: symbol })
    | null;
  const personIconEl = document.getElementById(
    "nav-account-person-icon",
  ) as SVGElement | null;
  const emailBadgeEl = document.getElementById(
    "nav-account-email-badge",
  ) as HTMLElement | null;
  const signInTextEl = document.getElementById(
    "nav-account-signin-text",
  ) as HTMLSpanElement | null;
  const walletTextEl = document.getElementById(
    "nav-account-wallet-text",
  ) as HTMLSpanElement | null; // [ARENA]

  // Auth state is resolved, so the button no longer shows the loading spinner.
  document
    .getElementById("nav-account-loading-spinner")
    ?.classList.add("hidden");

  // Unique token for this update call
  const navToken = Symbol();
  if (avatarEl) avatarEl._navToken = navToken;

  // Logged in, but with no avatar or badge to show (e.g. Steam without a
  // cached avatar, or an avatar that failed to load): the person icon alone,
  // minus the signed-out prompt.
  const showLoggedInPlain = () => {
    avatarEl?.classList.add("hidden");
    personIconEl?.classList.remove("hidden");
    emailBadgeEl?.classList.add("hidden");
    signInTextEl?.classList.add("hidden");
    button?.classList.add("border", "border-white/20");
    walletTextEl?.classList.add("hidden"); // [ARENA]
  };

  const showAvatar = (src: string, alt?: string) => {
    if (avatarEl) {
      avatarEl.alt = alt ?? translateText("main.discord_avatar_alt");
      // If the avatar fails to load (bad URL / CDN issue / offline), fall back
      // to the provider-neutral logged-in state rather than leaving a broken
      // image or a mismatched default (the button is used by Discord and Steam).
      avatarEl.onerror = () => {
        if (avatarEl._navToken !== navToken) return;
        avatarEl.onerror = null;
        showLoggedInPlain();
      };
      avatarEl.onload = () => {
        // Only handle if this is the latest update
        if (avatarEl._navToken !== navToken) return;
        // Clear error handler after a successful load.
        avatarEl.onerror = null;
      };
      avatarEl.src = src;
      avatarEl.classList.remove("hidden");
    }
    personIconEl?.classList.add("hidden");
    emailBadgeEl?.classList.add("hidden");
    signInTextEl?.classList.add("hidden");
    walletTextEl?.classList.add("hidden"); // [ARENA]
    button?.classList.remove("border", "border-white/20");
  };

  const showSignIn = () => {
    avatarEl?.classList.add("hidden");
    personIconEl?.classList.remove("hidden");
    emailBadgeEl?.classList.add("hidden");
    signInTextEl?.classList.remove("hidden");
    walletTextEl?.classList.add("hidden"); // [ARENA]
    // Restore border when showing signin state
    button?.classList.add("border", "border-white/20");
  };

  // [ARENA] A wallet session: the shortened address instead of "sign in".
  //
  // Truncated head and tail, never the middle: base58 addresses share no common
  // prefix, so the first characters do not identify one, and a reader comparing
  // it against their wallet checks both ends.
  const showWallet = (address: string) => {
    avatarEl?.classList.add("hidden");
    personIconEl?.classList.remove("hidden");
    emailBadgeEl?.classList.add("hidden");
    signInTextEl?.classList.add("hidden");
    if (walletTextEl) {
      walletTextEl.textContent =
        address.length > 11
          ? `${address.slice(0, 4)}…${address.slice(-4)}`
          : address;
      walletTextEl.classList.remove("hidden");
    }
    button?.classList.add("border", "border-white/20");
  };

  const showEmailLoggedIn = () => {
    avatarEl?.classList.add("hidden");
    personIconEl?.classList.remove("hidden");
    emailBadgeEl?.classList.remove("hidden");
    signInTextEl?.classList.add("hidden");
    button?.classList.add("border", "border-white/20");
    walletTextEl?.classList.add("hidden"); // [ARENA]
  };

  const discord =
    userMeResponse !== false ? userMeResponse.user.discord : undefined;
  if (discord && avatarEl) {
    const avatarAlt = translateText("main.user_avatar_alt", {
      username: discord.username,
    });
    const url = getDiscordAvatarUrl(discord);
    if (url) {
      showAvatar(url, avatarAlt);
      return;
    }
  }

  // Steam is a first-class logged-in identity (parity with Discord). A cached
  // avatar renders like the Discord avatar; without one — the summaries fetch
  // failed or hasn't populated yet — fall back to the logged-in person icon,
  // never the signed-out prompt (the bug that made Steam desktop players look
  // like guests). Placed after Discord so a future linked account still
  // prefers the Discord avatar.
  const steam =
    userMeResponse !== false ? userMeResponse.user.steam : undefined;
  if (steam) {
    if (steam.avatarUrl && avatarEl) {
      const avatarAlt = translateText("main.user_avatar_alt", {
        username:
          steam.personaName ?? translateText("steam_user_header.default_name"),
      });
      showAvatar(steam.avatarUrl, avatarAlt);
    } else {
      showLoggedInPlain();
    }
    return;
  }

  const email =
    userMeResponse !== false ? userMeResponse.user.email : undefined;
  if (email) {
    showEmailLoggedIn();
    return;
  }

  // Google logins have no avatar; show the same person/email badge as magic-link.
  const google =
    userMeResponse !== false ? userMeResponse.user.google : undefined;
  if (google) {
    showEmailLoggedIn();
    return;
  }

  // A linked identity that reached here rendered nothing rich (e.g. a Discord
  // account whose avatar URL didn't resolve, or a missing avatar element): the
  // user is still authenticated, so show the logged-in person icon. Only a
  // session with no linked identity at all gets the sign-in prompt.
  if (userMeResponse !== false && hasLinkedIdentity(userMeResponse.user)) {
    showLoggedInPlain();
    return;
  }

  // [ARENA] Last before the signed-out prompt, so a linked upstream identity
  // still wins if one ever exists. On this fork nothing above ever matches —
  // /users/@me returns `user: {}` — so in practice this is the only logged-in
  // state the nav can show.
  if (walletAddress !== null) {
    showWallet(walletAddress);
    return;
  }

  showSignIn();
}
