import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ClientEnv } from "src/client/ClientEnv";
import {
  Duos,
  GameMapType,
  GameMode,
  HumansVsNations,
  Quads,
  Trios,
} from "../core/game/Game";
import { PublicGameInfo, PublicGames } from "../core/Schemas";
import { DuelPanel } from "./arena/DuelPanel";
import "./components/IOSAddToHomeScreenBanner";
import { HostLobbyModal } from "./HostLobbyModal";
import { JoinLobbyModal } from "./JoinLobbyModal";
import { PublicLobbySocket } from "./LobbySocket";
import { JoinLobbyEvent } from "./Main";
import { SinglePlayerModal } from "./SinglePlayerModal";
import { terrainMapFileLoader } from "./TerrainMapFileLoader";
import { UsernameInput } from "./UsernameInput";
import {
  calculateServerTimeOffset,
  getMapName,
  getModifierLabels,
  getSecondsUntilServerTimestamp,
  renderDuration,
  translateText,
} from "./Utils";

const CARD_BG = "bg-surface";

// [ARENA] The two card treatments, named rather than repeated inline. There is
// exactly one primary card and it marks the site's primary mode — the accent
// belonged to Solo and now belongs to 1v1.
//
// ⚠️ BOTH scale on Y and barely on X, and that is not a style choice. These
// cards live inside `MainLayout`'s scroller, which is `overflow-y-auto
// overflow-x-hidden` — so anything a hover draws outside the card is CLIPPED
// at the scroller's edge, and the gutter it has to fit inside is only the
// 16px of `#page-play`'s `lg:px-4`.
//
// A uniform `scale-105` on a ~724px-wide card pushes each edge out by ~18px,
// past that 16px — so the hover ring's left and right sides were cut off and
// the glow never appeared at all. The card looked like it had a top and bottom
// border and nothing else. `scale-x-[1.01]` is ~3.6px instead, which leaves
// the ring and effectively all of the glow inside the clip.
//
// Do not "tidy" either one back to `scale-105`: it is the horizontal scale
// that breaks, the failure is invisible to tsc, lint and any test that does
// not measure, and it only shows on a real hover. Widening the gutter instead
// would work, but it narrows every card on the page to buy an animation.
// `overflow-x` cannot simply be made visible either — CSS computes a `visible`
// axis to `auto` when the other axis scrolls, so that trades the clip for a
// horizontal scrollbar that appears on hover.
const PRIMARY_CARD =
  "bg-malibu-blue hover:bg-aquarius active:bg-malibu-blue/80 hover:scale-y-105 hover:scale-x-[1.01]";
const SECONDARY_CARD =
  "bg-surface hover:brightness-[1.08] active:brightness-[0.95] hover:scale-y-105 hover:scale-x-[1.01] hover:shadow-[var(--shadow-action-card-hover)]";

@customElement("game-mode-selector")
export class GameModeSelector extends LitElement {
  @state() private lobbies: PublicGames | null = null;
  @state() private mapAspectRatios: Map<GameMapType, number> = new Map();
  @state() private inputValid: boolean = true;
  private serverTimeOffset: number = 0;
  private defaultLobbyTime: number = 0;

  private lobbySocket = new PublicLobbySocket((lobbies) =>
    this.handleLobbiesUpdate(lobbies),
  );

  createRenderRoot() {
    return this;
  }

  // Silent backstop; the buttons are already disabled while input is invalid.
  private validateUsername(): boolean {
    const usernameInput = document.querySelector(
      "username-input",
    ) as UsernameInput | null;
    return usernameInput ? usernameInput.canPlay() : true;
  }

  connectedCallback() {
    super.connectedCallback();
    this.lobbySocket.start();
    this.defaultLobbyTime = ClientEnv.gameCreationRate() / 1000;
    window.addEventListener(
      "username-validity-change",
      this.handleValidityChange,
    );
    // Pick up the current value in case username-input validated before us.
    const usernameInput = document.querySelector(
      "username-input",
    ) as UsernameInput | null;
    if (usernameInput) {
      this.inputValid = usernameInput.canPlay();
    }
  }

