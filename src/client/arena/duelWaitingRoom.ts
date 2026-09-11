// [ARENA] The head-to-head screen a duel waits on, rendered the same for both
// players.
//
// It exists as a shared function because the two sides of a duel arrive
// through different modals — the host through `HostLobbyModal` (which created
// the lobby and attached the escrow) and the opponent through
// `JoinLobbyModal` (which is where every other private join already lands) —
// and a 1v1 in which the two players are looking at visibly different screens
// is the kind of asymmetry nobody notices until someone asks why the other
// person "sees something different". One implementation of the pot and the
// seats; each side supplies its own footer, because what they may DO differs
// and only that differs.
//
// Structure only. No colour is introduced here: the palette comes from the
// menu-scoped tokens in styles.css, so this inherits it rather than hard-coding
// anything of its own.
import { html, TemplateResult } from "lit";
import { formatStake } from "../../core/arena/stakeTiers";
import { translateText } from "../Utils";

/**
 * What the seats need to know about the escrow.
 *
 * Structural rather than one of the wire types on purpose: `WagerInfo` (from
 * `lobby_info`) and `PublicWagerSummary` (from the lobby broadcast) both
 * satisfy it, and the two modals happen to hold different ones.
 */
export interface DuelStake {
  /** u64 base units as a decimal string — never a Number. */
  entryFee: string;
  decimals: number;
  symbol: string;
}

/** Only the name is rendered; anything else about a client is not this view's. */
export interface DuelOccupant {
  username: string;
}

/**
 * One of the two seats.
 *
 * An empty seat is drawn as a seat — dashed and pulsing — rather than as an
 * absent row. In a 1v1 the whole question on this screen is whether the other
 * side has arrived, so that state deserves a shape.
 *
 * No claim is made about which seat is *yours*: the client list carries
 * usernames, not an identity this view can match against, and guessing wrong
 * would label the opponent with the player's own name. Seats are in join
 * order, which is also the order `settle_match` indexes scores against.
 */
function renderSeat(occupant: DuelOccupant | undefined): TemplateResult {
  if (occupant === undefined) {
    return html`
      <div
        class="flex-1 min-w-0 flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-white/15 bg-black/20 py-5 animate-pulse"
      >
        <span class="text-white/30 text-2xl leading-none">?</span>
        <span
          class="text-white/30 text-[10px] uppercase tracking-[0.16em] text-center px-2"
          >${translateText("duel.slot_open")}</span
        >
      </div>
    `;
  }
  return html`
    <div
      class="flex-1 min-w-0 flex flex-col items-center justify-center gap-1 rounded-xl border border-white/10 bg-black/40 py-5"
    >
      <span
        class="text-white text-sm font-bold truncate max-w-full px-2 text-center"
        >${occupant.username}</span
      >
      <span class="text-emerald-300/70 text-[10px] uppercase tracking-[0.16em]"
        >${translateText("duel.seat_staked")}</span
      >
    </div>
  `;
}

/**
 * The pot, the two seats, and whatever the calling side offers below them.
 *
 * The pot leads because it is what both players committed to; the seats face
 * each other so an empty one reads as an empty seat rather than as a missing
 * line of text.
 *
 * Amounts render as data, outside the translated strings, and go through
 * `formatStake()` — a u64 is not a Number, and a prompt reading `5000000`
 * where the player chose 5 is how someone believes they checked.
 */
export function renderDuelWaitingRoom(opts: {
  occupants: DuelOccupant[];
  wager: DuelStake | null;
  footer: TemplateResult;
}): TemplateResult {
  const { occupants, wager, footer } = opts;
  const stake =
    wager !== null
      ? formatStake(BigInt(wager.entryFee), wager.decimals, wager.symbol)
      : null;
  const pot =
    wager !== null
      ? formatStake(BigInt(wager.entryFee) * 2n, wager.decimals, wager.symbol)
      : null;

  return html`
    <div class="custom-scrollbar p-6 flex flex-col gap-6">
      ${stake !== null
        ? html`<div class="text-center">
            <p class="text-white/40 text-[10px] uppercase tracking-[0.2em]">
              ${translateText("duel.pot_label")}
            </p>
            <p class="text-white text-4xl font-black leading-none mt-1">
              ${pot}
            </p>
            <p class="text-white/40 text-xs mt-2">
              ${translateText("duel.your_stake")} ${stake}
            </p>
          </div>`
        : html`<p class="text-center text-white/50 text-sm">
            ${translateText("duel.no_escrow")}
          </p>`}

      <div class="flex items-stretch gap-3">
        ${renderSeat(occupants[0])}
        <div class="flex items-center">
          <span class="text-white/30 text-sm font-black tracking-widest"
            >${translateText("duel.versus")}</span
          >
        </div>
        ${renderSeat(occupants[1])}
      </div>

      <p class="text-white/40 text-xs text-center leading-relaxed">
        ${translateText("duel.fixed_settings")}
      </p>

      ${footer}
    </div>
  `;
}
