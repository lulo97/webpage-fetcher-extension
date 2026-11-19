const $ = (id) => document.getElementById(id);
const setStatus = (t) => ($('status').textContent = t);

let currentTab = null;
let images = []; // {url, w, h, selected, el}

/* ---------- helpers ---------- */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Make any string a valid Windows 11 file name (without extension)
function sanitizeName(s, maxLen = 150) {
  let n = (s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.\s]+|[_.\s]+$/g, '')
    .slice(0, maxLen)
    .replace(/[_.\s]+$/g, '');
  if (!n) n = 'page';
  if (RESERVED.test(n.split('.')[0])) n = '_' + n;
  return n;
}

function urlToFilename(url) {
  return sanitizeName((url || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''));
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^(https?|file):/.test(tab.url || '')) return null;
  return tab;
}

/* ---------- destination folder ---------- */
const CFG_KEY = 'fetcherConfig';
const loadCfg = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (e) { return {}; } };
const saveCfg = (c) => localStorage.setItem(CFG_KEY, JSON.stringify(c));

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('fetcher', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => {
    const q = db.transaction('kv').objectStore('kv').get(k);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
async function idbSet(k, v) { // v === undefined deletes
  const db = await idb();
  return new Promise((res, rej) => {
    const st = db.transaction('kv', 'readwrite');
    const os = st.objectStore('kv');
    v === undefined ? os.delete(k) : os.put(v, k);
    st.oncomplete = res; st.onerror = () => rej(st.error);
  });
}

function renderDest() {
  $('destName').value = loadCfg().folderName || '';
  $('clearDir').disabled = !loadCfg().folderName;
}
renderDest();

$('pickDir').addEventListener('click', async () => {
  // popups close when a native dialog opens, so do the picking in a normal tab
  if (!new URLSearchParams(location.search).has('tab')) {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1') });
    return;
  }
  try {
    const h = await showDirectoryPicker({ id: 'fetcher', mode: 'readwrite' });
    await idbSet('dir', h);
    saveCfg({ folderName: h.name });
    renderDest();
    setStatus('Saved. You can close this tab and use the popup.');
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('Cannot use that folder: ' + e.message + ' (try a subfolder)');
  }
});

$('clearDir').addEventListener('click', async () => {
  await idbSet('dir', undefined);
  saveCfg({});
  renderDest();
  setStatus('Reset: using Chrome default download folder.');
});

// Call at the START of a click handler (needs user gesture for permission prompt)
async function getDestination() {
  if (!loadCfg().folderName) return null;
  try {
    const h = await idbGet('dir');
    if (!h) return null;
    let p = await h.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted') p = await h.requestPermission({ mode: 'readwrite' });
    if (p === 'granted') return h;
    setStatus('Folder permission denied, using Chrome default.');
  } catch (e) {}
  return null;
}

async function uniqueName(dir, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  let n = name, i = 2;
  while (true) {
    try { await dir.getFileHandle(n); n = `${base}_${i++}${ext}`; } // exists -> try next
    catch (e) { return n; }
  }
}

// returns the folder label actually used
async function saveBlob(blob, name, dir) {
  if (dir) {
    try {
      const finalName = await uniqueName(dir, name);
      const fh = await dir.getFileHandle(finalName, { create: true });
      const w = await fh.createWritable();
      await w.write(blob); await w.close();
      return { where: dir.name, name: finalName };
    } catch (e) {
      setStatus('Custom folder failed (' + e.message + '), using default.');
    }
  }
  download(blob, name);
  return { where: 'default Downloads', name };
}

/* ---------- in-page functions ---------- */
function pageGetText() {
  return { url: location.href, text: document.body ? document.body.innerText : '' };
}

function pageGetImages() {
  const map = new Map();
  const add = (u, w, h) => {
    if (!u) return;
    const prev = map.get(u);
    if (!prev || (!prev.w && w)) map.set(u, { url: u, w: w || 0, h: h || 0 });
  };
  document.querySelectorAll('img').forEach((img) => add(img.currentSrc || img.src, img.naturalWidth, img.naturalHeight));
  document.querySelectorAll('picture source[srcset]').forEach((s) => {
    const first = s.srcset.split(',')[0].trim().split(/\s+/)[0];
    try { if (first) add(new URL(first, location.href).href, 0, 0); } catch (e) {}
  });
  return [...map.values()];
}

/* ---------- mode switching ---------- */
document.querySelectorAll('input[name=mode]').forEach((r) =>
  r.addEventListener('change', () => {
    const m = document.querySelector('input[name=mode]:checked').value;
    $('textPanel').classList.toggle('hidden', m !== 'text');
    $('imagesPanel').classList.toggle('hidden', m !== 'images');
    setStatus('');
  })
);

(async () => {
  currentTab = await getTab();
  if (currentTab) $('filename').placeholder = urlToFilename(currentTab.url) + '.txt';
})();

/* ---------- TEXT MODE ---------- */
$('goText').addEventListener('click', async () => {
  $('goText').disabled = true;
  try {
    const dir = await getDestination();          // <-- first, keeps the user gesture
    const tab = await getTab();
    if (!tab) return setStatus('This page cannot be accessed (e.g. chrome:// pages).');
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageGetText });
    const custom = $('filename').value.trim().replace(/\.txt$/i, '');
    const name = (custom ? sanitizeName(custom) : urlToFilename(result.url)) + '.txt';
    const content = `${result.url}\n\n${result.text}`; // original URL kept untouched inside the file
    const r = await saveBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), name, dir);
    setStatus(`Done: saved ${r.name} to ${r.where}`);
  } catch (e) {
    setStatus('Error: ' + e.message);
  } finally {
    $('goText').disabled = false;
  }
});

