// ポップアップ: チェック開始ボタン + 前回結果の表示
// 表示文言は chrome.i18n（_locales）から取る。default_locale は ja で、
// ブラウザの表示言語が英語なら en が使われる。
const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

const noteEl = document.getElementById('note');
const resultsEl = document.getElementById('results');
const metaEl = document.getElementById('meta');
const flipLogEl = document.getElementById('fliplog');
const startBtn = document.getElementById('start');
const surfaceSel = document.getElementById('surface');
const surfaceNoteEl = document.getElementById('surface-note');

document.documentElement.lang = chrome.i18n.getUILanguage();
startBtn.textContent = msg('popupStartButton');
document.getElementById('brand').textContent = '▶' + msg('brandName');
document.getElementById('surface-label').textContent = msg('surfaceLabel');
surfaceSel.querySelector('option[value="auto"]').textContent = msg('surfaceAuto');

// 開く先の設定（v1.2.7）。値の意味は background.js の resolveNewTabUrl と対応:
// auto = 前回の面（無ければ表示言語で推測） / cojp / com / pv = 明示指定。
let lastScanUrl = null;

function updateSurfaceNote() {
  // primevideo.com を選んでいて地域の記録がまだ無いときだけ初回案内を出す
  const regionKnown = !!lastScanUrl && /primevideo\.com\/region\/[^/]+\//.test(lastScanUrl);
  surfaceNoteEl.textContent = surfaceSel.value === 'pv' && !regionKnown ? msg('surfacePvNote') : '';
}

surfaceSel.addEventListener('change', async () => {
  try { await chrome.storage.local.set({ pvSurfacePref: surfaceSel.value }); } catch (e) { /* noop */ }
  updateSurfaceNote();
});

startBtn.addEventListener('click', async () => {
  noteEl.textContent = msg('popupStarting');
  try {
    // 自分が開かれているウィンドウを background に伝える（v1.2.13）。
    // チェックはこのウィンドウの中で完結させるため。
    let windowId = null;
    try {
      const w = await chrome.windows.getCurrent();
      windowId = w && w.id != null ? w.id : null;
    } catch (e) { /* noop */ }
    const res = await chrome.runtime.sendMessage({ type: 'pv-open-and-scan', windowId });
    if (res && res.ok) {
      noteEl.textContent = msg('popupStarted');
    } else {
      noteEl.textContent = msg('popupStartFailed', [String((res && res.error) || msg('errorUnknown'))]);
    }
  } catch (e) {
    noteEl.textContent = msg('popupStartFailed', [e.message]);
  }
});

// 自動移動の記録（pvFlipLog）の表示。動かなかったときに理由が分かるよう、
// 最新8件を新しい順に並べる（v1.2.19）
function renderFlipLog(log) {
  flipLogEl.innerHTML = '';
  const h = document.createElement('h2');
  h.className = 'sub';
  h.textContent = msg('flipLogHeading');
  flipLogEl.appendChild(h);
  const entries = Array.isArray(log) ? log.slice(-8).reverse() : [];
  if (!entries.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = msg('flipLogEmpty');
    flipLogEl.appendChild(p);
    return;
  }
  const ul = document.createElement('ul');
  for (const en of entries) {
    const li = document.createElement('li');
    const time = new Date(en.t).toLocaleTimeString(chrome.i18n.getUILanguage(), { hour: '2-digit', minute: '2-digit' });
    const head = document.createElement('span');
    head.textContent = en.title ? `${time} ${en.title}` : time;
    li.appendChild(head);
    const span = document.createElement('span');
    span.className = 'cta';
    if (en.decision === 'flipped') span.textContent = msg('flipLogFlipped');
    else if (en.reason === 'small') span.textContent = msg('flipSkipSmall');
    else if (en.reason === 'no-intent') span.textContent = msg('flipSkipNoIntent');
    else if (en.reason === 'no-candidate') span.textContent = msg('flipSkipNoCandidate');
    else if (en.reason === 'not-unwatched') span.textContent = msg('flipSkipNotUnwatched');
    else if (en.reason === 'unknown-id') span.textContent = msg('flipSkipUnknownId');
    else span.textContent = en.reason || '';
    li.appendChild(span);
    ul.appendChild(li);
  }
  flipLogEl.appendChild(ul);
}

