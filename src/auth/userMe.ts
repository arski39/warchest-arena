// [ARENA] new file — the /users/@me body, derived from the session alone.
//
// Upstream's API reads this out of a database of accounts, subscriptions,
// cosmetics and clans. This fork has none of those, so every field is either
// derived from the session or a constant the operator sets. That is the whole
// reason the service needs no storage.
//
// The shape is not ours to choose: Worker.ts closes the socket with
// "Unauthorized" whenever this fails to parse as UserMeResponseSchema for any
// JWT-bearing client, so a missing required field takes the site down for
// everyone rather than degrading it.
import type { UserMeResponse } from "../core/ApiSchemas";
import { publicIdFor } from "./identity";

export type UserMeOptions = {
  /**
   * Whether this player may list a lobby publicly. Upstream gates it on a
   * subscription; here it is AUTH_ALLOW_PUBLIC_LOBBIES. Wagered lobbies stay
   * private-only either way -- POST /wager rejects a listed lobby and
   * /listing rejects a wagered one -- so this cannot widen the accepted
   * client-vote risk.
   */
  canCreatePublicLobbies: boolean;
};

export function buildUserMe(
  userId: string,
  opts: UserMeOptions,
): UserMeResponse {
  return {
    // No linked Discord/Google/Steam/email account exists on this deployment.
    // The wallet is deliberately not reported here either: `user` is
    // upstream's third-party-identity block, and every consumer of it
    // (AccountModal, hasLinkedAccount) would then offer account management
    // this fork has no backend for.
    user: {},
    player: {
      publicId: publicIdFor(userId),
      // The fork strips upstream's ad tags (see docs/branding.md), so there is
      // no ad to be free of and reporting otherwise would make AdGatekeeper
      // wait on an ad that never loads.
      adfree: true,
      // Ranked limits are a monetisation lever with no backend behind it here.
      unlimitedRanked: true,
      canCreatePublicLobbies: opts.canCreatePublicLobbies,
      achievements: { singleplayerMap: [] },
      friends: [],
      subscription: null,
    },
  } satisfies UserMeResponse;
}
