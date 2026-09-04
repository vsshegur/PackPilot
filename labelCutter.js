import { db } from './firebase-config.js';
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { groupPdfTextLines, parseFlipkartProduct, parseMeeshoBarcode, parseMeeshoProduct } from './labelParser.js';
import { makeThermalLogo, readImageAsDataUrl } from './logoTools.js';
import { LABEL_FORMAT_OPTIONS, normalizeLabelFormats } from './labelFormats.js';
import { encodeCode128B } from './barcodeTools.js';

let lc_rawFiles = []; 
let lc_parsedData = []; 
let lc_customLogoBase64 = null; 
let currentPlatform = 'flipkart';
let lc_initialized = false;
let lc_cachedPdfBytes = null;
let lc_changeVersion = 0;
let lc_cachedVersion = -1;
let lc_logoReadyPromise = Promise.resolve();
let lc_lastProcessedAt = 0;
const DEFAULT_BRAND_LOGO_URL = './S_3.jpg';
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

function updateProgress(percent, statusText) {
    const pBar = document.getElementById('loaderProgressBar');
    const pText = document.getElementById('loaderPercent');
    const lText = document.getElementById('loaderText');
    if (pBar) pBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    if (pText) pText.textContent = `${Math.min(100, Math.max(0, Math.round(percent)))}%`;
    if (lText && statusText) lText.textContent = statusText;
}

function lc_invalidateOutput() {
    lc_cachedPdfBytes = null;
    lc_cachedVersion = -1;
    lc_changeVersion += 1;
}

function lc_outputFileName(platform, format, stamp = Date.now()) {
    const sizeName = format.includes('4x6') ? '4x6' : (format.includes('4x4') ? '4x4' : '3x5');
    const date = new Date(stamp).toISOString().slice(0, 10);
    return `PackPilot_${platform.toUpperCase()}_${sizeName}_${date}.pdf`;
}

async function lc_applyLogo(dataUrl, persist = true) {
    const thermalLogo = await makeThermalLogo(dataUrl);
    lc_customLogoBase64 = thermalLogo;
    document.getElementById('lc_logoPreview').src = thermalLogo;
    lc_invalidateOutput();
    if (persist) {
        const userId = window.appState.currentUser?.uid;
        window.appState.brandLogoBase64 = thermalLogo;
        try { localStorage.setItem(`savedBrandLogo:${userId || 'guest'}`, thermalLogo); } catch (error) { console.warn('Logo could not be cached.', error); }
        if (userId && db) {
            await setDoc(doc(db, 'users', userId, 'branding', 'memory'), {
                logoDataUrl: thermalLogo,
                updatedAt: Date.now()
            });
            window.appState.brandLogoPreferenceLoaded = true;
        }
        window.dispatchEvent(new CustomEvent('accountBrandLogoChanged', { detail: { dataUrl: thermalLogo } }));
    }
}

async function lc_loadDefaultLogo() {
    document.getElementById('lc_logoPreview').src = DEFAULT_BRAND_LOGO_URL;
    const response = await fetch(DEFAULT_BRAND_LOGO_URL);
    if (!response.ok) throw new Error('Default logo could not be loaded.');
    await lc_applyLogo(await readImageAsDataUrl(await response.blob()), false);
}

window.addEventListener('appUnlocked', () => {
    if (window.appState.role === 'operations_manager') return;
    if (!lc_initialized) {
        lc_setPlatform('flipkart');
        lc_initialized = true;
    }
    let cached = window.appState.brandLogoBase64 || null;
    const userId = window.appState.currentUser?.uid || 'guest';
    if (!window.appState.brandLogoPreferenceLoaded) {
        try { cached ||= localStorage.getItem(`savedBrandLogo:${userId}`); } catch (error) { console.warn('Logo cache is unavailable.', error); }
    }
    lc_logoReadyPromise = (cached && cached.startsWith('data:image'))
        ? lc_applyLogo(cached, false).catch(() => lc_loadDefaultLogo())
        : lc_loadDefaultLogo();
    lc_logoReadyPromise.catch(error => console.error('Logo initialization failed:', error));
    lc_loadRecoveredPdfs();
});

document.getElementById('lc_logoInput').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
      lc_logoReadyPromise = lc_applyLogo(await readImageAsDataUrl(file));
      await lc_logoReadyPromise;
  } catch (error) {
      console.error(error);
      alert(error.message);
  } finally {
      event.target.value = '';
  }
});

window.addEventListener('accountBrandLogoChanged', event => {
  const dataUrl = event.detail?.dataUrl;
  if (dataUrl === lc_customLogoBase64) return;
  lc_logoReadyPromise = dataUrl ? lc_applyLogo(dataUrl, false) : lc_loadDefaultLogo();
  lc_logoReadyPromise.catch(error => console.error('Logo update failed:', error));
});

window.addEventListener('labelFormatPreferencesChanged', event => {
  const formats = normalizeLabelFormats(event.detail);
  const preferredFormat = formats[currentPlatform];
  const select = document.getElementById('lc_printFormat');
  if (select && select.value !== preferredFormat) {
    select.value = preferredFormat;
    lc_invalidateOutput();
  }
});

document.getElementById('lc_tabFk').addEventListener('click', () => lc_setPlatform('flipkart'));
document.getElementById('lc_tabMs').addEventListener('click', () => lc_setPlatform('meesho'));

function lc_setPlatform(platform) {
  if (currentPlatform !== platform) lc_invalidateOutput();
  currentPlatform = platform; 
  document.getElementById('labelWorkspace').dataset.marketplace = platform;
  document.getElementById('lc_results').classList.add('hidden'); 
  lc_parsedData = [];
  const isFlipkart = platform === 'flipkart';
  const fkTab = document.getElementById('lc_tabFk');
  const msTab = document.getElementById('lc_tabMs');
  fkTab.classList.toggle('is-active', isFlipkart);
  msTab.classList.toggle('is-active', !isFlipkart);
  fkTab.setAttribute('aria-selected', String(isFlipkart));
  msTab.setAttribute('aria-selected', String(!isFlipkart));
  document.getElementById('lc_platformName').textContent = isFlipkart ? 'Flipkart' : 'Meesho';
  document.getElementById('lc_dropzone').dataset.platform = platform;

  const options = LABEL_FORMAT_OPTIONS[platform];
  const select = document.getElementById('lc_printFormat');
  select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  const preferredFormat = normalizeLabelFormats(window.appState.labelFormats)[platform];
  select.value = preferredFormat;
}

