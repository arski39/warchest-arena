import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { connectWallet, getConnectedWallet } from "./WalletProvider";
import { joinMatchOnChain } from "./onchainJoin";

export interface WagerInfo {
  matchPDA: string;
  mint: string;
  entryFee: bigint;
  maxPlayers: number;
  currentPlayers: number;
}

/** Emitted when the player has connected their wallet and paid the entry fee. */
export const WAGER_JOINED_EVENT = "arena-wager-joined";

/**
 * Pre-game lobby UI showing stakes, pot size, and the "Join & Stake" button.
 * Mount alongside the existing OpenFront lobby for wagered games.
 *
 * Usage:
 *   <arena-wager-lobby .wager=${wagerInfo}></arena-wager-lobby>
 */
@customElement("arena-wager-lobby")
export class WagerLobby extends LitElement {
  @property({ type: Object }) wager: WagerInfo | null = null;
  @state() private walletAddress: string | null = null;
  @state() private txPending = false;
  @state() private error: string | null = null;

  connectedCallback() {
    super.connectedCallback();
    const existing = getConnectedWallet();
    if (existing) this.walletAddress = existing.publicKey;
  }

  private async handleConnect() {
    try {
      const wallet = await connectWallet();
      this.walletAddress = wallet.publicKey;
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : "Wallet connection failed";
    }
  }

  private async handleJoin() {
    if (!this.wager || !this.walletAddress) return;
    this.txPending = true;
    this.error = null;
    try {
      const txSig = await joinMatchOnChain({
        matchPDA: this.wager.matchPDA,
        mint: this.wager.mint,
        entryFee: this.wager.entryFee,
      });
      this.dispatchEvent(
        new CustomEvent(WAGER_JOINED_EVENT, {
          detail: { walletAddress: this.walletAddress, txSig },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (e) {
      this.error = e instanceof Error ? e.message : "Transaction failed";
    } finally {
      this.txPending = false;
    }
  }

  render() {
    if (!this.wager) return html``;
    const { entryFee, maxPlayers, currentPlayers } = this.wager;
    const pot = entryFee * BigInt(maxPlayers);

    return html`
      <div class="wager-panel">
        <div class="wager-header">Wagered Match</div>
        <div class="wager-row">
          <span>Entry fee</span><span>${entryFee.toLocaleString()} units</span>
        </div>
        <div class="wager-row">
          <span>Pot</span><span>${pot.toLocaleString()} units</span>
        </div>
        <div class="wager-row">
          <span>Players</span><span>${currentPlayers} / ${maxPlayers}</span>
        </div>

        ${this.walletAddress
          ? html`
              <div class="wallet-info">
                ${this.walletAddress.slice(0, 8)}…${this.walletAddress.slice(-4)}
              </div>
              <button
                ?disabled=${this.txPending}
                @click=${this.handleJoin}
              >
                ${this.txPending ? "Confirming…" : "Join & Stake"}
              </button>
            `
          : html`
              <button @click=${this.handleConnect}>Connect Wallet</button>
            `}
        ${this.error ? html`<div class="error">${this.error}</div>` : ""}
      </div>
    `;
  }

  static styles = css`
    .wager-panel {
      background: #1a1a2e;
      border: 1px solid #e94560;
      border-radius: 8px;
      padding: 1rem;
      color: #eee;
      font-family: sans-serif;
      min-width: 220px;
    }
    .wager-header {
      font-weight: bold;
      color: #e94560;
      margin-bottom: 0.75rem;
    }
    .wager-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 0.4rem;
      font-size: 0.9rem;
    }
    .wallet-info {
      font-size: 0.8rem;
      color: #aaa;
      margin: 0.5rem 0;
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
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .error {
      color: #ff6b6b;
      font-size: 0.8rem;
      margin-top: 0.5rem;
    }
  `;
}
