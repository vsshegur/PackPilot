import { db } from './firebase-config.js';
import { doc, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

let fk_rawSkuData = [];
const saveTimers = new Map();
const el = id => document.getElementById(id);
const excelInput = el('fk_excelInput');
const uploadZone = excelInput.closest('.pnl-upload');

excelInput.addEventListener('change', fk_handleExcel);
el('fk_applyBulkBtn').addEventListener('click', fk_applyBulkCost);
el('fk_lossInput').addEventListener('input', fk_updateCalculations);
el('fk_recalcBtn').addEventListener('click', fk_updateCalculations);

['dragenter', 'dragover'].forEach(eventName => {
  uploadZone.addEventListener(eventName, event => {
    event.preventDefault();
    uploadZone.classList.add('is-dragover');
  });
});
['dragleave', 'drop'].forEach(eventName => {
  uploadZone.addEventListener(eventName, event => {
    event.preventDefault();
    uploadZone.classList.remove('is-dragover');
  });
});
uploadZone.addEventListener('drop', event => {
  const file = Array.from(event.dataTransfer.files).find(item => /\.xlsx?$/i.test(item.name));
  if (!file) {
    alert('Choose a Flipkart Excel file in .xlsx or .xls format.');
    return;
  }
  fk_readExcel(file);
});

function fk_handleExcel(event) {
  const file = event.target.files[0];
  if (file) fk_readExcel(file);
  event.target.value = '';
}

function fk_readExcel(file) {
  el('fk_uploadStatus').textContent = `Reading ${file.name}…`;
  const reader = new FileReader();
  reader.onerror = () => {
    el('fk_uploadStatus').textContent = 'The file could not be read. Please try it again.';
  };
  reader.onload = event => {
    try {
      const workbook = XLSX.read(new Uint8Array(event.target.result), { type: 'array' });
      fk_extractData(workbook, file.name);
    } catch (error) {
      console.error(error);
      el('fk_uploadStatus').textContent = 'This workbook could not be processed.';
      alert(`Could not read this Excel file: ${error.message}`);
    }
  };
  reader.readAsArrayBuffer(file);
}

function fk_normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function fk_parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  const negative = /^\(.*\)$/.test(raw);
  const parsed = Number(raw.replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(parsed)) return 0;
  return negative ? -Math.abs(parsed) : parsed;
}

function fk_findSheet(workbook) {
  const exact = workbook.SheetNames.find(name => name.trim().toLowerCase() === 'sku-level p&l');
  const close = workbook.SheetNames.find(name => {
    const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    return normalized.includes('sku') && (normalized.includes('p l') || normalized.includes('profit'));
  });
  return exact || close;
}

function fk_findHeaderRow(rows) {
  const scanLimit = Math.min(rows.length, 50);
  for (let index = 0; index < scanLimit; index++) {
    const headers = rows[index].map(fk_normalizeHeader);
    const hasSku = headers.some(header => header === 'sku' || header.includes('sku id') || header.includes('seller sku'));
    const hasSettlement = headers.some(header => header.includes('settlement') || header.includes('amount settled'));
    if (hasSku && hasSettlement) return index;
  }
  return -1;
}

function fk_findColumn(headers, matchers) {
  return headers.findIndex(header => matchers.some(matcher => matcher(header)));
}

