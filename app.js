/* ReaderX — PDF viewer + synchronized RSVP speed reader */

const pdfContainer = document.getElementById('pdfContainer');
const paraText     = document.getElementById('paraText');
const rsvpWord     = document.getElementById('rsvpWord');
const rsvpStatus   = document.getElementById('rsvpStatus');
const paraCounter  = document.getElementById('paraCounter');
const paraProgress = document.getElementById('paraProgress');
const statusEl     = document.getElementById('status');
const wpmSlider    = document.getElementById('wpm');
const wpmLabel     = document.getElementById('wpmLabel');
const playBtn      = document.getElementById('playBtn');
const prevBtn      = document.getElementById('prevPara');
const nextBtn      = document.getElementById('nextPara');
const fileInput    = document.getElementById('fileInput');
const urlInput     = document.getElementById('urlInput');
const urlLoadBtn   = document.getElementById('urlLoad');

let doc = null;
let paragraphs = [];        // {text, pageNum, words, overlay, pageDiv} or {text, words, element}
let currentPara = 0;
let currentWord = 0;
let playing = false;
let wpm = parseInt(wpmSlider.value, 10);
let timer = null;
let mode = 'pdf';           // 'pdf' | 'html'

/* ---------- PDF loading & layout ---------- */

async function loadPDF(src) {
  statusEl.textContent = 'Loading PDF…';
  try {
    const task = pdfjsLib.getDocument(src);
    doc = await task.promise;
  } catch (e) {
    statusEl.textContent = 'Failed to load PDF: ' + e.message;
    console.error(e);
    throw e;
  }

  mode = 'pdf';
  pdfContainer.className = '';
  pdfContainer.innerHTML = '';
  paragraphs = [];
  currentPara = 0;
  currentWord = 0;

  const dpr = window.devicePixelRatio || 1;
  const scale = 1.3;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale });

    const pageDiv = document.createElement('div');
    pageDiv.className = 'pdf-page';
    pageDiv.style.width  = viewport.width + 'px';
    pageDiv.style.height = viewport.height + 'px';
    pdfContainer.appendChild(pageDiv);

    const canvas = document.createElement('canvas');
    canvas.width  = Math.floor(viewport.width  * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width  = viewport.width  + 'px';
    canvas.style.height = viewport.height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    pageDiv.appendChild(canvas);

    await page.render({ canvasContext: ctx, viewport }).promise;

    const tc = await page.getTextContent();
    const paras = groupIntoParagraphs(tc.items);

    for (const para of paras) {
      const overlay = document.createElement('div');
      overlay.className = 'para-overlay';

      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(para.rect);
      const left   = Math.min(x1, x2);
      const top    = Math.min(y1, y2);
      const width  = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);
      overlay.style.left   = (left - 6) + 'px';
      overlay.style.top    = (top  - 3) + 'px';
      overlay.style.width  = (width  + 12) + 'px';
      overlay.style.height = (height + 6)  + 'px';
      pageDiv.appendChild(overlay);

      const idx = paragraphs.length;
      overlay.addEventListener('click', () => setCurrentPara(idx, true));

      paragraphs.push({
        text: para.text,
        pageNum: p,
        words: splitIntoWords(para.text),
        overlay,
        pageDiv,
      });
    }
  }

  statusEl.textContent = `${doc.numPages} pages · ${paragraphs.length} paragraphs`;
  if (paragraphs.length) setCurrentPara(0, false);
  else {
    paraText.textContent = '(no extractable text found in this PDF)';
    paraCounter.textContent = '0 / 0';
  }
}

/* ---------- URL loading: arxiv HTML with PDF fallback ---------- */

