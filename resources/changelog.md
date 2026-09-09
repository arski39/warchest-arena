- Warchest Arena is a wagering layer built on OpenFront.io. These are this fork's release notes, not upstream's.

📦 **Warchest Arena v0.1.0** — devnet

⚔️ **What this fork adds**

- 1v1 duels are the primary mode, matched by stake: pick a tier and you are paired with whoever else picked the same one.
- Stakes go into an on-chain Solana escrow that only the program can pay out. The server never holds your funds.
- The winner is decided by the server replaying the match from the turn log it relayed — not by a vote from the players' own clients.
  → A replay that cannot be reproduced refuses to settle and the stakes are refunded, rather than paying out on an unverified result.
- A duel's map, bot count and match clock are drawn from the ranked 1v1 pool. Neither player configures them, because both paid the same amount for the same game.
- Wallet sign-in from the account menu. Playing for free needs no wallet at all.

💵 **Stakes**

- Stakes are **devnet test tokens**. They are worthless, cannot be bought, and cannot be exchanged for anything.
- Nothing is locked in until every seat is staked. Leave an unfilled lobby and your stake is returned to you automatically.
- Once the last seat is staked the match begins, and leaving after that forfeits your stake.
- The house takes a fixed percentage of the pot, shown on the stake prompt before you sign.

🎮 **The game itself**

- Game rules, maps, units and balance are OpenFront's, unmodified — this fork changes how a match is wagered on, not how it is played.
- Ranked matchmaking is hidden here: its queue lives in upstream's closed API, so the button never worked on this deployment.

⚠️ **This is a test deployment**

- Running against Solana devnet. Expect the program to be redeployed and match history to be wiped without notice.