function fk_extractData(workbook, fileName) {
  const sheetName = fk_findSheet(workbook);
  if (!sheetName) {
    el('fk_uploadStatus').textContent = 'Required “SKU-level P&L” sheet was not found.';
    alert('The workbook must include the Flipkart “SKU-level P&L” sheet.');
    return;
  }

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
  const headerRowIndex = fk_findHeaderRow(rows);
  if (headerRowIndex < 0) {
    el('fk_uploadStatus').textContent = 'SKU and settlement headings were not found.';
    alert('Could not find the SKU and settlement columns in this Flipkart report.');
    return;
  }

  const headers = rows[headerRowIndex].map(fk_normalizeHeader);
  const skuIndex = fk_findColumn(headers, [
    header => header === 'sku',
    header => header.includes('sku id'),
    header => header.includes('seller sku')
  ]);
  const unitIndex = fk_findColumn(headers, [
    header => header.includes('net units'),
    header => header.includes('net quantity'),
    header => header === 'net qty'
  ]);
  const settlementIndex = fk_findColumn(headers, [
    header => header.includes('amount settled'),
    header => header.includes('settled amount'),
    header => header.includes('bank settlement'),
    header => header.includes('net settlement'),
    header => header.includes('settlement amount')
  ]);

  if (skuIndex < 0 || unitIndex < 0 || settlementIndex < 0) {
    el('fk_uploadStatus').textContent = 'SKU, net units, or settlement column is missing.';
    alert('Could not find the SKU, net units, or settlement amount column in this report.');
    return;
  }

  const skuMap = new Map();
  rows.slice(headerRowIndex + 1).forEach(row => {
    const skuId = String(row[skuIndex] ?? '').trim();
    if (!skuId || /^(undefined|nan|total)$/i.test(skuId)) return;
    const netUnits = unitIndex >= 0 ? fk_parseNumber(row[unitIndex]) : 0;
    const bankSettlement = fk_parseNumber(row[settlementIndex]);
    const savedCost = typeof window.getSkuCost === 'function'
      ? fk_parseNumber(window.getSkuCost('flipkart', skuId))
      : fk_parseNumber(window.appState.userSkus[skuId]);

    if (!skuMap.has(skuId)) {
      skuMap.set(skuId, { skuId, netUnits, bankSettlement, costOfProduct: savedCost });
      return;
    }
    const item = skuMap.get(skuId);
    item.netUnits += netUnits;
    item.bankSettlement += bankSettlement;
  });

  fk_rawSkuData = Array.from(skuMap.values());
  if (fk_rawSkuData.length === 0) {
    el('fk_uploadStatus').textContent = 'No SKU rows were found in this report.';
    alert('No SKU data was found in the selected workbook.');
    return;
  }

  fk_rawSkuData.sort((a, b) => {
    const aMissing = a.costOfProduct <= 0;
    const bMissing = b.costOfProduct <= 0;
    if (aMissing !== bMissing) return aMissing ? -1 : 1;
    return Math.abs(b.bankSettlement) - Math.abs(a.bankSettlement);
  });
  fk_renderTable();
  el('fk_calcSection').classList.remove('hidden');
  const missing = fk_rawSkuData.filter(item => item.costOfProduct <= 0).length;
  el('fk_uploadStatus').textContent = `${fileName} · ${fk_rawSkuData.length} SKUs found${missing ? ` · ${missing} costs needed` : ' · all costs ready'}`;
  fk_updateCalculations();
}

function fk_renderTable() {
  const tbody = el('fk_skuTableBody');
  tbody.replaceChildren();

  fk_rawSkuData.forEach((item, index) => {
    const row = document.createElement('tr');
    const rankCell = document.createElement('td');
    const skuCell = document.createElement('td');
    const unitsCell = document.createElement('td');
    const settlementCell = document.createElement('td');
    const costCell = document.createElement('td');
    const unitProfitCell = document.createElement('td');
    const totalProfitCell = document.createElement('td');
    const costInput = document.createElement('input');
    const isMissing = item.costOfProduct <= 0;

    row.className = isMissing ? 'sku-row--missing' : '';
    rankCell.textContent = String(index + 1);
    skuCell.textContent = item.skuId;
    skuCell.title = item.skuId;
    skuCell.className = 'sku-id';
    unitsCell.textContent = fk_formatNumber(item.netUnits);
    unitsCell.className = 'number';
    settlementCell.textContent = fk_formatCurrency(item.bankSettlement);
    settlementCell.className = 'number';
    costCell.className = 'number';
    costInput.type = 'number';
    costInput.min = '0';
    costInput.step = '0.01';
    costInput.placeholder = '0.00';
    costInput.value = item.costOfProduct > 0 ? item.costOfProduct : '';
    costInput.className = `cost-input${isMissing ? ' is-missing' : ''}`;
    costInput.setAttribute('aria-label', `Product cost for ${item.skuId}`);
    costCell.appendChild(costInput);
    unitProfitCell.className = 'number profit-value';
    totalProfitCell.className = 'number profit-value';

    item.ui = { row, costInput, unitProfitCell, totalProfitCell };
    costInput.addEventListener('input', () => {
      item.costOfProduct = fk_parseNumber(costInput.value);
      fk_updateRowState(item);
      fk_updateCalculations();
      clearTimeout(saveTimers.get(item.skuId));
      saveTimers.set(item.skuId, setTimeout(() => fk_saveCosts({ [item.skuId]: item.costOfProduct }), 650));
    });

    row.append(rankCell, skuCell, unitsCell, settlementCell, costCell, unitProfitCell, totalProfitCell);
    tbody.appendChild(row);
  });
}