/* ---------- IMAGES MODE ---------- */
function measure(url) {
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => resolve([0, 0]), 8000);
    img.onload = () => { clearTimeout(t); resolve([img.naturalWidth, img.naturalHeight]); };
    img.onerror = () => { clearTimeout(t); resolve([0, 0]); };
    img.src = url;
  });
}

function getLimits() {
  const min = parseInt($('minSize').value, 10);
  const max = parseInt($('maxSize').value, 10);
  return { min: isNaN(min) ? 0 : min, max: isNaN(max) ? Infinity : max };
}

function passesFilter(im, { min, max }) {
  if (!im.w || !im.h) return true; // unknown size: keep, can't judge
  return Math.min(im.w, im.h) >= min && Math.max(im.w, im.h) <= max;
}

function updateCount() {
  const lim = getLimits();
  const shown = images.filter((im) => passesFilter(im, lim));
  const sel = shown.filter((im) => im.selected).length;
  $('count').textContent = `${sel} selected / ${shown.length} shown (${images.length} found)`;
  $('goImages').disabled = sel === 0;
}

function applyFilter() {
  const lim = getLimits();
  images.forEach((im) => im.el.classList.toggle('hidden', !passesFilter(im, lim)));
  updateCount();
}

function renderGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  images.forEach((im) => {
    const el = document.createElement('div');
    el.className = 'item selected';
    el.title = im.url;
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true;
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const img = document.createElement('img');
    img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.src = im.url;
    thumb.appendChild(img);
    const dim = document.createElement('div');
    dim.className = 'dim';
    dim.textContent = im.w && im.h ? `${im.w}×${im.h}` : '? size';
    el.append(cb, thumb, dim);
    const toggle = (v) => { im.selected = v; cb.checked = v; el.classList.toggle('selected', v); updateCount(); };
    el.addEventListener('click', (e) => { if (e.target !== cb) toggle(!im.selected); });
    cb.addEventListener('change', () => toggle(cb.checked));
    im.el = el; im.toggle = toggle;
    grid.appendChild(el);
  });
  applyFilter();
}

$('preload').addEventListener('click', async () => {
  $('preload').disabled = true;
  try {
    const tab = await getTab();
    if (!tab) return setStatus('This page cannot be accessed (e.g. chrome:// pages).');
    currentTab = tab;
    setStatus('Finding images...');
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageGetImages });
    if (!result.length) { setStatus('No images found on this page.'); return; }
    setStatus(`Measuring ${result.length} images...`);
    await Promise.all(result.map(async (im) => {
      if (!im.w || !im.h) [im.w, im.h] = await measure(im.url);
    }));
    images = result.map((im) => ({ ...im, selected: true }));
    $('previewWrap').classList.remove('hidden');
    renderGrid();
    setStatus('Preloaded. Adjust min/max, untick images you don\'t need, then download.');
  } catch (e) {
    setStatus('Error: ' + e.message);
  } finally {
    $('preload').disabled = false;
  }
});

['minSize', 'maxSize'].forEach((id) => $(id).addEventListener('input', applyFilter));
$('selAll').addEventListener('click', () => { const l = getLimits(); images.filter((i) => passesFilter(i, l)).forEach((i) => i.toggle(true)); });
$('selNone').addEventListener('click', () => { const l = getLimits(); images.filter((i) => passesFilter(i, l)).forEach((i) => i.toggle(false)); });

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico'
};
function guessExt(url, mime) {
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  try { const m = new URL(url).pathname.match(/\.([a-zA-Z0-9]{2,5})$/); if (m) return m[1].toLowerCase(); } catch (e) {}
  return 'img';
}

// Build a valid, unique file name from an image URL (host + path + query), with a real extension
function imageFileName(url, ext, used) {
  let base;
  if (/^data:/i.test(url)) {
    base = 'data_image';
  } else {
    try {
      const u = new URL(url);
      let path = u.pathname.replace(/\.[a-zA-Z0-9]{2,5}$/, ''); // drop existing extension, we re-add it
      base = u.host + path + (u.search ? '_' + u.search.slice(1) : '');
    } catch (e) {
      base = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    }
  }
  base = sanitizeName(base, 120);
  let name = `${base}.${ext}`, n = 2;
  while (used.has(name.toLowerCase())) name = `${base}_${n++}.${ext}`;
  used.add(name.toLowerCase());
  return name;
}

$('goImages').addEventListener('click', async () => {
  $('goImages').disabled = true;
  try {
    const dir = await getDestination();   // before the long download loop
    const lim = getLimits();
    const chosen = images.filter((im) => im.selected && passesFilter(im, lim));
    if (!chosen.length) return setStatus('No images selected.');
    const zip = new JSZip();
    const folder = zip.folder('imgs');
    let ok = 0, fail = 0;
    const used = new Set();
    for (let i = 0; i < chosen.length; i++) {
      setStatus(`Downloading image ${i + 1}/${chosen.length}...`);
      try {
        const res = await fetch(chosen[i].url);
        if (!res.ok) throw new Error(res.status);
        const blob = await res.blob();
        ok++;
        folder.file(imageFileName(chosen[i].url, guessExt(chosen[i].url, blob.type), used), blob);
      } catch (e) { fail++; }
    }
    if (!ok) return setStatus('Could not download any images.');
    setStatus('Zipping...');
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const r = await saveBlob(zipBlob, urlToFilename(currentTab.url) + '_imgs.zip', dir);
    setStatus(`Done: ${ok} images saved to ${r.where}${fail ? `, ${fail} failed` : ''}.`);
  } catch (e) {
    setStatus('Error: ' + e.message);
  } finally {
    updateCount();
  }
});
