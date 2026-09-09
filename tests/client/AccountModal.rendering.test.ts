import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserMeResponse } from "../../src/core/ApiSchemas";

// ─── Mocks (mirrors tests/client/clan/ClanModalTestUtils.ts factories) ──────

vi.mock("../../src/client/Api", () => ({
  getUserMe: vi.fn(async () => false as const),
  invalidateUserMe: vi.fn(),
  fetchPlayerById: vi.fn(async () => null),
  setMarketingConsent: vi.fn(async () => true),
  getApiBase: vi.fn(() => ""),
}));

// [ARENA] Hoisted so the vi.mock factories below can close over them and a test
// can drive the session. Without sessionProvider in the Auth mock the modal's
// resolution threw as an unhandled rejection — which vitest reported as errors
// while still passing every test, so the wallet branch was untested.
const arenaMocks = vi.hoisted(() => ({
  sessionProvider: vi.fn(async (): Promise<string | null> => null),
  storedWalletAddress: vi.fn((): string | null => null),
}));

vi.mock("../../src/client/Auth", () => ({
  discordLogin: vi.fn(),
  googleLogin: vi.fn(),
  linkGoogle: vi.fn(async () => true),
  logOut: vi.fn(async () => true),
  reauthAfterCrazyGamesChange: vi.fn(async () => false),
  sendMagicLink: vi.fn(async () => true),
  getAuthHeader: vi.fn(async () => "Bearer test-token"),
  sessionProvider: arenaMocks.sessionProvider,
}));

vi.mock("../../src/client/arena/walletSession", () => ({
  storedWalletAddress: arenaMocks.storedWalletAddress,
  rememberWalletAddress: vi.fn(),
  forgetWalletAddress: vi.fn(),
}));

// No extension in jsdom. The remembered address is the path that matters here:
// it is what makes a session survive a reload, and reading only the extension
// is what made a successful login render the sign-in screen again.
vi.mock("../../src/client/arena/WalletProvider", () => ({
  getConnectedWallet: vi.fn(() => null),
  // [ARENA] Null is "a desktop browser, or a phone already inside Phantom's
  // in-app browser" — i.e. the ordinary path these cases are about. The mobile
  // hand-off has its own suite in ArenaPhantomMobile.test.ts.
  phantomBrowseLink: vi.fn(() => null),
}));

vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
  showToast: vi.fn(),
  getDiscordAvatarUrl: vi.fn(() => null),
  copyToClipboard: vi.fn(),
  renderNumber: vi.fn((n: number) => String(n)),
  getMapName: vi.fn((m: string) => m),
  renderDuration: vi.fn(() => ""),
}));

vi.mock("../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: {
    isOnCrazyGames: vi.fn(() => false),
    getUserProfile: vi.fn(async () => null),
    showAuthPrompt: vi.fn(async () => null),
    isAvailable: false,
  },
}));

vi.mock("../../src/client/Cosmetics", () => ({
  fetchCosmetics: vi.fn(async () => null),
  translateCosmetic: vi.fn((v: unknown) => v),
}));

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
});

import { AccountModal } from "../../src/client/AccountModal";

function makeUserMe(
  overrides: Partial<UserMeResponse["user"]>,
): UserMeResponse {
  return {
    user: { ...overrides },
    player: {
      publicId: "test-player",
      adfree: false,
      unlimitedRanked: false,
      canCreatePublicLobbies: false,
      achievements: { singleplayerMap: [] },
      friends: [],
      subscription: null,
      currency: { soft: 100, hard: 10 },
    },
  };
}

