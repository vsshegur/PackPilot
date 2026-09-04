const el = id => document.getElementById(id);

const money = value => Number(value || 0).toLocaleString('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 2
});

function normalize(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  const negative = /^\(.*\)$/.test(raw);
  const parsed = Number(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? (negative ? -Math.abs(parsed) : parsed) : 0;
}

function findColumn(headers, tests) {
  return headers.findIndex(header => tests.some(test => test(header)));
}

function findHeader(rows, requiredGroups) {
  for (let index = 0; index < Math.min(rows.length, 60); index += 1) {
    const headers = (rows[index] || []).map(normalize);
    if (requiredGroups.every(group => findColumn(headers, group) >= 0)) return { index, headers };
  }
  return null;
}

function readWorkbook(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('The file could not be read.'));
    reader.onload = event => {
      try {
        resolve(XLSX.read(new Uint8Array(event.target.result), { type: 'array' }));
      } catch (error) {
        reject(error);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

function findRows(workbook, requiredGroups) {
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '', raw: true });
    const header = findHeader(rows, requiredGroups);
    if (header) return { rows, ...header, sheetName: name };
  }
  return null;
}

const SKU_TESTS = [h => h === 'sku', h => h.includes('sku id'), h => h.includes('seller sku'), h => h.includes('supplier sku'), h => h.includes('supplier sku code')];
const QTY_TESTS = [h => h === 'qty', h => h.includes('quantity'), h => h.includes('net units'), h => h.includes('net qty')];
const AMOUNT_TESTS = [h => h.includes('settlement amount'), h => h.includes('net settlement'), h => h.includes('amount settled'), h => h.includes('bank settlement'), h => h.includes('payable amount'), h => h === 'settlement'];
const ORDER_TESTS = [h => h === 'order id', h => h.includes('sub order id'), h => h.includes('suborder id'), h => h.includes('sub order no'), h => h.includes('suborder no'), h => h === 'order no', h => h.includes('order number')];
const DATE_TESTS = [h => h.includes('dispatch date'), h => h.includes('dispatch time'), h => h.includes('order date'), h => h.includes('ordered date'), h => h === 'date'];
const STATUS_TESTS = [h => h === 'status', h => h.includes('order status'), h => h.includes('shipment status')];
const PAYMENT_STATUS_TESTS = [h => h.includes('payment status'), h => h.includes('settlement status'), h => h === 'status'];
const RETURN_TYPE_TESTS = [h => h.includes('return type'), h => h.includes('return status'), h => h.includes('return reason'), h => h === 'type', h => h === 'status'];
const msReports = { orders: null, payments: null, returns: null };
let msProfitItems = [];
const msCostTimers = new Map();

function orderId(value) {
  return String(value ?? '').trim().replace(/\.0$/, '');
}

function parseDateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && value > 20000 && value < 100000) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d);
  }
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parts = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (parts) {
    const year = Number(parts[3]) < 100 ? 2000 + Number(parts[3]) : Number(parts[3]);
    const date = new Date(year, Number(parts[2]) - 1, Number(parts[1]));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function inputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function setDefaultMeeshoPeriod() {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 15);
  const end = new Date(cutoff.getFullYear(), cutoff.getMonth(), 0);
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  el('ms_fromDate').value = inputDate(start);
  el('ms_toDate').value = inputDate(end);
  el('ms_toDate').max = inputDate(cutoff);
  updateMeeshoRunState();
}

function updateMeeshoRunState() {
  const ready = msReports.orders && msReports.payments && msReports.returns && el('ms_fromDate').value && el('ms_toDate').value;
  el('ms_runPnlBtn').disabled = !ready;
  const from = parseDateValue(el('ms_fromDate').value);
  const to = parseDateValue(el('ms_toDate').value);
  if (from && to) {
    el('ms_dateHint').textContent = `${from.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} to ${to.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`;
  }
}

