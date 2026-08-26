import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { WagerInfo } from "../../core/Schemas";
import { getPlayToken } from "../Auth";
import { translateText } from "../Utils";
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
 * Pre-game gate for a wagered lobby: shows the stake, then walks the player
 * through connect → sign auth → stake on-chain. Mounted by wagerJoinFlow.ts,
 * which resolves once one of the two events above fires.
 *
 * Both the wallet signature and the on-chain stake are produced here because
 * the server checks them together, in the same ClientJoinMessage: the signature
 * proves the wallet belongs to this session, the transaction proves it staked.
 */
@customElement("arena-wager-lobby")
export class WagerLobby extends LitElement {
  @property({ type: Object }) wager: WagerInfo | null = null;
  @state() private walletAddress: string | null = null;
  @state() private busy = false;
  @state() private status: string | null = null;
  @state() private error: string | null = null;

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
    const { entryFee, maxPlayers, rakeBps } = this.wager;
    const pot = BigInt(entryFee) * BigInt(maxPlayers);
    const payout = pot - (pot * BigInt(rakeBps)) / 10000n;

    return html`
      <div class="wager-panel">
        <div class="wager-header">${translateText("wager_lobby.title")}</div>
        <p class="wager-note">${translateText("wager_lobby.description")}</p>

        <div class="wager-row">
          <span>${translateText("wager_lobby.entry_fee")}</span>
          <span>${entryFee}</span>
        </div>
        <div class="wager-row">
          <span>${translateText("wager_lobby.max_players")}</span>
          <span>${maxPlayers}</span>
        </div>
        <div class="wager-row">
          <span>${translateText("wager_lobby.winner_takes")}</span>
          <span>${payout.toString()}</span>
        </div>
        <div class="wager-row muted">
          <span>${translateText("wager_lobby.mint")}</span>
          <span class="mono">${shorten(this.wager.mint)}</span>
        </div>

        ${this.walletAddress
          ? html`
              <div class="wallet-info mono">${shorten(this.walletAddress)}</div>
              <button ?disabled=${this.busy} @click=${this.handleJoin}>
                ${this.busy
                  ? (this.status ??
                    translateText("wager_lobby.status_confirming"))
                  : translateText("wager_lobby.join_and_stake")}
              </button>
            `
          : html`
              <button ?disabled=${this.busy} @click=${this.handleConnect}>
                ${translateText("wager_lobby.connect_wallet")}
              </button>
            `}
        <button
          class="secondary"
          ?disabled=${this.busy}
          @click=${this.handleCancel}
        >
          ${translateText("wager_lobby.cancel")}
        </button>
        ${this.error ? html`<div class="error">${this.error}</div>` : ""}
      </div>
    `;
  }

  static styles = css`
    .wager-panel {
      background: #1a1a2e;
      border: 1px solid #e94560;
      border-radius: 8px;
      padding: 1.25rem;
      color: #eee;
      font-family: sans-serif;
      width: min(28rem, calc(100vw - 2rem));
      box-sizing: border-box;
    }
    .wager-header {
      font-weight: bold;
      color: #e94560;
      margin-bottom: 0.5rem;
    }
    .wager-note {
      color: #aaa;
      font-size: 0.8rem;
      margin: 0 0 0.9rem;
      line-height: 1.4;
    }
    .wager-row {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 0.4rem;
      font-size: 0.9rem;
    }
    .wager-row.muted {
      color: #888;
      font-size: 0.8rem;
    }
    .mono {
      font-family: ui-monospace, monospace;
    }
    .wallet-info {
      font-size: 0.8rem;
      color: #aaa;
      margin: 0.75rem 0 0;
    }
    button {
      width: 100%;
      padding: 0.6rem;
      background: #e94560;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 1rem;
      margin-top: 0.5rem;
    }
    button.secondary {
      background: transparent;
      border: 1px solid #ffffff33;
      color: #bbb;
      font-size: 0.85rem;
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .error {
      color: #ff6b6b;
      font-size: 0.8rem;
      margin-top: 0.6rem;
      overflow-wrap: anywhere;
    }
  `;
}

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
