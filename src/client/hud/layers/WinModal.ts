import { html, LitElement, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  getGamesPlayed,
  isInIframe,
  translateText,
  TUTORIAL_VIDEO_URL,
} from "../../../client/Utils";
import { formatStake, winnerPayout } from "../../../core/arena/stakeTiers"; // [ARENA]
import { EventBus } from "../../../core/EventBus";
import { RankedType } from "../../../core/game/Game";
import { GameUpdateType } from "../../../core/game/GameUpdates";
import { stakedMatch, StakedMatch } from "../../arena/wagerSession"; // [ARENA]
import "../../components/SteamWishlist";
import { Controller } from "../../Controller";
import { crazyGamesSDK } from "../../CrazyGamesSDK";
import { steamSDK } from "../../SteamSDK";
import { SendWinnerEvent } from "../../Transport";
import { GameView } from "../../view";

@customElement("win-modal")
export class WinModal extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  private hasShownDeathModal = false;

  @state()
  isVisible = false;

  @state()
  showButtons = false;

  @state()
  private isWin = false;

  @state()
  private isRankedGame = false;

  // [ARENA] What this player staked on this match, or null for a free game.
  @state()
  private stake: StakedMatch | null = null;

  private _title: string;

  private rand = Math.random();

  // Override to prevent shadow DOM creation
  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
  }

  render() {
    return html`
      <div
        class="${this.isVisible
          ? "fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-gray-800/70 p-4 md:p-6 shrink-0 rounded-lg z-[10010] shadow-2xl backdrop-blur-xs text-white w-[min(90vw,700px)] max-w-[90%] max-h-[90dvh] overflow-hidden flex flex-col"
          : "hidden"}"
      >
        <h2 class="m-0 mb-4 text-[26px] text-center text-white shrink-0">
          ${this._title || ""}
        </h2>
        <div class="min-h-0 flex-1 overflow-y-auto pr-0.5">
          ${this.innerHtml()}
        </div>
        <div
          class="${this.showButtons
            ? "mt-4 flex justify-between gap-2.5 shrink-0"
            : "hidden"}"
        >
          <o-button
            variant="primary"
            width="block"
            class="flex-1"
            translationKey="win_modal.exit"
            @click=${this._handleExit}
          ></o-button>
          ${this.isRankedGame
            ? html`
                <o-button
                  variant="primary"
                  width="block"
                  class="flex-1"
                  translationKey="win_modal.requeue"
                  @click=${this._handleRequeue}
                ></o-button>
              `
            : null}
          <o-button
            variant="primary"
            width="block"
            class="flex-1"
            .title=${this.game?.myPlayer()?.isAlive()
              ? translateText("win_modal.keep")
              : translateText("win_modal.spectate")}
            @click=${this.hide}
          ></o-button>
        </div>
      </div>
    `;
  }

  innerHtml() {
    // [ARENA] A match somebody staked into ends on what happened to the pot,
    // not on a promo. Checked first: it outranks every other branch, including
    // the beginner tutorial, because the player is owed the number.
    if (this.stake !== null) {
      return this.renderWagerResult(this.stake);
    }

    // The Steam desktop build has nothing to wishlist — fall through to the
    // other promos so the box is never empty.
    const canWishlist = !steamSDK.isOnSteam();

    if (isInIframe()) {
      return canWishlist ? this.steamWishlist() : this.discordDisplay();
    }

    if (!this.isWin && getGamesPlayed() < 3) {
      return this.renderYoutubeTutorial();
    }
    if (this.rand < 0.5 && canWishlist) {
      return this.steamWishlist();
    }
    return this.discordDisplay();
  }

  /**
   * [ARENA] The end of a wagered match: what the winner takes, or what the
   * loser lost and an invitation to go again.
   *
   * Amounts render through `formatStake` as data, outside the translated
   * string — the same rule the lobby card follows, so a missing translation
   * can never hide what changed hands. `winnerPayout` is the shared
   * implementation the stake prompt already quoted, so the figure here is the
   * one the player agreed to rather than a second copy of the rake maths.
   *
   * The winner's line says the payout is *being* made, not that it has been.
   * Settlement runs off the server's replay after the match and fails closed —
   * claiming the tokens had landed would be a promise this screen cannot keep.
   */
  private renderWagerResult(stake: StakedMatch): TemplateResult {
    if (this.isWin) {
      const takes = formatStake(
        winnerPayout(stake.entryFee, stake.maxPlayers, stake.rakeBps),
        stake.decimals,
        stake.symbol,
      );
      return html`
        <div class="text-center mb-6 bg-black/30 p-4 rounded-sm">
          <h3 class="text-xl font-semibold text-white mb-3">
            ${translateText("win_modal.arena_won_title")}
          </h3>
          <p class="text-[34px] font-bold text-emerald-400 leading-none my-2">
            ${takes}
          </p>
          <p class="text-sm text-white/70 mt-3">
            ${translateText("win_modal.arena_won_note")}
          </p>
        </div>
      `;
    }

    const staked = formatStake(stake.entryFee, stake.decimals, stake.symbol);
    return html`
      <div class="text-center mb-6 bg-black/30 p-4 rounded-sm">
        <h3 class="text-xl font-semibold text-white mb-3">
          ${translateText("win_modal.arena_lost_title")}
        </h3>
        <p class="text-white mb-4">
          ${translateText("win_modal.arena_lost_body", { stake: staked })}
        </p>
        <o-button
          variant="primary"
          .title=${translateText("win_modal.arena_try_again")}
          @click=${this._handleExit}
        ></o-button>
      </div>
    `;
  }

  renderYoutubeTutorial() {
    return html`
      <div class="text-center mb-6 bg-black/30 p-2.5 rounded-sm">
        <h3 class="text-xl font-semibold text-white mb-3">
          ${translateText("win_modal.youtube_tutorial")}
        </h3>
        <!-- 56.25% = 9:16 -->
        <div class="relative w-full pb-[56.25%]">
          <iframe
            class="absolute top-0 left-0 w-full h-full rounded-sm"
            src="${this.isVisible ? TUTORIAL_VIDEO_URL : ""}"
            title="YouTube video player"
            frameborder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen
          ></iframe>
        </div>
      </div>
    `;
  }

  steamWishlist(): TemplateResult {
    return html`
      <div class="text-center mb-6 bg-black/30 p-2.5 rounded-sm">
        <h3 class="text-xl font-semibold text-white mb-3">
          ${translateText("steam_wishlist.title")}
        </h3>
        <steam-wishlist
          campaign="win_modal"
          .active=${this.isVisible}
        ></steam-wishlist>
      </div>
    `;
  }

  discordDisplay(): TemplateResult {
    return html`
      <div class="text-center mb-6 bg-black/30 p-2.5 rounded-sm">
        <h3 class="text-xl font-semibold text-white mb-3">
          ${translateText("win_modal.join_discord")}
        </h3>
        <p class="text-white mb-3">
          ${translateText("win_modal.discord_description")}
        </p>
        <a
          href="https://discord.com/invite/openfront"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-block px-6 py-3 bg-indigo-600 text-white rounded-sm font-semibold transition-all duration-200 hover:bg-indigo-700 hover:-translate-y-px no-underline"
        >
          ${translateText("win_modal.join_server")}
        </a>
      </div>
    `;
  }

  show() {
    crazyGamesSDK.gameplayStop();
    // [ARENA] Read at show time, not at construction: the stake is written by
    // the join gate, which runs long before this layer is wired up.
    this.stake = stakedMatch(this.game.gameID());
    // Check if this is a ranked game
    this.isRankedGame =
      this.game.config().gameConfig().rankedType !== undefined;
    this.isVisible = true;
    this.requestUpdate();
    setTimeout(() => {
      this.showButtons = true;
      this.requestUpdate();
    }, 3000);
  }

  hide() {
    this.isVisible = false;
    this.showButtons = false;
    this.requestUpdate();
  }

  private _handleExit() {
    this.hide();
    window.location.href = "/";
  }

  private _handleRequeue() {
    this.hide();
    // Requeue for the same mode; Main owns the mechanism (currently a
    // reload with the requeue param, which reopens the queue after the
    // page teardown).
    document.dispatchEvent(
      new CustomEvent("matchmaking-requeue", {
        detail: {
          mode:
            this.game.config().gameConfig().rankedType === RankedType.TwoVTwo
              ? ("2v2" as const)
              : ("1v1" as const),
        },
      }),
    );
  }

  init() {}

  tick() {
    const myPlayer = this.game.myPlayer();
    if (
      !this.hasShownDeathModal &&
      myPlayer &&
      !myPlayer.isAlive() &&
      !this.game.inSpawnPhase() &&
      myPlayer.hasSpawned()
    ) {
      this.hasShownDeathModal = true;
      this._title = translateText("win_modal.died");
      this.show();
    }
    const updates = this.game.updatesSinceLastTick();
    const winUpdates = updates !== null ? updates[GameUpdateType.Win] : [];
    winUpdates.forEach((wu) => {
      if (wu.winner === undefined) {
        // Match cancelled (e.g. a ranked 2v2 that didn't fill or fully
        // spawn): the game ends with no winner. Still vote the result to the
        // server so the record is archived winnerless (never ranked).
        this.eventBus.emit(new SendWinnerEvent(undefined, wu.allPlayersStats));
        this._title = translateText("win_modal.match_cancelled");
        this.isWin = false;
        history.replaceState(null, "", `${window.location.pathname}?replay`);
        this.show();
      } else if (wu.winner[0] === "team") {
        this.eventBus.emit(new SendWinnerEvent(wu.winner, wu.allPlayersStats));
        if (wu.winner[1] === this.game.myPlayer()?.team()) {
          this._title = translateText("win_modal.your_team");
          this.isWin = true;
          crazyGamesSDK.happytime();
        } else {
          this._title = translateText("win_modal.other_team", {
            team: wu.winner[1],
          });
          this.isWin = false;
        }
        history.replaceState(null, "", `${window.location.pathname}?replay`);
        this.show();
      } else if (wu.winner[0] === "nation") {
        this.eventBus.emit(new SendWinnerEvent(wu.winner, wu.allPlayersStats));
        this._title = translateText("win_modal.nation_won", {
          nation: wu.winner[1],
        });
        this.isWin = false;
        this.show();
      } else {
        const winner = this.game.playerByClientID(wu.winner[1]);
        if (!winner?.isPlayer()) return;
        const winnerClient = winner.clientID();
        if (winnerClient !== null) {
          this.eventBus.emit(
            new SendWinnerEvent(["player", winnerClient], wu.allPlayersStats),
          );
        }
        if (
          winnerClient !== null &&
          winnerClient === this.game.myPlayer()?.clientID()
        ) {
          this._title = translateText("win_modal.you_won");
          this.isWin = true;
          crazyGamesSDK.happytime();
        } else {
          this._title = translateText("win_modal.other_won", {
            player: winner.displayName(),
          });
          this.isWin = false;
        }
        history.replaceState(null, "", `${window.location.pathname}?replay`);
        this.show();
      }
    });
  }
}
