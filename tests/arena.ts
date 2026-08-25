import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";

// Placeholder smoke test — Phase 0 scaffold verification.
// Full test suite in Phase 2 (task 7): happy path, double-join, bad-sig, rake math.
describe("arena – scaffold", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Arena as Program<any>;

  it("program ID is set", () => {
    assert.ok(program.programId.toBase58().length === 44);
  });
});
