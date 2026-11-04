// Amazon Prime Video 未視聴ウォッチリストチェッカー - background service worker
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
    // 応答がない場合はリロードしてから pending フラグで自動開始させる。
    // pending には対象タブを記録し、そのタブがログイン画面へ進んだら取り消す。
    await chrome.storage.local.set({ pvPendingScan: { at: Date.now(), tabId: existing.id } });
    await chrome.tabs.reload(existing.id);
    return { ok: true, mode: 'reloaded-tab' };
  }
  // タブが無い場合は pending フラグを立ててから新規タブで開く。
  // ページ読み込み後に content script がフラグを見て自動で巡回を始める。
  await chrome.storage.local.set({ pvPendingScan: { at: Date.now(), tabId: null } });
  const tab = await chrome.tabs.create({ url: WATCHLIST_URL, active: true });
  if (tab && tab.id) {
    await chrome.storage.local.set({ pvPendingScan: { at: Date.now(), tabId: tab.id } });
  }
  return { ok: true, mode: 'new-tab' };
}

// 未ログインでチェックを始めた場合の扱い（ユーザー指定）:
// ウォッチリストへ進む途中でログイン画面にリダイレクトされたら、そこで動作を止める。
// ログインした後に自動でチェックが始まることはしない（pending を取り消す）。
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = (changeInfo && changeInfo.url) || (tab && tab.url) || '';
  if (!url.includes('amazon.co.jp') || !url.includes('/signin')) return;
  try {
    const data = await chrome.storage.local.get('pvPendingScan');
    const pending = data.pvPendingScan;
    if (!pending) return;
    const at = typeof pending === 'number' ? pending : pending.at;
    const pendingTabId = typeof pending === 'number' ? null : pending.tabId;
    if (!at || Date.now() - at > 5 * 60 * 1000) return;
    if (pendingTabId != null && pendingTabId !== tabId) return;
    await chrome.storage.local.remove('pvPendingScan');
    await chrome.storage.local.set({
      pvNotice: { at: Date.now(), text: 'ログイン画面が出たのでチェックを止めたよ。ログインしてから、もう一度チェックを押してね。' },
    });
  } catch (e) { /* noop */ }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'pv-open-and-scan') {
    openAndScan()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true; // async response
  }
  return false;
});
