import { cloudGateway } from './cloudGateway.js';

const el = id => document.getElementById(id);
let activeItems = [];
let recentItems = [];
let countdownTimer = null;

function sellerUid() {
  return window.appState?.workspaceUid || window.appState?.ownerUid || window.appState?.currentUser?.uid;
}

function isSeller() {
  return window.appState?.role === 'seller';
}

function safeName(value) {
  return String(value || 'print-file.pdf').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 150);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countdown(expiresAt) {
  const remaining = Number(expiresAt) - Date.now();
  if (remaining <= 0) return 'Expired';
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.max(0, Math.ceil((remaining % 3600000) / 60000));
  return `Expires in ${hours}h ${minutes}m`;
}

function localCountdown(expiresAt) {
  const remaining = Number(expiresAt) - Date.now();
  if (remaining <= 0) return 'Local copy expired';
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.max(0, Math.ceil((remaining % 3600000) / 60000));
  return `Available for ${hours}h ${minutes}m`;
}

async function uploadCloudPdf(payload) {
  if (!isSeller()) throw new Error('Only the Seller can add cloud PDFs.');
  const uid = sellerUid();
  if (!uid || uid !== window.appState?.currentUser?.uid) throw new Error('Sign in again before saving this PDF.');
  const data = payload.bytes instanceof Blob ? payload.bytes : new Blob([payload.bytes], { type: 'application/pdf' });
  if (data.size > 25 * 1024 * 1024) throw new Error('Choose a PDF smaller than 25 MB.');
  const form = new FormData();
  form.set('sellerUid', uid);
  form.set('file', data, safeName(payload.fileName));
  form.set('metadata', JSON.stringify({
    source: payload.source || 'label-cutter',
    generatedAt: Number(payload.generatedAt) || Date.now(),
    platform: payload.platform || '',
    format: payload.format || '',
    totalOrders: Number(payload.totalOrders) || 0,
    totalPieces: Number(payload.totalPieces) || 0
  }));
  await cloudGateway('upload', form);
  await loadCloudPdfs();
}

async function loadRecentProcessedPdfs() {
  if (!isSeller()) return;
  const status = el('cloud_recentEmpty');
  status.classList.remove('hidden');
  status.textContent = 'Checking processed PDFs on this device…';
  try {
    recentItems = typeof window.getRecentProcessedPdfs === 'function'
      ? await window.getRecentProcessedPdfs()
      : [];
    renderRecentProcessedPdfs();
  } catch (error) {
    recentItems = [];
    renderRecentProcessedPdfs();
    status.classList.remove('hidden');
    status.textContent = error.message;
  }
}

function renderRecentProcessedPdfs() {
  const list = el('cloud_recentList');
  const empty = el('cloud_recentEmpty');
  list.replaceChildren();
  empty.classList.toggle('hidden', recentItems.length > 0);
  if (!recentItems.length) empty.textContent = 'No recent processed PDFs on this device. Process a label batch first.';

  recentItems.forEach(item => {
    const row = document.createElement('article');
    const icon = document.createElement('span');
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    const detail = document.createElement('small');
    const share = document.createElement('button');
    row.className = 'recent-output-item';
    icon.className = `market-file-mark market-file-mark--${item.platform === 'meesho' ? 'meesho' : 'flipkart'}`;
    icon.textContent = item.platform === 'meesho' ? 'M' : 'F';
    copy.className = 'recent-output-copy';
    title.textContent = item.fileName || 'Processed label PDF';
    title.title = title.textContent;
    detail.textContent = `${String(item.platform || '').toUpperCase()} · ${item.totalOrders || 0} orders · ${item.totalPieces || 0} pieces · ${localCountdown(item.expiresAt)}`;
    copy.append(title, detail);
    share.type = 'button';
    share.className = 'button button--primary recent-share-button';
    share.textContent = 'Share to manager';
    share.addEventListener('click', async () => {
      share.disabled = true;
      share.textContent = 'Sharing…';
      try {
        await uploadCloudPdf({
          bytes: item.data,
          fileName: item.fileName,
          platform: item.platform,
          format: item.format,
          totalOrders: item.totalOrders,
          totalPieces: item.totalPieces,
          generatedAt: item.timestamp,
          source: 'label-cutter'
        });
        share.textContent = 'Shared · expires in 6h';
      } catch (error) {
        share.disabled = false;
        share.textContent = 'Share to manager';
        alert(`PDF could not be shared: ${error.message}`);
      }
    });
    row.append(icon, copy, share);
    list.appendChild(row);
  });
}

async function loadCloudPdfs() {
  const uid = sellerUid();
  if (!uid || !window.appState?.currentUser) return;
  const manager = window.appState?.role === 'operations_manager';
  el('cloud_empty').textContent = manager
    ? 'Your Seller has not shared any active PDFs. Only explicitly shared files appear here.'
    : 'No active PDFs. Process labels and share a recent output from this device.';
  el('cloud_status').textContent = 'Checking active files…';
  try {
    const result = await cloudGateway('list', { sellerUid: uid });
    activeItems = Array.isArray(result.files)
      ? result.files.filter(item => Number(item.expiresAt) > Date.now()).sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
      : [];
    renderCloudPdfs();
    el('cloud_status').textContent = manager
      ? `${activeItems.length} ${activeItems.length === 1 ? 'shared PDF' : 'shared PDFs'} available to you`
      : `${activeItems.length} active ${activeItems.length === 1 ? 'file' : 'files'} · private to this Seller and accepted manager`;
  } catch (error) {
    activeItems = [];
    renderCloudPdfs();
    el('cloud_status').textContent = error.message;
  }
}

