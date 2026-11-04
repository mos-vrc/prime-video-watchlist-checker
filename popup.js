// ポップアップ: チェック開始ボタン + 前回結果の表示
// 表示文言は chrome.i18n（_locales）から取る。default_locale は ja で、
// ブラウザの表示言語が英語なら en が使われる。
const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

const noteEl = document.getElementById('note');
const resultsEl = document.getElementById('results');
const metaEl = document.getElementById('meta');
const startBtn = document.getElementById('start');

document.documentElement.lang = chrome.i18n.getUILanguage();
startBtn.textContent = msg('popupStartButton');
document.getElementById('brand').textContent = '▶' + msg('appName');

startBtn.addEventListener('click', async () => {
  noteEl.textContent = msg('popupStarting');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'pv-open-and-scan' });
    if (res && res.ok) {
      noteEl.textContent = msg('popupStarted');
    } else {
      noteEl.textContent = msg('popupStartFailed', [String((res && res.error) || msg('errorUnknown'))]);
    }
  } catch (e) {
    noteEl.textContent = msg('popupStartFailed', [e.message]);
  }
});

function render(data) {
  const scan = data.pvLastScan;
  const state = data.pvScanState;
  if (data.pvNotice && Date.now() - data.pvNotice.at < 10 * 60 * 1000 && !noteEl.textContent) {
    noteEl.textContent = data.pvNotice.text;
  }
  resultsEl.innerHTML = '';
  if (state && state.running) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = msg('popupScanning');
    resultsEl.appendChild(p);
  }
  if (!scan || !scan.results || scan.results.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = msg('popupNoResults');
    resultsEl.appendChild(p);
    return;
  }
  const groups = [
    ['unwatched', 'headingUnwatched', ''],
    ['resume', 'headingResume', 'sub'],
    ['unknown', 'headingUnknown', 'sub'],
  ];
  for (const [status, labelKey, cls] of groups) {
    const items = scan.results.filter((r) => r.status === status);
    const h = document.createElement('h2');
    if (cls) h.className = cls;
    h.textContent = msg(labelKey, [String(items.length)]);
    resultsEl.appendChild(h);
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = msg('emptyNone');
      resultsEl.appendChild(p);
      continue;
    }
    const ul = document.createElement('ul');
    for (const r of items) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = r.href;
      a.textContent = r.title;
      a.addEventListener('click', async (ev) => {
        ev.preventDefault();
        // 今開いているタブをそのまま作品ページへ遷移させる（新しいタブは開かない）
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab && tab.id) {
            await chrome.tabs.update(tab.id, { url: r.href });
            window.close();
            return;
          }
        } catch (e) { /* フォールバックへ */ }
        chrome.tabs.create({ url: r.href });
      });
      li.appendChild(a);
      const span = document.createElement('span');
      span.className = 'cta';
      span.textContent = r.ctaText || msg('ctaNotFound');
      li.appendChild(span);
      ul.appendChild(li);
    }
    resultsEl.appendChild(ul);
  }
  metaEl.textContent = msg('popupLastCheck', [new Date(scan.at).toLocaleString(chrome.i18n.getUILanguage())]);
}

chrome.storage.local.get(['pvLastScan', 'pvScanState', 'pvNotice']).then(render).catch(() => {});
