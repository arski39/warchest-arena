import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { WagerInfo } from "../../core/Schemas";
import { formatStake, winnerPayout } from "../../core/arena/stakeTiers";
import { getPlayToken } from "../Auth";
import { translateText } from "../Utils";
import "../components/baseComponents/Button";
import { connectWallet, getConnectedWallet } from "./WalletProvider";
import { joinMatchOnChain } from "./onchainJoin";
import { signAuthMessage } from "./walletAuth";

/** Emitted when the player has connected their wallet and paid the entry fee. */
export const WAGER_JOINED_EVENT = "arena-wager-joined";
/** Emitted when the player backs out instead of staking. */
export const WAGER_CANCELLED_EVENT = "arena-wager-cancelled";

export interface WagerJoinedDetail {
  walletAddress: string;
  /** base64 ed25519 signature over the canonical auth message. */
  walletSig: string;
  /** Confirmed join_match transaction signature. */
  onchainTxSig: string;
}

/**
 * Pre-game gate for a wagered lobby: shows what is at stake, then walks the
 * player through connect → sign auth → stake on-chain. Mounted by
 * wagerJoinFlow.ts, which resolves once one of the two events above fires.
 *
 * Both the wallet signature and the on-chain stake are produced here because
 * the server checks them together, in the same ClientJoinMessage: the signature
 * proves the wallet belongs to this session, the transaction proves it staked.
 *
 * Renders into the LIGHT DOM, like every other component in this codebase
 * (`BaseModal`, `o-button`, `GameConfigSettings`). It used to be the one
 * shadow-DOM island, with a hand-written palette that matched nothing — so it
 * missed every design token and could not use `o-button`. Tailwind classes only
 * reach it here because there is no shadow boundary in the way.
 *
 * Pot-first on purpose: the number that decides whether someone plays is what
 * the winner walks away with, not the row-of-labels the panel used to lead
 * with. The stake, the seat count and the mint stay visible underneath — the
 * mint especially, because ARENA_STAKE_SYMBOL is an operator string and not
 * on-chain metadata, so the ticker alone is an unverifiable claim.
 */
@customElement("arena-wager-lobby")
export class WagerLobby extends LitElement {
  @property({ type: Object }) wager: WagerInfo | null = null;
  /** Needed for the dev auth nonce; see core/arena/authMessage.ts. */
  @property({ type: String }) gameId = "";
  @state() private walletAddress: string | null = null;
  @state() private busy = false;
  @state() private status: string | null = null;
  @state() private error: string | null = null;