function renderCloudPdfs() {
  const list = el('cloud_list');
  list.replaceChildren();
  el('cloud_empty').classList.toggle('hidden', activeItems.length > 0);
  activeItems.forEach(item => {
    const row = document.createElement('article');
    const icon = document.createElement('span');
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    const detail = document.createElement('small');
    const expiry = document.createElement('span');
    const actions = document.createElement('div');
    row.className = 'cloud-item';
    icon.className = 'cloud-file-icon';
    icon.textContent = 'PDF';
    copy.className = 'cloud-item__copy';
    title.textContent = item.fileName || 'Print file.pdf';
    title.title = item.fileName || '';
    const created = new Date(Number(item.createdAt)).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const format = item.format ? ` · ${item.format}` : '';
    const batch = item.totalOrders ? ` · ${item.totalOrders} orders · ${item.totalPieces || 0} pieces` : '';
    detail.textContent = `${String(item.platform || 'uploaded').toUpperCase()}${format} · ${formatBytes(Number(item.size) || 0)}${batch} · shared ${created}`;
    copy.append(title, detail);
    expiry.className = 'expiry-chip';
    expiry.dataset.expiry = String(item.expiresAt);
    expiry.textContent = countdown(item.expiresAt);
    actions.className = 'cloud-item__actions';
    const preview = document.createElement('button');
    const download = document.createElement('button');
    preview.type = download.type = 'button';
    preview.className = 'mini-button';
    download.className = 'mini-button mini-button--success';
    preview.textContent = 'Preview';
    download.textContent = 'Download';
    preview.addEventListener('click', () => openCloudPdf(item));
    download.addEventListener('click', () => downloadCloudPdf(item));
    actions.append(preview, download);
    if (isSeller()) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mini-button mini-button--danger';
      remove.textContent = 'Delete now';
      remove.addEventListener('click', () => deleteCloudPdf(item));
      actions.appendChild(remove);
    }
    row.append(icon, copy, expiry, actions);
    list.appendChild(row);
  });
}

async function getActiveUrl(item, mode) {
  if (Number(item.expiresAt) <= Date.now()) {
    await loadCloudPdfs();
    throw new Error('This PDF has expired and is no longer available.');
  }
  const result = await cloudGateway('download-url', {
    sellerUid: sellerUid(),
    pdfId: item.id,
    mode
  });
  if (!result.url) throw new Error('A secure PDF link could not be created.');
  return result.url;
}

async function openCloudPdf(item) {
  const previewWindow = window.open('', '_blank');
  if (!previewWindow) return alert('Allow pop-ups for this site to preview the PDF.');
  previewWindow.document.body.innerHTML = '<p style="font:600 16px system-ui;padding:32px">Opening secure PDF…</p>';
  try {
    previewWindow.location.href = await getActiveUrl(item, 'preview');
  } catch (error) {
    previewWindow.close();
    alert(error.message);
  }
}

async function downloadCloudPdf(item) {
  try {
    const anchor = document.createElement('a');
    anchor.href = await getActiveUrl(item, 'download');
    anchor.download = safeName(item.fileName);
    anchor.rel = 'noopener';
    anchor.click();
  } catch (error) {
    alert(error.message);
  }
}

async function deleteCloudPdf(item) {
  if (!isSeller()) return;
  if (!confirm(`Permanently delete ${item.fileName || 'this PDF'} now? Your manager will immediately lose access.`)) return;
  try {
    await cloudGateway('delete', { sellerUid: sellerUid(), pdfId: item.id });
    activeItems = activeItems.filter(file => file.id !== item.id);
    renderCloudPdfs();
    el('cloud_status').textContent = `${item.fileName || 'PDF'} was permanently deleted.`;
  } catch (error) {
    alert(`PDF could not be deleted: ${error.message}`);
  }
}

el('lc_cloudSaveBtn').addEventListener('click', async () => {
  const button = el('lc_cloudSaveBtn');
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Saving securely…';
  try {
    if (typeof window.getPreparedLabelPdf !== 'function') throw new Error('Label output is not ready.');
    await uploadCloudPdf(await window.getPreparedLabelPdf());
    button.textContent = 'Saved · expires in 6h';
    setTimeout(() => { button.textContent = original; }, 2500);
  } catch (error) {
    button.textContent = original;
    alert(`PDF could not be saved to the cloud: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

el('cloud_refreshBtn').addEventListener('click', loadCloudPdfs);
el('cloud_refreshLocalBtn').addEventListener('click', loadRecentProcessedPdfs);
window.addEventListener('appUnlocked', () => {
  loadCloudPdfs();
  loadRecentProcessedPdfs();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    let expiredFound = false;
    document.querySelectorAll('[data-expiry]').forEach(node => {
      node.textContent = countdown(node.dataset.expiry);
      if (Number(node.dataset.expiry) <= Date.now()) expiredFound = true;
    });
    if (expiredFound) loadCloudPdfs();
  }, 30000);
});
window.addEventListener('workspaceChanged', event => {
  if (event.detail?.app === 'cloudLibrary') {
    loadCloudPdfs();
    loadRecentProcessedPdfs();
  }
});
window.addEventListener('processedPdfHistoryChanged', loadRecentProcessedPdfs);
