// Prime Video ウォッチリスト新着チェッカー - content script
// ウォッチリストページを下までスクロールしながら各作品カードを巡回し、
// 合成ホバーイベントでホバーカードを出させ、再生ボタンの文言で判定する。
//
// 判定ルール（ユーザー指定）:
//   「シーズン○エピソード○の続きを観る」等 "の続きを観る" -> 視聴済み側
//   「エピソード○を再生」等 "エピソード○を再生"           -> 未視聴（新着エピソードあり候補）
//   それ以外／ボタンが取れない                              -> 判定不能（診断ログに原文を残す）
//
// 英語UI（amazon.co.jp の英語表示など）向けの対応パターン（v1.1で追加）:
//   "Resume" / "Resume S3 E5" / "Continue Watching"          -> 視聴済み側
//   "Play Episode 5" / "Play S3 E5" / "Play Season 3 Episode 5" -> 未視聴
//   "Watch Now" は「今すぐ観る」相当で判定不能、"Play Trailer" 等の予告編は対象外
//
// 映画の文言（v1.2で追加。ユーザーの実物スクショで確認済み）:
//   ホバー: 未視聴は「再生」/ "Play"、視聴中・視聴済みは「続きを観る」/ "Resume"
//     （観終わった映画もホバーでは「続きを観る」になる ＝ 視聴済み側で正しい）
//   詳細ページ（大きい画面）: 観終わった映画は「もう一度観る」/ "Watch again"
//     → 仕様変更でホバー側にも出てきた場合に備え、視聴済み側として判定する
//   「再生」/ "Play" 単独は "弱い未視聴" として扱う: 強い文言（エピソード系など）が
//     1つも無い場合にだけ採用し、「今すぐ観る」等の判定不能な本命ボタンがある場合は
//     そちらを優先して弱い文言を捨てる（v1.1 の全件誤判定の再発防止）。
//
// パネル等の表示文言は chrome.i18n（_locales）から取る。判定はページ側の表示言語に
// 依存するため、日本語・英語両方のパターンを常に有効にしている。
//
// 第1話無料の作品（v1.2.3で追加。ユーザーの実物スクショで確認済み）:
//   ホバーカードに「第1話無料」/ "First episode free" と出る作品のボタンは
//   「今すぐ観る」/ "Watch now" になる。これは第1話から再生する＝未視聴として扱う。
//   目印が同じホバーカード等にある場合に限る。目印のない「今すぐ観る」は
//   従来通り判定不能（映画など他の文脈での誤判定を防ぐため）。
//
// 結果はページ内パネルに表示し、chrome.storage.local にも保存して
// 拡張ポップアップから「前回の結果」として見られるようにする。