function parseArxivId(url) {
  const m = String(url).match(
    /arxiv\.org\/(?:abs|pdf|html|ftp\/arxiv\/papers\/\d+)\/([a-z\-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?/i
  );
  return m ? m[1] : null;
}

async function loadFromUrl(url) {
  url = (url || '').trim();
  if (!url) return;
  const arxivId = parseArxivId(url);
  if (arxivId) {
    const htmlSources = [
      `https://arxiv.org/html/${arxivId}`,
      `https://ar5iv.labs.arxiv.org/html/${arxivId}`,
    ];
    for (const src of htmlSources) {
      try {
        statusEl.textContent = `Trying HTML: ${new URL(src).hostname}…`;
        await loadHtmlFromUrl(src);
        return;
      } catch (e) {
        console.warn('HTML load failed for', src, e);
      }
    }
    statusEl.textContent = 'HTML unavailable — falling back to PDF…';
    try {
      await loadPDF(`https://arxiv.org/pdf/${arxivId}`);
    } catch (e) {
      statusEl.textContent = 'All arxiv sources failed (likely CORS). See console.';
    }
    return;
  }
  // Not arxiv — try as a plain PDF URL.
  try {
    await loadPDF(url);
  } catch (e) {
    statusEl.textContent = 'Failed to load: ' + e.message;
  }
}

async function loadHtmlFromUrl(url) {
  const resp = await fetch(url, { redirect: 'follow', mode: 'cors' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  renderHtmlDocument(html, url);
}

function renderHtmlDocument(htmlText, baseUrl) {
  const parsed = new DOMParser().parseFromString(htmlText, 'text/html');
  // Safety: strip anything that could execute or pull in remote assets.
  parsed.querySelectorAll(
    'script, link[rel="stylesheet"], iframe, object, embed, style'
  ).forEach(el => el.remove());

  const main =
    parsed.querySelector('article.ltx_document, article, main, [role="main"], .ltx_page_main') ||
    parsed.body;

  mode = 'html';
  pdfContainer.className = 'html-mode';
  pdfContainer.innerHTML = '';
  paragraphs = [];
  currentPara = 0;
  currentWord = 0;

  const wrapper = document.createElement('div');
  wrapper.className = 'html-doc';
  wrapper.innerHTML = main.innerHTML;
  pdfContainer.appendChild(wrapper);

  // Resolve relative URLs (mainly images) against the source URL.
  const base = new URL(baseUrl);
  wrapper.querySelectorAll('img[src]').forEach(img => {
    try { img.src = new URL(img.getAttribute('src'), base).href; } catch {}
  });
  wrapper.querySelectorAll('a[href]').forEach(a => {
    try { a.href = new URL(a.getAttribute('href'), base).href; a.target = '_blank'; } catch {}
  });

  const paraSelectors = 'p, .ltx_p, li, h1, h2, h3, h4, blockquote';
  const skipInside    = '.ltx_bibliography, .ltx_biblist, .ltx_page_footer, footer, nav, .ltx_authors, .ltx_role_affiliation';

  wrapper.querySelectorAll(paraSelectors).forEach(el => {
    if (el.closest(skipInside)) return;
    const text = extractCleanText(el);
    if (!text || text.split(/\s+/).length < 3) return;
    const idx = paragraphs.length;
    el.dataset.paraIdx = idx;
    el.addEventListener('click', () => setCurrentPara(idx, false));
    paragraphs.push({
      text,
      words: splitIntoWords(text),
      element: el,
    });
  });

  statusEl.textContent = `HTML · ${paragraphs.length} paragraphs · ${new URL(baseUrl).hostname}`;
  if (paragraphs.length) setCurrentPara(0, true);
  else paraText.textContent = '(no paragraphs found in HTML)';
}

function extractCleanText(el) {
  const clone = el.cloneNode(true);
  // Drop math (unreadable as speech), sup footnote markers, ref anchors.
  clone.querySelectorAll(
    'math, .ltx_Math, mjx-container, .MathJax, script, style'
  ).forEach(n => n.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

/* ---------- text grouping ---------- */

function groupIntoParagraphs(items) {
  // Build lines by y-baseline; respect explicit EOLs.
  const lines = [];
  let cur = null;

  const flush = () => { if (cur) { lines.push(cur); cur = null; } };

  for (const it of items) {
    const str = it.str;
    const hasEOL = !!it.hasEOL;
    if (!str || !str.length) {
      if (hasEOL) flush();
      continue;
    }
    const y = it.transform[5];
    const x = it.transform[4];
    const h = it.height || Math.abs(it.transform[3]) || 10;
    const w = it.width  || 0;

    if (!cur || Math.abs(cur.y - y) > h * 0.5) {
      flush();
      cur = { y, h, minX: x, maxX: x + w, text: str, };
    } else {
      const sep = (cur.text.endsWith(' ') || str.startsWith(' ')) ? '' : ' ';
      // If items are visually adjacent, don't add extra space
      cur.text += (cur.text.length && !cur.text.endsWith(' ') && !str.startsWith(' ') && (x - cur.maxX) < 1)
        ? str
        : sep + str;
      cur.minX = Math.min(cur.minX, x);
      cur.maxX = Math.max(cur.maxX, x + w);
      cur.h    = Math.max(cur.h, h);
    }
    if (hasEOL) flush();
  }
  flush();

  // Group lines into paragraphs based on vertical gap.
  const paras = [];
  let p = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!p) { p = startPara(line); continue; }
    const prev = lines[i - 1];
    const gap = prev.y - line.y;              // PDF y grows upward
    const lh  = Math.max(line.h, prev.h, 10);
    // New paragraph if line-gap larger than ~1.7x line height,
    // or if line starts noticeably to the right of previous (indent).
    const indent = line.minX - prev.minX;
    const newPara = gap > lh * 1.7 || (gap > lh * 0.9 && indent > lh * 0.8);
    if (newPara) { paras.push(finalizePara(p)); p = startPara(line); }
    else {
      // Detect end-of-line hyphenation: previous line ends with a hyphen
      // (ASCII '-', U+2010 '‐', U+00AD soft hyphen) preceded by a letter,
      // and the next line begins with a lowercase letter. Join without a
      // space and drop the hyphen so "oth-\ner" becomes "other".
      const nextText = line.text.trim();
      const hyphenated =
        /\p{L}[-\u2010\u00AD]$/u.test(p.text) && /^\p{Ll}/u.test(nextText);
      if (hyphenated) {
        p.text = p.text.replace(/[-\u2010\u00AD]$/u, '') + nextText;
      } else {
        p.text += ' ' + nextText;
      }
      p.minX = Math.min(p.minX, line.minX);
      p.maxX = Math.max(p.maxX, line.maxX);
      p.minY = Math.min(p.minY, line.y);
      p.maxY = Math.max(p.maxY, line.y + line.h);
    }
  }
  if (p) paras.push(finalizePara(p));

  return paras.filter(pp => pp.text.split(/\s+/).length >= 3);
}

function startPara(line) {
  return {
    text: line.text.trim(),
    minX: line.minX, maxX: line.maxX,
    minY: line.y,    maxY: line.y + line.h,
  };
}
function finalizePara(p) {
  return {
    text: p.text.replace(/\s+/g, ' ').trim(),
    rect: [p.minX, p.minY, p.maxX, p.maxY],
  };
}

function stripCitations(text) {
  // Numeric bracket citations: [12], [12, 15], [12,15], [12-15], [12–15],
  // [3; 7, 9], with optional leading space to consume as well.
  text = text.replace(/\s?\[\s*\d+(\s*[,;\-–—]\s*\d+)*\s*\]/g, '');
  // Author-year in parens: (Smith 2020), (Smith et al., 2020),
  // (Smith & Jones, 2020), (Smith 2020; Jones 2019).
  // Heuristic: parens that start with a capital-letter word and contain a
  // 4-digit year within 80 chars, no nested parens allowed.
  text = text.replace(/\s?\([A-Z][^()]{0,80}\b(?:19|20)\d{2}[a-z]?\s*\)/g, '');
  // Superscript-style numeric refs stuck to a word, e.g. "word^12" or "word¹²".
  text = text.replace(/[\u00B2\u00B3\u00B9\u2070-\u2079]+/g, '');
  return text;
}

function splitIntoWords(text) {
  // Strip citations before anything else so word timing isn't polluted.
  text = stripCitations(text);
  // Rejoin PDF soft-hyphenation: "hyphen-\nated" -> "hyphenated".
  text = text.replace(/(\w)-\s+(\w)/g, '$1$2');
  // Normalize whitespace (may have double spaces after citation removal).
  text = text.replace(/\s+([.,;:!?])/g, '$1');
  text = text.replace(/\s+/g, ' ').trim();

  const rough = text.split(' ').filter(Boolean);
  const out = [];
  for (const w of rough) {
    // Split glued sentences: "word.Next" -> ["word.", "Next"].
    // Keeps ".NET" or "e.g." intact by requiring a word char before the punct
    // and an uppercase / opening bracket after.
    const parts = w.split(/(?<=\w[.!?)\]])(?=[A-Z"'([{])/);
    for (const p of parts) if (p) out.push(p);
  }
  return out;
}

/* ---------- reading state ---------- */

function setCurrentPara(idx, scrollIntoView = true) {
  if (!paragraphs.length) return;
  idx = Math.max(0, Math.min(paragraphs.length - 1, idx));

  // Deactivate old highlight (either overlay or DOM element).
  const old = paragraphs[currentPara];
  if (old?.overlay) old.overlay.classList.remove('active');
  if (old?.element) old.element.classList.remove('para-active');

  currentPara = idx;
  currentWord = 0;
  const p = paragraphs[currentPara];

  if (p.overlay) p.overlay.classList.add('active');
  if (p.element) p.element.classList.add('para-active');

  renderParagraphText(p);
  paraCounter.textContent = mode === 'pdf'
    ? `Para ${idx + 1} / ${paragraphs.length}  ·  page ${p.pageNum}`
    : `Para ${idx + 1} / ${paragraphs.length}`;
  updateWordUI();

  if (scrollIntoView) {
    if (mode === 'pdf' && p.overlay) {
      const cRect = pdfContainer.getBoundingClientRect();
      const oRect = p.overlay.getBoundingClientRect();
      const delta = (oRect.top - cRect.top) - (cRect.height / 2 - oRect.height / 2);
      pdfContainer.scrollBy({ top: delta, behavior: 'smooth' });
    } else if (p.element) {
      p.element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

function bionicSplit(word) {
  // Split leading/trailing punctuation off so we bold only the letters.
  const m = word.match(/^([^A-Za-z0-9]*)([A-Za-z0-9\u00C0-\u024F'’\-]*)(.*)$/);
  const [_, lead, core, tail] = m;
  if (!core) return { lead: word, b: '', r: '', tail: '' };
  let n;
  const len = core.length;
  if (len <= 1)      n = 1;
  else if (len <= 3) n = 1;
  else if (len <= 5) n = 2;
  else if (len <= 8) n = Math.ceil(len * 0.45);
  else               n = Math.ceil(len * 0.4);
  return { lead, b: core.slice(0, n), r: core.slice(n), tail };
}

function renderParagraphText(p) {
  paraText.innerHTML = '';
  p.words.forEach((w, i) => {
    const span = document.createElement('span');
    span.className = 'word';
    span.dataset.i = i;
    const { lead, b, r, tail } = bionicSplit(w);
    if (lead) span.appendChild(document.createTextNode(lead));
    if (b) {
      const bs = document.createElement('span'); bs.className = 'b'; bs.textContent = b;
      span.appendChild(bs);
    }
    if (r) {
      const rs = document.createElement('span'); rs.className = 'r'; rs.textContent = r;
      span.appendChild(rs);
    }
    if (tail) span.appendChild(document.createTextNode(tail));
    span.addEventListener('click', () => { currentWord = i; updateWordUI(); showRsvp(w); });
    paraText.appendChild(span);
    paraText.appendChild(document.createTextNode(' '));
  });
}

function updateWordUI() {
  const p = paragraphs[currentPara];
  if (!p) return;
  const spans = paraText.querySelectorAll('.word');
  spans.forEach((s, i) => {
    s.classList.toggle('current', i === currentWord);
    s.classList.toggle('read',    i <  currentWord);
  });
  paraProgress.textContent = `word ${Math.min(currentWord + 1, p.words.length)} / ${p.words.length}`;

  // Scroll current word into view within the text pane.
  const cur = spans[currentWord];
  if (cur) {
    const r = cur.getBoundingClientRect();
    const pr = paraText.getBoundingClientRect();
    if (r.top < pr.top + 40 || r.bottom > pr.bottom - 40) {
      cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

/* ---------- RSVP ---------- */

function showRsvp(word) {
  // Compute ORP (optimal recognition point).
  const clean = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '') || word;
  const len = clean.length;
  // Standard Spritz-style ORP table (matches most public RSVP libraries).
  let pivot;
  if (len <= 1)       pivot = 0;
  else if (len <= 5)  pivot = 1;
  else if (len <= 9)  pivot = 2;
  else if (len <= 13) pivot = 3;
  else                pivot = 4;

  // Map pivot back onto the original word (accounting for leading punctuation).
  const leading = word.match(/^[^A-Za-z0-9]*/)[0].length;
  pivot += leading;
  pivot = Math.min(pivot, word.length - 1);

  const pre  = word.slice(0, pivot);
  const piv  = word.charAt(pivot);
  const post = word.slice(pivot + 1);

  rsvpWord.innerHTML = '';
  const preSpan  = document.createElement('span'); preSpan.className  = 'pre';   preSpan.textContent  = pre;
  const pivSpan  = document.createElement('span'); pivSpan.className  = 'pivot'; pivSpan.textContent  = piv;
  const postSpan = document.createElement('span'); postSpan.className = 'post';  postSpan.textContent = post;
  // 3-column grid (1fr auto 1fr) in CSS keeps the pivot column centered
  // regardless of pre/post length, so the pivot always lands on the guideline.
  rsvpWord.appendChild(preSpan);
  rsvpWord.appendChild(pivSpan);
  rsvpWord.appendChild(postSpan);
}

function wordDelay(word) {
  const base = 60000 / wpm;
  let mult = 1;
  if (word.length > 8) mult *= 1.15;
  if (word.length > 12) mult *= 1.15;
  if (/[.!?]$/.test(word)) mult *= 1.8;
  else if (/[,;:]$/.test(word)) mult *= 1.35;
  return base * mult;
}

function tick() {
  if (!playing) return;
  const p = paragraphs[currentPara];
  if (!p) { stop(); return; }
  if (currentWord >= p.words.length) {
    // move to next paragraph
    if (currentPara >= paragraphs.length - 1) { stop(); return; }
    setCurrentPara(currentPara + 1, true);
  }
  const word = p.words[currentWord];
  showRsvp(word);
  updateWordUI();
  const delay = wordDelay(word);
  currentWord++;
  timer = setTimeout(tick, delay);
}

function play() {
  if (playing || !paragraphs.length) return;
  playing = true;
  playBtn.textContent = '❚❚ Pause';
  rsvpStatus.textContent = `Playing · ${wpm} wpm`;
  const p = paragraphs[currentPara];
  if (currentWord >= p.words.length) {
    if (currentPara < paragraphs.length - 1) setCurrentPara(currentPara + 1, true);
    else currentWord = 0;
  }
  tick();
}

function stop() {
  playing = false;
  playBtn.textContent = '▶ Play';
  rsvpStatus.textContent = 'Paused';
  if (timer) { clearTimeout(timer); timer = null; }
}

/* ---------- events ---------- */

playBtn.addEventListener('click', () => playing ? stop() : play());
prevBtn.addEventListener('click', () => { stop(); setCurrentPara(currentPara - 1, true); });
nextBtn.addEventListener('click', () => { stop(); setCurrentPara(currentPara + 1, true); });
wpmSlider.addEventListener('input', e => {
  wpm = parseInt(e.target.value, 10);
  wpmLabel.textContent = wpm;
  if (playing) rsvpStatus.textContent = `Playing · ${wpm} wpm`;
});

fileInput.addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  stop();
  try { await loadPDF({ data: buf }); } catch {}
});

urlLoadBtn.addEventListener('click', () => { stop(); loadFromUrl(urlInput.value); });
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); stop(); loadFromUrl(urlInput.value); }
});

document.addEventListener('keydown', e => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.code === 'Space')       { e.preventDefault(); playing ? stop() : play(); }
  else if (e.code === 'ArrowRight') { stop(); setCurrentPara(currentPara + 1, true); }
  else if (e.code === 'ArrowLeft')  { stop(); setCurrentPara(currentPara - 1, true); }
  else if (e.code === 'ArrowDown')  { stop(); currentWord = Math.min(currentWord + 1, paragraphs[currentPara].words.length - 1); updateWordUI(); showRsvp(paragraphs[currentPara].words[currentWord]); }
  else if (e.code === 'ArrowUp')    { stop(); currentWord = Math.max(currentWord - 1, 0); updateWordUI(); showRsvp(paragraphs[currentPara].words[currentWord]); }
});

/* ---------- bootstrap ---------- */

// Default: Rayner et al. 2016, "So Much to Read, So Little Time — How Do We
// Read, and Can Speed Reading Help?" — the definitive review showing that
// RSVP-based speed reading is *faster* but degrades comprehension.
loadPDF('rsvp-comprehension.pdf').catch(() => loadPDF('sample.pdf'));