async function parseMeeshoOrders(file) {
  const match = findRows(await readWorkbook(file), [ORDER_TESTS, SKU_TESTS, DATE_TESTS]);
  if (!match) throw new Error('Orders report needs Order ID, SKU and order/dispatch date columns.');
  const idIndex = findColumn(match.headers, ORDER_TESTS);
  const skuIndex = findColumn(match.headers, SKU_TESTS);
  const dateIndex = findColumn(match.headers, DATE_TESTS);
  const quantityIndex = findColumn(match.headers, QTY_TESTS);
  const statusIndex = findColumn(match.headers, STATUS_TESTS);
  const rows = match.rows.slice(match.index + 1).map(row => ({
    id: orderId(row[idIndex]),
    sku: String(row[skuIndex] ?? '').trim(),
    date: parseDateValue(row[dateIndex]),
    qty: Math.max(1, Math.abs(number(quantityIndex >= 0 ? row[quantityIndex] : 1)) || 1),
    status: statusIndex >= 0 ? String(row[statusIndex] ?? '').trim() : ''
  })).filter(row => row.id && row.sku && row.date);
  if (!rows.length) throw new Error('No dated order rows were found in the selected orders report.');
  return rows;
}

async function parseMeeshoPayments(file) {
  const match = findRows(await readWorkbook(file), [ORDER_TESTS, AMOUNT_TESTS]);
  if (!match) throw new Error('Payment report needs Order ID and final settlement amount columns.');
  const idIndex = findColumn(match.headers, ORDER_TESTS);
  const amountIndex = findColumn(match.headers, AMOUNT_TESTS);
  const statusIndex = findColumn(match.headers, PAYMENT_STATUS_TESTS);
  const paymentDateIndex = findColumn(match.headers, [h => h.includes('payment date'), h => h.includes('settlement date')]);
  const payments = new Map();
  match.rows.slice(match.index + 1).forEach(row => {
    const id = orderId(row[idIndex]);
    if (!id) return;
    const status = statusIndex >= 0 ? String(row[statusIndex] ?? '').trim().toLowerCase() : '';
    const explicitlyPending = /(pending|processing|hold|upcoming|not paid|not settled)/i.test(status);
    const explicitlyComplete = /(paid|complete|completed|settled|processed|success|credited|released)/i.test(status);
    const item = payments.get(id) || { amount: 0, completed: false, paymentDates: [] };
    item.amount += number(row[amountIndex]);
    item.completed = item.completed || (!status ? true : (explicitlyComplete && !explicitlyPending));
    const paymentDate = paymentDateIndex >= 0 ? parseDateValue(row[paymentDateIndex]) : null;
    if (paymentDate) item.paymentDates.push(paymentDate);
    payments.set(id, item);
  });
  if (!payments.size) throw new Error('No payment rows were found in the selected report.');
  return payments;
}

async function parseMeeshoReturns(file) {
  const workbook = await readWorkbook(file);
  const match = findRows(workbook, [ORDER_TESTS]);
  if (!match) throw new Error('Returns report needs an Order ID or Sub Order ID column.');
  const idIndex = findColumn(match.headers, ORDER_TESTS);
  const typeIndex = findColumn(match.headers, RETURN_TYPE_TESTS);
  const returns = new Map();
  match.rows.slice(match.index + 1).forEach(row => {
    const id = orderId(row[idIndex]);
    if (!id) return;
    const type = typeIndex >= 0 ? String(row[typeIndex] ?? '').trim() : 'Customer return';
    returns.set(id, `${returns.get(id) || ''} ${type}`.trim());
  });
  return returns;
}

async function chooseMeeshoReport(kind, file) {
  const status = el(`ms_${kind}Status`);
  status.textContent = `Reading ${file.name}…`;
  try {
    if (kind === 'orders') msReports.orders = await parseMeeshoOrders(file);
    if (kind === 'payments') msReports.payments = await parseMeeshoPayments(file);
    if (kind === 'returns') msReports.returns = await parseMeeshoReturns(file);
    const count = kind === 'orders' ? msReports.orders.length : msReports[kind].size;
    status.textContent = `${file.name} · ${count.toLocaleString('en-IN')} ${kind === 'orders' ? 'rows' : 'order IDs'}`;
  } catch (error) {
    msReports[kind] = null;
    status.textContent = `Could not use ${file.name}`;
    alert(error.message);
  }
  updateMeeshoRunState();
}

