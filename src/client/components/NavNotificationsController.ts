import { ReactiveController, ReactiveControllerHost } from "lit";
import version from "resources/version.txt?raw";
import { getGamesPlayed } from "../Utils";

const HELP_SEEN_KEY = "helpSeen";
const NEWS_SEEN_VERSION_KEY = "newsSeenVersion";

export class NavNotificationsController implements ReactiveController {
  private host: ReactiveControllerHost;

  private _helpSeen = localStorage.getItem(HELP_SEEN_KEY) === "true";
  private _hasNewVersion = false;

  private get normalizedVersion(): string {
    const trimmed = version.trim();
    return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  }

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
  }

  hostConnected(): void {
    // Check if version has changed
    const currentVersion = this.normalizedVersion;
    const seenVersion = localStorage.getItem(NEWS_SEEN_VERSION_KEY);
    this._hasNewVersion =
      seenVersion !== null && seenVersion !== currentVersion;
    if (seenVersion === null) {
      localStorage.setItem(NEWS_SEEN_VERSION_KEY, currentVersion);
    }
  }

  hostDisconnected(): void {}

  // Only show one dot at a time to prevent
  // overwhelming users. Priority: News > Help.
  //
  // [ARENA] The Store dot sat between them and is gone with the storefront.
  // Help's condition kept `!showStoreDot()`, so dropping that term is what
  // preserves the chain rather than a simplification of it -- leaving a stale
  // reference here would not compile, but silently deleting the wrong term
  // would make the help dot outrank news.
  showNewsDot(): boolean {
    return this._hasNewVersion;
  }

  showHelpDot(): boolean {
    return getGamesPlayed() < 10 && !this._helpSeen && !this.showNewsDot();
  }

  onNewsClick = (): void => {
    this._hasNewVersion = false;
    localStorage.setItem(NEWS_SEEN_VERSION_KEY, this.normalizedVersion);
    this.host.requestUpdate();
  };

  onHelpClick = (): void => {
    localStorage.setItem(HELP_SEEN_KEY, "true");
    this._helpSeen = true;
    this.host.requestUpdate();
  };
}