function lc_addFiles(fileList) {
  const files = Array.from(fileList).filter(file => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
  if (files.length === 0) {
    alert('Choose one or more PDF files.');
    return;
  }

  files.forEach(file => {
    const duplicate = lc_rawFiles.some(item => item.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified);
    if (!duplicate) {
      lc_rawFiles.push({ id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2), name: file.name, file });
    }
  });
  lc_parsedData = [];
  lc_invalidateOutput();
  document.getElementById('lc_results').classList.add('hidden');
  lc_updateUI();
}

document.getElementById('lc_pdfFileInput').addEventListener('change', event => {
  lc_addFiles(event.target.files);
  event.target.value = '';
});

const lc_dropzone = document.getElementById('lc_dropzone');
const lc_fileInput = document.getElementById('lc_pdfFileInput');
['dragenter', 'dragover'].forEach(eventName => {
  lc_dropzone.addEventListener(eventName, event => {
    event.preventDefault();
    lc_dropzone.classList.add('is-dragover');
  });
});
['dragleave', 'drop'].forEach(eventName => {
  lc_dropzone.addEventListener(eventName, event => {
    event.preventDefault();
    lc_dropzone.classList.remove('is-dragover');
  });
});
lc_dropzone.addEventListener('drop', event => lc_addFiles(event.dataTransfer.files));
lc_dropzone.addEventListener('click', event => {
  if (event.target === lc_fileInput) return;
  lc_fileInput.click();
});
lc_dropzone.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    document.getElementById('lc_pdfFileInput').click();
  }
});
lc_dropzone.setAttribute('tabindex', '0');
lc_dropzone.setAttribute('role', 'button');

window.lc_removeFile = function(id) {
  lc_rawFiles = lc_rawFiles.filter(f => f.id !== id);
  lc_parsedData = [];
  lc_invalidateOutput();
  document.getElementById('lc_results').classList.add('hidden');
  lc_updateUI();
};

function lc_updateUI() {
  const list = document.getElementById('lc_fileList'); 
  list.replaceChildren();
  document.getElementById('lc_fileCount').textContent = `${lc_rawFiles.length} ${lc_rawFiles.length === 1 ? 'file' : 'files'}`;
  if (lc_rawFiles.length > 0) {
      document.getElementById('lc_fileManager').classList.remove('hidden'); 
      document.getElementById('lc_processBtn').disabled = false; 
      document.getElementById('lc_processBtnText').textContent = `Process ${lc_rawFiles.length} ${lc_rawFiles.length === 1 ? 'file' : 'files'}`;
      lc_rawFiles.forEach(item => {
          const row = document.createElement('div');
          const icon = document.createElement('span');
          const copy = document.createElement('span');
          const name = document.createElement('strong');
          const size = document.createElement('small');
          const remove = document.createElement('button');
          row.className = 'file-item';
          icon.className = 'file-item__icon';
          icon.textContent = 'PDF';
          copy.className = 'file-item__copy';
          name.textContent = item.name;
          name.title = item.name;
          size.textContent = lc_formatBytes(item.file.size);
          copy.append(name, size);
          remove.type = 'button';
          remove.className = 'file-remove';
          remove.setAttribute('aria-label', `Remove ${item.name}`);
          remove.textContent = '×';
          remove.addEventListener('click', event => {
            event.stopPropagation();
            window.lc_removeFile(item.id);
          });
          row.append(icon, copy, remove);
          list.appendChild(row);
      });
  } else { 
      document.getElementById('lc_fileManager').classList.add('hidden'); 
      document.getElementById('lc_processBtn').disabled = true; 
      document.getElementById('lc_processBtnText').textContent = "Process Labels"; 
  }
}

function lc_formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

document.getElementById('lc_resetBtn').addEventListener('click', () => { 
    lc_rawFiles = []; 
    lc_parsedData = [];
    lc_invalidateOutput();
    document.getElementById('lc_pdfFileInput').value = ''; 
    document.getElementById('lc_results').classList.add('hidden');
    lc_updateUI(); 
});
document.getElementById('lc_clearFilesBtn').addEventListener('click', () => document.getElementById('lc_resetBtn').click());
document.getElementById('lc_printFormat').addEventListener('change', lc_invalidateOutput);
document.getElementById('lc_includeSummary').addEventListener('change', lc_invalidateOutput);

function lc_groupLines(items) {
  return groupPdfTextLines(items);
}

function lc_getBounds(lines, yStart, yEnd) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const l of lines){
    if (l.y < yStart || l.y > yEnd) continue;
    for (const it of l.items){ 
        if (!it.str.trim()) continue; 
        if (it.x < minX) minX = it.x; 
        if (it.x + it.width > maxX) maxX = it.x + it.width; 
        if (it.y < minY) minY = it.y; 
        if (it.y + it.height > maxY) maxY = it.y + it.height; 
    }
  } 
  return { minX, maxX, minY, maxY };
}

