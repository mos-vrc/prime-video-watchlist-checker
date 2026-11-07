# Chrome Web Store listing — English localization (DRAFT)

English listing texts for "Prime Video Watchlist New Episode Checker", for entry in the Developer Dashboard as an additional localized listing (the default listing stays Japanese). Everything here is a draft; confirm with the user before submitting.

How to apply: in the Developer Dashboard's Store listing page, use the language selector at the top to add "English" and paste these texts. The extension package itself already ships `_locales/en`, so its name/description/UI follow the browser's display language automatically.

## Item name

- The store display title is taken from the package title (the manifest name) and cannot be changed in the dashboard (verified 2026-11-05).
- Current name: Prime Video Watchlist New Episode Checker (no language suffix; supported languages are stated in the description instead)

## Summary (matches manifest `description` in the en locale)

Scans your Prime Video watchlist for titles with unwatched episodes. Titles you play move to Started automatically.

## Detailed description (draft)

This extension automatically checks the titles on your Amazon Prime Video watchlist and lists the ones that have episodes you haven't watched yet.

On Prime Video, a watchlist doesn't tell you when a new episode arrives — you only find out by opening each title. This extension scans your watchlist for you and judges each title's viewing state from the label of the play button shown on hover.

Note: Only the Japanese and English Prime Video interfaces are supported. Titles cannot be classified when the interface is set to another language.

■ How it decides
Each title is classified by the play-button label shown when you hover over it:
・"Resume" (e.g. "Resume S3 E5") → already started
・"Play Episode …" / "Play S3 E5" → has unwatched episodes
・For movies: "Play" → not watched yet, "Resume" → already started (movies are mixed into the same groups)
・Anything else is shown separately as "Couldn't tell"

(Japanese UI labels are supported too: 「〜の続きを観る」→ started, 「エピソード○を再生」→ unwatched.)

■ Automatic move when you play a title
When you play a title listed under "Has unwatched episodes", it moves to "Started / Resume" automatically — no re-check needed (only for playback in this browser; moved titles are marked "Played"). Trailers that autoplay do not trigger the move. If you open a title from the popup or the panel while a video is playing, it opens in a new tab (navigating the playing tab would bounce back to the playing title due to Prime Video's behavior).

■ How to use
1. Sign in to a supported site (amazon.co.jp, amazon.com, or primevideo.com) and press "Check my watchlist" from the extension icon
2. The watchlist tab opens and the scan starts automatically (about 1 second per title). You can choose which site to open with the "Watchlist to open" selector at the bottom of the popup (default: Auto = the site you checked last time)
3. Results appear in a panel on the page and in the extension popup, grouped into "Has unwatched episodes", "Started / Resume", and "Couldn't tell"
4. Click a title to go straight to its page

■ Privacy
Results are stored only inside your browser and are never sent to any server. The extension does not collect account information or viewing history. It uses your browser's existing signed-in session and never reads your ID, password, or cookies.

■ Notes
・Works with Prime Video on amazon.co.jp, amazon.com, and primevideo.com
・Only the Japanese and English interface languages are supported
・This is an unofficial tool and is not affiliated with Amazon.com, Inc. or its affiliates
・If you stopped an episode partway, the button keeps saying "Resume", so a newer episode beyond it cannot be detected
・If Prime Video changes its page layout, the extension may stop working until updated

## Single purpose (for the dashboard)

To scan the user's Amazon Prime Video watchlist and list the titles that have unwatched episodes.

## Permission justifications (for the dashboard)

- tabs: Used to find and focus the watchlist tab and to send it the scan-start message. Tab URLs are read only to identify the watchlist tab.
- storage: Used to save the latest check results, the scan state, and the "Watchlist to open" choice from the popup inside the browser (chrome.storage.local), so the popup can show the previous results and the check can open the right site. Nothing is sent anywhere.
- Host permissions (https://www.amazon.co.jp/gp/video/*, https://www.amazon.com/gp/video/*, https://www.primevideo.com/*): Used to run the content script on the Prime Video pages of the supported sites. On the watchlist page it reads the hover play-button labels of title cards; on detail and playback pages it detects when playback starts so a played title can be moved to "Started / Resume" in the stored results automatically. The extension does not run on any other sites.

## Data-use declarations (Privacy practices, for the dashboard)

- Personal data collection: None. This extension does not collect or transmit user data.
- Where data lives: Check results (title names, links to title pages, classification results) are stored only in the user's browser (chrome.storage.local).
- Remote code: Not used. All code is included in the package.
- Privacy policy: PRIVACY.md in the repository (register its URL in the dashboard after publication).

## Category / language

- Category: Entertainment
- Language: English (additional localized listing; default remains Japanese)

## Screenshots

The existing screenshots (store-assets/) show the Japanese UI. English screenshots can be captured the same way from the mock page; they are optional for adding the English listing and can be prepared when the English release is actually submitted.
