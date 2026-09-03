// [ARENA] new file — mounts the wagered-lobby gate and waits for its outcome.
//
// Kept separate from Main.ts so the join funnel there stays a two-line change:
// everything about overlay lifecycle, event wiring and teardown lives here.

import type { WagerInfo } from "../../core/Schemas";
import {
  WAGER_CANCELLED_EVENT,
  WAGER_JOINED_EVENT,
  WagerLobby,
  type WagerJoinedDetail,
} from "./WagerLobby";

/**
 * Shows the stake gate over the page and resolves once the player has staked,
 * or with null if they backed out. Never rejects: a failed transaction is
 * reported inside the panel and the player can retry or cancel.
 */
export function promptWagerJoin(
  gameId: string,
  wager: WagerInfo,
): Promise<WagerJoinedDetail | null> {
  const overlay = document.createElement("div");
  overlay.className = "arena-wager-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "10000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0, 0, 0, 0.72)",
    // Matches the scrim the rest of the app uses (JoinLobbyModal's
    // `backdrop-blur-md`). Inline rather than a Tailwind class because this
    // element is built imperatively, outside any component's template.
    backdropFilter: "blur(12px)",
    padding: "1rem",
  } satisfies Partial<CSSStyleDeclaration>);

  const panel = document.createElement("arena-wager-lobby") as WagerLobby;
  panel.wager = wager;
  panel.gameId = gameId;
  overlay.appendChild(panel);

  return new Promise<WagerJoinedDetail | null>((resolve) => {
    let settled = false;
    const finish = (result: WagerJoinedDetail | null) => {
      if (settled) return; // the panel is removed on first event, but be exact
      settled = true;
      overlay.remove();
      resolve(result);
    };

    overlay.addEventListener(WAGER_JOINED_EVENT, (e) => {
      finish((e as CustomEvent<WagerJoinedDetail>).detail);
    });
    overlay.addEventListener(WAGER_CANCELLED_EVENT, () => finish(null));

    document.body.appendChild(overlay);
  });
}
