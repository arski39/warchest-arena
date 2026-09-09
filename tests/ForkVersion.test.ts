// [ARENA] The two files upstream's release pipeline fills in and this fork's
// deploy does not.
//
// `resources/version.txt` and `resources/changelog.md` are committed as
// PLACEHOLDERS upstream, substituted at release time by `build.sh` (":86"). All
// four of upstream's scripts are unusable here — build.sh is amd64-only and
// registry-only — so this fork builds with `docker build` and neither file was
// ever replaced. The live consequences were both visible in the UI:
//
//   * the nav rendered the literal string "vx.xx.xx", because Main.ts prefixes
//     whatever version.txt holds with a "v";
//   * the News modal served upstream's SAMPLE changelog, whose own first line
//     says it is "based off of v0.24.0" — so the site advertised balance
//     changes and features from a version nobody was running, and did it under
//     an "OpenFront v24 Changelog" heading. That is the §7 misrepresentation
//     the branding work already removed from the app shell, arriving through a
//     resource file instead.
//
// Both are merge targets: an upstream merge restores both placeholders, and
// nothing else in the suite reads either file. Same reasoning as
// AppShellBranding's upstream-identity guard, which is why the needles here
// are upstream's own placeholder wording rather than anything of ours.
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const resources = path.join(__dirname, "..", "resources");

function read(name: string): string {
  return fs.readFileSync(path.join(resources, name), "utf-8");
}

describe("[ARENA] this fork's version is its own", () => {
  it("does not ship the unsubstituted version placeholder", () => {
    // Rendered verbatim, so the placeholder reaches players as "vx.xx.xx".
    expect(read("version.txt").trim()).not.toBe("x.xx.xx");
  });

  it("states a version that reads as one", () => {
    // Main.ts adds the "v" itself; a value starting with one would show "vv0.1".
    const version = read("version.txt").trim();
    expect(version).toMatch(/^\d+\.\d+/);
  });

  it("ships release notes rather than upstream's sample", () => {
    const changelog = read("changelog.md");
    expect(changelog).not.toContain("sample changelog");
    expect(changelog).not.toContain("replaced with real release notes");
  });

  it("does not present upstream's release notes as this deployment's", () => {
    // The sample's heading, which is what the News modal actually displayed.
    expect(read("changelog.md")).not.toContain("OpenFront v24 Changelog");
  });
});
