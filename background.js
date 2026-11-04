// Prime Video 未視聴エピソードチェッカー - background service worker
// ポップアップからの「チェック開始」を受けて、ウォッチリストのタブを
// 開く／前面化し、content script に巡回開始を伝える。

const WATCHLIST_URL = 'https://www.amazon.co.jp/gp/video/mystuff/watchlist';

async function findWatchlistTab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => t.url && t.url.startsWith(WATCHLIST_URL)) || null;
}

async function sendStartToTab(tabId, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'pv-scan-start' });
      if (res && res.ok) return true;
    } catch (e) {
      // content script が居ない/無効化されている場合は何度送っても届かない。
      // アドオン更新直後の既存タブがこれで、ここで粘ると開始が最大10秒遅れるため、
      // 即座に諦めてリロードでの自動開始に切り替える。
      const msg = String(e && e.message ? e.message : e);
      if (/Receiving end does not exist|Extension context invalidated|Could not establish connection/i.test(msg)) {
        return false;
      }
      // それ以外の一時的な失敗（読み込み途中など）は少し待って再試行
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function openAndScan() {
  const existing = await findWatchlistTab();
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) {
      try { await chrome.windows.update(existing.windowId, { focused: true }); } catch (e) {}
    }
    const ok = await sendStartToTab(existing.id);
    if (ok) return { ok: true, mode: 'existing-tab' };
    // 応答がない場合はリロードしてから pending フラグで自動開始させる
    await chrome.storage.local.set({ pvPendingScan: Date.now() });
    await chrome.tabs.reload(existing.id);
    return { ok: true, mode: 'reloaded-tab' };
  }
  // タブが無い場合は pending フラグを立ててから新規タブで開く。
  // ページ読み込み後に content script がフラグを見て自動で巡回を始める。
  await chrome.storage.local.set({ pvPendingScan: Date.now() });
  await chrome.tabs.create({ url: WATCHLIST_URL, active: true });
  return { ok: true, mode: 'new-tab' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'pv-open-and-scan') {
    openAndScan()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true; // async response
  }
  return false;
});