['orders', 'payments', 'returns'].forEach(kind => {
  el(`ms_${kind}Input`).addEventListener('change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) chooseMeeshoReport(kind, file);
  });
});

el('ms_fromDate').addEventListener('change', updateMeeshoRunState);
el('ms_toDate').addEventListener('change', updateMeeshoRunState);

function skuCosts(sku) {
  if (typeof window.getSkuCostBreakdown === 'function') return window.getSkuCostBreakdown('meesho', sku);
  const legacy = window.appState?.userSkus?.[sku];
  const productCost = typeof legacy === 'object' ? number(legacy.cost) : number(legacy);
  return { masterSku: sku, childSkus: [sku], productCost, packagingCost: 0, labourCost: 0, totalCost: productCost };
}

el('ms_runPnlBtn').addEventListener('click', () => {
  const from = parseDateValue(el('ms_fromDate').value);
  const to = parseDateValue(el('ms_toDate').value);
  if (!from || !to || from > to) return alert('Choose a valid From date and To date.');
  to.setHours(23, 59, 59, 999);
  const cutoff = new Date();
  cutoff.setHours(23, 59, 59, 999);
  cutoff.setDate(cutoff.getDate() - 15);
  if (to > cutoff) {
    alert(`The To date must be ${cutoff.toLocaleDateString('en-IN')} or earlier so payments have at least 15 days to complete.`);
    return;
  }

  const rows = msReports.orders.filter(row => row.date >= from && row.date <= to);
  if (!rows.length) return alert('No order rows were found inside the selected date range.');
  const groupedOrders = new Map();
  rows.forEach(row => {
    const order = groupedOrders.get(row.id) || { id: row.id, rows: [], status: '' };
    order.rows.push(row);
    order.status += ` ${row.status}`;
    groupedOrders.set(row.id, order);
  });

  let dispatched = 0;
  let cancelled = 0;
  let rto = 0;
  let customerReturn = 0;
  let pending = 0;
  let completed = 0;
  const groupedSku = new Map();

  groupedOrders.forEach(order => {
    const status = order.status.toLowerCase();
    const returnText = String(msReports.returns.get(order.id) || '').toLowerCase();
    const isCancelled = /cancel/.test(status);
    const isRto = /\brto\b|return to origin/.test(`${status} ${returnText}`);
    const isCustomerReturn = !isRto && Boolean(returnText) && /return|refund|customer/.test(returnText);
    const payment = msReports.payments.get(order.id);
    const isCompleted = Boolean(payment?.completed) && !isCancelled;
    if (!isCancelled) dispatched += 1;
    if (isCancelled) cancelled += 1;
    if (isRto) rto += 1;
    if (isCustomerReturn) customerReturn += 1;
    if (!isCancelled && !isRto && !isCustomerReturn && !isCompleted) pending += 1;
    if (!isCompleted) return;
    completed += 1;
    const orderUnits = order.rows.reduce((sum, row) => sum + row.qty, 0) || 1;
    order.rows.forEach(row => {
      const master = typeof window.resolveMasterSku === 'function' ? window.resolveMasterSku('meesho', row.sku) : row.sku;
      const item = groupedSku.get(master) || { master, childSkus: new Set(), units: 0, deliveredUnits: 0, settlement: 0, costs: skuCosts(row.sku) };
      item.childSkus.add(row.sku);
      item.units += row.qty;
      if (!isRto && !isCustomerReturn) item.deliveredUnits += row.qty;
      item.settlement += payment.amount * (row.qty / orderUnits);
      groupedSku.set(master, item);
    });
  });

  msProfitItems = Array.from(groupedSku.values());
  msProfitItems.forEach(recalculateMeeshoItem);
  msProfitItems.sort((a, b) => a.costs.productCost <= 0 && b.costs.productCost > 0 ? -1 : b.profit - a.profit);
  renderMeeshoPnl(msProfitItems);
  el('ms_kpiDispatched').textContent = dispatched.toLocaleString('en-IN');
  el('ms_kpiCancelled').textContent = cancelled.toLocaleString('en-IN');
  el('ms_kpiRto').textContent = rto.toLocaleString('en-IN');
  el('ms_kpiReturns').textContent = customerReturn.toLocaleString('en-IN');
  el('ms_kpiPending').textContent = pending.toLocaleString('en-IN');
  el('ms_periodLabel').textContent = `${from.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} — ${to.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`;
  el('ms_completedHeadline').textContent = `${completed.toLocaleString('en-IN')} completed-payment ${completed === 1 ? 'order' : 'orders'} used for profit`;
  el('ms_pnlStatus').textContent = `${groupedOrders.size.toLocaleString('en-IN')} orders checked · ${completed.toLocaleString('en-IN')} with completed payments`;
  el('ms_pnlResults').classList.remove('hidden');
});

