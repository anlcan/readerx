/* ReaderX — PDF/HTML reader + RSVP + bionic text + sentence nav + library */

const pdfContainer  = document.getElementById('pdfContainer');
const paraText      = document.getElementById('paraText');
const rsvpWord      = document.getElementById('rsvpWord');
const rsvpStatus    = document.getElementById('rsvpStatus');
const paraCounter   = document.getElementById('paraCounter');
const paraProgress  = document.getElementById('paraProgress');
const statusEl      = document.getElementById('status');
const wpmSlider     = document.getElementById('wpm');
const wpmLabel      = document.getElementById('wpmLabel');
const playBtn       = document.getElementById('playBtn');
const prevBtn       = document.getElementById('prevPara');
const nextBtn       = document.getElementById('nextPara');
const fileInput     = document.getElementById('fileInput');
const urlInput      = document.getElementById('urlInput');
const urlLoadBtn    = document.getElementById('urlLoad');
const highlightBtn  = document.getElementById('highlightBtn');
const libraryBtn    = document.getElementById('libraryBtn');
const libraryModal  = document.getElementById('libraryModal');
const libraryList   = document.getElementById('libraryList');
const libraryClose  = document.getElementById('libraryCloseBtn');
const exportBtn     = document.getElementById('exportHighlightsBtn');
const lightbox      = document.getElementById('lightbox');
const lightboxContent = lightbox.querySelector('.lightbox-content');
const lightboxClose = lightbox.querySelector('.lightbox-close');

let doc = null;
let paragraphs = [];        // {text, pageNum?, words, sentences, overlay?, element?}
let currentPara = 0;
let currentWord = 0;
let playing = false;
let wpm = parseInt(wpmSlider.value, 10);
let timer = null;
let mode = 'pdf';           // 'pdf' | 'html'
let currentPaper = null;    // { id, title, source, url?, arxivId?, filename? }
let highlightSet = new Set(); // "paraIdx:sentIdx" for current paper

/* ==================== IndexedDB layer ==================== */

const DB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('readerx', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('papers')) {
          db.createObjectStore('papers', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('highlights')) {
          const s = db.createObjectStore('highlights', { keyPath: 'id', autoIncrement: true });
          s.createIndex('paperId', 'paperId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return dbp;
  }
  function tx(store, mode) {
    return open().then(db => db.transaction(store, mode).objectStore(store));
  }
  function req2p(request) {
    return new Promise((res, rej) => {
      request.onsuccess = () => res(request.result);
      request.onerror   = () => rej(request.error);
    });
  }
  return {
    async putPaper(paper)     { return req2p((await tx('papers','readwrite')).put(paper)); },
    async getPaper(id)        { return req2p((await tx('papers','readonly')).get(id)); },
    async listPapers()        { return req2p((await tx('papers','readonly')).getAll()); },
    async deletePaper(id)     {
      await req2p((await tx('papers','readwrite')).delete(id));
      // Also drop its highlights.
      const store = await tx('highlights','readwrite');
      const idx = store.index('paperId');
      const cursorReq = idx.openCursor(IDBKeyRange.only(id));
      return new Promise((res, rej) => {
        cursorReq.onsuccess = (e) => {
          const cur = e.target.result;
          if (cur) { cur.delete(); cur.continue(); } else res();
        };
        cursorReq.onerror = () => rej(cursorReq.error);
      });
    },
    async addHighlight(hl)    { return req2p((await tx('highlights','readwrite')).add(hl)); },
    async deleteHighlight(id) { return req2p((await tx('highlights','readwrite')).delete(id)); },
    async listHighlightsFor(paperId) {
      const store = await tx('highlights','readonly');
      const idx = store.index('paperId');
      return req2p(idx.getAll(IDBKeyRange.only(paperId)));
    },
    async listAllHighlights() { return req2p((await tx('highlights','readonly')).getAll()); },
  };
})();

/* ==================== paper identity ==================== */