async function lc_extract(page, platform) {
  const textContent = await page.getTextContent(); 
  const lines = lc_groupLines(textContent.items); 
  const fullText = lines.map(l => l.text).join(' ');
  const v = page.view; 
  const pdfW = v[2] - v[0]; 
  const pdfH = v[3] - v[1];
  let splitY = 0; let fkGstin = null; let msGap = null; let isStandaloneLabel = false; let soldBy = 'Unknown Seller';

  const midMarker = lines.find(l => { 
      const y = l.y; 
      if (y < pdfH * 0.20 || y > pdfH * 0.65) return false; 
      return l.text.toUpperCase().startsWith('TAX INVOICE') || l.text.toUpperCase().includes('ORIGINAL FOR RECIPIENT'); 
  });
  if (midMarker) { splitY = midMarker.y + 15; } else { isStandaloneLabel = true; splitY = 0; }

  // Fallback Extraction (Dynamic Matching handles Meesho later)
  const sbMatch = fullText.match(/Sold [Bb]y\s*[:]?\s*([^,]+?)(?:\,|\s+34\/3\/16|\s+SHEGUR|\s+GSTIN)/i);
  if (sbMatch && sbMatch[1]) { 
      let extracted = sbMatch[1].trim(); 
      if(extracted.length > 3) soldBy = extracted.substring(0, 40); 
  }

  if (platform === 'flipkart') { 
      const gstinLine = lines.find(l => l.text.includes('GSTIN:')); 
      if (gstinLine) { 
          const it = gstinLine.items.find(i => i.str.includes('GSTIN:')); 
          if (it) fkGstin = { x: it.x, y: it.y }; 
      } 
  }

  const padX = 6; const padY = 12; let lBox, iBox, fullBox;
  if (isStandaloneLabel) {
      const lBounds = lc_getBounds(lines, 0, pdfH);
      const lLeft = isFinite(lBounds.minX) ? Math.max(0, lBounds.minX - padX) : 0; 
      const lRight = isFinite(lBounds.maxX) ? Math.min(pdfW, lBounds.maxX + padX) : pdfW; 
      const lBot = isFinite(lBounds.minY) ? Math.max(0, lBounds.minY - padY) : 0;
      const lTop = isFinite(lBounds.maxY) ? Math.min(pdfH, lBounds.maxY + padY) : pdfH;
      lBox = { left: lLeft, right: lRight, bottom: lBot, top: lTop, width: lRight - lLeft, height: lTop - lBot }; 
      iBox = null;
  } else {
      const lBounds = lc_getBounds(lines, splitY, pdfH);
      const lLeft = isFinite(lBounds.minX) ? Math.max(0, lBounds.minX - padX) : 10; 
      const lTop = isFinite(lBounds.maxY) ? Math.min(pdfH, lBounds.maxY + padY) : pdfH; 
      let lRight = pdfW - lLeft; 
      if (platform === 'flipkart') lRight = isFinite(lBounds.maxX) ? Math.min(pdfW, lBounds.maxX + padX) : (pdfW - lLeft);
      const labelBottom = platform === 'meesho' ? Math.max(0, splitY - 4) : splitY;
      lBox = { left: lLeft, right: lRight, bottom: labelBottom, top: lTop, width: lRight - lLeft, height: lTop - labelBottom };
      
      const iBounds = lc_getBounds(lines, 0, splitY - 5); 
      const iLeft = isFinite(iBounds.minX) ? Math.max(0, iBounds.minX - padX) : 0; 
      const iRight = isFinite(iBounds.maxX) ? Math.min(pdfW, iBounds.maxX + padX) : pdfW; 
      const iBot = isFinite(iBounds.minY) ? Math.max(0, iBounds.minY - padY) : 0; 
      iBox = { left: iLeft, right: iRight, bottom: iBot, top: splitY - 5, width: iRight - iLeft, height: (splitY - 5) - iBot };
  }
  
  const aB = lc_getBounds(lines, 0, pdfH);
  fullBox = { left: isFinite(aB.minX) ? Math.max(0, aB.minX - padX) : 10, right: isFinite(aB.maxX) ? Math.min(pdfW, aB.maxX + padX) : pdfW - 10, bottom: isFinite(aB.minY) ? Math.max(0, aB.minY - padY) : 10, top: isFinite(aB.maxY) ? Math.min(pdfH, aB.maxY + padY) : pdfH - 10 };

  if (platform === 'meesho') {
      let headerLine = lines.find(l => /IF UNDELIVERED|RETURN TO/i.test(l.text)); 
      let productLine = lines.find(l => /PRODUCT DETAILS|SKU SIZE QTY/i.test(l.text)); 
      let headY = headerLine ? headerLine.y : pdfH * 0.85; 
      let prodY = productLine ? productLine.y : pdfH * 0.35; 
      let addressLines = lines.filter(l => l.y < headY - 2 && l.y > prodY + 2 && l.items.some(i => i.x < pdfW * 0.48)); 
      let gapTopY = headY - 15; 
      let minX = headerLine ? headerLine.items[0].x : 15; 
      let maxX = minX + 120;
      if (addressLines.length > 0) { 
          gapTopY = Math.min(...addressLines.map(l => l.y)); 
          let allItems = addressLines.flatMap(l => l.items.filter(i => i.x < pdfW * 0.48)); 
          if(allItems.length > 0) { minX = Math.min(...allItems.map(i => i.x)); maxX = Math.max(...allItems.map(i => i.x + i.width)); } 
      }
      msGap = { x: minX, y: prodY + 10, w: Math.min(Math.max(maxX, minX + 120), (pdfW*0.48)-5) - minX, h: Math.max((gapTopY - 5) - (prodY + 10), 15) };
  }

  let qty = 1; let sku = 'Unknown SKU'; let courier = 'Unknown Courier'; let barcodeText = '';
  const cleanFull = fullText.replace(/\s+/g, ' '); 
  const cMatch = cleanFull.match(/E-Kart|Shadowfax|Delhivery|Xpress Bees|Xpressbees|Valmo|Ecom Express|DTDC/i); 
  if(cMatch) courier = cMatch[0];

  if (platform === 'flipkart') {
      const product = parseFlipkartProduct(lines, cleanFull);
      sku = product.sku;
      qty = product.qty;
  } else {
      const product = parseMeeshoProduct(lines, cleanFull);
      sku = product.sku;
      qty = product.qty;
      barcodeText = parseMeeshoBarcode(lines, fullText);
  }
  
  return { pdfW, pdfH, splitY, lBox, iBox, fullBox, fkGstin, msGap, sku, qty, courier, soldBy, barcodeText, rawText: fullText };
}

function lc_readFile(file) { 
    return new Promise((resolve, reject) => { 
        const reader = new FileReader(); 
        reader.onload = () => resolve(new Uint8Array(reader.result)); 
        reader.onerror = () => reject(reader.error); 
        reader.readAsArrayBuffer(file); 
    }); 
}

// Extraction Phase
document.getElementById('lc_processBtn').addEventListener('click', async () => {
  if (lc_rawFiles.length === 0) return;
  try {
      lc_parsedData = []; 
      lc_invalidateOutput();
      document.getElementById('lc_results').classList.add('hidden'); 
      document.getElementById('loaderBarContainer').classList.remove('hidden');
      document.getElementById('loader').classList.remove('hidden'); 
      document.getElementById('lc_processBtn').disabled = true;
      updateProgress(0, "Loading PDF documents...");

      let completedPages = 0;
      let discoveredPages = 0;

      for (let fIdx = 0; fIdx < lc_rawFiles.length; fIdx++) {
          updateProgress((fIdx / lc_rawFiles.length) * 48, `Opening file ${fIdx + 1} of ${lc_rawFiles.length}…`);
          const buf = await lc_readFile(lc_rawFiles[fIdx].file);
          const loadingTask = pdfjsLib.getDocument({ data: buf });
          const pdf = await loadingTask.promise;
          discoveredPages += pdf.numPages;
          for (let pIdx = 1; pIdx <= pdf.numPages; pIdx++) {
              if (completedPages % 8 === 0) {
                  const percent = ((fIdx + ((pIdx - 1) / pdf.numPages)) / lc_rawFiles.length) * 48;
                  updateProgress(percent, `Reading file ${fIdx + 1} · page ${pIdx} of ${pdf.numPages}`);
                  await new Promise(r => setTimeout(r, 0)); 
              }

              const page = await pdf.getPage(pIdx);
              const data = await lc_extract(page, currentPlatform);
              
              lc_parsedData.push({
                  fileIndex: fIdx, pageIndex: pIdx - 1,
                  w: data.pdfW, h: data.pdfH, splitY: data.splitY,
                  lBox: data.lBox, iBox: data.iBox, fullBox: data.fullBox,
                  fkPos: data.fkGstin, msPos: data.msGap,
                  sku: data.sku, qty: data.qty, courier: data.courier, soldBy: data.soldBy,
                  barcodeText: data.barcodeText, rawText: data.rawText
              });

              completedPages++;
          }
          pdf.cleanup();
          await loadingTask.destroy();
      }

      updateProgress(50, `Read ${completedPages || discoveredPages} pages · building print file…`);
      await lc_logoReadyPromise;
      const preparedVersion = lc_changeVersion;
      lc_cachedPdfBytes = await lc_generatePdf({ progressStart: 50 });
      lc_cachedVersion = preparedVersion;
      document.getElementById('lc_metricTotal').textContent = lc_parsedData.length;
      document.getElementById('lc_metricPieces').textContent = lc_parsedData.reduce((s,i)=>s+i.qty,0);
      document.getElementById('lc_results').classList.remove('hidden');
      document.getElementById('lc_processBtn').disabled = false;
  } catch (err) {
      console.error(err);
      alert("Error processing PDF: " + err.message);
      document.getElementById('loader').classList.add('hidden');
      document.getElementById('lc_processBtn').disabled = false;
  }
});