// 診断情報のコピー（v1.2.20）: 動かなかったときにユーザーがそのまま
// チャットへ貼れる形で、版・ページの見え方・自動移動の記録・前回結果を
// ひとまとめにしてクリップボードへ入れる
const diagBtn = document.getElementById('diag-copy');
diagBtn.textContent = msg('diagCopyButton');
diagBtn.addEventListener('click', async () => {
  try {
    const data = await chrome.storage.local.get(['pvLastScan', 'pvFlipLog', 'pvDiagLast', 'pvScanState', 'pvNotice']);
    const lines = [];
    lines.push('=== Prime Video watchlist checker diagnostics ===');
    lines.push('version: ' + chrome.runtime.getManifest().version);
    lines.push('copiedAt: ' + new Date().toLocaleString('ja-JP'));
    lines.push('uiLang: ' + chrome.i18n.getUILanguage());
    lines.push('');
    lines.push('--- last page snapshot ---');
    if (data.pvDiagLast) {
      lines.push('ageSec: ' + Math.round((Date.now() - data.pvDiagLast.t) / 1000));
      lines.push(JSON.stringify(data.pvDiagLast, null, 1));
    } else {
      lines.push('(none)');
    }
    lines.push('');
    lines.push('--- auto-move log (oldest first) ---');
    const log = Array.isArray(data.pvFlipLog) ? data.pvFlipLog : [];
    if (!log.length) lines.push('(empty)');
    for (const e of log) lines.push(JSON.stringify(e));
    lines.push('');
    lines.push('--- last scan ---');
    const scan = data.pvLastScan;
    if (scan) {
      lines.push('at: ' + new Date(scan.at).toLocaleString('ja-JP'));
      lines.push('url: ' + scan.url);
      for (const r of scan.results || []) {
        lines.push([r.status, r.flipped ? 'flipped' : '-', JSON.stringify(r.title), JSON.stringify(r.ctaText || ''), r.id].join(' | ')
          + (Array.isArray(r.altIds) && r.altIds.length ? ' | alt: ' + r.altIds.join(',') : ''));
      }
    } else {
      lines.push('(none)');
    }
    lines.push('');
    lines.push('--- scan state / notice ---');
    lines.push(JSON.stringify({ scanState: data.pvScanState || null, notice: data.pvNotice || null }));
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      noteEl.textContent = msg('diagCopied');
    } catch (e2) {
      let ta = document.getElementById('diag-text');
      if (!ta) {
        ta = document.createElement('textarea');
        ta.id = 'diag-text';
        ta.style.cssText = 'width:100%;height:140px;margin-top:8px;';
        diagBtn.after(ta);
      }
      ta.value = text;
      ta.select();
      noteEl.textContent = msg('diagCopyFailed');
    }
  } catch (e) {
    noteEl.textContent = msg('diagCopyFailed');
  }
});

function render(data) {
  renderFlipLog(data.pvFlipLog);
  const scan = data.pvLastScan;
  const state = data.pvScanState;
  lastScanUrl = (scan && scan.url) || null;
  if (data.pvSurfacePref) surfaceSel.value = data.pvSurfacePref;
  updateSurfaceNote();
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
      // 自動で視聴済み側へ移動した作品は「再生済み」と出す（v1.2.17）
      span.textContent = r.flipped ? msg('playedLabel') : (r.ctaText || msg('ctaNotFound'));
      li.appendChild(span);
      ul.appendChild(li);
    }
    resultsEl.appendChild(ul);
  }
  metaEl.textContent = msg('popupLastCheck', [new Date(scan.at).toLocaleString(chrome.i18n.getUILanguage())]);
}

chrome.storage.local.get(['pvLastScan', 'pvScanState', 'pvNotice', 'pvSurfacePref', 'pvFlipLog']).then(render).catch(() => {});