(() => {
  'use strict';

  const PANEL_ID = 'pv-checker-panel';
  const HOVER_WAIT_MS = 2500;      // 1作品あたりホバーを待つ最大時間
  const HOVER_POLL_MS = 50;
  const NO_REACTION_MS = 800;      // ホバーにDOMが全く反応しなければ、この時間で見切る
  const SETTLE_MS = 700;           // 反応はあったがDOMの変化がこの時間止まったら、ボタン無しと見切る
  const SETTLE_MIN_MS = 900;       // ただしホバー開始からこの時間までは見切らない
  const WEAK_SETTLE_MIN_MS = 1800; // 弱い文言（映画の「再生」/ "Play"）だけの場合は、本命ボタンの遅延描画に備えてこの時間までは確定しない
  const BETWEEN_CARDS_MS = 60;     // 作品間の間隔
  const SCROLL_WAIT_MS = 150;
  const MAX_SCROLL_ROUNDS = 120;   // 無限スクロールの安全上限
  const STABLE_ROUNDS_TO_STOP = 2; // 新規カードが出なくなってから止まるまでの回数

  let scanning = false;
  let cancelRequested = false;
  let panelHidden = false;
  let scanResults = [];
  let debugLog = [];

  // ---------- 純粋関数（テスト対象） ----------

  function normalizeText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  // 詳細ページURLから作品IDを取り出す (B0XXXXXXXX 形式 / amzn1.dv.gti.… 形式の両対応)
  function extractTitleId(href) {
    if (!href) return null;
    const m = String(href).match(/\/detail\/([^/?&#]+)/);
    return m ? m[1] : null;
  }

  // 再生ボタンの文言 -> 判定
  // 文言は空白・改行まわりがDOM構造で揺れるので、空白を全部詰めた文字列で照合する
  function classifyCta(rawText) {
    const t = normalizeText(rawText);
    if (!t) return { status: 'unknown', ctaText: '' };
    const compact = t.replace(/\s+/g, '');
    if (/の続きを観る/.test(compact) || compact === '続きを観る' || /もう一度観る/.test(compact)) {
      return { status: 'resume', ctaText: t }; // 視聴済み側
    }
    if (/エピソード\d+を再生/.test(compact)) {
      return { status: 'unwatched', ctaText: t }; // 未視聴
    }
    // 英語UI向け（ページの表示言語が英語の場合）。予告編（Play Trailer 等）は
    // どのパターンにも一致しないので自然に判定不能へ落ちる。
    if (/^resume\b/i.test(t) || /\bcontinue watching\b/i.test(t) || /\bwatch again\b/i.test(t)) {
      return { status: 'resume', ctaText: t }; // 視聴済み側
    }
    if (/^play\s+(?:season\s+\d+\s+)?episode\s+\d+\b/i.test(t)
      || /^play\s+s\d+\s*:?\s*e\d+\b/i.test(t)) {
      return { status: 'unwatched', ctaText: t }; // 未視聴
    }
    // 映画の未視聴ボタン（「再生」/ "Play" 単独）は "弱い未視聴" として返す。
    // 強い文言が他にある場合はそちらが優先される（findCtaElement の優先度制御）。
    if (compact === '再生' || /^play$/i.test(t)) {
      return { status: 'unwatched', ctaText: t, weak: true };
    }
    return { status: 'unknown', ctaText: t };
  }

  // 「今すぐ観る」/ "Watch now" そのものの文言かどうか
  function isWatchNowText(rawText) {
    const t = normalizeText(rawText);
    return t.replace(/\s+/g, '') === '今すぐ観る' || /^watch\s+now$/i.test(t);
  }

  // CTAらしい文言かどうか（ホバーカード内のボタン探索用）
  function looksLikeCta(text) {
    const t = normalizeText(text);
    if (!t || t.length > 40) return false;
    const compact = t.replace(/\s+/g, '');
    if (/の続きを観る/.test(compact) || compact === '続きを観る' || /もう一度観る/.test(compact) || /エピソード\d+を再生/.test(compact) || /を再生/.test(compact) || /今すぐ観る/.test(compact)) return true;
    if (compact === '再生') return true; // 映画の未視聴ボタン（弱い未視聴の候補）
    // 英語UI向け
    return /^play$/i.test(t) // 映画の未視聴ボタン（弱い未視聴の候補）
      || /\bresume\b/i.test(t)
      || /\bcontinue watching\b/i.test(t)
      || /\bwatch again\b/i.test(t)
      || /^play\s+(?:season\s+\d+\s+)?episode\s+\d+\b/i.test(t)
      || /^play\s+s\d+\s*:?\s*e\d+\b/i.test(t)
      || /\bwatch now\b/i.test(t)
      || /\bplay trailer\b/i.test(t)
      || /\bwatch trailer\b/i.test(t);
  }

  // Node 環境（テスト）からも使えるように公開
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeText, extractTitleId, classifyCta, looksLikeCta, isWatchNowText };
  }
  if (typeof document === 'undefined') return;

  // ---------- DOM ユーティリティ ----------

  // 表示文言（chrome.i18n）。ユニットテスト等の chrome が無い環境ではキー名を返す
  const msg = (key, subs) => {
    try {
      return (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage(key, subs)) || key;
    } catch (e) {
      return key;
    }
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.getClientRects) return false;
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  // 作品カードの一覧を返す [{id, title, href, el, poster}]
  function findCards() {
    const byId = new Map();
    const links = document.querySelectorAll('a[href*="/detail/"]');
    for (const link of links) {
      const id = extractTitleId(link.href);
      if (!id || byId.has(id)) continue;
      // ページ内の detail リンクを無条件に全部拾うと、宣伝バナーや
      // 非表示の埋め込み要素まで作品として数えてしまう（実例: Love Transit）。
      // 実物のカードだけに絞る: ページの chrome 内は除き、ポスター画像があり、
      // 実際に表示されている要素だけをカードとする。
      if (link.closest('header, nav, footer')) continue;
      const container = findCardContainer(link);
      if (!container) continue;
      const img = container.querySelector('img');
      if (!img) continue;
      if (!isVisible(container)) continue;
      const title =
        normalizeText(link.getAttribute('aria-label')) ||
        normalizeText(img && img.alt) ||
        normalizeText(link.textContent) ||
        normalizeText(container.querySelector('[data-testid*="title" i], h2, h3')?.textContent) ||
        msg('titleUnknown');
      byId.set(id, {
        id,
        title,
        href: 'https://www.amazon.co.jp/gp/video/detail/' + id,
        el: container,
        poster: img ? img.src : '',
      });
    }
    return [...byId.values()];
  }

  // 詳細リンクから「カード全体」と思われる要素まで遡る。
  // 別の作品のリンクを含むようになったら行き過ぎなので、その手前で止める。
  function findCardContainer(link) {
    let candidate = link;
    let el = link;
    for (let depth = 0; depth < 9 && el.parentElement; depth++) {
      const parent = el.parentElement;
      const ids = new Set();
      for (const a of parent.querySelectorAll('a[href*="/detail/"]')) {
        const id = extractTitleId(a.href);
        if (id) ids.add(id);
      }
      if (ids.size > 1) break;
      el = parent;
      const hasImg = !!el.querySelector('img');
      const rect = el.getBoundingClientRect();
      if (hasImg && rect.height > 40) candidate = el;
      if (rect.height > 560 || rect.width > 720) break;
    }
    return candidate;
  }

  function dispatchHover(target, enter) {
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const cx = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const cy = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, view: window };
    const types = enter
      ? ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove', 'pointermove']
      : ['pointerout', 'pointerleave', 'mouseout', 'mouseleave'];
    for (const type of types) {
      try {
        const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
        target.dispatchEvent(new Ctor(type, opts));
      } catch (e) { /* noop */ }
    }
  }

  // CTAテキストを持つ要素を探す。
  // 「予告編を再生」のような別ボタンに誤爆しないよう、エピソード判定できる文言
  // （続きを観る／エピソード○を再生）を最優先し、その中では一番短い＝深い要素を選ぶ。
  // 映画の「再生」/ "Play"（弱い未視聴）は、強い文言が1つも無い場合にだけ使う。
  // ただし「今すぐ観る」等の判定不能な本命ボタンがある場合は弱い文言を捨てる
  // （予告編だけは本命ではないので、弱い文言をブロックしない）。
  function findCtaElements(root) {
    if (!root) return [];
    // 「第1話無料」の目印が探索範囲（ホバーカード等）の中にあるか。
    // ページ全体（body）を範囲にする場合は、別の作品の目印を拾わないよう無効にする。
    const rootText = normalizeText(root.textContent);
    const freeFirst = root !== document.body
      && (/第1話無料/.test(rootText.replace(/\s+/g, '')) || /first episode free/i.test(rootText));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const candidates = [];
    let node = root;
    const consider = (el) => {
      if (!el || el.id === PANEL_ID || el.closest?.('#' + PANEL_ID)) return;
      const t = normalizeText(el.textContent);
      if (looksLikeCta(t) && el.children.length <= 3 && isVisible(el)) {
        let cls = classifyCta(t);
        // 第1話無料の目印がある文脈では、「今すぐ観る」は第1話からの再生＝未視聴
        if (cls.status === 'unknown' && freeFirst && isWatchNowText(t)) {
          cls = { status: 'unwatched', ctaText: t };
        }
        const priority = cls.weak ? 1 : (cls.status !== 'unknown' ? 0 : 2);
        candidates.push({ el, len: t.length, priority, cls, text: t });
      }
    };
    consider(root);
    while ((node = walker.nextNode())) consider(node);
    if (!candidates.length) return [];
    // 候補を内包する祖先要素は、内側の文言を拾っただけの可能性が高いので落とし、
    // 一番深い要素だけを候補に残す（文言が子要素に分かれている場合は祖先が残る）。
    const deepest = candidates.filter((c) => !candidates.some((o) => o !== c && c.el !== o.el && c.el.contains(o.el)));
    const isTrailer = (text) => /予告編/.test(text) || /\btrailer\b/i.test(text);
    const hasBlocker = deepest.some((c) => c.cls.status === 'unknown' && !isTrailer(c.text));
    const usable = hasBlocker ? deepest.filter((c) => !c.cls.weak) : deepest;
    usable.sort((a, b) => a.priority - b.priority || a.len - b.len);
    return usable;
  }

  function findCtaElement(root) {
    const list = findCtaElements(root);
    return list.length ? list[0].el : null;
  }

  // 最善の候補を {el, cls, text} ごと返す。判定には文脈（第1話無料の目印など）が
  // 効く場合があるので、要素だけを返して後から文言だけで再判定してはいけない。
  function findCtaCandidate(root) {
    const list = findCtaElements(root);
    return list.length ? list[0] : null;
  }

  function snapshotCtaElements() {
    // 要素→文言の対応で覚える。ポータルのボタン要素が作品ごとに再利用され、
    // 文言だけ差し替わる場合でも「変わった」と検出できるようにするため。
    const map = new Map();
    for (const c of findCtaElements(document.body)) map.set(c.el, c.text);
    return map;
  }

  // ホバー後にCTAを探す: 1) カード内 2) 同じ作品へのリンクを含むポータル
  // 2b) 作品リンクから遡って見つけるポータル 3) ホバー前から変わったCTA要素
  function findCtaFor(card, beforeMap) {
    // 1) カード内（ホバーでカード自体が展開するタイプ）
    let cand = findCtaCandidate(card.el);
    if (cand) return { el: cand.el, cls: cand.cls, where: 'card' };

    // 2) 同じ作品IDへのリンクを含む可視要素（body直下などにポータル表示されるタイプ）
    const candidates = document.querySelectorAll('body > div, body > section, [data-testid], [role="dialog"], [class*="hover" i], [class*="popover" i], [class*="Hover" i]');
    for (const candEl of candidates) {
      if (candEl.id === PANEL_ID || candEl.contains(card.el)) continue;
      const hasSame = [...candEl.querySelectorAll('a[href*="/detail/"]')].some((a) => extractTitleId(a.href) === card.id);
      if (!hasSame) continue;
      cand = findCtaCandidate(candEl);
      if (cand) return { el: cand.el, cls: cand.cls, where: 'portal' };
    }

    // 2b) ポータル内の作品リンクから外枠まで遡って探す。
    // ポータルがアプリのルート要素の中など 2) のセレクタに合わない場所に出る
    // 場合でも、リンクの作品IDで確実に結び付けられる（実例: 劇場版総集編など
    // 一部の作品だけポータルの出方が違い、ボタン未検出になっていた）。
    for (const a of document.querySelectorAll('a[href*="/detail/"]')) {
      if (extractTitleId(a.href) !== card.id) continue;
      if (card.el.contains(a) || (a.closest && a.closest('#' + PANEL_ID))) continue;
      let portal = a;
      for (let depth = 0; depth < 8 && portal.parentElement; depth++) {
        const parent = portal.parentElement;
        if (parent === document.body || parent.contains(card.el)) break;
        const ids = new Set();
        for (const x of parent.querySelectorAll('a[href*="/detail/"]')) {
          const xid = extractTitleId(x.href);
          if (xid) ids.add(xid);
        }
        if (ids.size > 1) break;
        portal = parent;
      }
      cand = findCtaCandidate(portal);
      if (cand) return { el: cand.el, cls: cand.cls, where: 'portal-link' };
    }

    // 3) ホバー前には無かったCTA要素、または文言が変わったCTA要素
    // （ポータルが使い回され、前の作品のボタン要素が残っている場合への対策。
    // 以前は「最善の1件」だけを見ていたため、残っていた要素に阻まれて
    // 新しいボタンを見つけられないことがあった）
    for (const c of findCtaElements(document.body)) {
      if (!beforeMap.has(c.el) || beforeMap.get(c.el) !== c.text) {
        return { el: c.el, cls: c.cls, where: 'new-element' };
      }
    }

    return null;
  }

  function findProgressHint(root) {
    if (!root) return null;
    const bar = root.querySelector('[role="progressbar"], [aria-valuenow], [class*="progress" i]');
    if (!bar) return null;
    const now = bar.getAttribute('aria-valuenow');
    const style = bar.getAttribute('style') || '';
    return normalizeText((now ? 'aria-valuenow=' + now + ' ' : '') + style).slice(0, 120) || null;
  }

  // ---------- パネル UI ----------

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) {
      panel.style.display = panelHidden ? 'none' : '';
      return panel;
    }
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="pv-toprow">
        <div class="pv-status">${msg('panelIdle')}</div>
        <button class="pv-close" type="button">×</button>
      </div>
      <div class="pv-actions">
        <button class="pv-cancel" type="button">${msg('panelCancel')}</button>
        <button class="pv-log" type="button" style="display:none">${msg('panelSaveLog')}</button>
      </div>
      <div class="pv-section pv-unwatched"><h4>${msg('headingUnwatched', ['0'])}</h4><ul></ul></div>
      <div class="pv-section pv-resume"><h4>${msg('headingResume', ['0'])}</h4><ul></ul></div>
      <div class="pv-section pv-unknown"><h4>${msg('headingUnknown', ['0'])}</h4><ul></ul></div>
      <div class="pv-brand">▶${msg('appName')}</div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('.pv-close').addEventListener('click', () => closePanel());
    panel.querySelector('.pv-cancel').addEventListener('click', () => { cancelRequested = true; });
    // 診断ログボタンは当面非表示（ユーザー要望）。保存機能自体は残してあり、必要になったら表示に戻す
    panel.querySelector('.pv-log').addEventListener('click', downloadDebugLog);
    setPanelRunning(false);
    panel.style.display = panelHidden ? 'none' : '';
    return panel;
  }

  // パネルを閉じる（隠す）。巡回中に閉じても巡回は裏で続き、結果はポップアップで見られる。
  // 次にチェックを始めるとまた表示される。
  function closePanel() {
    panelHidden = true;
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.display = 'none';
  }

  // パネル以外の場所をクリックしたら閉じる。本物のクリックだけを対象にし、
  // 巡回がカードへ送る合成イベント（isTrusted=false）では閉じない。
  document.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted) return;
    if (!document.getElementById(PANEL_ID)) return;
    if (e.target && e.target.closest && e.target.closest('#' + PANEL_ID)) return;
    closePanel();
  }, true);

  // 巡回中だけボタン行（中止ボタン）を出す。終わったら行ごと消して情報を上に詰める
  function setPanelRunning(running) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const actions = panel.querySelector('.pv-actions');
    const cancel = panel.querySelector('.pv-cancel');
    if (actions) actions.style.display = running ? 'flex' : 'none';
    if (cancel) cancel.style.display = running ? '' : 'none';
  }

  function setStatus(text) {
    const panel = ensurePanel();
    panel.querySelector('.pv-status').textContent = text;
  }

  function renderResults() {
    const panel = ensurePanel();
    const groups = { unwatched: [], resume: [], unknown: [] };
    for (const r of scanResults) (groups[r.status] || groups.unknown).push(r);
    const fill = (cls, headingKey, items, fmt) => {
      const sec = panel.querySelector(cls);
      sec.querySelector('h4').textContent = msg(headingKey, [String(items.length)]);
      const ul = sec.querySelector('ul');
      ul.innerHTML = '';
      for (const r of items) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = r.href;
        // 同じタブで作品ページへ遷移する（新しいタブは開かない）。選択したらパネルも閉じる
        a.addEventListener('click', () => closePanel());
        a.textContent = r.title;
        li.appendChild(a);
        const span = document.createElement('span');
        span.className = 'pv-cta';
        span.textContent = fmt(r);
        li.appendChild(span);
        ul.appendChild(li);
      }
    };
    fill('.pv-unwatched', 'headingUnwatched', groups.unwatched, (r) => r.ctaText);
    fill('.pv-resume', 'headingResume', groups.resume, (r) => r.ctaText);
    fill('.pv-unknown', 'headingUnknown', groups.unknown, (r) => (r.ctaText ? msg('panelButtonPrefix', [r.ctaText]) : msg('ctaNotFound')));
  }

  function downloadDebugLog() {
    const payload = {
      generatedAt: new Date().toISOString(),
      url: location.href,
      userAgent: navigator.userAgent,
      results: scanResults,
      debug: debugLog,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pv-checker-debug.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function saveState(extra) {
    try {
      await chrome.storage.local.set(Object.assign({
        pvLastScan: { at: Date.now(), url: location.href, results: scanResults },
      }, extra || {}));
    } catch (e) { /* storage 不可でも巡回は続ける */ }
  }

  // ---------- 巡回本体 ----------

  async function checkCard(card) {
    const debug = { id: card.id, title: card.title, ctaText: '', foundIn: 'none', progressHint: null, snippet: '' };
    card.el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await wait(60);

    const before = snapshotCtaElements();
    const hoverTargets = [card.el.querySelector('img'), card.el.querySelector('a'), card.el].filter(Boolean);

    // ホバーに対するDOMの反応（ホバーカードの出現など）を数える。
    // 一定時間たっても何も起きなければ、その作品はホバー詳細を持たないと見切って
    // フルに待ち続けずに次へ進む（高速化）。自分自身のパネルの変化は数えない。
    let domReactions = 0;
    let lastReactionAt = 0;
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        const t = r.target;
        if (t && t.closest && t.closest('#' + PANEL_ID)) continue;
        domReactions++;
        lastReactionAt = Date.now();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });

    const hoverStartedAt = Date.now();
    for (const t of hoverTargets) dispatchHover(t, true);

    let found = null;
    try {
      const deadline = Date.now() + HOVER_WAIT_MS;
      while (Date.now() < deadline && !cancelRequested) {
        // React系のホバーはマウスが留まっている前提のことがあるので、時々 mousemove を足す
        dispatchHover(hoverTargets[0], true);
        const f = findCtaFor(card, before);
        if (f) {
          found = f;
          // 強い文言（エピソード系・Resume系）が見つかれば即確定する。
          // 弱い文言（映画の「再生」/ "Play" 単独）だけのうちは確定しない:
          // 初回スキャンなど描画が遅い状況では、本命ボタン（Resume等）が後から
          // 描画されるのに先に弱い文言で確定してしまう誤判定が起きるため、
          // DOMが落ち着くまで弱い文言は保留して待ち続ける（v1.2.1）。
          // 判定は探索時の文脈込みの結果（f.cls）を使う（第1話無料の判定など）。
          if (!(f.cls || classifyCta(normalizeText(f.el.textContent))).weak) break;
        }
        const elapsed = Date.now() - hoverStartedAt;
        if (!found && domReactions === 0 && elapsed > NO_REACTION_MS) break;
        // ホバーカードは出たがボタンが無く、DOMの変化も止まったなら、
        // 最大時間まで待ち切らずに「ボタン無し」として次へ進む（高速化）。
        // 弱い文言だけが見つかっている場合は見切りを遅らせる。
        const weakOnly = found && (found.cls || classifyCta(normalizeText(found.el.textContent))).weak;
        const settleMin = weakOnly ? WEAK_SETTLE_MIN_MS : SETTLE_MIN_MS;
        if (domReactions > 0 && elapsed > settleMin && Date.now() - lastReactionAt > SETTLE_MS) break;
        await wait(HOVER_POLL_MS);
      }
    } finally {
      observer.disconnect();
    }
    debug.hoverWaitMs = Date.now() - hoverStartedAt;
    debug.domReactions = domReactions;

    let result;
    if (found) {
      const rawText = normalizeText(found.el.textContent);
      const cls = found.cls || classifyCta(rawText);
      const hoverRoot = found.el.closest('div,section,article') || found.el;
      debug.ctaText = rawText;
      debug.foundIn = found.where;
      debug.progressHint = findProgressHint(hoverRoot) || findProgressHint(card.el);
      debug.snippet = (hoverRoot.outerHTML || '').slice(0, 1500);
      result = { id: card.id, title: card.title, href: card.href, poster: card.poster, status: cls.status, ctaText: cls.ctaText || rawText };
    } else {
      debug.snippet = (card.el.outerHTML || '').slice(0, 1500);
      result = { id: card.id, title: card.title, href: card.href, poster: card.poster, status: 'unknown', ctaText: '' };
    }

    for (const t of hoverTargets) dispatchHover(t, false);
    debug.status = result.status;
    debugLog.push(debug);
    return result;
  }

  async function startScan() {
    if (scanning) return { ok: true, already: true };
    scanning = true;
    cancelRequested = false;
    panelHidden = false;
    scanResults = [];
    debugLog = [];
    ensurePanel();
    setPanelRunning(true);
    renderResults();
    await saveState({ pvScanState: { running: true, at: Date.now() } });

    try {
      if (/signin|ap\/signin/i.test(location.href)) {
        setStatus(msg('statusSignin'));
        return { ok: false, reason: 'signin' };
      }
      const processed = new Set();
      let stableRounds = 0;
      let rounds = 0;

      while (rounds < MAX_SCROLL_ROUNDS && stableRounds < STABLE_ROUNDS_TO_STOP && !cancelRequested) {
        rounds++;
        const cards = findCards().filter((c) => !processed.has(c.id));
        if (cards.length === 0) {
          stableRounds++;
        } else {
          stableRounds = 0;
          for (const card of cards) {
            if (cancelRequested) break;
            processed.add(card.id);
            setStatus(msg('statusScanning', [String(processed.size), card.title]));
            const r = await checkCard(card);
            scanResults.push(r);
            renderResults();
            await saveState();
            await wait(BETWEEN_CARDS_MS);
          }
        }
        window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
        await wait(SCROLL_WAIT_MS);
      }

      // 巡回で一番下までスクロールしているので、終わったら最上部に戻す
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });

      const unwatchedCount = scanResults.filter((r) => r.status === 'unwatched').length;
      if (cancelRequested) {
        setStatus(msg('statusCancelled', [String(scanResults.length), String(unwatchedCount)]));
      } else if (scanResults.length === 0) {
        setStatus(msg('statusNoCards'));
        debugLog.push({ pageHtmlSnippet: (document.body.outerHTML || '').slice(0, 4000) });
      } else {
        setStatus(msg('statusDone', [String(scanResults.length), String(unwatchedCount)]));
      }
      await saveState({ pvScanState: { running: false, at: Date.now() } });
      return { ok: true, count: scanResults.length };
    } finally {
      scanning = false;
      setPanelRunning(false);
    }
  }

  // ---------- 起動・連携 ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'pv-scan-start') {
      startScan().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg && msg.type === 'pv-scan-status') {
      sendResponse({ running: scanning, count: scanResults.length });
      return false;
    }
    return false;
  });

  // タブを新規に開いた直後など、pending フラグが立っていたら自動開始する。
  // 初期描画は固定で待たず、最初のカードが見えるまでポーリングして
  // 描画が終わり次第すぐ始める（速いときは速く、遅いときは待つ）。
  (async () => {
    try {
      const data = await chrome.storage.local.get('pvPendingScan');
      const pending = data.pvPendingScan;
      const pendingAt = typeof pending === 'number' ? pending : (pending && pending.at);
      if (pendingAt && Date.now() - pendingAt < 5 * 60 * 1000) {
        await chrome.storage.local.remove('pvPendingScan');
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline) {
          if (findCards().length > 0) break;
          await wait(200);
        }
        startScan();
      }
    } catch (e) { /* noop */ }
  })();
})();
