const { app, BrowserWindow, ipcMain, shell, Notification, dialog } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const QRCode = require('qrcode');

// پوشه نصب نرم‌افزار؛ اگر قابل نوشتن نبود (مثلا Program Files) از پوشه داده‌های کاربر استفاده می‌شود
function baseDir() {
  const c = app.isPackaged ? path.dirname(process.execPath) : __dirname;
  try { fs.accessSync(c, fs.constants.W_OK); return c; } catch { return app.getPath('userData'); }
}
const BASE = baseDir();
const CUSTOMERS = path.join(BASE, 'Customers');
const CFG_FILE = path.join(BASE, 'config.json');
const DB_FILE = path.join(BASE, 'orders.json');
fs.mkdirSync(CUSTOMERS, { recursive: true });

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
let cfg = { hostUrl: '', apiKey: '', bg: 'auto', theme: 'system', printSize: 'a5', ...readJSON(CFG_FILE, {}) };
let orders = readJSON(DB_FILE, []);
const saveCfg = () => fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
const saveDB = () => fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 1));
const safe = s => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 60) || 'بدون_نام';
let win, status = { ok: false, msg: 'هنوز تنظیم نشده' }, busy = false;
const seen = new Set(orders.map(o => o.id));

function uniquePath(dir, name) {
  let p = path.join(dir, name), n = 2; const ext = path.extname(name), b = path.basename(name, ext);
  while (fs.existsSync(p)) p = path.join(dir, `${b} (${n++})${ext}`);
  return p;
}
const api = (a, q = '') => `${cfg.hostUrl.replace(/\/+$/, '')}/api.php?a=${a}&key=${encodeURIComponent(cfg.apiKey)}${q}`;
const setStatus = (ok, msg) => { status = { ok, msg, time: new Date().toISOString() }; win && win.webContents.send('status', status); };

// تاریخ شمسی به‌صورت 1405-08-14 (برای نام پوشه روز)
function jday(d = new Date()) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d).map(x => [x.type, x.value]));
    if (/^1[34]\d\d$/.test(p.year)) return `${p.year}-${p.month}-${p.day}`;
  } catch {}
  return d.toISOString().slice(0, 10);
}
const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'svg'];
const extOf = f => path.extname(f).slice(1).toLowerCase();

async function receive(o) {
  const day = jday(), dayDir = path.join(CUSTOMERS, day), base = safe(o.name);
  let dir = path.join(dayDir, base), k = 2;
  while (fs.existsSync(dir)) dir = path.join(dayDir, `${base} (${k++})`);   // یک مشتری چند بار در یک روز
  fs.mkdirSync(dir, { recursive: true });
  const files = [], originals = {};
  let next = 0;
  const worker = async () => {                       // دانلود هم‌زمان چند فایل برای سرعت بیشتر
    while (next < o.files.length) {
      const f = o.files[next++];
      const mm = /^(\d+)__(.*)$/.exec(f.file), num = mm ? +mm[1] + 1 : next, orig = mm ? mm[2] : f.file;
      const r = await fetch(api('get', `&id=${o.id}&file=${encodeURIComponent(f.file)}`));
      if (!r.ok) throw new Error('دانلود ناموفق: ' + f.file);
      const name = `${num}${path.extname(orig).toLowerCase()}`;          // نام فایل = شماره انتخاب مشتری
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(path.join(dir, name)));
      files.push(name); originals[name] = orig;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, o.files.length) }, worker));
  files.sort((a, b) => parseInt(a) - parseInt(b));
  const fullKeys = Object.keys(o.full || {});
  const rec = { ...o, day, dir, files, originals, fileCount: files.length, time: new Date().toISOString(), opened: false,
    fullPending: fullKeys.length, fullDone: [], fullMap: o.full || {}, fullLost: false };
  fs.writeFileSync(path.join(dir, 'info.txt'),
    `نام: ${o.name}\nشماره: ${o.phone || '-'}\nتعداد برگ: ${o.sheets}\nنوع چاپ: ${o.duplex === 'double' ? 'پشت‌و‌رو' : 'تک‌رو'}\nرنگ: ${o.color === 'bw' ? 'سیاه و سفید' : 'رنگی'}\n` +
    `تعداد فایل: ${rec.fileCount}\nعکس‌ها: ${o.images}\nصفحات: ${o.pages}\nحجم: ${o.size} بایت\nتوضیحات: ${o.note || '-'}\n\nفایل‌ها:\n` +
    files.map(f => `${f}  <-  ${originals[f]}`).join('\n') + '\n');
  await fetch(api('ack', `&id=${o.id}${fullKeys.length ? '&s=1' : ''}`));   // فایل‌های بهینه رسید؛ اگر نسخه اصلی در راه باشد هنوز پاک نمی‌شود
  orders.unshift(rec); seen.add(o.id); saveDB();
  win && win.webContents.send('new-order', rec);
  if (!win || win.isMinimized() || !win.isVisible() || curPage !== 'sOrders') {   // برنامه مینیمایز است یا کاربر در صفحه سفارش‌ها نیست
    const n = new Notification({ title: 'مکسنت - سفارش جدید', body: `${o.name} فایل برای چاپ فرستاد (${rec.fileCount} فایل)`, icon: path.join(__dirname, 'build/icon.png') });
    n.on('click', () => { if (win) { win.show(); if (win.isMinimized()) win.restore(); win.focus(); win.webContents.send('goto', 'sOrders'); } });
    n.show();
  }
}

