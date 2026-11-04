// ポップアップ: チェック開始ボタン + 前回結果の表示
const noteEl = document.getElementById('note');
const resultsEl = document.getElementById('results');
const metaEl = document.getElementById('meta');

document.getElementById('start').addEventListener('click', async () => {
  noteEl.textContent = 'ウォッチリストを開いて巡回を始めるよ…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'pv-open-and-scan' });
    if (res && res.ok) {
      noteEl.textContent = '巡回中はウォッチリストのタブに結果パネルが出るよ。終わったらまたこのポップアップを開くと一覧が見られるよ。';
    } else {
      noteEl.textContent = '開始できなかった: ' + ((res && res.error) || '不明なエラー');
    }
  } catch (e) {
    noteEl.textContent = '開始できなかった: ' + e.message;
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
    p.textContent = 'いま巡回中… ウォッチリストのタブで進み具合が見られるよ。';
    resultsEl.appendChild(p);
  }
  if (!scan || !scan.results || scan.results.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'まだ結果がないよ。「ウォッチリストをチェック」から始めてね。';
    resultsEl.appendChild(p);
    return;
  }
  const groups = [
    ['unwatched', '未視聴あり', ''],
    ['resume', '視聴済み側・続きを観る', 'sub'],
    ['unknown', '判定不能', 'sub'],
  ];
  for (const [status, label, cls] of groups) {
    const items = scan.results.filter((r) => r.status === status);
    const h = document.createElement('h2');
    if (cls) h.className = cls;
    h.textContent = `${label}（${items.length}）`;
    resultsEl.appendChild(h);
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'なし';
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
      span.textContent = r.ctaText || 'ボタン未検出';
      li.appendChild(span);
      ul.appendChild(li);
    }
    resultsEl.appendChild(ul);
  }
  metaEl.textContent = '前回チェック: ' + new Date(scan.at).toLocaleString('ja-JP');
}

chrome.storage.local.get(['pvLastScan', 'pvScanState', 'pvNotice']).then(render).catch(() => {});
