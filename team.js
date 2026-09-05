import { db } from './firebase-config.js';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  setDoc,
  where
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { cloudGateway } from './cloudGateway.js';

const el = id => document.getElementById(id);
let invitations = [];

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function loadInvitations() {
  const user = window.appState?.currentUser;
  if (!user || window.appState.role !== 'seller' || !db) return;
  try {
    const snapshot = await getDocs(query(collection(db, 'managerInvites'), where('ownerUid', '==', user.uid)));
    invitations = snapshot.docs.map(item => ({ id: item.id, ...item.data() })).sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    renderInvitations();
    Promise.allSettled(invitations.filter(invite => invite.status === 'accepted').map(invite => cloudGateway('manager-upsert', {
      sellerUid: user.uid,
      managerEmail: invite.managerEmail
    }))).catch(() => {});
  } catch (error) {
    el('team_message').textContent = `Invitations could not be loaded: ${error.message}`;
  }
}

function renderInvitations() {
  const body = el('team_body');
  body.replaceChildren();
  el('team_empty').classList.toggle('hidden', invitations.length > 0);
  invitations.forEach(invite => {
    const row = document.createElement('tr');
    const emailCell = document.createElement('td');
    const statusCell = document.createElement('td');
    const dateCell = document.createElement('td');
    const actionCell = document.createElement('td');
    emailCell.textContent = invite.managerEmail;
    emailCell.className = 'sku-id';
    const status = document.createElement('span');
    const statusMap = {
      accepted: { className: 'status-badge--success', label: 'Accepted · active' },
      rejected: { className: 'status-badge--muted', label: 'Rejected' },
      pending: { className: 'status-badge--warning', label: 'Awaiting response' }
    };
    const inviteStatus = statusMap[invite.status] || statusMap.pending;
    status.className = `status-badge ${inviteStatus.className}`;
    status.textContent = inviteStatus.label;
    statusCell.appendChild(status);
    dateCell.textContent = new Date(Number(invite.createdAt)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'mini-button mini-button--danger';
    revoke.textContent = 'Revoke';
    revoke.addEventListener('click', () => revokeInvitation(invite));
    actionCell.appendChild(revoke);
    row.append(emailCell, statusCell, dateCell, actionCell);
    body.appendChild(row);
  });
}

async function revokeInvitation(invite) {
  if (!confirm(`Remove PDF access for ${invite.managerEmail}?`)) return;
  try {
    try {
      await cloudGateway('manager-remove', {
        sellerUid: window.appState.currentUser.uid,
        managerEmail: invite.managerEmail
      });
    } catch (error) {
      if (!/setup is not complete/i.test(error.message)) throw error;
    }
    await deleteDoc(doc(db, 'managerInvites', invite.id));
    invitations = invitations.filter(item => item.id !== invite.id);
    renderInvitations();
    el('team_message').textContent = `${invite.managerEmail} can no longer open your cloud PDF desk.`;
  } catch (error) {
    alert(`Access could not be revoked: ${error.message}`);
  }
}

el('team_inviteBtn').addEventListener('click', async () => {
  const user = window.appState?.currentUser;
  if (!user || window.appState?.role !== 'seller') return;
  const email = normalizeEmail(el('team_email').value);
  if (!validEmail(email)) {
    alert('Enter a valid Google account email.');
    el('team_email').focus();
    return;
  }
  if (email === normalizeEmail(user?.email)) {
    alert('Use your manager’s email, not the Seller email.');
    return;
  }
  const button = el('team_inviteBtn');
  button.disabled = true;
  el('team_message').textContent = `Adding ${email}…`;
  try {
    await setDoc(doc(db, 'managerInvites', email), {
      managerEmail: email,
      ownerUid: user.uid,
      ownerEmail: normalizeEmail(user.email),
      ownerName: user.displayName || 'PackPilot Seller',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    el('team_email').value = '';
    el('team_message').textContent = `${email} was invited. They must accept the Operations Manager role after Google sign-in before any PDF access starts.`;
    await loadInvitations();
  } catch (error) {
    el('team_message').textContent = '';
    alert(`Invitation could not be saved: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

window.addEventListener('appUnlocked', loadInvitations);
window.addEventListener('workspaceChanged', event => {
  if (event.detail?.app === 'team') loadInvitations();
});
