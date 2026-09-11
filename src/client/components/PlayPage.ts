import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { assetUrl } from "../../core/AssetUrls";
import "../arena/WalletBalanceCard"; // [ARENA]
import { crazyGamesSDK } from "../CrazyGamesSDK";
import "./CosmeticBackground";
import "./NewsBox";
import "./SteamWishlist";
import "./StreamingNow";

@customElement("play-page")
export class PlayPage extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <!-- [ARENA] my-auto, not justify-center on the scrolling parent: a
           centred flex item taller than its container has its top clipped and
           cannot be scrolled back to. Auto margins collapse to zero once the
           content fills the space, so a short menu centres and a long one still
           scrolls from the top. -->
      <div
        id="page-play"
        class="flex flex-col gap-2 w-full px-0 lg:px-4 min-h-0 my-auto"
      >
        <token-login class="absolute"></token-login>
        <rewards-modal class="absolute"></rewards-modal>

        <!-- Mobile: Fixed top bar -->
        <div
          class="lg:hidden fixed left-0 right-0 top-0 z-40 pt-[env(safe-area-inset-top)] bg-surface border-b border-white/10"
        >
          <div
            class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center h-14 px-2 gap-2"
          >
            <button
              id="hamburger-btn"
              class="col-start-1 justify-self-start h-10 shrink-0 aspect-[4/3] flex text-white/90 rounded-md items-center justify-center transition-colors"
              data-i18n-aria-label="main.menu"
              aria-expanded="false"
              aria-controls="sidebar-menu"
              aria-haspopup="dialog"
              data-i18n-title="main.menu"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                class="size-8"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                />
              </svg>
            </button>

            <div
              class="col-start-2 flex items-center justify-center text-malibu-blue min-w-0"
            >
              <img
                src=${assetUrl("images/OpenFrontLogo.svg")}
                alt="OpenFront"
                class="h-full w-auto"
              />
            </div>

            ${crazyGamesSDK.isOnCrazyGames()
              ? html`
                  <button
                    id="crazygames-account-btn"
                    data-page="page-account"
                    class="nav-menu-item col-start-3 justify-self-end h-10 shrink-0 flex items-center justify-center rounded-full overflow-hidden text-white/90 cursor-pointer"
                    data-i18n-aria-label="main.account"
                    data-i18n-title="main.account"
                  >
                    <img
                      id="crazygames-account-avatar"
                      class="hidden w-8 h-8 rounded-full object-cover"
                      alt=""
                      referrerpolicy="no-referrer"
                    />
                    <svg
                      id="crazygames-account-icon"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                      class="w-7 h-7"
                    >
                      <path d="M20 21a8 8 0 0 0-16 0" />
                      <path d="M12 13a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z" />
                    </svg>
                  </button>
                `
              : html`
                  <div
                    aria-hidden="true"
                    class="col-start-3 justify-self-end h-10 shrink-0 aspect-[4/3]"
                  ></div>
                `}
          </div>
        </div>

        <!-- [ARENA] Top strip: identity only.
             Upstream had a news banner on the left and a Streaming Now panel on
             the right, with a 2fr/1fr split that existed only while the panel
             was live. Both are gone — the news feed and the streamer list are
             upstream's community, and a fork surfacing them is advertising
             somebody else's game from its own front page. With the right column
             gone the split has nothing to split, so the grid goes too. -->
        <div
          class="w-full pb-4 lg:pb-0 flex flex-col gap-4 sm:-mx-4 sm:w-[calc(100%+2rem)] lg:mx-0 lg:w-full"
        >
          <!-- Mobile: spacer for fixed top bar -->
          <div
            class="lg:hidden h-[calc(env(safe-area-inset-top)+56px)] -mb-4"
          ></div>

          <!-- [ARENA] Identity and wallet share the strip: who you are and what
               you can stake are the two things you check before picking a mode,
               so they read as one row rather than two stacked bars. Stacks on
               mobile, where side-by-side would squeeze both. -->
          <div
            class="grid grid-cols-1 gap-2 min-w-0 lg:grid-cols-[3fr_2fr] lg:items-stretch"
          >
            <!-- Identity row: flag + tag/username + skin in one line. Flag sits before the
                 tag (where it shows in-game), skin at the end; both preview the current
                 selection. Replaces the old separate SELECT SKIN / SELECT FLAG buttons. -->
            <div
              class="relative bg-surface border-y border-white/10 overflow-visible flex items-center sm:min-h-[60px] sm:flex-1 sm:z-20 sm:border-y-0 sm:rounded-xl"
            >
              <!-- Selected skin/pattern fills the bubble like the player's territory in
                   game (the skin button updates it), shown as a frame around the controls. -->
              <cosmetic-background
                class="absolute inset-0 z-0 overflow-hidden sm:rounded-xl pointer-events-none"
              ></cosmetic-background>
              <!-- Controls share one surface bubble so it reads as a single clean bar
                   (buttons blend at rest and only highlight on hover). -->
              <div
                class="relative z-10 flex h-full w-full min-w-0 items-center gap-2 bg-surface/80 p-1 sm:rounded-xl"
              >
                <flag-input
                  show-select-label
                  class="shrink-0 h-full max-h-[52px] aspect-square"
                ></flag-input>
                <username-input
                  class="flex-1 min-w-0 h-10 sm:h-[50px]"
                ></username-input>
                <!-- [ARENA] The skin picker is gone. It opens CosmeticsModal,
                     which reads /cosmetics.json — served as {patterns:{},
                     flags:{}} here, because this deployment sells nothing. The
                     button therefore opened an empty picker. CosmeticsInput and
                     CosmeticsModal are untouched and still reachable, the same
                     treatment Ranked and Clans got; rendering of skins a player
                     already has is a separate path and still works. -->
              </div>
            </div>
          </div>

          <!-- Renders nothing at all when this deployment has no wagering
               configured, in which case the grid collapses to one column. -->
          <wallet-balance-card class="block min-w-0"></wallet-balance-card>
        </div>

        <game-mode-selector></game-mode-selector>

        <!-- Desktop gets the compact footer button instead. -->
        <steam-wishlist
          campaign="home_mobile"
          class="block px-2 pb-4 lg:hidden"
        ></steam-wishlist>
      </div>
    `;
  }
}