function makePaperId(source) {
  if (source.arxivId) return `arxiv:${source.arxivId}`;
  if (source.url)     return `url:${source.url}`;
  if (source.filename) return `file:${source.filename}:${source.size || 0}:${source.lastModified || 0}`;
  return `unknown:${Date.now()}`;
}

async function registerPaper(meta) {
  currentPaper = { ...meta, id: meta.id || makePaperId(meta) };
  const existing = await DB.getPaper(currentPaper.id).catch(() => null);
  const now = Date.now();
  const record = {
    ...existing,
    ...currentPaper,
    addedAt:    existing?.addedAt || now,
    lastReadAt: now,
  };
  await DB.putPaper(record).catch(e => console.warn('putPaper failed', e));
  return record;
}

const savePosition = debounce(async () => {
  if (!currentPaper) return;
  const p = await DB.getPaper(currentPaper.id).catch(() => null);
  if (!p) return;
  await DB.putPaper({
    ...p,
    lastParaIdx: currentPara,
    lastWordIdx: currentWord,
    paraCount:   paragraphs.length,
    lastReadAt:  Date.now(),
  }).catch(e => console.warn('savePosition failed', e));
}, 400);

async function restorePosition() {
  if (!currentPaper) return;
  const rec = await DB.getPaper(currentPaper.id).catch(() => null);
  if (!rec || !paragraphs.length) return;
  const pi = Math.min(rec.lastParaIdx || 0, paragraphs.length - 1);
  const wi = Math.min(rec.lastWordIdx || 0, (paragraphs[pi]?.words.length || 1) - 1);
  if (pi > 0 || wi > 0) {
    setCurrentPara(pi, true);
    currentWord = wi;
    updateWordUI();
    if (paragraphs[pi]?.words[wi]) showRsvp(paragraphs[pi].words[wi]);
  }
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ==================== PDF loading ==================== */

async function loadPDF(src, meta) {
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

      const words = splitIntoWords(para.text);
      paragraphs.push({
        text: para.text,
        pageNum: p,
        words,
        sentences: detectSentences(words),
        overlay,
        pageDiv,
      });
    }
  }

  statusEl.textContent = `${doc.numPages} pages · ${paragraphs.length} paragraphs`;
  await registerPaper(meta || { source: 'url', url: typeof src === 'string' ? src : 'file' });
  await loadHighlightsForCurrent();
  if (paragraphs.length) setCurrentPara(0, false);
  else {
    paraText.textContent = '(no extractable text found in this PDF)';
    paraCounter.textContent = '0 / 0';
  }
  await restorePosition();
}

/* ==================== URL loading (arxiv HTML w/ PDF fallback) ==================== */

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
        await loadHtmlFromUrl(src, {
          source: 'arxiv-html', arxivId, url: src,
          title: `arxiv:${arxivId}`,
        });
        return;
      } catch (e) {
        console.warn('HTML load failed for', src, e);
      }
    }
    statusEl.textContent = 'HTML unavailable — falling back to PDF…';
    try {
      await loadPDF(`https://arxiv.org/pdf/${arxivId}`, {
        source: 'arxiv-pdf', arxivId, url: `https://arxiv.org/pdf/${arxivId}`,
        title: `arxiv:${arxivId} (PDF)`,
      });
    } catch (e) {
      statusEl.textContent = 'All arxiv sources failed (likely CORS). See console.';
    }
    return;
  }
  try {
    await loadPDF(url, { source: 'url', url, title: url });
  } catch (e) {
    statusEl.textContent = 'Failed to load: ' + e.message;
  }
}