  disconnectedCallback() {
    this.stop();
    window.removeEventListener(
      "username-validity-change",
      this.handleValidityChange,
    );
    super.disconnectedCallback();
  }

  private handleValidityChange = (e: Event) => {
    this.inputValid = (e as CustomEvent).detail?.isValid ?? true;
  };

  public stop() {
    this.lobbySocket.stop();
  }

  private handleLobbiesUpdate(lobbies: PublicGames) {
    this.lobbies = lobbies;
    this.serverTimeOffset = calculateServerTimeOffset(lobbies.serverTime);
    document.dispatchEvent(
      new CustomEvent("public-lobbies-update", {
        detail: { payload: lobbies },
      }),
    );
    this.requestUpdate();

    const allGames = Object.values(lobbies.games ?? {}).flat();
    for (const game of allGames) {
      const mapType = game.gameConfig?.gameMap as GameMapType;
      if (mapType && !this.mapAspectRatios.has(mapType)) {
        // New Map reference triggers Lit reactivity; placeholder ratio 1 lets
        // has() guard against duplicate in-flight fetches.
        this.mapAspectRatios = new Map(this.mapAspectRatios).set(mapType, 1);
        terrainMapFileLoader
          .getMapData(mapType)
          .manifest()
          .then((m: any) => {
            if (m?.map?.width && m?.map?.height) {
              this.mapAspectRatios = new Map(this.mapAspectRatios).set(
                mapType,
                m.map.width / m.map.height,
              );
            }
          })
          .catch((e) =>
            console.error(`Failed to load manifest for ${mapType}`, e),
          );
      }
    }
  }

  render() {
    // [ARENA] The master's generated ffa / team / special lobbies are no longer
    // rendered — see renderPlayerLobbies(). They are still broadcast and still
    // joinable by URL; this page just stops advertising them.
    const hosted = this.lobbies?.games?.hosted ?? [];

    return html`
      <div class="flex flex-col gap-4 w-full px-4 sm:px-0 mx-auto pb-4 sm:pb-0">
        <!-- [ARENA] 1v1 first, and biggest: it is the primary mode. Two
             stakes, one pot, and no team-win ambiguity for settle_match to
             refuse. The accent treatment used to mark Solo. -->
        <div class="h-16 sm:h-20">
          ${this.renderSmallActionCard(
            translateText("main.duel"),
            this.openDuel,
            PRIMARY_CARD,
          )}
        </div>

        <!-- Solo, and the private-lobby actions. These used to be duplicated
             for mobile and desktop because the two breakpoints ordered them
             differently around the lobby grid; now that the grid is last in
             both, one copy serves both. -->
        <div class="h-14">
          ${this.renderSmallActionCard(
            translateText("main.solo"),
            this.openSinglePlayerModal,
            SECONDARY_CARD,
          )}
        </div>
        <!-- [ARENA] Ranked is deliberately absent. Its queue lived in
             upstream's closed API — Matchmaking.ts opens a socket to
             <issuer>/matchmaking/join, which this fork's auth service returns
             404 for — so the button never did anything here, and next to a
             wagered 1v1 two things read as "compete seriously".
             The code is intact and the page is still reachable at
             #modal=ranked (registered in Main.ts), so restoring it is putting
             this card back. -->
        <div class="grid grid-cols-2 gap-4 h-14">
          ${this.renderSmallActionCard(
            translateText("main.create"),
            this.openHostLobby,
            SECONDARY_CARD,
          )}
          ${this.renderSmallActionCard(
            translateText("main.join"),
            this.openJoinLobby,
            SECONDARY_CARD,
            this.hostedLobbyCount(),
          )}
        </div>

        <!-- iOS Add to Home Screen banner -->
        <ios-add-to-home-screen-banner
          class="no-crazygames"
        ></ios-add-to-home-screen-banner>

        <!-- [ARENA] Player-made lobbies, replacing upstream's generated
             ffa / team / special cards.
             Those three were created by the master on a timer and refreshed
             themselves whether or not anyone was in them, so the page always
             looked busy and never told you anything true. What a player can
             act on is which lobbies other players actually made, which is the
             hosted bucket — the same list the Join browser shows, and the
             same one the Join button already counts. -->
        ${this.renderPlayerLobbies(hosted)}
      </div>
    `;
  }