// ---- ساخت فایل docx (A4، حاشیه صفر، هر عکس یک برگ) بدون نیاز به Word یا کتابخانه
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zip(entries) {
  const parts = [], cen = []; let off = 0;
  for (const e of entries) {
    const nm = Buffer.from(e.name, 'utf8'), crc = crc32(e.data), sz = e.data.length;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x0800, 6); l.writeUInt16LE(0x21, 12);
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(sz, 18); l.writeUInt32LE(sz, 22); l.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(sz, 20); c.writeUInt32LE(sz, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    parts.push(l, nm, e.data); cen.push(c, nm); off += 30 + nm.length + sz;
  }
  const cd = Buffer.concat(cen), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const PAPER = { a3: [16838, 23811], a4: [11906, 16838], a5: [8391, 11906] };   // تویپ (twips)
function buildDocx(items, paper = 'a4') {   // items: [{w, h, buf(JPEG)}]
  const [TW, TH] = PAPER[paper] || PAPER.a4, PW = TW * 635, PH = TH * 635;   // اندازه کاغذ به EMU
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const paras = items.map((it, i) => {
    const k = Math.min(PW / it.w, PH / it.h), cx = Math.round(it.w * k), cy = Math.round(it.h * k);
    const x = Math.round((PW - cx) / 2), y = Math.round((PH - cy) / 2), n = i + 1;
    return `<w:p><w:pPr>${i ? '<w:pageBreakBefore/>' : ''}<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr><w:r><w:drawing>` +
      `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251658240 + n}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>` +
      `<wp:positionH relativeFrom="page"><wp:posOffset>${x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${y}</wp:posOffset></wp:positionV>` +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${n}" name="Picture ${n}"/><wp:cNvGraphicFramePr/>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.jpg"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="rId${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`;
  }).join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${paras}<w:sectPr><w:pgSz w:w="${TW}" w:h="${TH}"/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const rels = items.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.jpg"/>`).join('');
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', B = s => Buffer.from(s, 'utf8');
  return zip([
    { name: '[Content_Types].xml', data: B(`${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`) },
    { name: '_rels/.rels', data: B(`${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: 'word/document.xml', data: B(doc) },
    { name: 'word/_rels/document.xml.rels', data: B(`${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`) },
    ...items.map((it, i) => ({ name: `word/media/image${i + 1}.jpg`, data: it.buf }))
  ]);
}

// تبدیل هر عکس به JPEG استاندارد (چرخش EXIF اعمال می‌شود؛ webp و gif و bmp و svg هم پشتیبانی می‌شوند)
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff' };
let conv = null;
async function toJpeg(file) {
  if (!conv) { conv = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } }); await conv.loadFile(path.join(__dirname, 'app/blank.html')); }
  const b64 = fs.readFileSync(file).toString('base64'), mime = MIME[extOf(file)] || 'application/octet-stream';
  const r = await conv.webContents.executeJavaScript(`(async () => {
    const blob = await (await fetch('data:${mime};base64,${b64}')).blob();
    const img = new Image(); img.src = URL.createObjectURL(blob); await img.decode();
    const w0 = img.naturalWidth || 1000, h0 = img.naturalHeight || 1000, k = Math.min(1, 3508 / Math.max(w0, h0));
    const w = Math.round(w0 * k), h = Math.round(h0 * k);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0, w, h);
    const out = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.93));
    const buf = new Uint8Array(await out.arrayBuffer()); let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { w, h, data: btoa(s) };
  })()`);
  return { w: r.w, h: r.h, buf: Buffer.from(r.data, 'base64') };
}

// جایگزینی نسخه بهینه عکس‌ها با نسخه اصلی (کیفیت و حجم اصلی) وقتی به هاست رسید
let fullBusy = false, curPage = 'sOrders';
ipcMain.on('page', (_, p) => { curPage = p; });
async function fullSync(list) {
  const inList = new Map(list.map(o => [o.id, o]));
  for (const rec of orders) {
    if (!(rec.fullPending > 0)) continue;
    const o = inList.get(rec.id);
    if (!o) { rec.fullPending = 0; rec.fullLost = true; saveDB(); win && win.webContents.send('new-order', rec); continue; }
    for (const n of (o.full_ready || [])) {
      if (rec.fullDone.includes(n) || !rec.fullMap[n]) continue;
      try {
        const r = await fetch(api('getfull', `&id=${rec.id}&n=${n}`)); if (!r.ok) continue;
        const num = n + 1, newName = `${num}${path.extname(rec.fullMap[n].name).toLowerCase()}`, oldName = rec.files.find(f => parseInt(f) === num);
        const tmp = path.join(rec.dir, newName + '.part');
        await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
        if (oldName && oldName !== newName) fs.rmSync(path.join(rec.dir, oldName), { force: true });
        fs.renameSync(tmp, path.join(rec.dir, newName));
        rec.files = rec.files.map(f => parseInt(f) === num ? newName : f);
        rec.originals[newName] = rec.fullMap[n].name; rec.fullDone.push(n); rec.fullPending--; saveDB();
        win && win.webContents.send('new-order', rec);
      } catch (e) { /* فایل باز است یا قطعی شبکه؛ دور بعد دوباره تلاش می‌شود */ }
    }
    if (rec.fullPending === 0) await fetch(api('ack', `&id=${rec.id}`)).catch(() => {});
  }
}

async function poll() {
  if (busy || !cfg.hostUrl || !cfg.apiKey) return;
  busy = true;
  try {
    const r = await fetch(api('list'));
    if (r.status === 403) return setStatus(false, 'کلید API اشتباه است');
    if (!r.ok) return setStatus(false, 'پاسخ نامعتبر از هاست (' + r.status + ')');
    const { orders: list } = await r.json();
    for (const o of list) {
      if (!seen.has(o.id)) await receive(o);
      else { const rec = orders.find(x => x.id === o.id); if (!rec || !(rec.fullPending > 0)) fetch(api('ack', `&id=${o.id}`)).catch(() => {}); }
    }
    if (!fullBusy) { fullBusy = true; fullSync(list).catch(() => {}).finally(() => { fullBusy = false; }); }
    setStatus(true, 'متصل به هاست');
  } catch (e) { setStatus(false, 'عدم اتصال به هاست یا اینترنت'); }
  finally { busy = false; }
}
setInterval(poll, 2500);

ipcMain.handle('state', async () => ({
  cfg, orders, status, customersDir: CUSTOMERS, today: jday(),
  qr: cfg.hostUrl ? await QRCode.toDataURL(cfg.hostUrl, { width: 600, margin: 1, errorCorrectionLevel: 'M' }) : ''
}));
ipcMain.handle('save-cfg', (_, c) => {
  cfg = { ...cfg, hostUrl: c.hostUrl.trim(), apiKey: c.apiKey.trim() };
  if (cfg.hostUrl && !/^https?:\/\//i.test(cfg.hostUrl)) cfg.hostUrl = 'https://' + cfg.hostUrl;
  saveCfg(); poll(); return true;
});
async function wordFromImages(paths, paper, out) {
  const items = [], bad = [];
  for (const f of paths) { try { items.push(await toJpeg(f)); } catch (e) { bad.push(path.basename(f)); } }
  if (conv) { conv.destroy(); conv = null; }
  if (!items.length) return { ok: false, msg: 'هیچ‌کدام از عکس‌ها قابل خواندن نبود: ' + bad.join('، ') };
  const data = buildDocx(items, paper); let o2 = out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try { fs.writeFileSync(out, data); } catch { o2 = out.replace(/\.docx$/, `-${Date.now()}.docx`); fs.writeFileSync(o2, data); }
  const err = await shell.openPath(o2);       // با Word سیستم باز می‌شود
  if (err) return { ok: false, msg: 'فایل ساخته شد ولی باز نشد: ' + err + '\n' + o2 };
  return { ok: true, msg: bad.length ? 'این فایل‌ها قرار نگرفتند: ' + bad.join('، ') : '' };
}
ipcMain.handle('open-word', (_, id) => {
  const o = orders.find(x => x.id === id);
  const names = o ? o.files.filter(f => IMG_EXT.includes(extOf(f))).sort((a, b) => parseInt(a) - parseInt(b)) : [];
  if (!names.length) return { ok: false, msg: 'عکسی پیدا نشد.' };
  const paper = o.paper || 'a4';
  return wordFromImages(names.map(f => path.join(o.dir, f)), paper, path.join(o.dir, `photos-${paper.toUpperCase()}.docx`));
});
ipcMain.handle('open-file', async (_, id, name) => {
  const o = orders.find(x => x.id === id);
  if (!o || !o.files.includes(name)) return false;
  return !(await shell.openPath(path.join(o.dir, name)));
});
ipcMain.handle('open-pdf', async (_, id) => {
  const o = orders.find(x => x.id === id);
  const pdfs = o ? o.files.filter(f => extOf(f) === 'pdf') : [];
  if (!pdfs.length) return { ok: false, msg: 'PDF پیدا نشد.' };
  for (const f of pdfs) { const e = await shell.openPath(path.join(o.dir, f)); if (e) return { ok: false, msg: e }; }
  return { ok: true };
});
ipcMain.handle('pick-images', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'عکس', extensions: IMG_EXT }] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('word-from-files', (_, paths, paper) => {
  const ts = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
  return wordFromImages(paths, paper, path.join(CUSTOMERS, '_Manual', jday(), `photos-${String(paper).toUpperCase()}-${ts}.docx`));
});
ipcMain.handle('set-pref', (_, k, v) => { if (['bg', 'printSize', 'theme', 'navMini'].includes(k)) { cfg[k] = v; saveCfg(); } return true; });
ipcMain.handle('pick-bg', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'عکس', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
  if (r.canceled) return false;
  const dest = path.join(BASE, 'background' + path.extname(r.filePaths[0]).toLowerCase());
  fs.copyFileSync(r.filePaths[0], dest); cfg.bg = 'image'; cfg.bgFile = dest; saveCfg(); return true;
});
ipcMain.handle('mark-opened', (_, id) => { const o = orders.find(x => x.id === id); if (o && o.opened === false) { o.opened = true; saveDB(); } return true; });
ipcMain.handle('disconnect', () => { cfg.apiKey = ''; saveCfg(); setStatus(false, 'اتصال قطع شده است'); return true; });
ipcMain.handle('open-folder', (_, p) => shell.openPath(p || CUSTOMERS));
ipcMain.handle('print', (_, size, silent) => new Promise(r => win.webContents.print({ silent: !!silent, printBackground: true, pageSize: String(size || 'a5').toUpperCase(), margins: { marginType: 'none' } }, r)));

app.setAppUserModelId('ir.maxnet.app');
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
app.whenReady().then(() => {
  win = new BrowserWindow({ width: 1320, height: 860, minWidth: 980, minHeight: 640, title: 'مکسنت', icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  win.setMenuBarVisibility(false);
  win.loadFile('app/index.html');
  poll();
});
app.on('second-instance', () => { if (win) { win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