// Generation Phase (Memory-Safe Sequential Loading)
function lc_drawBrandLogo(page, logo, item, embBox, xOff, yOff, scale) {
  if (!logo) return;
  const embW = embBox.right - embBox.left;
  const embH = embBox.top - embBox.bottom;

  if (currentPlatform === 'flipkart') {
      if (item.fkPos) {
          page.drawImage(logo, {
              x: xOff + ((item.fkPos.x - embBox.left + 125) * scale),
              y: yOff + ((item.fkPos.y - embBox.bottom - 2) * scale),
              width: 60 * scale,
              height: 18 * scale
          });
      } else {
          page.drawImage(logo, {
              x: xOff + ((embW - 140) * scale),
              y: yOff + ((embH - 30) * scale),
              width: 60 * scale,
              height: 18 * scale
          });
      }
      return;
  }

  if (item.msPos) {
      let height = Math.min(26 * scale, item.msPos.h * scale * 0.9);
      if (height < 15) height = 20 * scale;
      const width = height * 3.76;
      const x = xOff + ((item.msPos.x - embBox.left) * scale) + ((item.msPos.w * scale) / 2) - (width / 2);
      const y = yOff + ((item.msPos.y - embBox.bottom) * scale) + ((item.msPos.h * scale) / 2) - (height / 2);
      page.drawRectangle({ x: x - 2, y: y - 2, width: width + 4, height: height + 4, color: PDFLib.rgb(1, 1, 1) });
      page.drawImage(logo, { x, y, width, height });
  }
}

function lc_fitText(text, font, size, maxWidth) {
  const value = String(text || '');
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;
  let shortened = value;
  while (shortened.length > 3 && font.widthOfTextAtSize(`${shortened}…`, size) > maxWidth) shortened = shortened.slice(0, -1);
  return `${shortened}…`;
}

function lc_findStore(item) {
  if (!window.appState?.storeLinks || !item.rawText) return null;
  const cleanedText = item.rawText.toLowerCase();
  return window.appState.storeLinks.find(store => cleanedText.includes(store.name.toLowerCase())) || null;
}