describe("AccountModal — rendering", () => {
  let modal: AccountModal;

  beforeEach(async () => {
    if (!customElements.get("account-modal")) {
      customElements.define("account-modal", AccountModal);
    }
    modal = document.createElement("account-modal") as AccountModal;
    modal.setAttribute("inline", "");
    document.body.appendChild(modal);
    await modal.updateComplete;
  });

  afterEach(() => {
    document.body.removeChild(modal);
    vi.clearAllMocks();
  });

  // Directly install a resolved userMeResponse and flip off the loading state,
  // bypassing onOpen()'s network calls — this mirrors ClanModalTestUtils'
  // setState() helper, but userMeResponse is a plain private field (not a Lit
  // @state), so we force a render manually afterward.
  async function setLoggedInUser(userMe: UserMeResponse): Promise<void> {
    (
      modal as unknown as { userMeResponse: UserMeResponse | null }
    ).userMeResponse = userMe;
    (modal as unknown as { isLoadingUser: boolean }).isLoadingUser = false;
    modal.requestUpdate();
    await modal.updateComplete;
  }

  // onOpen kicks off getUserMe(); let the microtasks settle before asserting on
  // the rendered output.
  async function flushOpen(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await modal.updateComplete;
  }

  // [ARENA] Puts a wallet session in place for the next open.
  function signedInWith(address: string): void {
    arenaMocks.sessionProvider.mockResolvedValue("wallet");
    arenaMocks.storedWalletAddress.mockReturnValue(address);
  }

  it("shows the wallet address, not the sign-in screen, for a wallet session", async () => {
    // THE REGRESSION. isLinkedAccount() reads /users/@me, which returns
    // `user: {}` for every session on this fork — so a real wallet session
    // rendered renderLoginOptions() and looked like a login that silently
    // failed. Reported from the live site.
    signedInWith("8uqQv5J69KNM3pHx7bVKhGMLQLa6LvDHpjYfivD72bdc");
    modal.open();
    await flushOpen();

    const text = modal.textContent ?? "";
    expect(text).toContain("8uqQv5J69KNM3pHx7bVKhGMLQLa6LvDHpjYfivD72bdc");
    expect(text).toContain("account_modal.wallet_signed_in");
    // The connect button must be gone, not merely further down the page.
    expect(text).not.toContain("account_modal.wallet_login");
  });

  it("still shows the sign-in screen for a guest session", async () => {
    // A guest is the default and must keep seeing the way in. `guest` rather
    // than null, because that is what the token actually says.
    arenaMocks.sessionProvider.mockResolvedValue("guest");
    arenaMocks.storedWalletAddress.mockReturnValue(null);
    modal.open();
    await flushOpen();

    const text = modal.textContent ?? "";
    expect(text).toContain("account_modal.wallet_login");
    expect(text).not.toContain("account_modal.wallet_signed_in");
  });

  it("ignores a remembered address when the session is not a wallet one", async () => {
    // A stale entry from a logout that failed to clear is a display cache, not
    // a credential. Believing it would claim an identity the token denies.
    arenaMocks.sessionProvider.mockResolvedValue("guest");
    arenaMocks.storedWalletAddress.mockReturnValue("8uqQv5J69KNM3pHx7bVKh");
    modal.open();
    await flushOpen();

    const text = modal.textContent ?? "";
    expect(text).toContain("account_modal.wallet_login");
    expect(text).not.toContain("8uqQv5J69KNM3pHx7bVKh");
  });

  it("shows the Steam account (no link/login CTAs) for a Steam-primary user", async () => {
    const userMe = makeUserMe({
      steam: {
        steamId: "76561198000000001",
        personaName: "SnugglePuppy",
        avatarUrl: "https://cdn/x.jpg",
      },
    });
    await setLoggedInUser(userMe);

    // Logged-in Account tab is rendered (not the login-options screen).
    const steamHeader = modal.querySelector("steam-user-header");
    expect(steamHeader).toBeTruthy();

    // No login CTA — that only renders on the logged-out
    // `renderLoginOptions()` screen. [ARENA] The marker used to be the
    // Discord/Google buttons; wallet login replaced them, because this fork's
    // auth service has no OAuth backend and those buttons 404'd.
    const text = modal.textContent ?? "";
    expect(text).not.toContain("account_modal.wallet_login");

    // No Google-link CTA either — Steam is primary in v1, no linking UI.
    expect(text).not.toContain("account_modal.link_google");

    // Currency + logout ARE rendered for the Steam branch of renderLoggedInAs().
    expect(modal.querySelector("currency-display")).toBeTruthy();
    expect(text).toContain("account_modal.log_out");
  });

  // The complement of the test above, and it earns its keep twice over:
  //
  // 1. It covers the direction the isSteamPrimary() primacy fix was about —
  //    a non-Steam user must keep their account-linking UI.
  // 2. It pins `account_modal.link_google` *positively*. The assertions above
  //    are negative checks against translation-key literals, which silently
  //    decay into no-ops if a key is ever renamed. Asserting the same key is
  //    present here means a rename breaks this test loudly instead.
  it("keeps the Google-link CTA for a Discord user (unaffected by the Steam branch)", async () => {
    const userMe = makeUserMe({
      discord: {
        id: "1",
        avatar: null,
        username: "player",
        global_name: null,
        discriminator: "0",
      },
    });
    await setLoggedInUser(userMe);

    const text = modal.textContent ?? "";

    // Discord takes the first branch of renderLoggedInAs() — no Steam header.
    expect(modal.querySelector("steam-user-header")).toBeNull();

    // The linking CTA a Steam-primary user does NOT get.
    expect(text).toContain("account_modal.link_google");

    // Still a logged-in view, not the login-options screen.
    expect(modal.querySelector("currency-display")).toBeTruthy();
    expect(text).toContain("account_modal.log_out");
  });
  // The duplicate-account rejection: the auth callback bounced us back with
  // `login=email_exists` rather than creating a second account, and the user
  // needs to be told why nothing happened and what to do instead.
  it("shows the duplicate-account error after a rejected sign-in", async () => {
    modal.open({ login: "email_exists" });
    await flushOpen();

    // Logged out, so the login options screen is what renders.
    const text = modal.textContent ?? "";
    expect(text).toContain("account_modal.wallet_login");
    expect(text).toContain("account_modal.login_email_exists");
  });

  it("shows no login error on an ordinary open", async () => {
    modal.open();
    await flushOpen();

    const text = modal.textContent ?? "";
    expect(text).toContain("account_modal.wallet_login");
    expect(text).not.toContain("account_modal.login_email_exists");
  });

  it("drops the error when the modal is reopened", async () => {
    modal.open({ login: "email_exists" });
    await flushOpen();
    expect(modal.textContent ?? "").toContain(
      "account_modal.login_email_exists",
    );

    modal.close();
    modal.open();
    await flushOpen();

    expect(modal.textContent ?? "").not.toContain(
      "account_modal.login_email_exists",
    );
  });
});
