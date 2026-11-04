// ==UserScript==
// @name         Prime Video 未視聴ハイライト
// @namespace    https://github.com/mos-vrc/prime-video-watchlist-checker
// @version      1.0
// @description  amazon.co.jp の Prime Video ウォッチリストを開くと自動で巡回し、未視聴エピソードがある作品（と未視聴の映画）の周囲を水色にハイライトします。Chrome拡張「Amazon Prime Video 未視聴ウォッチリストチェッカー」の判定ロジック（ホバーボタンの文言で判定）をそのまま使った Tampermonkey 版です。前回結果が30分以内なら巡回せずハイライトだけ復元します。
// @match        https://www.amazon.co.jp/gp/video/mystuff/watchlist*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Chrome拡張版と両方を有効にしていると二重に巡回するので、どちらか片方だけ使ってください。
  // 判定ルール（拡張版と同じ）:
  //   「〜の続きを観る」/ "Resume" 系        -> 視聴済み側（ハイライトしない）
  //   「エピソード○を再生」/ "Play Episode ○" -> 未視聴あり（ハイライト）
  //   映画の「再生」/ "Play"（弱い未視聴）    -> 未視聴（ハイライト）。強い文言が無い場合にだけ採用
  //   それ以外                                -> 判定不能（ハイライトしない）

  const PANEL_ID = 'pvhl-chip';
  const HL_CLASS = 'pv-hl-unwatched';
  const STORE_KEY = 'pvhl:lastScan';
  const FRESH_MS = 30 * 60 * 1000; // この時間内なら前回結果のハイライト表示だけにして自動巡回しない

  let scanning = false;
  let cancelRequested = false;
  let scanResults = [];

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const msg = (key) => (key === 'titleUnknown' ? 'タイトル不明' : key);

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
  function findCtaElement(root) {
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const candidates = [];
    let node = root;
    const consider = (el) => {
      if (!el || el.id === PANEL_ID || el.closest?.('#' + PANEL_ID)) return;
      const t = normalizeText(el.textContent);
      if (looksLikeCta(t) && el.children.length <= 3 && isVisible(el)) {
        const cls = classifyCta(t);
        const priority = cls.weak ? 1 : (cls.status !== 'unknown' ? 0 : 2);
        candidates.push({ el, len: t.length, priority, cls, text: t });
      }
    };
    consider(root);
    while ((node = walker.nextNode())) consider(node);
    if (!candidates.length) return null;
    const isTrailer = (text) => /予告編/.test(text) || /\btrailer\b/i.test(text);
    const hasBlocker = candidates.some((c) => c.cls.status === 'unknown' && !isTrailer(c.text));
    const usable = hasBlocker ? candidates.filter((c) => !c.cls.weak) : candidates;
    if (!usable.length) return null;
    usable.sort((a, b) => a.priority - b.priority || a.len - b.len);
    return usable[0].el;
  }

  function snapshotCtaElements() {
    const set = new Set();
    const el = findCtaElement(document.body);
    if (el) set.add(el);
    return set;
  }

  // ホバー後にCTAを探す: 1) カード内 2) 同じ作品へのリンクを含むポータル 3) 新しく現れた要素
  function findCtaFor(card, beforeSet) {
    // 1) カード内（ホバーでカード自体が展開するタイプ）
    let el = findCtaElement(card.el);
    if (el) return { el, where: 'card' };

    // 2) 同じ作品IDへのリンクを含む可視要素（body直下などにポータル表示されるタイプ）
    const candidates = document.querySelectorAll('body > div, body > section, [data-testid], [role="dialog"], [class*="hover" i], [class*="popover" i], [class*="Hover" i]');
    for (const cand of candidates) {
      if (cand.id === PANEL_ID || cand.contains(card.el)) continue;
      const hasSame = [...cand.querySelectorAll('a[href*="/detail/"]')].some((a) => extractTitleId(a.href) === card.id);
      if (!hasSame) continue;
      el = findCtaElement(cand);
      if (el) return { el, where: 'portal' };
    }

    // 3) ホバー前には無かったCTA要素（ポータルがリンクを持たないタイプ）
    el = findCtaElement(document.body);
    if (el && !beforeSet.has(el)) return { el, where: 'new-element' };

    return null;
  }

  // ---------- 保存（localStorage） ----------

  function loadLast() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveLast() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ at: Date.now(), results: scanResults })); } catch (e) { /* noop */ }
  }

  // ---------- ハイライト ----------

  function clearHighlights() {
    document.querySelectorAll('.' + HL_CLASS).forEach((el) => el.classList.remove(HL_CLASS));
  }

  // 前回結果のハイライトを復元する（ページ描画が遅れることがあるので少し再試行する）
  async function applyStoredHighlights() {
    const last = loadLast();
    if (!last) return;
    const wanted = new Set((last.results || []).filter((r) => r.status === 'unwatched').map((r) => r.id));
    for (let i = 0; i < 12 && wanted.size > 0; i++) {
      if (scanning) return;
      for (const c of findCards()) {
        if (wanted.has(c.id)) { c.el.classList.add(HL_CLASS); wanted.delete(c.id); }
      }
      if (wanted.size > 0) await wait(500);
    }
  }

  // ---------- チップ UI（右上の小さい状態表示） ----------

  const style = document.createElement('style');
  style.textContent = `
    .${HL_CLASS} { outline: 3px solid #38bdf8 !important; outline-offset: 2px; box-shadow: 0 0 18px rgba(56, 189, 248, 0.6) !important; }
    #${PANEL_ID} { position: fixed; top: 0; right: 0; z-index: 2147483000; background: #0f171e; color: #fff; border: 1px solid #374550; border-top: none; border-right: none; border-radius: 0 0 0 10px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55); font-family: "Amazon Ember", "Hiragino Kaku Gothic ProN", sans-serif; font-size: 12px; padding: 8px 10px; display: flex; gap: 8px; align-items: center; max-width: 92vw; }
    #${PANEL_ID} .pvhl-text { color: #c7d5e0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #${PANEL_ID} button { background: #232f3e; color: #fff; border: 1px solid #4a5a68; border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 12px; white-space: nowrap; }
    #${PANEL_ID} button:hover { background: #31445a; }
  `;
  document.documentElement.appendChild(style);

  function ensureChip() {
    let chip = document.getElementById(PANEL_ID);
    if (chip) return chip;
    chip = document.createElement('div');
    chip.id = PANEL_ID;
    chip.innerHTML = `
      <span class="pvhl-text">…</span>
      <button class="pvhl-rerun" type="button">再チェック</button>
      <button class="pvhl-stop" type="button" style="display:none">中止</button>
      <button class="pvhl-close" type="button">×</button>
    `;
    document.body.appendChild(chip);
    chip.querySelector('.pvhl-rerun').addEventListener('click', () => runScan());
    chip.querySelector('.pvhl-stop').addEventListener('click', () => { cancelRequested = true; });
    chip.querySelector('.pvhl-close').addEventListener('click', () => chip.remove());
    return chip;
  }

  function setChipText(t) {
    const chip = ensureChip();
    chip.querySelector('.pvhl-text').textContent = t;
    chip.querySelector('.pvhl-stop').style.display = scanning ? '' : 'none';
    chip.querySelector('.pvhl-rerun').style.display = scanning ? 'none' : '';
  }

  // ---------- 巡回（拡張版 checkCard と同じ判定フロー） ----------

  async function checkCard(card) {
    card.el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await wait(60);

    const before = snapshotCtaElements();
    const hoverTargets = [card.el.querySelector('img'), card.el.querySelector('a'), card.el].filter(Boolean);

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
        dispatchHover(hoverTargets[0], true);
        const f = findCtaFor(card, before);
        if (f) {
          found = f;
          // 弱い文言（映画の「再生」/ "Play"）だけのうちは確定しない（拡張版 v1.2.1 と同じ）
          if (!classifyCta(normalizeText(f.el.textContent)).weak) break;
        }
        const elapsed = Date.now() - hoverStartedAt;
        if (!found && domReactions === 0 && elapsed > NO_REACTION_MS) break;
        const weakOnly = found && classifyCta(normalizeText(found.el.textContent)).weak;
        const settleMin = weakOnly ? WEAK_SETTLE_MIN_MS : SETTLE_MIN_MS;
        if (domReactions > 0 && elapsed > settleMin && Date.now() - lastReactionAt > SETTLE_MS) break;
        await wait(HOVER_POLL_MS);
      }
    } finally {
      observer.disconnect();
    }

    let result;
    if (found) {
      const rawText = normalizeText(found.el.textContent);
      const cls = classifyCta(rawText);
      result = { id: card.id, title: card.title, status: cls.status, ctaText: cls.ctaText || rawText };
    } else {
      result = { id: card.id, title: card.title, status: 'unknown', ctaText: '' };
    }
    for (const t of hoverTargets) dispatchHover(t, false);
    return result;
  }

  async function runScan() {
    if (scanning) return;
    scanning = true;
    cancelRequested = false;
    scanResults = [];
    clearHighlights();
    setChipText('チェック中…');
    try {
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
            setChipText(`チェック中… ${processed.size}件目: ${card.title}`);
            const r = await checkCard(card);
            scanResults.push(r);
            if (r.status === 'unwatched') card.el.classList.add(HL_CLASS);
            saveLast();
            await wait(BETWEEN_CARDS_MS);
          }
        }
        window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
        await wait(SCROLL_WAIT_MS);
      }
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      const n = scanResults.filter((r) => r.status === 'unwatched').length;
      setChipText(cancelRequested
        ? `中止しました（${scanResults.length}件チェック、未視聴あり ${n}件）`
        : `完了！ ${scanResults.length}件中、未視聴あり ${n}件`);
      saveLast();
    } finally {
      scanning = false;
      setChipText(document.querySelector('#' + PANEL_ID + ' .pvhl-text')?.textContent || '');
    }
  }

  // ---------- 起動: 開いたら自動でハイライト ----------

  (async () => {
    applyStoredHighlights(); // 前回分があれば先に付けておく（巡回結果で更新される）
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && findCards().length === 0) await wait(300);
    if (findCards().length === 0) return;
    const last = loadLast();
    if (last && Date.now() - last.at < FRESH_MS) {
      const n = (last.results || []).filter((r) => r.status === 'unwatched').length;
      const d = new Date(last.at);
      const hhmm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
      setChipText(`前回（${hhmm}）の結果: 未視聴あり ${n}件`);
      return;
    }
    runScan();
  })();
})();
