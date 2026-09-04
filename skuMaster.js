import { db } from './firebase-config.js';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  setDoc
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const el = id => document.getElementById(id);
let records = [];

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return number(value).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
}

function displaySku(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizedSku(value) {
  return displaySku(value).toUpperCase();
}

function normalizedPlatform(value) {
  return String(value || '').toLowerCase() === 'meesho' ? 'meesho' : 'flipkart';
}

function skuDocId(platform, masterSku) {
  const bytes = new TextEncoder().encode(`${platform}::${normalizedSku(masterSku)}`);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function parseChildren(value) {
  const unique = new Map();
  String(value || '')
    .split(/[\n,;]+/)
    .map(displaySku)
    .filter(Boolean)
    .forEach(child => unique.set(normalizedSku(child), child));
  return [...unique.values()];
}

function normalizeRecord(data, id) {
  const marketplace = normalizedPlatform(data.marketplace);
  const masterSku = displaySku(data.masterSku || data.sku);
  const productCost = Math.max(0, number(data.productCost ?? data.cost));
  const packagingCost = Math.max(0, number(data.packagingCost));
  const labourCost = Math.max(0, number(data.labourCost ?? data.otherCost));
  const childSkus = parseChildren(Array.isArray(data.childSkus) ? data.childSkus.join('\n') : (data.sku || masterSku));
  return {
    id,
    masterSku,
    marketplace,
    childSkus: childSkus.length ? childSkus : [masterSku],
    productCost,
    packagingCost,
    labourCost,
    totalCost: productCost + packagingCost + labourCost,
    price: Math.max(0, number(data.price)),
    updatedAt: number(data.updatedAt)
  };
}

function publishRecords() {
  window.appState.skuMaster = Object.fromEntries(records.map(record => [`${record.marketplace}::${record.masterSku}`, record]));
  window.resolveMasterSku = (platform, childSku) => {
    const source = normalizedSku(childSku);
    const market = normalizedPlatform(platform);
    const match = records.find(record => record.marketplace === market && (
      normalizedSku(record.masterSku) === source || record.childSkus.some(child => normalizedSku(child) === source)
    ));
    return match?.masterSku || String(childSku || '').trim();
  };
  window.getSkuSortInfo = (platform, childSku) => {
    const source = normalizedSku(childSku);
    const market = normalizedPlatform(platform);
    const match = records.find(record => record.marketplace === market && (
      normalizedSku(record.masterSku) === source || record.childSkus.some(child => normalizedSku(child) === source)
    ));
    if (!match) {
      return {
        mapped: false,
        masterSku: String(childSku || '').trim(),
        masterKey: source,
        childIndex: Number.MAX_SAFE_INTEGER
      };
    }
    const savedChildIndex = match.childSkus.findIndex(child => normalizedSku(child) === source);
    return {
      mapped: true,
      masterSku: match.masterSku,
      masterKey: normalizedSku(match.masterSku),
      childIndex: savedChildIndex >= 0 ? savedChildIndex : -1
    };
  };
  window.getSkuCostBreakdown = (platform, sku) => {
    const source = normalizedSku(sku);
    const market = normalizedPlatform(platform);
    const match = records.find(record => record.marketplace === market && (
      normalizedSku(record.masterSku) === source || record.childSkus.some(child => normalizedSku(child) === source)
    ));
    if (match) return { ...match };
    const legacyKey = Object.keys(window.appState.userSkus || {}).find(key => normalizedSku(key) === source);
    const legacy = legacyKey ? window.appState.userSkus[legacyKey] : undefined;
    const legacyCost = typeof legacy === 'object' ? number(legacy.cost) : number(legacy);
    return {
      masterSku: String(sku || '').trim(), marketplace: market, childSkus: [source],
      productCost: legacyCost, packagingCost: 0, labourCost: 0, totalCost: legacyCost, price: 0
    };
  };
  window.getSkuCost = (platform, sku) => window.getSkuCostBreakdown(platform, sku).totalCost;
  window.dispatchEvent(new CustomEvent('skuMasterChanged', { detail: records }));
}

async function loadSkuMaster() {
  const user = window.appState?.currentUser;
  if (!user || window.appState.role === 'operations_manager' || !db) return;
  try {
    const snapshot = await getDocs(collection(db, 'users', user.uid, 'skuMaster'));
    records = snapshot.docs
      .map(item => normalizeRecord(item.data(), item.id))
      .filter(record => record.masterSku);
    publishRecords();
    renderSkuMaster();
  } catch (error) {
    el('sku_message').textContent = `SKU Master could not be loaded: ${error.message}`;
  }
}

function renderSkuMaster() {
  const body = el('sku_body');
  const term = el('sku_search').value.trim().toLowerCase();
  const visible = records
    .filter(record => !term || `${record.masterSku} ${record.marketplace} ${record.childSkus.join(' ')}`.toLowerCase().includes(term))
    .sort((a, b) => a.marketplace.localeCompare(b.marketplace) || a.masterSku.localeCompare(b.masterSku));
  body.replaceChildren();
  el('sku_count').textContent = `${records.length} ${records.length === 1 ? 'master' : 'masters'}`;
  el('sku_empty').classList.toggle('hidden', visible.length > 0);

  visible.forEach(record => {
    const row = document.createElement('tr');
    const masterCell = document.createElement('td');
    const marketCell = document.createElement('td');
    const childrenCell = document.createElement('td');
    const productCell = document.createElement('td');
    const packagingCell = document.createElement('td');
    const labourCell = document.createElement('td');
    const totalCell = document.createElement('td');
    const actionCell = document.createElement('td');
    masterCell.textContent = record.masterSku;
    masterCell.className = 'sku-id';
    const marketBadge = document.createElement('span');
    marketBadge.className = `status-badge ${record.marketplace === 'meesho' ? 'status-badge--pink' : 'status-badge--brand'}`;
    marketBadge.textContent = record.marketplace === 'meesho' ? 'Meesho' : 'Flipkart';
    marketCell.appendChild(marketBadge);
    const children = document.createElement('div');
    children.className = 'child-sku-list';
    record.childSkus.forEach((child, index) => {
      const chip = document.createElement('code');
      chip.textContent = `${index + 1}. ${child}`;
      children.appendChild(chip);
    });
    childrenCell.appendChild(children);
    [
      [productCell, record.productCost], [packagingCell, record.packagingCost],
      [labourCell, record.labourCost], [totalCell, record.totalCost]
    ].forEach(([cell, value]) => { cell.textContent = money(value); cell.className = 'number'; });
    totalCell.classList.add('sku-total-cost');
    const actions = document.createElement('div');
    const edit = document.createElement('button');
    const remove = document.createElement('button');
    actions.className = 'table-actions';
    edit.type = remove.type = 'button';
    edit.className = 'mini-button';
    remove.className = 'mini-button mini-button--danger';
    edit.textContent = 'Edit';
    remove.textContent = 'Delete';
    edit.addEventListener('click', () => editRecord(record));
    remove.addEventListener('click', () => removeRecord(record));
    actions.append(edit, remove);
    actionCell.appendChild(actions);
    row.append(masterCell, marketCell, childrenCell, productCell, packagingCell, labourCell, totalCell, actionCell);
    body.appendChild(row);
  });
}

function editRecord(record) {
  el('sku_master').value = record.masterSku;
  el('sku_master').dataset.editId = record.id;
  el('sku_marketplace').value = record.marketplace;
  el('sku_children').value = record.childSkus.join('\n');
  el('sku_productCost').value = record.productCost || '';
  el('sku_packagingCost').value = record.packagingCost || '';
  el('sku_labourCost').value = record.labourCost || '';
  el('sku_price').value = record.price || '';
  el('sku_master').focus();
  el('sku_message').textContent = `Editing ${record.masterSku} for ${record.marketplace === 'meesho' ? 'Meesho' : 'Flipkart'}.`;
}

async function removeRecord(record) {
  if (!confirm(`Delete ${record.masterSku} and its ${record.childSkus.length} child SKU mapping${record.childSkus.length === 1 ? '' : 's'}?`)) return;
  try {
    await deleteDoc(doc(db, 'users', window.appState.currentUser.uid, 'skuMaster', record.id));
    records = records.filter(item => item.id !== record.id);
    publishRecords();
    renderSkuMaster();
    el('sku_message').textContent = `${record.masterSku} was removed. Its child SKUs will appear normally in future summaries.`;
  } catch (error) {
    alert(`Master SKU could not be deleted: ${error.message}`);
  }
}

function duplicateChild(platform, children, ignoredId = '') {
  const incoming = new Set(children.map(normalizedSku));
  return records.find(record => record.marketplace === platform && record.id !== ignoredId && record.childSkus.some(existing => incoming.has(normalizedSku(existing))));
}

async function saveRecord(record, editId = '') {
  const newId = skuDocId(record.marketplace, record.masterSku);
  const payload = { ...record, totalCost: record.productCost + record.packagingCost + record.labourCost, updatedAt: Date.now() };
  const writes = [setDoc(doc(db, 'users', window.appState.currentUser.uid, 'skuMaster', newId), payload)];
  if (editId && editId !== newId) writes.push(deleteDoc(doc(db, 'users', window.appState.currentUser.uid, 'skuMaster', editId)));
  const legacyUpdates = Object.fromEntries([record.masterSku, ...record.childSkus].map(sku => [sku, payload.totalCost]));
  writes.push(setDoc(doc(db, 'users', window.appState.currentUser.uid, 'skus', 'memory'), legacyUpdates, { merge: true }));
  await Promise.all(writes);
  Object.assign(window.appState.userSkus, legacyUpdates);
  records = records.filter(item => item.id !== editId && !(item.marketplace === record.marketplace && normalizedSku(item.masterSku) === normalizedSku(record.masterSku)));
  records.push({ id: newId, ...payload });
  publishRecords();
  renderSkuMaster();
  return records.find(item => item.id === newId);
}

window.upsertSkuCostFromProfit = async (platform, sku, costs) => {
  const market = normalizedPlatform(platform);
  const source = normalizedSku(sku);
  let record = records.find(item => item.marketplace === market && (
    normalizedSku(item.masterSku) === source || item.childSkus.some(child => normalizedSku(child) === source)
  ));
  if (!record) {
    const display = displaySku(sku);
    record = { masterSku: display, marketplace: market, childSkus: [display], productCost: 0, packagingCost: 0, labourCost: 0, price: 0 };
  }
  const updated = {
    masterSku: record.masterSku,
    marketplace: record.marketplace,
    childSkus: record.childSkus,
    productCost: Math.max(0, number(costs.productCost ?? record.productCost)),
    packagingCost: Math.max(0, number(costs.packagingCost ?? record.packagingCost)),
    labourCost: Math.max(0, number(costs.labourCost ?? record.labourCost)),
    price: Math.max(0, number(record.price))
  };
  return saveRecord(updated, record.id || '');
};

el('sku_saveBtn').addEventListener('click', async () => {
  const masterSku = displaySku(el('sku_master').value);
  const marketplace = normalizedPlatform(el('sku_marketplace').value);
  const childSkus = parseChildren(el('sku_children').value);
  const editId = el('sku_master').dataset.editId || '';
  if (!masterSku) {
    alert('Enter a master SKU name.');
    el('sku_master').focus();
    return;
  }
  if (!childSkus.length) {
    alert('Add at least one child SKU from the shipping labels.');
    el('sku_children').focus();
    return;
  }
  const duplicate = duplicateChild(marketplace, childSkus, editId);
  if (duplicate) {
    const repeated = childSkus.find(child => duplicate.childSkus.some(existing => normalizedSku(existing) === normalizedSku(child)));
    alert(`${repeated} is already mapped to ${duplicate.masterSku} for ${marketplace === 'meesho' ? 'Meesho' : 'Flipkart'}.`);
    return;
  }
  const record = {
    masterSku,
    marketplace,
    childSkus,
    productCost: Math.max(0, number(el('sku_productCost').value)),
    packagingCost: Math.max(0, number(el('sku_packagingCost').value)),
    labourCost: Math.max(0, number(el('sku_labourCost').value)),
    price: Math.max(0, number(el('sku_price').value))
  };
  const button = el('sku_saveBtn');
  button.disabled = true;
  el('sku_message').textContent = `Saving ${masterSku}…`;
  try {
    await saveRecord(record, editId);
    ['sku_master', 'sku_children', 'sku_productCost', 'sku_packagingCost', 'sku_labourCost', 'sku_price'].forEach(id => { el(id).value = ''; });
    delete el('sku_master').dataset.editId;
    el('sku_marketplace').value = 'meesho';
    el('sku_message').textContent = `${masterSku} now groups ${childSkus.length} ${marketplace === 'meesho' ? 'Meesho' : 'Flipkart'} child SKU${childSkus.length === 1 ? '' : 's'} in the saved label-sorting order.`;
  } catch (error) {
    el('sku_message').textContent = '';
    alert(`Master SKU could not be saved: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

el('sku_search').addEventListener('input', renderSkuMaster);
window.addEventListener('appUnlocked', () => {
  window.skuMasterReady = loadSkuMaster();
});
window.addEventListener('workspaceChanged', event => {
  if (event.detail?.app === 'skuMaster') window.skuMasterReady = loadSkuMaster();
});