function recalculateMeeshoItem(item) {
  const costs = item.costs;
  item.totalCost = (costs.productCost * item.deliveredUnits) + ((costs.packagingCost + costs.labourCost) * item.units);
  item.profit = item.settlement - item.totalCost;
}

function costInput(item, field, label) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '0.01';
  input.value = number(item.costs[field]) || '';
  input.placeholder = '0.00';
  input.className = `cost-input${field === 'productCost' && number(item.costs[field]) <= 0 ? ' is-missing' : ''}`;
  input.setAttribute('aria-label', `${label} for ${item.master}`);
  input.addEventListener('input', () => {
    item.costs[field] = Math.max(0, number(input.value));
    input.classList.toggle('is-missing', field === 'productCost' && item.costs[field] <= 0);
    recalculateMeeshoItem(item);
    item.ui.profit.textContent = money(item.profit);
    item.ui.profit.className = `number ${item.profit >= 0 ? 'positive' : 'negative'}`;
    item.ui.row.classList.toggle('sku-row--missing', item.costs.productCost <= 0);
    updateMeeshoTotals();
    clearTimeout(msCostTimers.get(item.master));
    msCostTimers.set(item.master, setTimeout(async () => {
      if (typeof window.upsertSkuCostFromProfit !== 'function') return;
      try {
        item.costs = await window.upsertSkuCostFromProfit('meesho', item.master, item.costs);
        recalculateMeeshoItem(item);
        el('ms_pnlStatus').textContent = `${item.master} costs saved to your account.`;
      } catch (error) {
        el('ms_pnlStatus').textContent = `${item.master} costs could not be saved.`;
      }
    }, 700));
  });
  return input;
}

function renderMeeshoPnl(items) {
  const body = el('ms_pnlBody');
  body.replaceChildren();
  if (!items.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 8;
    cell.textContent = 'No completed-payment orders were found in this period. Check the payment report or choose an older month.';
    row.appendChild(cell);
    body.appendChild(row);
    updateMeeshoTotals();
    return;
  }
  items.forEach(item => {
    const row = document.createElement('tr');
    const masterCell = document.createElement('td');
    const childrenCell = document.createElement('td');
    const unitsCell = document.createElement('td');
    const settlementCell = document.createElement('td');
    const productCell = document.createElement('td');
    const packagingCell = document.createElement('td');
    const labourCell = document.createElement('td');
    const profitCell = document.createElement('td');
    masterCell.textContent = item.master;
    masterCell.className = 'sku-id';
    const children = document.createElement('div');
    children.className = 'child-sku-list';
    [...item.childSkus].sort().forEach(value => { const chip = document.createElement('code'); chip.textContent = value; children.appendChild(chip); });
    childrenCell.appendChild(children);
    unitsCell.textContent = number(item.units).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    settlementCell.textContent = money(item.settlement);
    unitsCell.className = settlementCell.className = 'number';
    productCell.appendChild(costInput(item, 'productCost', 'Product cost including GST'));
    packagingCell.appendChild(costInput(item, 'packagingCost', 'Packaging cost'));
    labourCell.appendChild(costInput(item, 'labourCost', 'Labour and other cost'));
    productCell.className = packagingCell.className = labourCell.className = 'number';
    profitCell.textContent = money(item.profit);
    profitCell.className = `number ${item.profit >= 0 ? 'positive' : 'negative'}`;
    item.ui = { row, profit: profitCell };
    row.classList.toggle('sku-row--missing', item.costs.productCost <= 0);
    row.append(masterCell, childrenCell, unitsCell, settlementCell, productCell, packagingCell, labourCell, profitCell);
    body.appendChild(row);
  });
  updateMeeshoTotals();
}