async function lc_drawStoreBanner(page, outDoc, font, fontReg, item, { x, y, width, height, compact = false }) {
  const { rgb } = PDFLib;
  page.drawRectangle({ x, y, width, height, color: rgb(0.97, 0.97, 0.97), borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 1 });
  const store = lc_findStore(item);
  if (!store) return;

  try {
    const padding = compact ? 7 : 12;
    const qrSize = Math.min(compact ? 58 : 75, height - (padding * 2));
    const qrDataUrl = await QRCode.toDataURL(store.url, { width: 150, margin: 1 });
    const qrBytes = Uint8Array.from(atob(qrDataUrl.split(',')[1]), character => character.charCodeAt(0));
    const qrImage = await outDoc.embedPng(qrBytes);
    const qrY = y + ((height - qrSize) / 2);
    page.drawImage(qrImage, { x: x + padding, y: qrY, width: qrSize, height: qrSize });

    const textX = x + padding + qrSize + (compact ? 8 : 15);
    const maxTextWidth = Math.max(30, (x + width - padding) - textX);
    const titleSize = compact ? 9.5 : 12;
    const nameSize = compact ? 7.5 : 10;
    const urlSize = compact ? 6.2 : 8;
    page.drawText('Visit Our Brand Store', { x: textX, y: y + height - (compact ? 18 : 24), size: titleSize, font, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(lc_fitText(store.name.toUpperCase(), fontReg, nameSize, maxTextWidth), { x: textX, y: y + height - (compact ? 34 : 42), size: nameSize, font: fontReg, color: rgb(0.2, 0.2, 0.2) });
    page.drawText(lc_fitText(store.url, fontReg, urlSize, maxTextWidth), { x: textX, y: y + height - (compact ? 48 : 58), size: urlSize, font: fontReg, color: rgb(0.4, 0.4, 0.4) });
  } catch (error) {
    console.error('QR Code Error:', error);
  }
}

function lc_drawCode128(page, font, value, { x, y, width, height }) {
  const encoded = encodeCode128B(value);
  if (!encoded || width < 40 || height < 20) return false;
  const { rgb } = PDFLib;
  const quietModules = 10;
  const moduleWidth = width / (encoded.moduleCount + (quietModules * 2));
  const textSize = Math.min(8, Math.max(6, height * 0.18));
  const barY = y + 2;
  const barHeight = Math.max(12, height - textSize - 7);
  let cursorX = x + (quietModules * moduleWidth);

  encoded.patterns.forEach(pattern => {
    [...pattern].forEach((digit, index) => {
      const segmentWidth = Number(digit) * moduleWidth;
      if (index % 2 === 0) page.drawRectangle({ x: cursorX, y: barY, width: segmentWidth, height: barHeight, color: rgb(0, 0, 0) });
      cursorX += segmentWidth;
    });
  });

  const textWidth = font.widthOfTextAtSize(encoded.text, textSize);
  page.drawText(encoded.text, {
    x: x + Math.max(0, (width - textWidth) / 2),
    y: y + height - textSize - 1,
    size: textSize,
    font,
    color: rgb(0, 0, 0)
  });
  return true;
}

function lc_sortPrintItems(items, platform) {
  const isMulti = item => item.qty > 1 || (item.sku && item.sku.includes('+'));
  const entries = items.map((item, originalIndex) => {
    const sortInfo = typeof window.getSkuSortInfo === 'function'
      ? window.getSkuSortInfo(platform, item.sku)
      : { mapped: false, masterKey: String(item.sku || '').trim().toUpperCase(), childIndex: Number.MAX_SAFE_INTEGER };
    return { item, originalIndex, sortInfo };
  });
  const textCompare = (left, right) => String(left || '').localeCompare(String(right || ''), undefined, { numeric: true, sensitivity: 'base' });
  const normalCompare = (a, b) => {
    const courierCompare = textCompare(a.item.courier, b.item.courier);
    if (courierCompare !== 0) return courierCompare;
    const skuCompare = textCompare(a.item.sku, b.item.sku);
    return skuCompare !== 0 ? skuCompare : a.originalIndex - b.originalIndex;
  };

  const mapped = entries.filter(entry => entry.sortInfo.mapped).sort((a, b) => {
    const masterCompare = textCompare(a.sortInfo.masterKey, b.sortInfo.masterKey);
    if (masterCompare !== 0) return masterCompare;
    const childCompare = Number(a.sortInfo.childIndex) - Number(b.sortInfo.childIndex);
    if (childCompare !== 0) return childCompare;
    const quantityCompare = Number(isMulti(a.item)) - Number(isMulti(b.item));
    if (quantityCompare !== 0) return quantityCompare;
    const courierCompare = textCompare(a.item.courier, b.item.courier);
    return courierCompare !== 0 ? courierCompare : a.originalIndex - b.originalIndex;
  });

  const unmapped = entries.filter(entry => !entry.sortInfo.mapped);
  const unmappedSingles = unmapped.filter(entry => !isMulti(entry.item)).sort(normalCompare);
  const unmappedMulti = unmapped.filter(entry => isMulti(entry.item)).sort(normalCompare);
  return [...mapped, ...unmappedSingles, ...unmappedMulti].map(entry => entry.item);
}

async function lc_generatePdf({ progressStart = 0 } = {}) {
  const { PDFDocument, rgb, StandardFonts } = PDFLib; 
  await lc_logoReadyPromise;
  if (window.skuMasterReady) await window.skuMasterReady.catch(() => {});
  const outDoc = await PDFDocument.create(); 
  const font = await outDoc.embedFont(StandardFonts.HelveticaBold); 
  const fontReg = await outDoc.embedFont(StandardFonts.Helvetica);
  
  const isMs = currentPlatform === 'meesho'; 
  const formatSelection = document.getElementById('lc_printFormat').value; 
  const incInv = formatSelection.includes('with-inv'); 
  const is4x4Combined = formatSelection === 'ms-4x4-with-inv'; 
  const is4x6Combined = formatSelection === 'ms-4x6-with-inv'; 
  const is3x5StoreCombined = formatSelection === 'ms-3x5-with-inv-store';
  const incSum = document.getElementById('lc_includeSummary').checked; 
  const margin = 1 * 2.83465;
  const report = (percent, status) => updateProgress(progressStart + (((100 - progressStart) * percent) / 100), status);
  
  document.getElementById('loaderBarContainer').classList.remove('hidden');
  document.getElementById('loader').classList.remove('hidden');
  report(0, "Preparing print file…");

  // Load sequentially to prevent RAM crashes on i3 processors
  const srcDocs = [];
  for (let i = 0; i < lc_rawFiles.length; i++) {
      report((i / lc_rawFiles.length) * 10, `Loading file ${i + 1} of ${lc_rawFiles.length}…`);
      await new Promise(r => setTimeout(r, 0)); // Yield to prevent browser freeze
      const buf = await lc_readFile(lc_rawFiles[i].file);
      const doc = await PDFDocument.load(buf, { ignoreEncryption: true }); 
      srcDocs.push(doc);
  }
  
  let logo = null;
  if (lc_customLogoBase64) {
      try { 
          // Bulletproof Logo Parsing
          const base64Data = lc_customLogoBase64.split(',')[1];
          const imgBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
          if (lc_customLogoBase64.includes('jpeg') || lc_customLogoBase64.includes('jpg')) {
              logo = await outDoc.embedJpg(imgBytes);
          } else {
              logo = await outDoc.embedPng(imgBytes); 
          }
      } catch(e) { console.error("Logo Error Bypassed:", e); }
  }

  const sortedData = lc_sortPrintItems(lc_parsedData, currentPlatform);

  for (let i = 0; i < sortedData.length; i++) {
      
      // Micro-Yield to prevent UI Freeze
      if (i % 20 === 0) {
          const genPercent = 10 + ((i + 1) / sortedData.length) * 85;
          report(genPercent, `Arranging label ${i + 1} of ${sortedData.length}…`);
          await new Promise(r => setTimeout(r, 0));
      }

      const item = sortedData[i];
      const doc = srcDocs[item.fileIndex]; 
      const srcPage = doc.getPage(item.pageIndex);

      if (is3x5StoreCombined) {
          const p = outDoc.addPage([216, 360]);
          p.drawRectangle({ x: 0, y: 0, width: 216, height: 360, color: rgb(1, 1, 1) });
          const printableW = 216 - (margin * 2);
          const printableH = 360 - (margin * 2);
          const bannerH = 72;
          const barcodeH = 46;
          const sectionGap = 3;
          const bannerY = margin;
          const contentY = bannerY + bannerH + sectionGap;
          const contentMaxH = printableH - bannerH - barcodeH - (sectionGap * 2);
          const embBox = { left: item.fullBox.left, bottom: item.fullBox.bottom, right: item.fullBox.right, top: item.fullBox.top };
          const embedded = await outDoc.embedPage(srcPage, embBox);
          const eW = embBox.right - embBox.left;
          const eH = embBox.top - embBox.bottom;
          const scale = Math.min(printableW / eW, contentMaxH / eH);
          const drawWidth = eW * scale;
          const drawHeight = eH * scale;
          const drawX = margin + ((printableW - drawWidth) / 2);
          p.drawPage(embedded, { x: drawX, y: contentY, xScale: scale, yScale: scale });
          lc_drawBrandLogo(p, logo, item, embBox, drawX, contentY, scale);
          p.drawLine({ start: { x: drawX, y: contentY }, end: { x: drawX + drawWidth, y: contentY }, thickness: 1.1, color: rgb(0, 0, 0) });

          const barcodeY = contentY + drawHeight + sectionGap;
          const availableBarcodeH = Math.max(0, (360 - margin) - barcodeY);
          lc_drawCode128(p, fontReg, item.barcodeText, {
            x: margin + 7,
            y: barcodeY,
            width: printableW - 14,
            height: Math.min(barcodeH, availableBarcodeH)
          });
          await lc_drawStoreBanner(p, outDoc, font, fontReg, item, { x: margin, y: bannerY, width: printableW, height: bannerH, compact: true });
      } else if (is4x4Combined) {
          const p = outDoc.addPage([288, 288]); p.drawRectangle({ x: 0, y: 0, width: 288, height: 288, color: rgb(1,1,1) });
          const embBox = { left: item.fullBox.left, bottom: item.fullBox.bottom, right: item.fullBox.right, top: item.fullBox.top }; 
          const embedded = await outDoc.embedPage(srcPage, embBox);
          const eW = embBox.right - embBox.left; const eH = embBox.top - embBox.bottom; 
          const pW = 288 - (margin * 2); const pH = 288 - (margin * 2);
          const scale = Math.min(pW / eW, pH / eH); 
          const drawX = margin + (pW - (eW * scale)) / 2;
          const drawY = margin + (pH - (eH * scale)) / 2;
          p.drawPage(embedded, { x: drawX, y: drawY, xScale: scale, yScale: scale });
          lc_drawBrandLogo(p, logo, item, embBox, drawX, drawY, scale);
          p.drawLine({ start: { x: drawX, y: drawY }, end: { x: drawX + (eW * scale), y: drawY }, thickness: 1.1, color: rgb(0,0,0) });
      } else if (is4x6Combined) {
          const p = outDoc.addPage([288, 432]); p.drawRectangle({ x: 0, y: 0, width: 288, height: 432, color: rgb(1,1,1) });
          const printableW = 288 - (margin * 2); const printableH = 432 - (margin * 2); 
          const bannerH = 95; const bannerY = margin; const contentH = printableH - bannerH - margin;
          const embBox = { left: item.fullBox.left, bottom: item.fullBox.bottom, right: item.fullBox.right, top: item.fullBox.top }; 
          const embedded = await outDoc.embedPage(srcPage, embBox);
          const eW = embBox.right - embBox.left; const eH = embBox.top - embBox.bottom; 
          const scale = Math.min(printableW / eW, contentH / eH); 
          const drawX = margin + (printableW - (eW * scale)) / 2;
          const drawY = bannerY + bannerH + margin + (contentH - (eH * scale)) / 2;
          p.drawPage(embedded, { x: drawX, y: drawY, xScale: scale, yScale: scale });
          lc_drawBrandLogo(p, logo, item, embBox, drawX, drawY, scale);
          p.drawLine({ start: { x: drawX, y: drawY }, end: { x: drawX + (eW * scale), y: drawY }, thickness: 1.1, color: rgb(0,0,0) });
          await lc_drawStoreBanner(p, outDoc, font, fontReg, item, { x: margin, y: bannerY, width: printableW, height: bannerH });
      } else {
          const is4x6Standard = formatSelection.includes('4x6'); 
          const embBox = { left: item.lBox.left, bottom: item.lBox.bottom, right: item.lBox.right, top: item.lBox.top }; 
          const embedded = await outDoc.embedPage(srcPage, embBox);
          const embW = embBox.right - embBox.left; const embH = embBox.top - embBox.bottom; 
          const baseW = is4x6Standard ? 288 : 216; const baseH = is4x6Standard ? 432 : 360; 
          const labelFw = (embW > embH) ? baseH : baseW; const labelFh = (embW > embH) ? baseW : baseH; 
          const p1 = outDoc.addPage([labelFw, labelFh]); 
          p1.drawRectangle({ x: 0, y: 0, width: labelFw, height: labelFh, color: rgb(1,1,1) }); 
          const sw = labelFw - (margin * 2); const sh = labelFh - (margin * 2);
          const scale = Math.min(sw / embW, sh / embH); 
          const xOff = margin + (sw - (embW*scale)) / 2; const yOff = margin + (sh - (embH*scale)) / 2;
          p1.drawPage(embedded, { x: xOff, y: yOff, xScale: scale, yScale: scale });
          lc_drawBrandLogo(p1, logo, item, embBox, xOff, yOff, scale);
          if (isMs) p1.drawLine({ start: { x: xOff, y: yOff }, end: { x: xOff + (embW * scale), y: yOff }, thickness: 1.1, color: rgb(0,0,0) });
          if (incInv && item.iBox) {
              const embeddedInv = await outDoc.embedPage(srcPage, item.iBox); 
              const invW = item.iBox.right - item.iBox.left; const invH = item.iBox.top - item.iBox.bottom; 
              let invFw, invFh; 
              if (isMs) { invFw = labelFw; invFh = labelFh; } 
              else { 
                  if (is4x6Standard) { invFw = (invW > invH) ? 432 : 288; invFh = (invW > invH) ? 288 : 432; } 
                  else { invFw = 360; invFh = 216; } 
              }
              const p2 = outDoc.addPage([invFw, invFh]); 
              p2.drawRectangle({ x: 0, y: 0, width: invFw, height: invFh, color: rgb(1,1,1) }); 
              const iScale = Math.min((invFw - margin*2) / invW, (invFh - margin*2) / invH); 
              p2.drawPage(embeddedInv, { x: margin + ((invFw - margin*2) - (invW*iScale)) / 2, y: margin + ((invFh - margin*2) - (invH*iScale)) / 2, xScale: iScale, yScale: iScale });
          }
      }
  }

  if (incSum) {
    report(96, "Generating packing summary…");
    await new Promise(r => setTimeout(r, 0));

    let sp = outDoc.addPage([216, 360]); let y = 345; const skus = {}; const couriers = {}; const sellers = {};
    lc_parsedData.forEach(item => {
        if (!couriers[item.courier]) { couriers[item.courier] = 0; } couriers[item.courier] += 1;
        if (!sellers[item.soldBy]) { sellers[item.soldBy] = { items: 0, orders: 0 }; } sellers[item.soldBy].items += item.qty; sellers[item.soldBy].orders += 1;
        const summarySku = item.qty > 1
          ? item.sku
          : (typeof window.resolveMasterSku === 'function' ? window.resolveMasterSku(currentPlatform, item.sku) : item.sku);
        const key = summarySku + "|||" + item.qty;
        if (!skus[key]) { skus[key] = { sku: summarySku, qtyPerOrder: item.qty, orders: 0 }; }
        skus[key].orders += 1;
    });
    sp.drawRectangle({ x: 5, y: y-5, width: 206, height: 15, color: rgb(0,0,0) }); 
    sp.drawText("DELIVERY PARTNERS", { x: 10, y: y, size: 9, font, color: rgb(1,1,1) }); 
    sp.drawText("PARCELS", { x: 160, y: y, size: 9, font, color: rgb(1,1,1) }); y-=14;
    Object.entries(couriers).forEach(([c, n]) => { 
        if (y<15) { sp=outDoc.addPage([216,360]); y=345; } 
        sp.drawText(c, { x: 10, y, size: 8, font }); 
        sp.drawText(String(n), { x: 180, y, size: 10, font }); 
        sp.drawLine({ start: {x:5,y:y-3}, end: {x:211,y:y-3}, thickness: 0.5, color: rgb(0.8,0.8,0.8) }); y-=14; 
    }); 
    y-=10;
    if (y<30) { sp=outDoc.addPage([216,360]); y=345; } 
    sp.drawRectangle({ x: 5, y: y-5, width: 206, height: 15, color: rgb(0,0,0) }); 
    sp.drawText("SOLD BY", { x: 10, y: y, size: 9, font, color: rgb(1,1,1) }); 
    sp.drawText("ITEMS", { x: 140, y: y, size: 9, font, color: rgb(1,1,1) }); 
    sp.drawText("ORDS", { x: 180, y: y, size: 9, font, color: rgb(1,1,1) }); y-=14;
    Object.entries(sellers).forEach(([s, data]) => { 
        if (y<25) { sp=outDoc.addPage([216,360]); y=345; } 
        let line1 = s.substring(0, 25); let line2 = s.substring(25, 50); 
        sp.drawText(line1, { x: 10, y, size: 8, font }); 
        if (line2) sp.drawText(line2, { x: 10, y: y-10, size: 8, font }); 
        sp.drawText(String(data.items), { x: 145, y, size: 10, font }); 
        sp.drawText(String(data.orders), { x: 185, y, size: 10, font }); 
        let yStep = line2 ? 22 : 14; 
        sp.drawLine({ start: {x:5,y:y-yStep+3}, end: {x:211,y:y-yStep+3}, thickness: 0.5, color: rgb(0.8,0.8,0.8) }); y-=yStep; 
    }); 
    y-=10;
    if (y<30) { sp=outDoc.addPage([216,360]); y=345; } 
    sp.drawRectangle({ x: 5, y: y-5, width: 206, height: 15, color: rgb(0,0,0) }); 
    sp.drawText("SKU", { x: 10, y: y, size: 9, font, color: rgb(1,1,1) }); 
    sp.drawText("QTY/ORD", { x: 135, y: y, size: 9, font, color: rgb(1,1,1) }); 
    sp.drawText("ORDERS", { x: 180, y: y, size: 9, font, color: rgb(1,1,1) }); y-=14;
    Object.values(skus).sort((a, b) => a.sku.localeCompare(b.sku) || a.qtyPerOrder - b.qtyPerOrder).forEach(item => { 
        let line1 = item.sku.substring(0, 28); let line2 = item.sku.substring(28, 56); 
        if (y < (line2 ? 25 : 15)) { sp = outDoc.addPage([216, 360]); y = 345; } 
        sp.drawText(line1, { x: 10, y, size: 8, font }); 
        if (line2) sp.drawText(line2, { x: 10, y: y - 10, size: 8, font }); 
        sp.drawText(String(item.qtyPerOrder), { x: 145, y, size: 10, font }); 
        sp.drawText(String(item.orders), { x: 191, y, size: 10, font }); 
        let yStep = line2 ? 22 : 14; 
        sp.drawLine({ start: {x:5, y: y - yStep + 3}, end: {x:211, y: y - yStep + 3}, thickness: 0.5, color: rgb(0.8,0.8,0.8) }); y -= yStep; 
    });
  }

  report(98, "Finalizing print file…");
  await new Promise(r => setTimeout(r, 10)); 
  
  const pdfBytes = await outDoc.save({ useObjectStreams: false, objectsPerTick: 200 });
  
  if(window.appState.currentUser && db && lc_dbLocal && window.appState.role === 'seller') {
      const processedAt = Date.now();
      lc_lastProcessedAt = processedAt;
      const tx = lc_dbLocal.transaction('pdfs', 'readwrite');
      tx.objectStore('pdfs').put({ 
          id: processedAt,
          userId: window.appState.currentUser.uid, 
          platform: currentPlatform, 
          format: formatSelection,
          fileName: lc_outputFileName(currentPlatform, formatSelection, processedAt),
          totalOrders: lc_parsedData.length, 
          totalPieces: lc_parsedData.reduce((s,i)=>s+i.qty,0), 
          data: pdfBytes, 
          timestamp: processedAt,
          expiresAt: processedAt + SIX_HOURS_MS
      });
      tx.oncomplete = () => {
          lc_loadRecoveredPdfs();
          window.dispatchEvent(new CustomEvent('processedPdfHistoryChanged'));
      };
  }
  if (typeof window.recordLabelBatch === 'function') {
      window.recordLabelBatch({
          platform: currentPlatform,
          format: formatSelection,
          totalOrders: lc_parsedData.length,
          totalPieces: lc_parsedData.reduce((sum, item) => sum + item.qty, 0)
      }).catch(error => console.warn('Private dashboard activity could not be updated.', error));
  }
  
  document.getElementById('loader').classList.add('hidden');
  return pdfBytes;
}

async function lc_getPdfBytes() {
  if (lc_cachedPdfBytes && lc_cachedVersion === lc_changeVersion) return lc_cachedPdfBytes;
  const generationVersion = lc_changeVersion;
  const bytes = await lc_generatePdf();
  if (generationVersion === lc_changeVersion) {
      lc_cachedPdfBytes = bytes;
      lc_cachedVersion = generationVersion;
  }
  return bytes;
}

window.getPreparedLabelPdf = async function() {
  if (!lc_parsedData.length) throw new Error('Process the label batch before saving it to the cloud.');
  if (window.appState.role !== 'seller') throw new Error('Only a Seller can share processed label PDFs.');
  const bytes = await lc_getPdfBytes();
  const format = document.getElementById('lc_printFormat').value;
  const generatedAt = lc_lastProcessedAt || Date.now();
  return {
    bytes,
    fileName: lc_outputFileName(currentPlatform, format, generatedAt),
    platform: currentPlatform,
    format,
    totalOrders: lc_parsedData.length,
    totalPieces: lc_parsedData.reduce((sum, item) => sum + item.qty, 0),
    generatedAt,
    source: 'label-cutter'
  };
};

document.getElementById('lc_downloadBtn').addEventListener('click', async () => {
  try { 
      const bytes = await lc_getPdfBytes();
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })); 
      const a = document.createElement('a'); 
      a.href = url; 
      const fmt = document.getElementById('lc_printFormat').value; 
      a.download = lc_outputFileName(currentPlatform, fmt);
      a.click(); 
      setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { 
      document.getElementById('loader').classList.add('hidden');
      alert(e.message); 
  }
});