  /**
   * [ARENA] Open lobbies other players are hosting right now.
   *
   * Reuses `renderLobbyCard`, which is upstream's and already renders a
   * PublicGameInfo — a hosted lobby is one of those. Keeping the card means
   * this is a change of *source*, not a second lobby renderer to maintain, and
   * upstream merges still land on one component.
   *
   * Capped at six so a busy evening cannot push the modes off the page. The
   * Join browser is the full list and the card below says so, rather than the
   * page silently truncating.
   */
  private renderPlayerLobbies(hosted: PublicGameInfo[]) {
    if (this.lobbies === null) {
      return html`<div class="flex items-center justify-center h-32">
        <span
          class="w-16 h-16 border-[6px] border-malibu-blue/30 border-t-malibu-blue rounded-full animate-spin"
        ></span>
      </div>`;
    }

    if (hosted.length === 0) {
      // The honest empty state. Upstream never had one here because the
      // generated lobbies meant the grid was never empty.
      return html`<div
        class="flex flex-col items-center justify-center gap-1 rounded-2xl border border-white/10 bg-surface/60 py-8 text-center"
      >
        <span class="text-sm font-bold uppercase tracking-widest text-white/70"
          >${translateText("mode_selector.no_player_lobbies")}</span
        >
        <span class="text-xs text-white/40"
          >${translateText("mode_selector.no_player_lobbies_hint")}</span
        >
      </div>`;
    }

    const shown = hosted.slice(0, 6);
    return html`
      <div class="flex flex-col gap-2">
        <div class="flex items-baseline justify-between px-1">
          <span
            class="text-xs font-bold uppercase tracking-widest text-white/50"
            >${translateText("mode_selector.player_lobbies")}</span
          >
          ${hosted.length > shown.length
            ? html`<button
                @click=${this.openJoinLobby}
                class="text-xs text-white/40 underline underline-offset-2 hover:text-white/70"
              >
                ${translateText("mode_selector.player_lobbies_more", {
                  count: hosted.length - shown.length,
                })}
              </button>`
            : null}
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          ${shown.map(
            (lobby) =>
              html`<div class="h-32 sm:h-36">
                ${this.renderLobbyCard(lobby, this.getLobbyTitle(lobby))}
              </div>`,
          )}
        </div>
      </div>
    `;
  }

  private renderSpecialLobbyCard(lobby: PublicGameInfo) {
    return this.renderLobbyCard(lobby, this.getLobbyTitle(lobby));
  }

  private openSinglePlayerModal = () => {
    if (!this.validateUsername()) return;
    (
      document.querySelector("single-player-modal") as SinglePlayerModal
    )?.open();
  };

  private openHostLobby = () => {
    if (!this.validateUsername()) return;
    (document.querySelector("host-lobby-modal") as HostLobbyModal)?.open();
  };

  // [ARENA] A duel is an ordinary two-seat private lobby, so it opens the host
  // lobby with the seat count preset and locked rather than through a second
  // screen. Everything a duel needs past that point — the waiting room, the
  // client list, the start timer, the share link, and the stake gate reached by
  // re-dispatching join-lobby — already exists there and should have one
  // implementation.
  private openDuel = () => {
    if (!this.validateUsername()) return;
    (document.querySelector("arena-duel-panel") as DuelPanel)?.open();
  };

  private openJoinLobby = () => {
    if (!this.validateUsername()) return;
    (document.querySelector("join-lobby-modal") as JoinLobbyModal)?.open();
  };

  // Number of open hosted lobbies waiting in the browser; shown as a chip
  // on the Join button.
  private hostedLobbyCount(): number {
    return this.lobbies?.games?.hosted?.length ?? 0;
  }