function updateMeeshoTotals() {
  const totals = msProfitItems.reduce((sum, item) => ({
    units: sum.units + item.units,
    settlement: sum.settlement + item.settlement,
    cost: sum.cost + item.totalCost,
    profit: sum.profit + item.profit
  }), { units: 0, settlement: 0, cost: 0, profit: 0 });
  el('ms_kpiUnits').textContent = number(totals.units).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  el('ms_kpiSettlement').textContent = money(totals.settlement);
  el('ms_kpiCost').textContent = money(totals.cost);
  el('ms_kpiProfit').textContent = money(totals.profit);
  el('ms_kpiProfit').className = totals.profit >= 0 ? 'positive' : 'negative';
}

setDefaultMeeshoPeriod();

let orderReport = null;
let settlementReport = null;

async function loadReconciliationFile(file, kind) {
  const status = el(kind === 'order' ? 'recon_orderStatus' : 'recon_settlementStatus');
  status.textContent = `Reading ${file.name}…`;
  const workbook = await readWorkbook(file);
  const amountTests = kind === 'order'
    ? [h => h.includes('expected amount'), h => h.includes('order amount'), h => h.includes('invoice value'), h => h.includes('total amount'), h => h.includes('selling price'), h => h === 'amount']
    : [...AMOUNT_TESTS, h => h.includes('paid amount'), h => h.includes('net payable'), h => h === 'amount'];
  const match = findRows(workbook, [ORDER_TESTS, amountTests]);
  if (!match) throw new Error(`Could not find order ID and ${kind === 'order' ? 'order value' : 'settlement amount'} columns.`);
  const orderIndex = findColumn(match.headers, ORDER_TESTS);
  const amountIndex = findColumn(match.headers, amountTests);
  const map = new Map();
  match.rows.slice(match.index + 1).forEach(row => {
    const id = String(row[orderIndex] ?? '').trim().replace(/\.0$/, '');
    if (!id || /^(total|nan|undefined)$/i.test(id)) return;
    map.set(id, (map.get(id) || 0) + number(row[amountIndex]));
  });
  if (!map.size) throw new Error('No order rows were found below the detected headings.');
  status.textContent = `${file.name} · ${map.size} order IDs`;
  return map;
}

el('recon_orderInput').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  try { orderReport = await loadReconciliationFile(file, 'order'); } catch (error) { orderReport = null; alert(error.message); }
  el('recon_runBtn').disabled = !(orderReport && settlementReport);
});

el('recon_settlementInput').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  try { settlementReport = await loadReconciliationFile(file, 'settlement'); } catch (error) { settlementReport = null; alert(error.message); }
  el('recon_runBtn').disabled = !(orderReport && settlementReport);
});

el('recon_runBtn').addEventListener('click', () => {
  if (!orderReport || !settlementReport) return;
  const tolerance = Math.max(0, number(el('recon_tolerance').value));
  const ids = new Set([...orderReport.keys(), ...settlementReport.keys()]);
  const results = [];
  let matched = 0;
  let missing = 0;
  let short = 0;
  let totalDifference = 0;
  ids.forEach(id => {
    const expected = orderReport.get(id) || 0;
    const hasSettlement = settlementReport.has(id);
    const settled = settlementReport.get(id) || 0;
    const difference = settled - expected;
    totalDifference += difference;
    let status = 'Matched';
    if (!hasSettlement) { status = 'Missing'; missing += 1; }
    else if (difference < -tolerance) { status = 'Short paid'; short += Math.abs(difference); }
    else if (difference > tolerance) status = expected ? 'Excess paid' : 'Settlement only';
    else matched += 1;
    results.push({ id, expected, settled, difference, status });
  });
  el('recon_matched').textContent = matched.toLocaleString('en-IN');
  el('recon_missing').textContent = missing.toLocaleString('en-IN');
  el('recon_short').textContent = money(short);
  el('recon_difference').textContent = money(totalDifference);
  el('recon_difference').className = totalDifference >= 0 ? 'positive' : 'negative';
  renderReconciliation(results.filter(item => item.status !== 'Matched'));
  el('recon_results').classList.remove('hidden');
});