  // Light DOM, so the page's Tailwind reaches this component. See the class
  // comment: the shadow root is what kept it outside the design system.
  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    const existing = getConnectedWallet();
    if (existing) this.walletAddress = existing.publicKey;
  }

  private async handleConnect() {
    this.busy = true;
    try {
      const wallet = await connectWallet();
      this.walletAddress = wallet.publicKey;
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : "Wallet connection failed";
    } finally {
      this.busy = false;
    }
  }

  private handleCancel() {
    if (this.busy) return;
    this.dispatchEvent(
      new CustomEvent(WAGER_CANCELLED_EVENT, {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async handleJoin() {
    if (!this.wager || !this.walletAddress) return;
    this.busy = true;
    this.error = null;
    try {
      // Sign first. It is the cheap step, and a player who declines the
      // signature prompt should not have already spent their stake.
      this.status = translateText("wager_lobby.status_signing");
      const { walletAddress, walletSig } = await signAuthMessage(
        await getPlayToken(),
        this.gameId,
      );

      this.status = translateText("wager_lobby.status_staking");
      const onchainTxSig = await joinMatchOnChain({
        programId: this.wager.programId,
        rpcUrl: this.wager.rpcUrl,
        matchPDA: this.wager.matchPDA,
        vault: this.wager.vault,
        mint: this.wager.mint,
        entryFee: BigInt(this.wager.entryFee),
      });

      this.dispatchEvent(
        new CustomEvent<WagerJoinedDetail>(WAGER_JOINED_EVENT, {
          detail: { walletAddress, walletSig, onchainTxSig },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (e) {
      this.error =
        e instanceof Error
          ? e.message
          : translateText("wager_lobby.error_generic");
      this.status = null;
    } finally {
      this.busy = false;
    }
  }

  render() {
    if (!this.wager) return html``;
    const { entryFee, maxPlayers, rakeBps, decimals, symbol } = this.wager;
    const payout = winnerPayout(entryFee, maxPlayers, rakeBps);
    // [ARENA] Render whole tokens, not base units. A prompt that says
    // "5000000" when the host chose the 5 tier is how someone stakes the wrong
    // amount believing they checked. formatStake never routes through Number.
    const fee = formatStake(entryFee, decimals, symbol);
    const takes = formatStake(payout, decimals, symbol);

    return html`
      <div
        class="w-[min(28rem,calc(100vw-2rem))] box-border rounded-2xl border
               border-white/10 bg-surface p-6 text-white shadow-2xl"
      >
        <div
          class="text-[10px] font-bold uppercase tracking-widest text-white/40"
        >
          ${translateText("wager_lobby.title")}
        </div>

        <!-- The pot leads. It is the number that decides whether someone
             plays, and it is the payout after rake, not the gross pot. -->
        <div class="mt-4 text-center">
          <div
            class="text-[10px] font-bold uppercase tracking-widest text-white/40"
          >
            ${translateText("wager_lobby.winner_takes")}
          </div>
          <div
            class="mt-1 text-4xl font-bold tracking-tight text-cyber-yellow
                   break-all"
          >
            ${takes}
          </div>
        </div>

        <dl class="mt-5 space-y-2 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="text-white/50">
              ${translateText("wager_lobby.entry_fee")}
            </dt>
            <dd class="font-bold">${fee}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="text-white/50">
              ${translateText("wager_lobby.max_players")}
            </dt>
            <dd class="font-bold">${maxPlayers}</dd>
          </div>
          <div class="flex justify-between gap-4 text-xs">
            <dt class="text-white/40">${translateText("wager_lobby.mint")}</dt>
            <dd class="font-mono text-white/40">${shorten(this.wager.mint)}</dd>
          </div>
        </dl>

        <p class="mt-4 text-xs leading-relaxed text-white/40">
          ${translateText("wager_lobby.description")}
        </p>

        <!-- [ARENA] What backing out costs, said before the signature rather
             than discovered after it. Signing is the irreversible half: the
             stake is in the vault whatever the browser does next, and the only
             thing that decides whether it comes back is whether the lobby
             filled. Two sentences because they are two different moments —
             leaving an unfilled lobby is free, leaving a filled one forfeits —
             and the switch happens when the LAST seat stakes, which this
             screen cannot show.

             Brighter than the description above on purpose. That paragraph
             explains the mechanism; this one is the only thing here that
             changes what a player would do.

             Deliberately carries no time estimate. The same prompt serves a
             listed duel (cancelled at HOSTED_LOBBY_AUTO_START_MS, ~5 min) and
             a hand-made private wagered lobby with no armed timer (up to
             MAX_GAME_DURATION_MS, 3 h), so any number stated here would be a
             promise broken for one of them. -->
        <div
          class="mt-4 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5
                 text-xs leading-relaxed"
        >
          <p class="text-white/70">
            ${translateText("wager_lobby.refund_notice")}
          </p>
          <p class="mt-2 text-white/50">
            ${translateText("wager_lobby.forfeit_notice")}
          </p>
        </div>

        ${this.walletAddress
          ? html`
              <div class="mt-4 font-mono text-xs text-white/40">
                ${shorten(this.walletAddress)}
              </div>
              <o-button
                class="mt-2 block"
                variant="primary"
                width="fill"
                .title=${this.busy
                  ? (this.status ??
                    translateText("wager_lobby.status_confirming"))
                  : translateText("wager_lobby.join_and_stake")}
                ?disable=${this.busy}
                @click=${this.handleJoin}
              ></o-button>
            `
          : html`
              <o-button
                class="mt-4 block"
                variant="primary"
                width="fill"
                .title=${translateText("wager_lobby.connect_wallet")}
                ?disable=${this.busy}
                @click=${this.handleConnect}
              ></o-button>
            `}
        <o-button
          class="mt-2 block"
          variant="ghost"
          size="sm"
          width="fill"
          .title=${translateText("wager_lobby.cancel")}
          ?disable=${this.busy}
          @click=${this.handleCancel}
        ></o-button>
        ${this.error
          ? html`<div
              class="mt-3 text-xs text-red-400 [overflow-wrap:anywhere]"
            >
              ${this.error}
            </div>`
          : ""}
      </div>
    `;
  }
}

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
