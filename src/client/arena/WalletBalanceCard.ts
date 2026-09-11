// [ARENA] What the connected wallet actually holds, shown on the menu.
//
// ## Why this speaks JSON-RPC over fetch instead of using @solana/web3.js
//
// The hardest standing constraint on this client is that `@solana/web3.js`
// (~296 kB) stays inside the lazily imported `wagerJoinFlow` chunk and out of
// the main bundle, which every player downloads whether or not they ever
// stake. A balance read needs two RPC calls and no key handling, and Solana's
// RPC is plain JSON over HTTP, so `fetch` does the whole job for zero bytes.
//
// `getTokenAccountsByOwner` is used rather than deriving the associated token
// address, precisely because deriving an ATA needs PDA maths and therefore
// needs web3.js. Asking the node "which token accounts does this owner have
// for this mint" gets the same answer over the wire. It is also the more
// correct question: a player can legitimately stake from a non-canonical
// token account — `join_match` checks owner and mint, not ATA derivation, and
// devnet scenario S7 exists for exactly that case.
//
// ## What it deliberately does not do
//
// No Add Funds and no Cash Out. This deployment has neither flow: stakes move
// only through `join_match` and payouts only through `settle_match`. A control
// that looks like a deposit and does nothing is worse than no control.
//
// It DOES offer a connect button -- a second entry point to the account menu's
// wallet login, not a second implementation of it (see `handleConnect`). That
// stays safe because this card only exists on the menu, which is where wallet
// login is allowed in the first place, and because `walletLogin()` re-checks
// the rule itself.
import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { formatStake } from "../../core/arena/stakeTiers";
import { sessionProvider } from "../Auth";
import { ClientEnv } from "../ClientEnv";
import { translateText } from "../Utils";
import { getConnectedWallet, phantomBrowseLink } from "./WalletProvider";
import { storedWalletAddress } from "./walletSession";

/** Fixed by the protocol. */
const LAMPORTS_PER_SOL = 1_000_000_000n;

/** How often to notice that a wallet was connected elsewhere on the page. */
const POLL_MS = 15_000;

interface RpcResponse {
  result?: unknown;
  error?: { message?: string };
}

@customElement("wallet-balance-card")
export class WalletBalanceCard extends LitElement {
  @state() private address: string | null = null;
  @state() private stakeBalance: string | null = null;
  @state() private solBalance: string | null = null;
  @state() private busy = false;
  @state() private stale = false;
  @state() private copied = false;
  @state() private connecting = false;
  @state() private connectError: string | null = null;

  private timer: number | null = null;