function renderReconciliation(items) {
  const body = el('recon_body');
  body.replaceChildren();
  if (!items.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = 'Every detected order matches within the selected tolerance.';
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  items.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)).slice(0, 1000).forEach(item => {
    const row = document.createElement('tr');
    [item.id, item.status, money(item.expected), money(item.settled), money(item.difference)].forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (index > 1) cell.className = 'number';
      if (index === 1) cell.innerHTML = `<span class="status-badge ${item.status === 'Missing' || item.status === 'Short paid' ? 'status-badge--warning' : 'status-badge--brand'}">${item.status}</span>`;
      if (index === 4) cell.classList.add(item.difference >= 0 ? 'positive' : 'negative');
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
}

function populateMarginSkus() {
  const select = el('margin_sku');
  const current = select.value;
  const records = Object.values(window.appState?.skuMaster || {})
    .sort((a, b) => a.marketplace.localeCompare(b.marketplace) || a.masterSku.localeCompare(b.masterSku));
  select.replaceChildren(new Option('Manual calculation', ''));
  records.forEach(record => {
    const key = `${record.marketplace}::${record.masterSku}`;
    const market = record.marketplace === 'meesho' ? 'Meesho' : 'Flipkart';
    select.add(new Option(`${market} · ${record.masterSku}`, key));
  });
  if (records.some(record => `${record.marketplace}::${record.masterSku}` === current)) select.value = current;
}

function calculateMargin() {
  const price = Math.max(0, number(el('margin_price').value));
  const cost = Math.max(0, number(el('margin_cost').value));
  const fee = Math.max(0, number(el('margin_fee').value));
  const shipping = Math.max(0, number(el('margin_shipping').value));
  const ads = Math.max(0, number(el('margin_ads').value));
  const gstRate = Math.min(100, Math.max(0, number(el('margin_gst').value)));
  const returnRate = Math.min(100, Math.max(0, number(el('margin_returns').value)));
  const units = Math.max(1, Math.round(number(el('margin_units').value) || 1));
  const gstReserve = price * (gstRate / (100 + gstRate));
  const returnReserve = (cost + shipping) * (returnRate / 100);
  const profit = price - cost - fee - shipping - ads - gstReserve - returnReserve;
  const margin = price ? (profit / price) * 100 : 0;
  const fixedCost = cost + fee + shipping + ads + returnReserve;
  const breakEven = gstRate ? fixedCost / (1 - (gstRate / (100 + gstRate))) : fixedCost;
  const profitEl = el('margin_profit');
  profitEl.textContent = money(profit);
  profitEl.className = profit >= 0 ? 'positive' : 'negative';
  el('margin_badge').textContent = `${margin.toFixed(1)}% margin`;
  el('margin_gstValue').textContent = money(gstReserve);
  el('margin_returnValue').textContent = money(returnReserve);
  el('margin_total').textContent = money(profit * units);
  el('margin_breakEven').textContent = money(breakEven);
  el('margin_meter').style.width = `${Math.max(0, Math.min(100, margin * 3))}%`;
  el('margin_guidance').textContent = margin < 0 ? 'This price is below break-even.' : margin < 10 ? 'Margin is thin; review fees or selling price.' : margin < 20 ? 'A workable margin with limited room for surprises.' : 'Healthy estimated margin before unexpected losses.';
}

['margin_price', 'margin_cost', 'margin_fee', 'margin_shipping', 'margin_ads', 'margin_gst', 'margin_returns', 'margin_units']
  .forEach(id => el(id).addEventListener('input', calculateMargin));

el('margin_sku').addEventListener('change', () => {
  const record = window.appState?.skuMaster?.[el('margin_sku').value];
  if (!record) return calculateMargin();
  el('margin_cost').value = number(record.totalCost);
  if (number(record.price) > 0) el('margin_price').value = number(record.price);
  calculateMargin();
});

window.addEventListener('appUnlocked', () => { populateMarginSkus(); calculateMargin(); });
window.addEventListener('skuMasterChanged', () => { populateMarginSkus(); calculateMargin(); });