document.getElementById('lc_previewBtn').addEventListener('click', async () => {
  const previewWindow = window.open('', '_blank');
  if (!previewWindow) {
      alert('Your browser blocked the preview window. Allow pop-ups for this site and try again.');
      return;
  }
  previewWindow.document.title = 'Preparing preview…';
  previewWindow.document.body.innerHTML = '<p style="font:600 16px system-ui;padding:32px;color:#344054">Preparing your print preview…</p>';
  try {
      const bytes = await lc_getPdfBytes();
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })); 
      previewWindow.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (e) { 
      previewWindow.close();
      document.getElementById('loader').classList.add('hidden');
      alert(e.message); 
  }
});

let lc_dbLocal;
let lc_dbReadyResolve;
const lc_dbReady = new Promise(resolve => { lc_dbReadyResolve = resolve; });
const lc_dbRequest = indexedDB.open("ShegursLabelDB", 6);
lc_dbRequest.onupgradeneeded = (e) => { 
    lc_dbLocal = e.target.result; 
    if (!lc_dbLocal.objectStoreNames.contains('pdfs')) { 
        lc_dbLocal.createObjectStore('pdfs', { keyPath: 'id' }).createIndex('userId', 'userId', { unique: false }); 
    } 
};
lc_dbRequest.onsuccess = (e) => {
    lc_dbLocal = e.target.result;
    lc_dbReadyResolve(lc_dbLocal);
    lc_loadRecoveredPdfs();
    window.dispatchEvent(new CustomEvent('processedPdfHistoryChanged'));
};
lc_dbRequest.onerror = () => lc_dbReadyResolve(null);