  createRenderRoot() {
    return this; // light DOM so Tailwind utilities apply
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
    // There is no "wallet connected" event to subscribe to — connecting
    // happens in AccountModal, which this component does not reach into. A
    // slow poll notices it without coupling the two together.
    this.timer = window.setInterval(() => void this.refresh(), POLL_MS);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** Wagering off means no mint and no endpoint, so there is nothing to read. */
  private configured(): boolean {
    return ClientEnv.arenaStakeMint() !== "" && ClientEnv.arenaRpcUrl() !== "";
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(ClientEnv.arenaRpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const body = (await response.json()) as RpcResponse;
    if (body.error !== undefined) {
      throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
    }
    return body.result;
  }

  /**
   * Whose balance this card is showing.
   *
   * The same two-source precedence the nav uses (`Main.ts`'s onUserMe), and
   * deliberately not a second rule: the connected extension first because it is
   * live, then the remembered address of a wallet *session*. Reading only the
   * extension is what this card did at first, and it was wrong for the case
   * that matters most -- immediately after `walletLogin()` reloads the page.
   * `mountWalletProvider()` runs at module scope while Phantom's auto-connect
   * is still in flight, so `getConnectedWallet()` is usually null right then,
   * and the card offered "Connect wallet" to someone who had just connected
   * their wallet. Clicking it signed them in again, reloaded, and showed the
   * same button: a login loop that looked like login was broken.
   *
   * The provider claim is what makes the remembered address trustworthy. A
   * stale entry left behind by a failed logout has no `wallet` session to go
   * with it and is therefore ignored, never believed.
   */
  private async currentAddress(): Promise<string | null> {
    const connected = getConnectedWallet()?.publicKey;
    if (connected !== undefined) return connected;
    return (await sessionProvider()) === "wallet"
      ? storedWalletAddress()
      : null;
  }

  private async refresh(): Promise<void> {
    this.address = await this.currentAddress();
    if (this.address === null || !this.configured() || this.busy) return;

    this.busy = true;
    try {
      const [tokens, lamports] = await Promise.all([
        this.rpc("getTokenAccountsByOwner", [
          this.address,
          { mint: ClientEnv.arenaStakeMint() },
          { encoding: "jsonParsed" },
        ]),
        this.rpc("getBalance", [this.address]),
      ]);

      this.stakeBalance = this.sumTokenAccounts(tokens);
      this.solBalance = this.formatSol(lamports);
      this.stale = false;
    } catch {
      // A balance is informational. An RPC hiccup must not put an error card on
      // the menu, so the last known figures stay and the card says they are
      // stale. Public endpoints rate-limit hard; see the membership-retry note.
      this.stale = true;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Every account for the mint, summed.
   *
   * Not just the first: a wallet can hold more than one token account for a
   * mint, and showing only one would understate what the player has.
   */
  private sumTokenAccounts(tokens: unknown): string {
    let base = 0n;
    let decimals = 0;
    const value = (tokens as { value?: unknown[] } | null)?.value ?? [];
    for (const entry of value) {
      const amount = (
        entry as {
          account?: {
            data?: {
              parsed?: { info?: { tokenAmount?: Record<string, unknown> } };
            };
          };
        }
      )?.account?.data?.parsed?.info?.tokenAmount;
      if (amount === undefined) continue;
      base += BigInt(String(amount.amount ?? "0"));
      decimals = Number(amount.decimals ?? 0);
    }
    // formatStake, not hand-rolled maths: a u64 is not a Number, and this is
    // the one implementation every amount on the site goes through.
    return formatStake(base, decimals);
  }

  /** Four decimal places, the convention wallets use. String surgery, never Number. */
  private formatSol(lamports: unknown): string {
    const raw = BigInt(
      String((lamports as { value?: unknown } | null)?.value ?? 0),
    );
    const whole = raw / LAMPORTS_PER_SOL;
    const fraction = (raw % LAMPORTS_PER_SOL).toString().padStart(9, "0");
    return `${whole}.${fraction.slice(0, 4)}`;
  }

  /**
   * Connect a wallet and sign in, from the menu.
   *
   * Deliberately the same sequence as AccountModal.handleWalletLogin, including
   * the reload: signing in swaps `sub`, hence the persistentID, so half the
   * page would otherwise still be showing the previous identity. Two entry
   * points to one flow is fine; two implementations of it would not be.
   *
   * Safe here for the reason wallet login is menu-only in the first place —
   * this card only exists on the menu, where nothing is bound to the current
   * session yet. walletLogin() re-checks that itself and refuses if a game or
   * a stake prompt is open, so the rule is enforced in one place regardless.
   */
  private handleConnect = async (): Promise<void> => {
    if (this.connecting) return;
    // A mobile tab cannot reach the Phantom app at all; hand off to its
    // in-app browser instead of throwing "install Phantom" at someone who
    // has it installed.
    const deeplink = phantomBrowseLink();
    if (deeplink !== null) {
      window.location.href = deeplink;
      return;
    }
    this.connecting = true;
    this.connectError = null;
    try {
      // Lazily imported: the sign-in path should not be in front of a player
      // who never connects a wallet.
      const { walletLogin } = await import("./walletLogin");
      await walletLogin();
      window.location.reload();
    } catch (e) {
      const reason =
        e instanceof Error && e.name === "WalletLoginError"
          ? (e as { reason?: string }).reason
          : undefined;
      if (reason === "rejected") {
        // They changed their mind at the wallet prompt. Not a fault.
        this.connectError = null;
      } else if (reason === "no-wallet") {
        this.connectError = translateText("account_modal.wallet_no_extension");
      } else {
        this.connectError =
          e instanceof Error
            ? e.message
            : translateText("account_modal.wallet_login_failed");
      }
    } finally {
      this.connecting = false;
    }
  };

  private handleCopy = () => {
    if (this.address === null) return;
    void navigator.clipboard?.writeText(this.address);
    this.copied = true;
    window.setTimeout(() => {
      this.copied = false;
    }, 1200);
  };

  private shortened(address: string): string {
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  }

  render() {
    if (!this.configured()) return null;

    const symbol = ClientEnv.arenaStakeSymbol();
    return html`
      <div class="min-w-0 rounded-xl border border-white/10 bg-surface/70 p-4">
        <div class="flex items-center justify-between gap-2">
          <span
            class="text-xs font-bold uppercase tracking-widest text-white/60"
            >${translateText("wallet_card.title")}</span
          >
          ${this.address !== null
            ? html`<div class="flex items-center gap-3">
                <button
                  @click=${this.handleCopy}
                  title=${this.address}
                  class="text-[10px] text-white/40 hover:text-white/80"
                >
                  ${this.copied
                    ? translateText("wallet_card.copied")
                    : this.shortened(this.address)}
                </button>
                <button
                  @click=${() => void this.refresh()}
                  ?disabled=${this.busy}
                  class="text-[10px] text-white/40 hover:text-white/80 disabled:opacity-40"
                >
                  ${translateText("wallet_card.refresh")}
                </button>
              </div>`
            : null}
        </div>

        ${this.address === null
          ? html`<div class="mt-3 flex flex-col gap-2">
              <button
                @click=${this.handleConnect}
                ?disabled=${this.connecting}
                class="w-full rounded-lg bg-malibu-blue px-4 py-3 font-bold tracking-wide text-white transition-colors hover:bg-aquarius disabled:cursor-not-allowed disabled:opacity-50"
              >
                ${this.connecting
                  ? translateText("account_modal.wallet_connecting")
                  : phantomBrowseLink() !== null
                    ? translateText("account_modal.wallet_open_phantom")
                    : translateText("account_modal.wallet_login")}
              </button>
              <!-- The same strings the account modal uses, not copies of them:
                   one action should not have two wordings that can drift. -->
              <p class="text-center text-[10px] leading-relaxed text-white/35">
                ${translateText("wallet_card.connect_hint")}
              </p>
              ${this.connectError !== null
                ? html`<p class="text-center text-xs text-red-400">
                    ${this.connectError}
                  </p>`
                : null}
            </div>`
          : html`
              <!-- Amounts render as data, outside the translated string: a
                   missing translation must not be able to hide a balance. -->
              <p class="mt-2 text-3xl font-black tabular-nums text-white">
                ${this.stakeBalance ?? "-"}
                <span class="text-base font-bold text-white/50">${symbol}</span>
              </p>
              <p class="text-xs tabular-nums text-white/40">
                ${this.solBalance ?? "-"} SOL
              </p>
              ${this.stale
                ? html`<p class="mt-2 text-[10px] text-amber-300/80">
                    ${translateText("wallet_card.stale")}
                  </p>`
                : null}
            `}
      </div>
    `;
  }
}
