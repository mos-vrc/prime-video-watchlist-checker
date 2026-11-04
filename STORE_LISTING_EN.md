# Chrome Web Store listing — English localization (DRAFT)

English listing texts for "Amazon Prime Video Unwatched Watchlist Checker", for entry in the Developer Dashboard as an additional localized listing (the default listing stays Japanese). Everything here is a draft; confirm with the user before submitting.

How to apply: in the Developer Dashboard's Store listing page, use the language selector at the top to add "English" and paste these texts. The extension package itself already ships `_locales/en`, so its name/description/UI follow the browser's display language automatically.

## Item name (matches manifest `name` in the en locale)

Amazon Prime Video Unwatched Watchlist Checker

## Summary (matches manifest `description` in the en locale)

Scans your Amazon Prime Video watchlist and lists titles that have unwatched episodes, based on each card's hover play-button label ("Resume" vs. "Play Episode …").

## Detailed description (draft)

This extension automatically checks the titles on your Amazon Prime Video watchlist and lists the ones that have episodes you haven't watched yet.

On Prime Video, a watchlist doesn't tell you when a new episode arrives — you only find out by opening each title. This extension scans your watchlist for you and judges each title's viewing state from the label of the play button shown on hover.

■ How it decides
Each title is classified by the play-button label shown when you hover over it:
・"Resume" (e.g. "Resume S3 E5") → already started
・"Play Episode …" / "Play S3 E5" → has unwatched episodes
・Anything else is shown separately as "Couldn't tell"

(Japanese UI labels are supported too: 「〜の続きを観る」→ started, 「エピソード○を再生」→ unwatched.)

■ How to use
1. Sign in to amazon.co.jp and press "Check my watchlist" from the extension icon
2. The watchlist tab opens and the scan starts automatically (about 1 second per title)
3. Results appear in a panel on the page and in the extension popup, grouped into "Has unwatched episodes", "Started / Resume", and "Couldn't tell"
4. Click a title to go straight to its page

■ Privacy
Results are stored only inside your browser and are never sent to any server. The extension does not collect account information or viewing history. It uses your browser's existing signed-in session and never reads your ID, password, or cookies.

■ Notes
・Works only with Prime Video on amazon.co.jp
・This is an unofficial tool and is not affiliated with Amazon.com, Inc. or its affiliates
・If you stopped an episode partway, the button keeps saying "Resume", so a newer episode beyond it cannot be detected
・If Prime Video changes its page layout, the extension may stop working until updated

## Single purpose (for the dashboard)

To scan the user's Amazon Prime Video watchlist and list the titles that have unwatched episodes.

## Permission justifications (for the dashboard)

- tabs: Used to find and focus the watchlist tab and to send it the scan-start message. Tab URLs are read only to identify the watchlist tab.
- storage: Used to save the latest check results and scan state inside the browser (chrome.storage.local) so the popup can show the previous results. Nothing is sent anywhere.
- Host permission (https://www.amazon.co.jp/gp/video/*): Used to run the content script only on the watchlist page and read the hover play-button labels of title cards. The extension does not run on any other pages.

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
