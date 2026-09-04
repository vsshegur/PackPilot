import { db } from './firebase-config.js';
import {
  addDoc,
  collection,
  doc,
  onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const el = id => document.getElementById(id);
let sellerUnsubscribe = null;

function wholeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function formatNumber(value) {
  return wholeNumber(value).toLocaleString('en-IN');
}

function validPlatform(value) {
  return value === 'meesho' ? 'meesho' : 'flipkart';
}

function platformName(value) {
  return value === 'meesho' ? 'Meesho' : 'Flipkart';
}

function formatName(value) {
  const format = String(value || 'Standard').replace(/^(fk|ms)-/, '').replace(/-/g, ' ');
  return format.replace(/\b\w/g, letter => letter.toUpperCase());
}

function renderPublicCount(value) {
  const count = el('publicLabelCount');
  if (count) count.textContent = Number.isFinite(Number(value)) ? formatNumber(value) : '—';
}

function watchPublicCount() {
  if (!db) return renderPublicCount(null);
  onSnapshot(doc(db, 'publicStats', 'usage'), snapshot => {
    renderPublicCount(snapshot.exists() ? snapshot.data().labelCount : 0);
  }, () => renderPublicCount(null));
}

function emptyTotals() {
  return {
    orders: 0,
    pieces: 0,
    batches: 0,
    last30: 0,
    flipkart: { orders: 0, pieces: 0 },
    meesho: { orders: 0, pieces: 0 }
  };
}

function renderSellerDashboard(items) {
  const totals = emptyTotals();
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  items.forEach(item => {
    const platform = validPlatform(item.platform);
    const orders = wholeNumber(item.totalOrders);
    const pieces = wholeNumber(item.totalPieces);
    totals.orders += orders;
    totals.pieces += pieces;
    totals.batches += 1;
    totals[platform].orders += orders;
    totals[platform].pieces += pieces;
    if (wholeNumber(item.createdAt) >= thirtyDaysAgo) totals.last30 += orders;
  });

  el('dash_allOrders').textContent = formatNumber(totals.orders);
  el('dash_totalPieces').textContent = formatNumber(totals.pieces);
  el('dash_batches').textContent = formatNumber(totals.batches);
  el('dash_last30').textContent = formatNumber(totals.last30);
  el('dash_fkOrders').textContent = formatNumber(totals.flipkart.orders);
  el('dash_fkPieces').textContent = formatNumber(totals.flipkart.pieces);
  el('dash_msOrders').textContent = formatNumber(totals.meesho.orders);
  el('dash_msPieces').textContent = formatNumber(totals.meesho.pieces);

  const recent = [...items].sort((a, b) => wholeNumber(b.createdAt) - wholeNumber(a.createdAt)).slice(0, 8);
  const body = el('dash_recentBody');
  body.replaceChildren();
  el('dash_empty').classList.toggle('hidden', recent.length > 0);
  recent.forEach(item => {
    const row = document.createElement('tr');
    const dateCell = document.createElement('td');
    const platformCell = document.createElement('td');
    const formatCell = document.createElement('td');
    const ordersCell = document.createElement('td');
    const piecesCell = document.createElement('td');
    const date = new Date(wholeNumber(item.createdAt));
    dateCell.textContent = Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const badge = document.createElement('span');
    badge.className = `status-badge ${item.platform === 'meesho' ? 'status-badge--pink' : 'status-badge--brand'}`;
    badge.textContent = platformName(item.platform);
    platformCell.appendChild(badge);
    formatCell.textContent = formatName(item.format);
    ordersCell.textContent = formatNumber(item.totalOrders);
    piecesCell.textContent = formatNumber(item.totalPieces);
    ordersCell.className = piecesCell.className = 'number';
    row.append(dateCell, platformCell, formatCell, ordersCell, piecesCell);
    body.appendChild(row);
  });

  el('dash_lastUpdated').textContent = items.length
    ? `Showing your latest ${Math.min(8, items.length)} of ${items.length.toLocaleString('en-IN')} private processing batches.`
    : 'Your latest successful label batches will appear here.';
}

function watchSellerDashboard() {
  if (sellerUnsubscribe) sellerUnsubscribe();
  sellerUnsubscribe = null;
  const user = window.appState?.currentUser;
  if (!db || !user || window.appState.role !== 'seller') return;
  const firstName = String(user.displayName || 'Seller').trim().split(/\s+/)[0];
  el('dash_greeting').textContent = `${firstName}, these totals contain only labels processed from your account.`;
  sellerUnsubscribe = onSnapshot(collection(db, 'users', user.uid, 'labelBatches'), snapshot => {
    const items = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderSellerDashboard(items);
  }, error => {
    console.warn('Private dashboard could not be loaded.', error);
    el('dash_lastUpdated').textContent = 'Your private activity could not be loaded. Check Firebase rules and try again.';
  });
}

window.recordLabelBatch = async payload => {
  const user = window.appState?.currentUser;
  if (!db || !user || window.appState.role !== 'seller') return;
  const totalOrders = Math.min(5000, wholeNumber(payload.totalOrders));
  const totalPieces = Math.min(50000, wholeNumber(payload.totalPieces));
  if (!totalOrders || totalPieces < totalOrders) return;
  await addDoc(collection(db, 'users', user.uid, 'labelBatches'), {
    ownerUid: user.uid,
    platform: validPlatform(payload.platform),
    format: String(payload.format || '').slice(0, 80),
    totalOrders,
    totalPieces,
    createdAt: Date.now()
  });
};

window.addEventListener('appUnlocked', watchSellerDashboard);
window.addEventListener('workspaceChanged', event => {
  if (event.detail?.app === 'dashboard') watchSellerDashboard();
});

watchPublicCount();