window.getRecentProcessedPdfs = async function() {
    const database = lc_dbLocal || await lc_dbReady;
    if (!database || !window.appState.isUnlocked || window.appState.role !== 'seller' || !window.appState.currentUser) return [];
    return await new Promise((resolve, reject) => {
        const tx = database.transaction('pdfs', 'readwrite');
        const store = tx.objectStore('pdfs');
        const req = store.getAll();
        req.onerror = () => reject(req.error || new Error('Recent processed PDFs could not be opened.'));
        req.onsuccess = () => {
            const now = Date.now();
            const currentUid = window.appState.currentUser.uid;
            const items = [];
            req.result.forEach(item => {
                const expiresAt = Number(item.expiresAt) || (Number(item.timestamp) + SIX_HOURS_MS);
                if (!Number(item.timestamp) || expiresAt <= now) {
                    store.delete(item.id);
                } else if (item.userId === currentUid) {
                    items.push({
                        ...item,
                        expiresAt,
                        format: item.format || '',
                        fileName: item.fileName || lc_outputFileName(item.platform || 'labels', item.format || '3x5', item.timestamp)
                    });
                }
            });
            resolve(items.sort((a, b) => Number(b.timestamp) - Number(a.timestamp)));
        };
    });
};

function lc_loadRecoveredPdfs() {
    if (!lc_dbLocal || !window.appState.isUnlocked || !window.appState.currentUser) return;
    const tx = lc_dbLocal.transaction('pdfs', 'readwrite'); const req = tx.objectStore('pdfs').getAll();
    req.onsuccess = () => {
        const now = Date.now(); const validItems = []; const currentUid = window.appState.currentUser.uid;
        req.result.forEach(item => { 
            const expiresAt = Number(item.expiresAt) || (Number(item.timestamp) + SIX_HOURS_MS);
            if (expiresAt <= now) tx.objectStore('pdfs').delete(item.id);
            else if (item.userId === currentUid) validItems.push(item); 
        });
        validItems.sort((a,b) => b.timestamp - a.timestamp); 
        lc_renderRecoveryList(validItems);
    };
}

