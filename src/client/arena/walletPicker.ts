// [ARENA] new file — asks which wallet to connect.
//
// Two entry points, and they deliberately differ:
//
// * **Sign-in** (`connectForSignIn`) always shows the picker. It is the first
//   thing a new player sees of the wallet side of the site, so it says where
//   they are, lists what is installed, and offers well-known wallets that are
//   not (walletDirectory.ts): an install page on desktop, and on a phone a link
//   that reopens this page inside the wallet's own browser -- the only way a
//   phone can reach a wallet at all. Leaving the page is safe here because
//   sign-in is menu-only (walletLogin refuses otherwise), so nothing is bound.
//
// * **The stake prompt** (`connectPickedWallet`) asks only when there is a
//   choice to make. With zero or one usable wallet this is exactly
//   `connectWallet()`, and it never offers a link away from the page: the
//   player is in a lobby, and reopening it in a wallet's browser would seat
//   them a second time (see phantomBrowseLink).
//
// Silent reconnect never comes here: it is a page load, not a press of Connect.
//
// ⚠️ The overlay's class is `arena-wallet-picker-overlay`, NOT
// `arena-wager-overlay`. `sessionIsBound()` treats the latter as a bound
// session, so reusing it would make `walletLogin()` refuse the very sign-in the
// picker was opened for.

import { ClientEnv } from "../ClientEnv";
import { DISPLAY_FONT_STACK, loadDisplayFont } from "../components/displayFont";
import { translateText } from "../Utils";
import { suggestWallets, type WalletSuggestion } from "./walletDirectory";
import {
  connectWallet,
  isMobileBrowser,
  listWallets,
  type WalletAdapter,
  type WalletChoice,
} from "./WalletProvider";
import { storedWalletName } from "./walletSession";

export const WALLET_PICKER_OVERLAY_CLASS = "arena-wallet-picker-overlay";

/**
 * Connects the wallet the player picks, asking only when there is more than
 * one. Resolves null when they close the picker without choosing -- a change of
 * mind, which callers treat as they treat declining the wallet's own prompt: no
 * error shown.
 */
export async function connectPickedWallet(): Promise<WalletAdapter | null> {
  const choices = listWallets();
  if (choices.length <= 1) return connectWallet();
  const name = await pickWallet(choices, { lastUsed: storedWalletName() });
  if (name === null) return null;
  return connectWallet(name);
}

/**
 * The sign-in picker: always shown, with the site's name and the wallets the
 * player could get. Resolves null when dismissed, and also when the player
 * leaves for a wallet's in-app browser -- the page is unloading, and there is
 * nothing to report.
 */
export async function connectForSignIn(): Promise<WalletAdapter | null> {
  const choices = listWallets();
  const suggestions = suggestWallets(
    choices.map((c) => c.name),
    isMobileBrowser(),
    window.location.href,
    `${window.location.protocol}//${window.location.host}`,
  );
  const name = await pickWallet(choices, {
    lastUsed: storedWalletName(),
    welcome: true,
    suggestions,
  });
  if (name === null) return null;
  return connectWallet(name);
}

/** The last-used wallet first, then registration order. */
export function orderChoices(
  choices: readonly WalletChoice[],
  lastUsed: string | null,
): WalletChoice[] {
  const last = choices.filter((c) => c.name === lastUsed);
  return [...last, ...choices.filter((c) => c.name !== lastUsed)];
}

export interface PickerOptions {
  lastUsed: string | null;
  /** Show the site's name above the list. Sign-in only. */
  welcome?: boolean;
  /** Not-installed wallets to offer. Sign-in only -- see the file comment. */
  suggestions?: readonly WalletSuggestion[];
}

function badge(text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "text-xs text-white/50";
  el.textContent = text;
  return el;
}

const ROW_CLASS =
  "flex w-full items-center gap-3 border-b border-white/10 px-4 py-3 " +
  "text-left last:border-b-0 hover:bg-white/10 focus-visible:bg-white/10 " +
  "focus-visible:outline-none";

/**
 * A letter in the wallet's colour, standing in for a logo we do not ship
 * (walletDirectory.ts explains why).
 */
function monogram(
  name: string,
  color: string,
  ink = "#000000",
): HTMLSpanElement {
  const el = document.createElement("span");
  el.setAttribute("aria-hidden", "true");
  el.className =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full " +
    "text-sm font-bold";
  el.style.background = color;
  el.style.color = ink;
  el.textContent = name.slice(0, 1).toUpperCase();
  return el;
}

/**
 * Shows the picker and resolves with the chosen wallet's name, or null if it
 * was dismissed (Cancel, Escape, a click on the backdrop) or the player left
 * for a wallet app.
 *
 * Built imperatively, like the stake prompt in `wagerJoinFlow.ts`, because it is
 * opened from inside other components and must sit above all of them.
 * Wallet names and icons come from browser extensions, so names are set as
 * text and icons only ever as `pickerIcon()`'s `data:image/*` output.
 */
