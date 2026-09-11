// [ARENA] Pick a stake, get an opponent. The site's primary mode.
//
// ## Why this is not a queue
//
// Upstream's matchmaking queue lives in its closed API — `Matchmaking.ts` opens
// a socket to `<issuer>/matchmaking/join`, which this fork's auth service
// returns 404 for. So "Ranked" does nothing here, and there is no queue
// subsystem to reuse.
//
// Building one would mean a single process holding cross-worker state, and this
// deployment has no such place a browser can reach: the master serves no client
// API, and workers each hold their own memory (`NUM_WORKERS=3`). The one thing
// that DOES aggregate across workers is the public lobby list — workers report
// to the master, the master broadcasts back — and it already carries a wager
// summary per lobby.
//
// So a duel is an ordinary two-seat wagered private lobby that is *listed*, and
// matchmaking is: join an open one at your tier, or create one and wait. Every
// piece of that already exists and is tested — lobby creation, `POST /wager`,
// `POST /listing`, the stake gate, the lobby socket. A queue would have been a
// new subsystem to do what listing already does.
//
// The cost, stated plainly: two players choosing the same tier within the same
// broadcast interval can both create a lobby and sit in separate ones. It
// self-heals — the list refreshes and a waiting player can take the other's
// lobby — and at this deployment's traffic it is not the constraint. A real
// queue is the answer if it ever is.
//
// ## What this must not import
//
// Nothing that drags `@solana/web3.js` in. The staking itself happens through
// `Main.resolveWagerJoin`'s existing lazy `wagerJoinFlow` chunk; this component
// only decides WHICH lobby to join, and joins it the same way the lobby browser
// does — by dispatching `join-lobby` with `source: "private"`.
import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { STAKE_TIERS } from "../../core/arena/stakeTiers";
import type { PublicGameInfo, PublicGames } from "../../core/Schemas";
import { ClientEnv } from "../ClientEnv";
import { BaseModal } from "../components/BaseModal";
import { modalHeader } from "../components/ui/ModalHeader";
import type { HostLobbyModal } from "../HostLobbyModal";
import type { JoinLobbyEvent } from "../Main";
import { translateText } from "../Utils";

@customElement("arena-duel-panel")
export class DuelPanel extends BaseModal {
  protected routerName = "duel";

  @state() private tier: number | null = null;
  @state() private busy: boolean = false;
  @state() private error: string | null = null;
  /** Latest public lobby list, re-broadcast by GameModeSelector. */
  @state() private lobbies: PublicGames | null = null;

  constructor() {
    super();
    this.id = "page-duel";
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener(
      "public-lobbies-update",
      this.handleLobbies as EventListener,
    );
  }

  disconnectedCallback() {
    document.removeEventListener(
      "public-lobbies-update",
      this.handleLobbies as EventListener,
    );
    super.disconnectedCallback();
  }

  // The lobby socket is owned by GameModeSelector, which re-broadcasts every
  // update to the document. Reusing it means no second socket, and it is
  // already running before this panel is ever opened.
  private handleLobbies = (e: CustomEvent<{ payload: PublicGames }>) => {
    this.lobbies = e.detail?.payload ?? null;
  };

  protected override onOpen(): void {
    this.busy = false;
    this.error = null;
  }

  /**
   * An open duel at this tier, or null.
   *
   * `hosted` is the bucket of private lobbies their creators chose to advertise
   * — which is exactly what a waiting duel is. A lobby only appears here with a
   * `wager` summary once it is both staked and listed, so anything matching is
   * already an escrow someone has money in.
   */
  private openDuelAt(tier: number): PublicGameInfo | null {
    for (const lobby of this.lobbies?.games?.hosted ?? []) {
      const wager = lobby.wager;
      if (wager === undefined) continue;
      if (wager.maxPlayers !== 2) continue;
      // Full, or filling. Two is the whole lobby, so anything at 2 is taken.
      if (lobby.numClients >= 2) continue;
      // entryFee is a u64 string and Number() on it would be the precision loss
      // the string exists to avoid. Divide as BigInt and only then narrow — the
      // quotient is a tier, so it is tiny by the time it is a number.
      const lobbyTier = Number(
        BigInt(wager.entryFee) / 10n ** BigInt(wager.decimals),
      );
      if (lobbyTier === tier) return lobby;
    }
    return null;
  }

  private handleFind = async (): Promise<void> => {
    if (this.busy) return;
    if (this.tier === null) {
      this.error = translateText("duel.error_no_stake");
      return;
    }
    this.busy = true;
    this.error = null;

    const existing = this.openDuelAt(this.tier);
    if (existing !== null) {
      // The same path the lobby browser uses for a listed lobby, so the stake
      // gate in Main.resolveWagerJoin runs unchanged — `source: "private"` is
      // what it keys on.
      this.close();
      this.dispatchEvent(
        new CustomEvent("join-lobby", {
          detail: {
            gameID: existing.gameID,
            source: "private",
          } as JoinLobbyEvent,
          bubbles: true,
          composed: true,
        }),
      );
      return;
    }

    // Nobody waiting: become the one who waits. The host lobby is the waiting
    // room — client list, start timer, share link — so the duel preset drives
    // it rather than reimplementing any of that here.
    this.close();
    const host = document.querySelector(
      "host-lobby-modal",
    ) as HostLobbyModal | null;
    if (host === null) {
      this.error = translateText("duel.error_generic");
      this.busy = false;
      return;
    }
    host.open({ preset: "duel", tier: this.tier, list: true });
  };

  protected renderHeaderSlot() {
    return modalHeader({
      title: translateText("main.duel"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
    });
  }

  protected renderBody() {
    // Rendered from the shared tier list, which is the sanctioned use of it:
    // the server derives the fee from the tier, so a drifted client copy can
    // only offer a tier the server refuses, never create a wrong escrow.
    // ARENA_MAX_ENTRY_FEE can suppress some, and those surface as a rejection
    // when chosen rather than being hidden here.
    const symbol = ClientEnv.arenaStakeSymbol();
    return html`
      <div class="custom-scrollbar p-6">
        <p class="text-white/50 text-sm mb-6 text-center">
          ${translateText("duel.explain")}
        </p>

        <div class="grid grid-cols-3 gap-3">
          ${STAKE_TIERS.map(
            (tier) => html`
              <button
                @click=${() => {
                  this.tier = tier;
                  this.error = null;
                }}
                ?disabled=${this.busy}
                class="flex flex-col items-center justify-center gap-1 rounded-xl border py-5 transition-all duration-150 ${this
                  .tier === tier
                  ? "bg-malibu-blue border-malibu-blue text-white"
                  : "bg-surface border-white/10 text-white/80 hover:brightness-125"}"
              >
                <span class="text-2xl font-bold">${tier}</span>
                <span class="text-[10px] uppercase tracking-widest opacity-70"
                  >${symbol}</span
                >
              </button>
            `,
          )}
        </div>

        <p class="text-white/40 text-xs mt-4 text-center leading-relaxed">
          ${translateText("duel.winner_takes")}
        </p>

        <button
          @click=${this.handleFind}
          ?disabled=${this.busy}
          class="w-full mt-6 h-14 rounded-lg bg-malibu-blue hover:bg-aquarius disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold uppercase tracking-wider transition-colors"
        >
          ${this.busy
            ? translateText("duel.searching")
            : translateText("duel.find")}
        </button>

        ${this.error !== null
          ? html`<p class="text-red-400 text-xs mt-3 text-center">
              ${this.error}
            </p>`
          : ""}
      </div>
    `;
  }
}