function lc_renderRecoveryList(items) {
    const panel = document.getElementById('recoveryPanel'); const list = document.getElementById('savedBatchesList'); list.replaceChildren();
    if (items.length === 0 || !window.appState.isUnlocked) { panel.classList.add('hidden'); return; } 
    panel.classList.remove('hidden');
    items.forEach(item => {
        const timeStr = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const li = document.createElement('li');
        const meta = document.createElement('div');
        const badge = document.createElement('span');
        const copy = document.createElement('span');
        const title = document.createElement('strong');
        const detail = document.createElement('small');
        const actions = document.createElement('div');
        li.className = 'recovery-item';
        meta.className = 'recovery-item__meta';
        badge.className = `market-badge market-badge--${item.platform}`;
        badge.textContent = item.platform;
        copy.className = 'recovery-item__copy';
        title.textContent = `${item.totalOrders} ${item.totalOrders === 1 ? 'order' : 'orders'} · ${item.totalPieces} ${item.totalPieces === 1 ? 'piece' : 'pieces'}`;
        const remainingMinutes = Math.max(1, Math.ceil(((Number(item.expiresAt) || (item.timestamp + SIX_HOURS_MS)) - Date.now()) / 60000));
        const remainingText = remainingMinutes >= 60
          ? `${Math.floor(remainingMinutes / 60)}h ${remainingMinutes % 60}m left`
          : `${remainingMinutes}m left`;
        detail.textContent = `${String(item.platform || '').toUpperCase()} · created at ${timeStr} · ${remainingText}`;
        copy.append(title, detail);
        meta.append(badge, copy);
        actions.className = 'recovery-item__actions';
        [
          ['Preview', 'preview', 'mini-button'],
          ['Download', 'download', 'mini-button mini-button--success'],
          ['Delete', 'delete', 'mini-button mini-button--danger']
        ].forEach(([label, action, className]) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = className;
          button.textContent = label;
          button.addEventListener('click', () => window.lc_handleRecovery(item.id, action));
          actions.appendChild(button);
        });
        li.append(meta, actions);
        list.appendChild(li);
    });
}

window.lc_handleRecovery = function(id, action) {
    if (!lc_dbLocal) return; 
    const tx = lc_dbLocal.transaction('pdfs', action === 'delete' ? 'readwrite' : 'readonly'); 
    const store = tx.objectStore('pdfs');
    if (action === 'delete') { 
        store.delete(id); 
        tx.oncomplete = () => lc_loadRecoveredPdfs(); 
        return; 
    }
    const req = store.get(id); 
    req.onsuccess = () => { 
        if (!req.result) return; 
        const bytes = req.result.data; 
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })); 
        if (action === 'download') { 
            const a = document.createElement('a'); 
            a.href = url; 
            a.download = req.result.fileName || `PackPilot_${req.result.platform.toUpperCase()}_Recovered_${id}.pdf`;
            a.click(); 
            URL.revokeObjectURL(url); 
        } else if (action === 'preview') { 
            window.open(url, '_blank'); 
            setTimeout(() => URL.revokeObjectURL(url), 10000); 
        } 
    };
};
