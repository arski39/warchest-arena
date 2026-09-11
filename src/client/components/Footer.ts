import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { assetUrl } from "../../core/AssetUrls";
import { ClientEnv } from "../ClientEnv"; // [ARENA]
import "./SteamWishlistButton";

@customElement("page-footer")
export class Footer extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <footer
        class="[.in-game_&]:hidden bg-zinc-900/90 backdrop-blur-md flex flex-col items-center justify-center gap-1 pt-1 pb-3 text-white/50 w-full border-t border-white/10 shrink-0 relative z-50 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center lg:gap-0"
      >
        <!-- Icons and legal links stay centred on the bar; on desktop they
             share it with the Steam promo, which gets its own grid column so
             the two can never overlap however wide a translation runs. -->
        <div
          class="flex w-full flex-col items-center gap-1 lg:col-start-2 lg:w-auto"
        >
          <div
            class="flex items-center justify-center gap-4 lg:gap-6 pt-2 w-full relative"
          >
            <!-- [ARENA] Upstream's Reddit, Discord and wiki links are removed.
               They pointed at OpenFront's community and documentation, which a
               fork surfacing from its own footer is advertising somebody
               else's game.

               ⚠️ This CONTRADICTS docs/branding.md, which lists "the Reddit and
               Discord links in the footer" among the upstream attribution that
               stays for AGPL §7. Read that before this branch goes anywhere
               near a deploy: either restore them, or decide deliberately that
               they are community links rather than author attributions and
               update branding.md to say so. The GitHub source link above is a
               separate matter and is NOT optional — it is the §13 mechanism. -->
            <a
              href=${ClientEnv.sourceRepoUrl()}
              target="_blank"
              rel="noopener noreferrer"
              class="opacity-60 hover:opacity-100 hover:scale-110 transition-all"
            >
              <img
                src=${assetUrl("icons/github-mark-white.svg")}
                data-i18n-alt="main.github"
                class="h-6 w-6 lg:h-7 lg:w-7 object-contain pointer-events-none"
                draggable="false"
              />
            </a>
          </div>
          <div
            class="text-xs mt-1 lg:mt-2 flex items-center justify-center gap-4 px-4"
          >
            <a
              href="/terms-of-service.html"
              data-i18n="main.terms_of_service"
              target="_blank"
              class="hover:text-white transition-colors"
            ></a>
            <span data-i18n="main.copyright"></span>
            <a
              href="/privacy-policy.html"
              data-i18n="main.privacy_policy"
              target="_blank"
              class="hover:text-white transition-colors"
            ></a>
          </div>
        </div>

        <!-- Phones keep the full store widget on the play page instead; there
             is no room for it here. -->
        <div
          class="hidden lg:flex lg:col-start-3 lg:items-center lg:justify-end lg:pt-2 lg:pr-20"
        >
          <steam-wishlist-button
            campaign="home_desktop"
            class="min-w-0 flex-1 max-w-[544px]"
          ></steam-wishlist-button>
        </div>

        <!-- Single instance: translateText() resolves the active language via
             document.querySelector("lang-selector"), so a second one would
             shadow it. -->
        <lang-selector
          class="absolute right-4 top-3 lg:top-1/2 lg:-translate-y-1/2"
        ></lang-selector>
      </footer>
    `;
  }
}