  private renderSmallActionCard(
    title: string,
    onClick: () => void,
    bgClass: string = CARD_BG,
    badge?: number,
  ) {
    return html`
      <button
        @click=${onClick}
        ?disabled=${!this.inputValid}
        class="relative flex items-center justify-center w-full h-full rounded-lg ${bgClass} transition-all duration-200 text-sm lg:text-base font-medium text-white uppercase tracking-wider text-center ${!this
          .inputValid
          ? "opacity-50 cursor-not-allowed pointer-events-none"
          : ""}"
      >
        ${title}
        ${badge
          ? html`<span
              class="absolute -top-2 -right-2 min-w-[1.375rem] h-[1.375rem] px-1.5 flex items-center justify-center rounded-full bg-red-500 text-white text-xs font-bold tracking-normal"
              >${badge}</span
            >`
          : nothing}
      </button>
    `;
  }

  private renderLobbyCard(
    lobby: PublicGameInfo,
    titleContent: string | TemplateResult,
  ) {
    const mapType = lobby.gameConfig!.gameMap as GameMapType;
    const mapImageSrc = terrainMapFileLoader.getMapData(mapType).webpPath;
    const aspectRatio = this.mapAspectRatios.get(mapType);
    // Use object-contain for extreme aspect ratios (e.g. Amazon River ~20:1) so
    // the full map is visible instead of being cropped by object-cover.
    const useContain =
      aspectRatio !== undefined && (aspectRatio > 4 || aspectRatio < 0.25);
    const timeRemaining = lobby.startsAt
      ? getSecondsUntilServerTimestamp(lobby.startsAt, this.serverTimeOffset)
      : undefined;

    let timeDisplay: string;
    let timeDisplayUppercase = false;
    if (timeRemaining === undefined) {
      timeDisplay = renderDuration(this.defaultLobbyTime);
    } else if (timeRemaining > 0) {
      timeDisplay = renderDuration(timeRemaining);
    } else {
      timeDisplay = translateText("public_lobby.starting_game");
      timeDisplayUppercase = true;
    }

    const mapName = getMapName(lobby.gameConfig?.gameMap);

    const modifierLabels = getModifierLabels(
      lobby.gameConfig?.publicGameModifiers,
      lobby.gameConfig?.doomsdayClock?.speed,
    );
    // Sort by length for visual consistency (shorter labels first)
    if (modifierLabels.length > 1) {
      modifierLabels.sort((a, b) => a.length - b.length);
    }

    return html`
      <button
        @click=${() => this.validateAndJoin(lobby)}
        ?disabled=${!this.inputValid}
        class="group relative w-full h-44 sm:h-full text-white uppercase rounded-2xl transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] bg-surface hover:shadow-[var(--shadow-lobby-card-hover)] ${!this
          .inputValid
          ? "opacity-50 cursor-not-allowed pointer-events-none"
          : ""}"
      >
        <!-- Image clipped separately so overflow-hidden doesn't block absolute children -->
        <div
          class="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none"
        >
          ${mapImageSrc
            ? html`<img
                src="${mapImageSrc}"
                alt="${mapName ?? lobby.gameConfig?.gameMap ?? "map"}"
                draggable="false"
                class="absolute inset-0 w-full h-full ${useContain
                  ? "object-contain"
                  : "object-cover object-center scale-[1.05]"} [image-rendering:auto]"
              />`
            : null}
        </div>
        <!-- Top row: modifiers + timer -->
        <div
          class="absolute inset-x-2 top-2 flex items-start justify-between gap-2"
        >
          ${modifierLabels.length > 0
            ? html`<div class="flex flex-col items-start gap-1 mt-[2px]">
                ${modifierLabels.map(
                  (label) =>
                    html`<span
                      class="px-2 py-1 rounded text-xs font-bold uppercase tracking-widest bg-malibu-blue text-white shadow-[var(--shadow-malibu-blue-pill)]"
                      >${label}</span
                    >`,
                )}
              </div>`
            : html`<div></div>`}
          <div class="shrink-0">
            <span
              class="text-xs font-bold tracking-widest ${timeDisplayUppercase
                ? "uppercase"
                : "normal-case"} bg-malibu-blue text-white px-2 py-1 rounded"
              >${timeDisplay}</span
            >
          </div>
        </div>
        <!-- Bottom bar: map name + mode, with player count floating above -->
        <div
          class="absolute bottom-0 left-0 right-0 flex flex-col px-3 py-2 bg-black/55 backdrop-blur-sm rounded-b-2xl"
          style="overflow: visible;"
        >
          <span
            class="absolute bottom-full right-2 mb-1 flex items-center gap-1 text-xs font-bold tracking-widest bg-black/70 backdrop-blur-sm px-2 py-0.5 rounded"
          >
            ${lobby.numClients}/${lobby.gameConfig?.maxPlayers}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-4 w-4 inline-block"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v3h8v-3zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-3a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v3h-3zM4.75 12.094A5.973 5.973 0 004 15v3H1v-3a3 3 0 013.75-2.906z"
              ></path>
            </svg>
          </span>
          ${mapName
            ? html`<p
                class="text-sm sm:text-base font-bold uppercase tracking-wider text-left leading-tight"
              >
                ${mapName}
              </p>`
            : ""}
          <h3 class="text-xs text-white/70 uppercase tracking-wider text-left">
            ${titleContent}
          </h3>
        </div>
      </button>
    `;
  }

  private validateAndJoin(lobby: PublicGameInfo) {
    if (!this.validateUsername()) return;

    this.dispatchEvent(
      new CustomEvent("join-lobby", {
        detail: {
          gameID: lobby.gameID,
          source: "public",
          publicLobbyInfo: lobby,
        } as JoinLobbyEvent,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private getLobbyTitle(lobby: PublicGameInfo): string {
    const config = lobby.gameConfig!;
    if (config.gameMode === GameMode.FFA) {
      return translateText("game_mode.ffa");
    }

    if (config?.gameMode === GameMode.Team) {
      const totalPlayers = config.maxPlayers ?? lobby.numClients ?? undefined;
      const formatTeamsOf = (
        teamCount: number | undefined,
        playersPerTeam: number | undefined,
        label?: string,
      ) => {
        if (!teamCount)
          return label ?? translateText("mode_selector.teams_title");
        const baseTitle = playersPerTeam
          ? translateText("mode_selector.teams_of", {
              teamCount: String(teamCount),
              playersPerTeam: String(playersPerTeam),
            })
          : translateText("mode_selector.teams_count", {
              teamCount: String(teamCount),
            });
        return `${baseTitle}${label ? ` (${label})` : ""}`;
      };

      switch (config.playerTeams) {
        case Duos: {
          const teamCount = totalPlayers
            ? Math.floor(totalPlayers / 2)
            : undefined;
          return formatTeamsOf(teamCount, 2);
        }
        case Trios: {
          const teamCount = totalPlayers
            ? Math.floor(totalPlayers / 3)
            : undefined;
          return formatTeamsOf(teamCount, 3);
        }
        case Quads: {
          const teamCount = totalPlayers
            ? Math.floor(totalPlayers / 4)
            : undefined;
          return formatTeamsOf(teamCount, 4);
        }
        case HumansVsNations: {
          const humanSlots = config.maxPlayers ?? lobby.numClients;
          return humanSlots
            ? translateText("public_lobby.teams_hvn_detailed", {
                num: String(humanSlots),
              })
            : translateText("public_lobby.teams_hvn");
        }
        default:
          if (typeof config.playerTeams === "number") {
            const teamCount = config.playerTeams;
            const playersPerTeam =
              totalPlayers && teamCount > 0
                ? Math.floor(totalPlayers / teamCount)
                : undefined;
            return formatTeamsOf(teamCount, playersPerTeam);
          }
      }
    }

    return "";
  }
}