function fk_updateRowState(item) {
  const missing = item.costOfProduct <= 0;
  item.ui.row.classList.toggle('sku-row--missing', missing);
  item.ui.costInput.classList.toggle('is-missing', missing);
}

function fk_applyBulkCost() {
  const value = fk_parseNumber(el('fk_bulkCostInput').value);
  if (value <= 0) {
    alert('Enter a product cost greater than zero.');
    el('fk_bulkCostInput').focus();
    return;
  }

  const updates = {};
  fk_rawSkuData.forEach(item => {
    if (item.costOfProduct <= 0) {
      item.costOfProduct = value;
      item.ui.costInput.value = value;
      fk_updateRowState(item);
      updates[item.skuId] = value;
    }
  });
  if (Object.keys(updates).length === 0) {
    alert('All SKUs already have a product cost.');
    return;
  }
  fk_updateCalculations();
  fk_saveCosts(updates);
}

function fk_updateCalculations() {
  let totalUnits = 0;
  let totalSettlement = 0;
  let grossProfit = 0;

  fk_rawSkuData.forEach(item => {
    totalUnits += item.netUnits;
    totalSettlement += item.bankSettlement;
    const missing = item.costOfProduct <= 0;
    if (missing) {
      item.ui.unitProfitCell.innerHTML = '<span class="missing-copy">Cost needed</span>';
      item.ui.totalProfitCell.innerHTML = '<span class="missing-copy">Excluded</span>';
      return;
    }

    const totalProfit = item.bankSettlement - (item.costOfProduct * item.netUnits);
    const unitProfit = item.netUnits !== 0 ? totalProfit / item.netUnits : 0;
    grossProfit += totalProfit;
    item.ui.unitProfitCell.textContent = item.netUnits !== 0 ? fk_formatCurrency(unitProfit) : '—';
    item.ui.totalProfitCell.textContent = fk_formatCurrency(totalProfit);
    item.ui.unitProfitCell.classList.toggle('positive', unitProfit >= 0);
    item.ui.unitProfitCell.classList.toggle('negative', unitProfit < 0);
    item.ui.totalProfitCell.classList.toggle('positive', totalProfit >= 0);
    item.ui.totalProfitCell.classList.toggle('negative', totalProfit < 0);
  });

  const additionalLoss = Math.max(0, fk_parseNumber(el('fk_lossInput').value));
  const finalProfit = grossProfit - additionalLoss;
  el('fk_kpiUnits').textContent = fk_formatNumber(totalUnits);
  el('fk_kpiSettlement').textContent = fk_formatCurrency(totalSettlement);
  el('fk_kpiGross').textContent = fk_formatCurrency(grossProfit);
  el('fk_kpiNet').textContent = fk_formatCurrency(finalProfit);
  fk_setValueTone(el('fk_kpiGross'), grossProfit);
  fk_setValueTone(el('fk_kpiNet'), finalProfit);
}

function fk_setValueTone(element, value) {
  element.classList.toggle('positive', value >= 0);
  element.classList.toggle('negative', value < 0);
}

function fk_formatNumber(value) {
  return Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fk_formatCurrency(value) {
  return Number(value || 0).toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

async function fk_saveCosts(updates) {
  Object.assign(window.appState.userSkus, updates);
  if (!window.appState.currentUser || !db) return;
  try {
    await setDoc(doc(db, 'users', window.appState.currentUser.uid, 'skus', 'memory'), updates, { merge: true });
  } catch (error) {
    console.warn('SKU costs could not be saved.', error);
  }
}