export function pickWallet(
  choices: readonly WalletChoice[],
  options: PickerOptions,
): Promise<string | null> {
  const { lastUsed, welcome = false, suggestions = [] } = options;

  const overlay = document.createElement("div");
  overlay.className = WALLET_PICKER_OVERLAY_CLASS;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    // Above the stake prompt (10000), which can be what opened it.
    zIndex: "10001",
    display: "flex",
    justifyContent: "center",
    overflowY: "auto",
    background: "rgba(0, 0, 0, 0.72)",
    backdropFilter: "blur(12px)",
    padding: "1rem",
  } satisfies Partial<CSSStyleDeclaration>);

  const panel = document.createElement("div");
  panel.className =
    "w-[min(24rem,calc(100vw-2rem))] box-border overflow-hidden rounded-2xl " +
    "border border-white/10 bg-surface text-white shadow-2xl";
  panel.style.margin = "auto";

  const header = document.createElement("div");
  header.className = welcome
    ? "px-5 pt-6 pb-4 text-center bg-gradient-to-b from-malibu-blue/25 to-transparent"
    : "px-5 pt-5 pb-3";
  const title = document.createElement("div");
  title.id = "arena-wallet-picker-title";
  overlay.setAttribute("aria-labelledby", title.id);
  // The site's name is data (SITE_NAME), never a translated string -- the
  // nameplate's rule, for the same AGPL §7 reason.
  const siteName = welcome ? ClientEnv.siteName() : "";
  if (siteName !== "") {
    title.className = "text-4xl leading-tight text-white [text-wrap:balance]";
    title.style.fontFamily = DISPLAY_FONT_STACK;
    // The menu wordmark's gradient, on an inline span for the same reason.
    const wordmark = document.createElement("span");
    wordmark.className = "arena-wordmark";
    wordmark.textContent = siteName;
    title.appendChild(wordmark);
    void loadDisplayFont();
    const subtitle = document.createElement("div");
    subtitle.className = "mt-1 text-sm text-white/60";
    subtitle.textContent = translateText("wallet_picker.sign_in_subtitle");
    header.append(title, subtitle);
  } else {
    title.className = "text-lg font-bold";
    title.textContent = translateText("wallet_picker.title");
    header.appendChild(title);
  }
  panel.appendChild(header);

  const body = document.createElement("div");
  body.className = "px-5 pb-5";
  panel.appendChild(body);

  const list = document.createElement("div");
  list.className =
    "flex max-h-[min(22rem,60vh)] flex-col overflow-y-auto rounded-xl " +
    "border border-white/10 bg-white/5";
  body.appendChild(list);

  // With something installed, the wallets to go and get are one click away
  // rather than in the way; with nothing installed they are the whole answer.
  const collapsible = choices.length > 0 && suggestions.length > 0;
  let toggle: HTMLButtonElement | null = null;
  if (collapsible) {
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.dataset.action = "more";
    toggle.className =
      "mt-3 w-full text-center text-sm text-aquarius hover:text-white";
    toggle.textContent = translateText("wallet_picker.more_wallets");
    body.appendChild(toggle);
  }

  // Extensions inject into pages loaded after they are installed, so a wallet
  // installed from this picker cannot appear in it until a reload.
  const reloadHint = document.createElement("p");
  reloadHint.className = "mt-3 text-center text-xs text-white/40";
  reloadHint.textContent = translateText("wallet_picker.reload_hint");
  const offersInstall = suggestions.some((s) => s.action.kind === "install");

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.dataset.action = "cancel";
  cancel.className =
    "mt-3 w-full rounded-lg px-4 py-2 text-sm text-white/60 hover:text-white";
  cancel.textContent = translateText("wallet_picker.cancel");
  body.appendChild(cancel);

  overlay.appendChild(panel);

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      finish(null);
    };

    for (const choice of orderChoices(choices, lastUsed)) {
      const row = document.createElement("button");
      row.type = "button";
      row.dataset.wallet = choice.name;
      row.className = ROW_CLASS;
      if (choice.icon !== "") {
        const img = document.createElement("img");
        img.src = choice.icon;
        img.alt = "";
        img.width = 28;
        img.height = 28;
        img.className = "h-7 w-7 shrink-0 rounded";
        row.appendChild(img);
      } else {
        row.appendChild(monogram(choice.name, "rgba(255,255,255,0.8)"));
      }
      const label = document.createElement("span");
      label.className = "flex-1 font-medium";
      label.textContent = choice.name;
      row.appendChild(label);
      row.appendChild(
        badge(
          translateText(
            choice.name === lastUsed
              ? "wallet_picker.last_used"
              : "wallet_picker.detected",
          ),
        ),
      );
      row.addEventListener("click", () => finish(choice.name));
      list.appendChild(row);
    }

    const suggestionRows: HTMLElement[] = [];
    for (const s of suggestions) {
      const row = document.createElement("button");
      row.type = "button";
      row.dataset.suggestion = s.name;
      row.className = ROW_CLASS;
      row.appendChild(monogram(s.name, s.color, s.ink));
      const label = document.createElement("span");
      label.className = "flex-1 font-medium";
      label.textContent = s.name;
      row.appendChild(label);
      row.appendChild(
        badge(
          translateText(
            s.action.kind === "open"
              ? "wallet_picker.open_app"
              : "wallet_picker.install",
          ),
        ),
      );
      row.addEventListener("click", () => {
        if (s.action.kind === "open") {
          // Same tab: the universal link hands the page to the wallet app, or
          // lands on the wallet's site to install it when it is not there.
          window.location.assign(s.action.url);
          finish(null);
        } else {
          window.open(s.action.url, "_blank", "noopener,noreferrer");
        }
      });
      if (collapsible) row.hidden = true;
      suggestionRows.push(row);
      list.appendChild(row);
    }

    const setExpanded = (expanded: boolean) => {
      for (const row of suggestionRows) row.hidden = !expanded;
      if (toggle !== null) {
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.textContent = translateText(
          expanded
            ? "wallet_picker.fewer_wallets"
            : "wallet_picker.more_wallets",
        );
      }
      if (offersInstall && expanded) {
        cancel.before(reloadHint);
      } else {
        reloadHint.remove();
      }
    };
    setExpanded(!collapsible);
    toggle?.addEventListener("click", () =>
      setExpanded(toggle?.getAttribute("aria-expanded") !== "true"),
    );

    cancel.addEventListener("click", () => finish(null));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(overlay);
    list.querySelector("button")?.focus();
  });
}