async function loadHtmlFromUrl(url, meta) {
  const resp = await fetch(url, { redirect: 'follow', mode: 'cors' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  renderHtmlDocument(html, url);
  // Try to pick up the real paper title from the document.
  const t = new DOMParser().parseFromString(html, 'text/html');
  const title = t.querySelector('h1.ltx_title, h1.title, h1')?.textContent?.trim();
  await registerPaper({ ...meta, title: title || meta.title });
  await loadHighlightsForCurrent();
  await restorePosition();
}

function renderHtmlDocument(htmlText, baseUrl) {
  const parsed = new DOMParser().parseFromString(htmlText, 'text/html');
  // Safety: strip anything that could execute or pull in remote assets,
  // BUT keep <figure>, <img>, and <svg> — they are essential for papers.
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

  // Resolve relative URLs. Use base URL of the loaded doc.
  const base = new URL(baseUrl);
  wrapper.querySelectorAll('img[src]').forEach(img => {
    try { img.src = new URL(img.getAttribute('src'), base).href; } catch {}
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(img.cloneNode(true)));
  });
  // Also handle srcset if present.
  wrapper.querySelectorAll('img[srcset]').forEach(img => {
    const parts = img.getAttribute('srcset').split(',').map(p => {
      const [u, d] = p.trim().split(/\s+/);
      try { return `${new URL(u, base).href} ${d || ''}`.trim(); } catch { return p; }
    });
    img.srcset = parts.join(', ');
  });
  wrapper.querySelectorAll('svg').forEach(svg => {
    svg.addEventListener('click', () => openLightbox(svg.cloneNode(true)));
  });
  wrapper.querySelectorAll('a[href]').forEach(a => {
    try { a.href = new URL(a.getAttribute('href'), base).href; a.target = '_blank'; } catch {}
  });

  const paraSelectors = 'p, .ltx_p, li, h1, h2, h3, h4, blockquote';
  const skipInside    = '.ltx_bibliography, .ltx_biblist, .ltx_page_footer, footer, nav, .ltx_authors, .ltx_role_affiliation, figure, .ltx_figure, .ltx_caption, figcaption';

  wrapper.querySelectorAll(paraSelectors).forEach(el => {
    if (el.closest(skipInside)) return;
    const text = extractCleanText(el);
    if (!text || text.split(/\s+/).length < 3) return;
    const idx = paragraphs.length;
    el.dataset.paraIdx = idx;
    el.addEventListener('click', () => setCurrentPara(idx, false));
    const words = splitIntoWords(text);
    paragraphs.push({
      text,
      words,
      sentences: detectSentences(words),
      element: el,
    });
  });

  statusEl.textContent = `HTML · ${paragraphs.length} paragraphs · ${new URL(baseUrl).hostname}`;
  if (paragraphs.length) setCurrentPara(0, true);
  else paraText.textContent = '(no paragraphs found in HTML)';
}

function extractCleanText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll(
    'math, .ltx_Math, mjx-container, .MathJax, script, style, figure, .ltx_figure, figcaption, .ltx_caption'
  ).forEach(n => n.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

/* ==================== text grouping (PDF) ==================== */

function groupIntoParagraphs(items) {
  const lines = [];
  let cur = null;
  const flush = () => { if (cur) { lines.push(cur); cur = null; } };

  for (const it of items) {
    const str = it.str;
    const hasEOL = !!it.hasEOL;
    if (!str || !str.length) { if (hasEOL) flush(); continue; }
    const y = it.transform[5];
    const x = it.transform[4];
    const h = it.height || Math.abs(it.transform[3]) || 10;
    const w = it.width  || 0;

    if (!cur || Math.abs(cur.y - y) > h * 0.5) {
      flush();
      cur = { y, h, minX: x, maxX: x + w, text: str };
    } else {
      const sep = (cur.text.endsWith(' ') || str.startsWith(' ')) ? '' : ' ';
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

  const paras = [];
  let p = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!p) { p = startPara(line); continue; }
    const prev = lines[i - 1];
    const gap = prev.y - line.y;
    const lh  = Math.max(line.h, prev.h, 10);
    const indent = line.minX - prev.minX;
    const newPara = gap > lh * 1.7 || (gap > lh * 0.9 && indent > lh * 0.8);
    if (newPara) { paras.push(finalizePara(p)); p = startPara(line); }
    else {
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
  return { text: line.text.trim(), minX: line.minX, maxX: line.maxX, minY: line.y, maxY: line.y + line.h };
}
function finalizePara(p) {
  return { text: p.text.replace(/\s+/g, ' ').trim(), rect: [p.minX, p.minY, p.maxX, p.maxY] };
}

function stripCitations(text) {
  text = text.replace(/\s?\[\s*\d+(\s*[,;\-–—]\s*\d+)*\s*\]/g, '');
  text = text.replace(/\s?\([A-Z][^()]{0,80}\b(?:19|20)\d{2}[a-z]?\s*\)/g, '');
  text = text.replace(/[\u00B2\u00B3\u00B9\u2070-\u2079]+/g, '');
  return text;
}

function splitIntoWords(text) {
  text = stripCitations(text);
  text = text.replace(/(\w)-\s+(\w)/g, '$1$2');
  text = text.replace(/\s+([.,;:!?])/g, '$1');
  text = text.replace(/\s+/g, ' ').trim();
  const rough = text.split(' ').filter(Boolean);
  const out = [];
  for (const w of rough) {
    const parts = w.split(/(?<=\w[.!?)\]])(?=[A-Z"'([{])/);
    for (const p of parts) if (p) out.push(p);
  }
  return out;
}

/* ==================== sentence detection ==================== */

const ABBREVIATIONS = new Set([
  'Dr.','Mr.','Mrs.','Ms.','Prof.','Fig.','Figs.','Eq.','Eqs.','vs.','etc.',
  'e.g.','i.e.','cf.','al.','St.','Nr.','No.','Vol.','pp.','ca.','p.','ch.',
  'Sec.','Ref.','Refs.','Def.','Thm.','Lem.','Prop.','Cor.','Ave.','Jr.','Sr.',
  'Jan.','Feb.','Mar.','Apr.','Jun.','Jul.','Aug.','Sep.','Sept.','Oct.','Nov.','Dec.',
]);

function isAbbreviation(word) {
  if (ABBREVIATIONS.has(word)) return true;
  // Single-letter dotted abbreviations: "U." "A."
  if (/^[A-Za-z]\.$/.test(word)) return true;
  // Multi-letter dotted abbreviations: "U.S." "A.I." "Ph.D."
  if (/^([A-Za-z]\.){2,}$/.test(word)) return true;
  return false;
}

function detectSentences(words) {
  if (!words.length) return [];
  const sentences = [];
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    // Strip trailing closers to test the punctuation itself.
    if (!/[.!?][")\]'’]*$/.test(w)) continue;
    if (isAbbreviation(w)) continue;
    // A sentence ends here if there's no next word, or the next word starts
    // with a capital letter / opening quote / opening bracket / digit.
    if (!next || /^["'“‘([{]?[A-Z0-9]/.test(next)) {
      sentences.push({ start, end: i });
      start = i + 1;
    }
  }
  if (start < words.length) sentences.push({ start, end: words.length - 1 });
  return sentences;
}

function currentSentenceIdx(p, wordIdx) {
  if (!p?.sentences?.length) return 0;
  for (let i = 0; i < p.sentences.length; i++) {
    const s = p.sentences[i];
    if (wordIdx >= s.start && wordIdx <= s.end) return i;
  }
  return p.sentences.length - 1;
}

/* ==================== rendering ==================== */

function setCurrentPara(idx, scrollIntoView = true) {
  if (!paragraphs.length) return;
  idx = Math.max(0, Math.min(paragraphs.length - 1, idx));

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
  savePosition();

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
    // Map word to its sentence index.
    const sIdx = currentSentenceIdx(p, i);
    span.dataset.sent = sIdx;
    if (highlightSet.has(`${currentPara}:${sIdx}`)) {
      span.classList.add('sent-highlighted');
    }
    const { lead, b, r, tail } = bionicSplit(w);
    if (lead) span.appendChild(document.createTextNode(lead));
    if (b) { const bs = document.createElement('span'); bs.className = 'b'; bs.textContent = b; span.appendChild(bs); }
    if (r) { const rs = document.createElement('span'); rs.className = 'r'; rs.textContent = r; span.appendChild(rs); }
    if (tail) span.appendChild(document.createTextNode(tail));
    span.addEventListener('click', () => {
      currentWord = i; updateWordUI(); showRsvp(w); savePosition();
    });
    paraText.appendChild(span);
    paraText.appendChild(document.createTextNode(' '));
  });
}

function updateWordUI() {
  const p = paragraphs[currentPara];
  if (!p) return;
  const spans = paraText.querySelectorAll('.word');
  const sIdx = currentSentenceIdx(p, currentWord);
  spans.forEach((s, i) => {
    s.classList.toggle('current',      i === currentWord);
    s.classList.toggle('read',         i <  currentWord);
    s.classList.toggle('sent-current', parseInt(s.dataset.sent, 10) === sIdx);
  });
  paraProgress.textContent = `word ${Math.min(currentWord + 1, p.words.length)} / ${p.words.length}  ·  sent ${sIdx + 1}/${p.sentences.length}`;

  const cur = spans[currentWord];
  if (cur) {
    const r = cur.getBoundingClientRect();
    const pr = paraText.getBoundingClientRect();
    if (r.top < pr.top + 40 || r.bottom > pr.bottom - 40) {
      cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

/* ==================== RSVP ==================== */

function showRsvp(word) {
  const clean = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '') || word;
  const len = clean.length;
  let pivot;
  if (len <= 1)       pivot = 0;
  else if (len <= 5)  pivot = 1;
  else if (len <= 9)  pivot = 2;
  else if (len <= 13) pivot = 3;
  else                pivot = 4;

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
  rsvpWord.appendChild(preSpan);
  rsvpWord.appendChild(pivSpan);
  rsvpWord.appendChild(postSpan);
}

function wordDelay(word) {
  const base = 60000 / wpm;
  let mult = 1;
  if (word.length > 8)  mult *= 1.15;
  if (word.length > 12) mult *= 1.15;
  if (/[.!?]$/.test(word))       mult *= 1.8;
  else if (/[,;:]$/.test(word))  mult *= 1.35;
  return base * mult;
}

function tick() {
  if (!playing) return;
  const p = paragraphs[currentPara];
  if (!p) { stop(); return; }
  if (currentWord >= p.words.length) {
    if (currentPara >= paragraphs.length - 1) { stop(); return; }
    setCurrentPara(currentPara + 1, true);
  }
  const word = p.words[currentWord];
  showRsvp(word);
  updateWordUI();
  const delay = wordDelay(word);
  currentWord++;
  savePosition();
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

/* ==================== sentence navigation ==================== */

function jumpToSentenceStart() {
  const p = paragraphs[currentPara];
  if (!p) return;
  const s = p.sentences[currentSentenceIdx(p, currentWord)];
  currentWord = s.start;
  updateWordUI();
  showRsvp(p.words[currentWord]);
  savePosition();
}

function nextSentence() {
  const p = paragraphs[currentPara];
  if (!p) return;
  const sIdx = currentSentenceIdx(p, currentWord);
  if (sIdx + 1 < p.sentences.length) {
    currentWord = p.sentences[sIdx + 1].start;
    updateWordUI();
    showRsvp(p.words[currentWord]);
    savePosition();
  } else if (currentPara + 1 < paragraphs.length) {
    setCurrentPara(currentPara + 1, true);
  }
}

function prevSentence() {
  const p = paragraphs[currentPara];
  if (!p) return;
  const sIdx = currentSentenceIdx(p, currentWord);
  // If we're mid-sentence, first jump to its start.
  if (currentWord > p.sentences[sIdx].start) {
    currentWord = p.sentences[sIdx].start;
  } else if (sIdx > 0) {
    currentWord = p.sentences[sIdx - 1].start;
  } else if (currentPara > 0) {
    setCurrentPara(currentPara - 1, true);
    const prev = paragraphs[currentPara];
    if (prev.sentences.length) currentWord = prev.sentences[prev.sentences.length - 1].start;
    return;
  }
  updateWordUI();
  showRsvp(p.words[currentWord]);
  savePosition();
}

/* ==================== highlights ==================== */

async function toggleHighlight() {
  if (!currentPaper) return;
  const p = paragraphs[currentPara];
  if (!p?.sentences?.length) return;
  const sIdx = currentSentenceIdx(p, currentWord);
  const key = `${currentPara}:${sIdx}`;
  const s = p.sentences[sIdx];
  const text = p.words.slice(s.start, s.end + 1).join(' ');

  const all = await DB.listHighlightsFor(currentPaper.id);
  const existing = all.find(h => h.paraIdx === currentPara && h.sentenceIdx === sIdx);

  if (existing) {
    await DB.deleteHighlight(existing.id);
    highlightSet.delete(key);
    statusEl.textContent = 'Highlight removed';
  } else {
    await DB.addHighlight({
      paperId: currentPaper.id,
      paraIdx: currentPara,
      sentenceIdx: sIdx,
      text,
      addedAt: Date.now(),
    });
    highlightSet.add(key);
    statusEl.textContent = 'Highlighted ✎';
  }
  // Re-render current paragraph to reflect highlight class changes.
  renderParagraphText(p);
  updateWordUI();
}

async function loadHighlightsForCurrent() {
  highlightSet = new Set();
  if (!currentPaper) return;
  const all = await DB.listHighlightsFor(currentPaper.id).catch(() => []);
  for (const h of all) highlightSet.add(`${h.paraIdx}:${h.sentenceIdx}`);
}

/* ==================== library UI ==================== */

async function openLibrary() {
  const papers = await DB.listPapers();
  papers.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
  libraryList.innerHTML = '';
  if (!papers.length) {
    libraryList.innerHTML = '<div class="library-empty">No papers saved yet. Load a PDF or arxiv URL to start.</div>';
  } else {
    for (const p of papers) {
      const hlCount = (await DB.listHighlightsFor(p.id).catch(() => [])).length;
      const item = document.createElement('div');
      item.className = 'library-item' + (currentPaper?.id === p.id ? ' current' : '');
      const progress = p.paraCount
        ? Math.round(100 * (p.lastParaIdx || 0) / Math.max(1, p.paraCount - 1)) + '%'
        : '–';
      const when = p.lastReadAt ? new Date(p.lastReadAt).toLocaleString() : '';
      item.innerHTML = `
        <div class="library-item-main">
          <div class="library-item-title"></div>
          <div class="library-item-meta">${p.source} · ${progress} · ${hlCount} highlight${hlCount === 1 ? '' : 's'} · ${when}</div>
        </div>
        <div class="library-item-actions">
          <button data-act="open">Open</button>
          <button data-act="del" class="danger">Delete</button>
        </div>
      `;
      item.querySelector('.library-item-title').textContent = p.title || p.id;
      item.querySelector('[data-act="open"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        closeLibrary();
        stop();
        await reopenPaper(p);
      });
      item.querySelector('[data-act="del"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove "${p.title || p.id}" and its highlights from your library?`)) return;
        await DB.deletePaper(p.id);
        openLibrary();
      });
      item.addEventListener('click', async () => { closeLibrary(); stop(); await reopenPaper(p); });
      libraryList.appendChild(item);
    }
  }
  libraryModal.classList.remove('hidden');
}

function closeLibrary() { libraryModal.classList.add('hidden'); }

async function reopenPaper(p) {
  if (p.source === 'arxiv-html' && p.url) {
    await loadHtmlFromUrl(p.url, p).catch(async () => {
      if (p.arxivId) await loadPDF(`https://arxiv.org/pdf/${p.arxivId}`, { ...p, source: 'arxiv-pdf' });
    });
  } else if (p.url) {
    await loadPDF(p.url, p);
  } else {
    statusEl.textContent = 'This paper was loaded from a local file. Re-upload it via "Load PDF".';
  }
}

async function exportHighlights() {
  const papers = await DB.listPapers();
  const byPaper = new Map(papers.map(p => [p.id, p]));
  const all = await DB.listAllHighlights();
  all.sort((a, b) => (a.paperId + '').localeCompare(b.paperId + '') || a.paraIdx - b.paraIdx || a.sentenceIdx - b.sentenceIdx);
  let md = `# ReaderX highlights\n\nExported ${new Date().toLocaleString()}\n\n`;
  let lastPaperId = null;
  for (const h of all) {
    if (h.paperId !== lastPaperId) {
      const p = byPaper.get(h.paperId);
      md += `\n## ${p?.title || h.paperId}\n\n`;
      if (p?.url) md += `${p.url}\n\n`;
      lastPaperId = h.paperId;
    }
    md += `- ${h.text}\n`;
  }
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `readerx-highlights-${Date.now()}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ==================== lightbox ==================== */

function openLightbox(node) {
  lightboxContent.innerHTML = '';
  lightboxContent.appendChild(node);
  lightbox.classList.remove('hidden');
}
function closeLightbox() { lightbox.classList.add('hidden'); lightboxContent.innerHTML = ''; }

/* ==================== events ==================== */

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
  try {
    await loadPDF({ data: buf }, {
      source: 'file', filename: f.name, size: f.size, lastModified: f.lastModified,
      title: f.name,
    });
  } catch {}
});

urlLoadBtn.addEventListener('click', () => { stop(); loadFromUrl(urlInput.value); });
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); stop(); loadFromUrl(urlInput.value); }
});

highlightBtn.addEventListener('click', () => toggleHighlight());
libraryBtn.addEventListener('click', () => openLibrary());
libraryClose.addEventListener('click', () => closeLibrary());
libraryModal.addEventListener('click', (e) => { if (e.target === libraryModal) closeLibrary(); });
exportBtn.addEventListener('click', () => exportHighlights());
lightboxClose.addEventListener('click', () => closeLightbox());
lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });

document.addEventListener('keydown', e => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

  // Modals absorb Escape.
  if (e.code === 'Escape') {
    if (!lightbox.classList.contains('hidden'))   { closeLightbox(); return; }
    if (!libraryModal.classList.contains('hidden')) { closeLibrary(); return; }
  }

  const p = paragraphs[currentPara];

  // Sentence-level shortcuts (Shift + arrows / Home / s)
  if (e.shiftKey && e.code === 'ArrowRight') { e.preventDefault(); stop(); nextSentence(); return; }
  if (e.shiftKey && e.code === 'ArrowLeft')  { e.preventDefault(); stop(); prevSentence(); return; }
  if (e.code === 'Home' || (e.key === 's' && !e.metaKey && !e.ctrlKey)) {
    e.preventDefault(); stop(); jumpToSentenceStart(); return;
  }
  if (e.key === 'h' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); toggleHighlight(); return; }
  if (e.key === 'l' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); openLibrary();   return; }

  if (e.code === 'Space')            { e.preventDefault(); playing ? stop() : play(); }
  else if (e.code === 'ArrowRight')  { stop(); setCurrentPara(currentPara + 1, true); }
  else if (e.code === 'ArrowLeft')   { stop(); setCurrentPara(currentPara - 1, true); }
  else if (e.code === 'ArrowDown')   {
    stop();
    if (!p) return;
    currentWord = Math.min(currentWord + 1, p.words.length - 1);
    updateWordUI(); showRsvp(p.words[currentWord]); savePosition();
  }
  else if (e.code === 'ArrowUp')     {
    stop();
    if (!p) return;
    currentWord = Math.max(currentWord - 1, 0);
    updateWordUI(); showRsvp(p.words[currentWord]); savePosition();
  }
});

/* ==================== bootstrap ==================== */

// Default: Rayner et al. 2016, "So Much to Read, So Little Time — How Do We
// Read, and Can Speed Reading Help?" — the definitive review showing that
// RSVP-based speed reading is *faster* but degrades comprehension.
loadPDF('rsvp-comprehension.pdf', {
  id: 'default:rsvp-comprehension',
  source: 'bundled',
  filename: 'rsvp-comprehension.pdf',
  title: 'Rayner et al. 2016 — So Much to Read, So Little Time',
}).catch(() => loadPDF('sample.pdf', {
  id: 'default:sample',
  source: 'bundled',
  filename: 'sample.pdf',
  title: 'Sample',
}));
