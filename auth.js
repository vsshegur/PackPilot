import { auth, db, provider } from './firebase-config.js';
import { makeThermalLogo, readImageAsDataUrl } from './logoTools.js';
import { DEFAULT_LABEL_FORMATS, normalizeLabelFormats } from './labelFormats.js';
import { clearCloudGatewayConfigCache } from './cloudGateway.js';
import {
  signInWithPopup,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs,
  onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const ADMIN_EMAIL = 'vsshegur@gmail.com';
const APP_META = {
  dashboard: { eyebrow: 'Private seller overview', title: 'Dashboard' },
  labelCutter: { eyebrow: "Today's workspace", title: 'Label Cutter' },
  fkPnlCalculator: { eyebrow: 'Profit review', title: 'Flipkart P&L' },
  meeshoPnl: { eyebrow: 'Profit review', title: 'Meesho P&L' },
  settlement: { eyebrow: 'Payment control', title: 'Reconciliation' },
  skuMaster: { eyebrow: 'Product data', title: 'SKU Master' },
  marginCalculator: { eyebrow: 'Listing decision', title: 'Margin Calculator' },
  cloudLibrary: { eyebrow: 'Print handoff', title: 'Cloud PDFs' },
  team: { eyebrow: 'People & access', title: 'Operations Team' },
  settings: { eyebrow: 'Account', title: 'Settings' }
};

const el = id => document.getElementById(id);
const workspaceIds = ['dashboardWorkspace', 'labelWorkspace', 'fkPnlWorkspace', 'meeshoPnlWorkspace', 'settlementWorkspace', 'skuMasterWorkspace', 'marginWorkspace', 'cloudLibraryWorkspace', 'teamWorkspace', 'settingsWorkspace', 'adminPanel'];
const fallbackAvatar = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" rx="20" fill="#eef2ff"/><circle cx="40" cy="31" r="14" fill="#818cf8"/><path d="M17 71c2-16 11-24 23-24s21 8 23 24" fill="#4f46e5"/></svg>')}`;
let managerInviteUnsubscribe = null;
let managerInviteRefreshActive = false;

window.appState = {
  userSkus: {},
  storeLinks: [],
  brandLogoBase64: null,
  brandLogoPreferenceLoaded: false,
  labelFormats: { ...DEFAULT_LABEL_FORMATS },
  isUnlocked: false,
  currentUser: null,
  currentApp: 'labelCutter',
  userPlan: {},
  role: null,
  ownerUid: null,
  ownerEmail: null,
  workspaceUid: null,
  skuMaster: {}
};

function isOperationsManager() {
  return window.appState.role === 'operations_manager';
}

function applyRoleUi() {
  const manager = isOperationsManager();
  document.body.classList.toggle('operation-manager-mode', manager);
  document.querySelectorAll('.seller-only').forEach(node => node.classList.toggle('role-hidden', manager));
  document.querySelectorAll('.seller-cloud-only').forEach(node => node.classList.toggle('role-hidden', window.appState.role !== 'seller'));
  document.querySelectorAll('.manager-only').forEach(node => node.classList.toggle('role-hidden', !manager));
  const description = el('cloudRoleDescription');
  if (description) {
    description.textContent = manager
      ? 'Only active PDFs explicitly shared by your Seller are shown here.'
      : 'Ready-to-print files are available to your operations team for six hours only.';
  }
  const ownerDescription = el('cloud_managerOwner');
  if (ownerDescription && manager) {
    const owner = window.appState.ownerEmail || 'your Seller';
    ownerDescription.textContent = `Only PDFs explicitly shared by ${owner} appear here. You cannot open labels, reports, settings, or any other Seller data.`;
  }
}

function requestManagerInvitationDecision(invitation, existingSeller) {
  const dialog = el('managerInviteDialog');
  const accept = el('managerInviteAccept');
  const reject = el('managerInviteReject');
  const seller = invitation.ownerName || invitation.ownerEmail || 'A PackPilot Seller';
  el('managerInviteSeller').textContent = seller;
  el('managerInviteSellerWarning').classList.toggle('hidden', !existingSeller);
  reject.textContent = existingSeller ? 'Reject and stay Seller' : 'Reject invitation';
  dialog.classList.remove('hidden');
  document.body.classList.add('invitation-open');

  return new Promise(resolve => {
    const finish = decision => {
      dialog.classList.add('hidden');
      document.body.classList.remove('invitation-open');
      accept.onclick = null;
      reject.onclick = null;
      resolve(decision);
    };
    accept.onclick = () => finish('accepted');
    reject.onclick = () => finish('rejected');
  });
}

function watchManagerInvitation(user) {
  if (managerInviteUnsubscribe) managerInviteUnsubscribe();
  managerInviteUnsubscribe = null;
  const emailKey = String(user?.email || '').trim().toLowerCase();
  if (!emailKey || user.email === ADMIN_EMAIL) return;
  managerInviteUnsubscribe = onSnapshot(doc(db, 'managerInvites', emailKey), snapshot => {
    const invite = snapshot.exists() ? snapshot.data() : null;
    const pending = invite?.managerEmail === emailKey && invite.status === 'pending';
    const managerAccessEnded = isOperationsManager()
      && (!invite || invite.status !== 'accepted' || invite.acceptedUid !== user.uid);
    if ((!pending && !managerAccessEnded) || managerInviteRefreshActive) return;
    managerInviteRefreshActive = true;
    handleSignedInUser(user).catch(error => {
      console.error(error);
      alert(`Your account access could not be refreshed: ${error.message}`);
    }).finally(() => {
      managerInviteRefreshActive = false;
    });
  }, error => console.warn('Manager invitations could not be watched.', error));
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('shegurs-theme', theme);
  const toggle = el('themeToggle');
  if (toggle) {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    toggle.setAttribute('aria-label', `Switch to ${nextTheme} mode`);
    toggle.title = `Switch to ${nextTheme} mode`;
  }
}

setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
el('themeToggle').addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

function setAppChrome(visible) {
  const manager = visible && isOperationsManager();
  el('appSidebar').classList.toggle('hidden', !visible || manager);
  el('mobileMenuBtn').classList.toggle('hidden', !visible || manager);
  el('pageIdentity').classList.toggle('hidden', !visible);
  if (!visible) closeMobileMenu();
}

function closeMobileMenu() {
  const sidebar = el('appSidebar');
  const backdrop = el('mobileMenuBackdrop');
  const button = el('mobileMenuBtn');
  sidebar.classList.remove('is-mobile-open');
  backdrop.classList.remove('is-open');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', 'Open navigation');
  document.body.classList.remove('mobile-menu-open');
}

function openMobileMenu() {
  if (!window.appState.isUnlocked) return;
  const sidebar = el('appSidebar');
  const backdrop = el('mobileMenuBackdrop');
  const button = el('mobileMenuBtn');
  sidebar.classList.add('is-mobile-open');
  backdrop.classList.add('is-open');
  button.setAttribute('aria-expanded', 'true');
  button.setAttribute('aria-label', 'Close navigation');
  document.body.classList.add('mobile-menu-open');
}

el('mobileMenuBtn').addEventListener('click', () => {
  if (el('appSidebar').classList.contains('is-mobile-open')) closeMobileMenu();
  else openMobileMenu();
});
el('mobileMenuBackdrop').addEventListener('click', closeMobileMenu);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMobileMenu();
});
window.addEventListener('resize', () => {
  if (window.innerWidth > 820) closeMobileMenu();
});

function updateNavigation(appId) {
  document.querySelectorAll('[data-app]').forEach(button => {
    const active = button.dataset.app === appId;
    button.classList.toggle('is-active', active);
    if (button.closest('[role="navigation"], nav')) {
      button.setAttribute('aria-current', active ? 'page' : 'false');
    }
  });

  const meta = APP_META[appId] || APP_META.labelCutter;
  el('pageEyebrow').textContent = meta.eyebrow;
  el('pageTitle').textContent = meta.title;
}

function navigateApp(appId, { notify = true } = {}) {
  if (!window.appState.isUnlocked || !APP_META[appId]) return;
  if (isOperationsManager() && appId !== 'cloudLibrary') appId = 'cloudLibrary';
  if (appId === 'dashboard' && window.appState.role !== 'seller') appId = 'labelCutter';
  window.appState.currentApp = appId;
  closeMobileMenu();
  workspaceIds.forEach(id => el(id).classList.add('hidden'));

  if (appId === 'dashboard') el('dashboardWorkspace').classList.remove('hidden');
  if (appId === 'labelCutter') el('labelWorkspace').classList.remove('hidden');
  if (appId === 'fkPnlCalculator') el('fkPnlWorkspace').classList.remove('hidden');
  if (appId === 'meeshoPnl') el('meeshoPnlWorkspace').classList.remove('hidden');
  if (appId === 'settlement') el('settlementWorkspace').classList.remove('hidden');
  if (appId === 'skuMaster') el('skuMasterWorkspace').classList.remove('hidden');
  if (appId === 'marginCalculator') el('marginWorkspace').classList.remove('hidden');
  if (appId === 'cloudLibrary') el('cloudLibraryWorkspace').classList.remove('hidden');
  if (appId === 'team') el('teamWorkspace').classList.remove('hidden');
  if (appId === 'settings') {
    el('settingsWorkspace').classList.remove('hidden');
    renderSettings();
  }

  el('adminToggleBtn').textContent = 'Admin';
  updateNavigation(appId);
  if (notify) window.dispatchEvent(new CustomEvent('workspaceChanged', { detail: { app: appId } }));
}

document.querySelectorAll('[data-app]').forEach(button => {
  button.addEventListener('click', () => navigateApp(button.dataset.app));
});

el('openSettingsBtn').addEventListener('click', () => navigateApp(isOperationsManager() ? 'cloudLibrary' : 'settings'));

function resetSignedOutView() {
  if (managerInviteUnsubscribe) managerInviteUnsubscribe();
  managerInviteUnsubscribe = null;
  managerInviteRefreshActive = false;
  window.appState.currentUser = null;
  window.appState.userSkus = {};
  window.appState.storeLinks = [];
  window.appState.brandLogoBase64 = null;
  window.appState.brandLogoPreferenceLoaded = false;
  window.appState.labelFormats = { ...DEFAULT_LABEL_FORMATS };
  window.appState.isUnlocked = false;
  window.appState.currentApp = 'labelCutter';
  window.appState.role = null;
  window.appState.ownerUid = null;
  window.appState.ownerEmail = null;
  window.appState.workspaceUid = null;
  window.appState.skuMaster = {};
  document.body.classList.remove('operation-manager-mode', 'invitation-open');
  el('managerInviteDialog').classList.add('hidden');
  workspaceIds.forEach(id => el(id).classList.add('hidden'));
  el('authPanel').classList.remove('hidden');
  el('authWarning').classList.remove('hidden');
  el('authFeatures').classList.remove('hidden');
  el('expiredWarning').classList.add('hidden');
  el('userInfo').classList.add('hidden');
  el('adminToggleBtn').classList.add('hidden');
  setAppChrome(false);
}

function showUnlockedView() {
  window.appState.isUnlocked = true;
  el('authPanel').classList.add('hidden');
  el('userInfo').classList.remove('hidden');
  setAppChrome(true);
  applyRoleUi();
  const defaultApp = isOperationsManager() ? 'cloudLibrary' : (window.appState.role === 'seller' ? 'dashboard' : 'labelCutter');
  navigateApp(defaultApp, { notify: false });
  window.dispatchEvent(new Event('appUnlocked'));
}

async function loadUserMemory(user) {
  try {
    const [skuResult, storeResult, brandingResult, preferencesResult] = await Promise.allSettled([
      getDoc(doc(db, 'users', user.uid, 'skus', 'memory')),
      getDoc(doc(db, 'users', user.uid, 'stores', 'memory')),
      getDoc(doc(db, 'users', user.uid, 'branding', 'memory')),
      getDoc(doc(db, 'users', user.uid, 'preferences', 'label-cutter'))
    ]);
    const skuSnap = skuResult.status === 'fulfilled' ? skuResult.value : null;
    const storeSnap = storeResult.status === 'fulfilled' ? storeResult.value : null;
    const brandingSnap = brandingResult.status === 'fulfilled' ? brandingResult.value : null;
    const preferencesSnap = preferencesResult.status === 'fulfilled' ? preferencesResult.value : null;
    if (skuSnap?.exists()) window.appState.userSkus = skuSnap.data() || {};
    if (storeSnap?.exists() && Array.isArray(storeSnap.data().links)) {
      window.appState.storeLinks = storeSnap.data().links;
    }
    if (brandingSnap?.exists()) {
      window.appState.brandLogoPreferenceLoaded = true;
      if (brandingSnap.data().logoDataUrl?.startsWith('data:image')) {
        window.appState.brandLogoBase64 = brandingSnap.data().logoDataUrl;
      }
    }
    if (preferencesSnap?.exists()) {
      window.appState.labelFormats = normalizeLabelFormats(preferencesSnap.data());
    } else if (preferencesResult.status === 'rejected') {
      try {
        const cached = JSON.parse(localStorage.getItem(`savedLabelFormats:${user.uid}`) || '{}');
        window.appState.labelFormats = normalizeLabelFormats(cached);
      } catch (error) {
        console.warn('Saved label sizes could not be read from this device.', error);
      }
    }
    [skuResult, storeResult, brandingResult, preferencesResult]
      .filter(result => result.status === 'rejected')
      .forEach(result => console.warn('An account preference could not be loaded.', result.reason));
  } catch (error) {
    console.warn('Account preferences could not be loaded.', error);
  }
}

async function handleSignedInUser(user) {
  el('authWarning').classList.add('hidden');
  el('authFeatures').classList.add('hidden');

  const userRef = doc(db, 'users', user.uid);
  const emailKey = String(user.email || '').trim().toLowerCase();
  const inviteRef = emailKey ? doc(db, 'managerInvites', emailKey) : null;
  const [userSnap, inviteSnap] = await Promise.all([
    getDoc(userRef),
    inviteRef ? getDoc(inviteRef) : Promise.resolve(null)
  ]);
  const invitation = inviteSnap?.exists() ? inviteSnap.data() : null;
  const matchingInvitation = invitation && invitation.managerEmail === emailKey ? { ...invitation } : null;
  const newUser = {
    email: user.email,
    name: user.displayName || 'User',
    photo: user.photoURL || '',
    role: user.email === ADMIN_EMAIL ? 'platform_super_admin' : 'seller',
    ownerUid: user.uid,
    planType: 'Free Trial',
    createdAt: Date.now(),
    expiresAt: Date.now() + (2 * 24 * 60 * 60 * 1000),
    isActive: true
  };
  const userData = userSnap.exists() ? { ...userSnap.data() } : newUser;
  const existingSeller = userSnap.exists() && ['user', 'seller', 'seller_owner'].includes(userData.role);
  let acceptedManager = Boolean(
    matchingInvitation
    && matchingInvitation.status === 'accepted'
    && matchingInvitation.acceptedUid === user.uid
  );

  if (user.email !== ADMIN_EMAIL && matchingInvitation?.status === 'pending') {
    const decision = await requestManagerInvitationDecision(matchingInvitation, existingSeller);
    if (decision === 'accepted') {
      await setDoc(inviteRef, {
        status: 'accepted',
        acceptedUid: user.uid,
        acceptedAt: Date.now(),
        updatedAt: Date.now()
      }, { merge: true });
      matchingInvitation.status = 'accepted';
      matchingInvitation.acceptedUid = user.uid;
      acceptedManager = true;
    } else {
      await setDoc(inviteRef, {
        status: 'rejected',
        acceptedUid: user.uid,
        acceptedAt: 0,
        updatedAt: Date.now()
      }, { merge: true });
      matchingInvitation.status = 'rejected';
      acceptedManager = false;
    }
  }

  if (user.email === ADMIN_EMAIL) {
    userData.role = 'platform_super_admin';
    userData.ownerUid = user.uid;
  } else if (acceptedManager) {
    userData.role = 'operations_manager';
    userData.ownerUid = matchingInvitation.ownerUid;
  } else if (userData.role === 'operations_manager') {
    userData.role = 'seller';
    userData.ownerUid = user.uid;
  } else {
    userData.role = 'seller';
    userData.ownerUid = user.uid;
  }

  const profileUpdate = {
      email: user.email,
      name: user.displayName || userData.name || 'User',
      photo: user.photoURL || userData.photo || '',
      role: userData.role,
      ownerUid: userData.ownerUid,
      lastSignInAt: Date.now()
  };
  try {
    if (!userSnap.exists()) await setDoc(userRef, userData);
    else await updateDoc(userRef, profileUpdate);
  } catch (error) {
    // Existing deployments may still use the previous internal role key until
    // the updated Firestore rules are deployed. Keep the visible role as Seller.
    if (userData.role !== 'seller' || !/permission|insufficient/i.test(`${error.code || ''} ${error.message || ''}`)) throw error;
    const legacyProfile = { ...profileUpdate, role: 'seller_owner' };
    if (!userSnap.exists()) await setDoc(userRef, { ...userData, role: 'seller_owner' });
    else await updateDoc(userRef, legacyProfile);
  }

  if (userData.role !== 'operations_manager') await loadUserMemory(user);
  window.appState.currentUser = user;
  window.appState.role = userData.role;
  window.appState.ownerUid = userData.ownerUid || user.uid;
  window.appState.ownerEmail = acceptedManager ? (matchingInvitation.ownerEmail || '') : user.email;
  window.appState.workspaceUid = userData.ownerUid || user.uid;

  if (acceptedManager) {
    try {
      await cloudGateway('manager-accept', { sellerUid: userData.ownerUid });
    } catch (error) {
      console.warn('Manager PDF access could not be activated yet.', error);
    }
  }
  const avatar = el('userAvatar');
  avatar.src = user.photoURL || fallbackAvatar;
  avatar.alt = user.displayName ? `${user.displayName}'s profile` : 'Account profile';
  avatar.onerror = () => { avatar.src = fallbackAvatar; };
  el('userName').textContent = user.displayName || 'User';
  el('userInfo').classList.remove('hidden');

  const isAdmin = userData.role === 'platform_super_admin';
  let accessData = userData;
  if (userData.role === 'operations_manager' && userData.ownerUid) {
    const ownerSnap = await getDoc(doc(db, 'users', userData.ownerUid));
    if (!ownerSnap.exists()) throw new Error('The Seller account could not be found.');
    accessData = ownerSnap.data();
  }
  const expiry = Number(accessData.expiresAt) || 0;
  const daysLeft = Math.max(0, Math.ceil((expiry - Date.now()) / (1000 * 60 * 60 * 24)));
  const isExpired = !isAdmin && (!accessData.isActive || expiry <= Date.now());

  window.appState.userPlan = {
    planType: isAdmin ? 'Super Admin' : (userData.role === 'operations_manager' ? 'Operations Manager' : (accessData.planType || 'Seller')),
    daysLeft: isAdmin ? 'Lifetime access' : `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`
  };
  el('userPlan').textContent = `${window.appState.userPlan.planType} · ${window.appState.userPlan.daysLeft}`;

  if (isAdmin) el('adminToggleBtn').classList.remove('hidden');

  if (isExpired) {
    el('expiredWarning').classList.remove('hidden');
    el('authPanel').classList.remove('hidden');
    setAppChrome(false);
    return;
  }

  showUnlockedView();
}

const signInButton = el('googleSignInBtn');
const signInMarkup = signInButton.innerHTML;

if (auth && db && provider) {
  onAuthStateChanged(auth, user => {
    if (!user) {
      resetSignedOutView();
      return;
    }
    handleSignedInUser(user)
      .then(() => watchManagerInvitation(user))
      .catch(error => {
        console.error(error);
        resetSignedOutView();
        alert(`Could not open your account: ${error.message}`);
      });
  });

  signInButton.addEventListener('click', async () => {
    signInButton.disabled = true;
    signInButton.textContent = 'Connecting…';
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      alert(`Login failed: ${error.message}\n\nAdd this website domain to Firebase Authentication → Authorized domains.`);
    } finally {
      signInButton.disabled = false;
      signInButton.innerHTML = signInMarkup;
    }
  });

  el('logoutBtn').addEventListener('click', () => signOut(auth));
  el('expiredLogoutBtn').addEventListener('click', () => signOut(auth));
} else {
  signInButton.addEventListener('click', () => {
    alert('Firebase is not configured. Update firebase-config.js before signing in.');
  });
}

function renderSettings() {
  const user = window.appState.currentUser;
  if (!user) return;
  el('set_userName').textContent = user.displayName || 'User';
  el('set_userEmail').textContent = user.email || '—';
  el('set_planType').textContent = window.appState.userPlan.planType || '—';
  el('set_daysLeft').textContent = window.appState.userPlan.daysLeft || '—';
  const customLogo = window.appState.brandLogoBase64;
  el('set_logoPreview').src = customLogo || './S_3.jpg';
  el('set_logoStatus').textContent = customLogo ? 'Your account logo' : "Shegur's default";
  const formats = normalizeLabelFormats(window.appState.labelFormats);
  el('set_fkFormat').value = formats.flipkart;
  el('set_msFormat').value = formats.meesho;

  const list = el('set_storeList');
  list.replaceChildren();
  const links = window.appState.storeLinks;
  el('set_storeEmpty').classList.toggle('hidden', links.length > 0);
  el('set_storeList').closest('.store-table').classList.toggle('hidden', links.length === 0);

  links.forEach((store, index) => {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const urlCell = document.createElement('td');
    const actionCell = document.createElement('td');
    const url = document.createElement('span');
    const remove = document.createElement('button');

    nameCell.textContent = store.name;
    nameCell.className = 'sku-id';
    url.textContent = store.url;
    url.title = store.url;
    url.className = 'store-url';
    urlCell.appendChild(url);
    remove.type = 'button';
    remove.className = 'mini-button mini-button--danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removeStore(index));
    actionCell.appendChild(remove);
    row.append(nameCell, urlCell, actionCell);
    list.appendChild(row);
  });
}

async function saveAccountLogo(thermalLogo) {
  const user = window.appState.currentUser;
  if (!user) throw new Error('Sign in again before saving your logo.');
  await setDoc(doc(db, 'users', user.uid, 'branding', 'memory'), {
    logoDataUrl: thermalLogo,
    updatedAt: Date.now()
  });
  window.appState.brandLogoBase64 = thermalLogo || null;
  window.appState.brandLogoPreferenceLoaded = true;
  const cacheKey = `savedBrandLogo:${user.uid}`;
  try {
    if (thermalLogo) localStorage.setItem(cacheKey, thermalLogo);
    else localStorage.removeItem(cacheKey);
  } catch (error) {
    console.warn('Logo could not be cached on this device.', error);
  }
  window.dispatchEvent(new CustomEvent('accountBrandLogoChanged', { detail: { dataUrl: thermalLogo || null } }));
  renderSettings();
}

el('set_logoInput').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  const message = el('set_logoMessage');
  message.textContent = 'Preparing and saving your logo…';
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('Choose an image smaller than 10 MB.');
    const thermalLogo = await makeThermalLogo(await readImageAsDataUrl(file));
    await saveAccountLogo(thermalLogo);
    message.textContent = 'Your logo is now the default for all label sizes.';
  } catch (error) {
    message.textContent = '';
    alert(`Logo could not be saved: ${error.message}`);
  } finally {
    event.target.value = '';
  }
});

el('set_resetLogoBtn').addEventListener('click', async () => {
  const button = el('set_resetLogoBtn');
  const message = el('set_logoMessage');
  button.disabled = true;
  message.textContent = "Restoring Shegur's default…";
  try {
    await saveAccountLogo('');
    message.textContent = "Shegur's logo is now your default.";
  } catch (error) {
    message.textContent = '';
    alert(`Default logo could not be restored: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

el('set_saveFormatsBtn').addEventListener('click', async () => {
  const user = window.appState.currentUser;
  if (!user) return;
  const button = el('set_saveFormatsBtn');
  const message = el('set_formatMessage');
  const formats = normalizeLabelFormats({
    flipkart: el('set_fkFormat').value,
    meesho: el('set_msFormat').value
  });
  button.disabled = true;
  message.textContent = 'Saving your label defaults…';
  try {
    await setDoc(doc(db, 'users', user.uid, 'preferences', 'label-cutter'), {
      ...formats,
      updatedAt: Date.now()
    }, { merge: true });
    window.appState.labelFormats = formats;
    try { localStorage.setItem(`savedLabelFormats:${user.uid}`, JSON.stringify(formats)); } catch (error) { console.warn('Label defaults could not be cached.', error); }
    window.dispatchEvent(new CustomEvent('labelFormatPreferencesChanged', { detail: formats }));
    message.textContent = 'Saved. These options will open automatically in Label Cutter.';
  } catch (error) {
    message.textContent = '';
    alert(`Label defaults could not be saved: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

el('set_addStoreBtn').addEventListener('click', async () => {
  const nameInput = el('set_storeName');
  const urlInput = el('set_storeUrl');
  const name = nameInput.value.trim();
  const url = urlInput.value.trim();
  if (!name || !url) {
    alert('Enter both the store name and its URL.');
    return;
  }

  try {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Unsupported URL');
  } catch {
    alert('Enter a valid store URL beginning with https://');
    urlInput.focus();
    return;
  }

  const duplicate = window.appState.storeLinks.some(store => store.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    alert('A store with this name match already exists. Remove it before adding a replacement.');
    return;
  }

  const button = el('set_addStoreBtn');
  button.disabled = true;
  try {
    window.appState.storeLinks.push({ name, url });
    await setDoc(doc(db, 'users', window.appState.currentUser.uid, 'stores', 'memory'), {
      links: window.appState.storeLinks
    });
    nameInput.value = '';
    urlInput.value = '';
    renderSettings();
  } catch (error) {
    window.appState.storeLinks.pop();
    alert(`Store link could not be saved: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

async function removeStore(index) {
  const previous = [...window.appState.storeLinks];
  window.appState.storeLinks.splice(index, 1);
  renderSettings();
  try {
    await setDoc(doc(db, 'users', window.appState.currentUser.uid, 'stores', 'memory'), {
      links: window.appState.storeLinks
    });
  } catch (error) {
    window.appState.storeLinks = previous;
    renderSettings();
    alert(`Store link could not be removed: ${error.message}`);
  }
}

el('adminToggleBtn').addEventListener('click', async () => {
  const adminPanel = el('adminPanel');
  if (adminPanel.classList.contains('hidden')) {
    workspaceIds.forEach(id => el(id).classList.add('hidden'));
    adminPanel.classList.remove('hidden');
    el('adminToggleBtn').textContent = 'Back to app';
    el('pageEyebrow').textContent = 'Administration';
    el('pageTitle').textContent = 'User Access';
    await Promise.all([loadAdminUsers(), loadCloudStorageConfig()]);
  } else {
    navigateApp(window.appState.currentApp);
  }
});

async function loadCloudStorageConfig() {
  const input = el('admin_supabaseUrl');
  const message = el('admin_supabaseMessage');
  if (!input || !message) return;
  try {
    const snapshot = await getDoc(doc(db, 'appConfig', 'cloudStorage'));
    input.value = snapshot.exists() ? String(snapshot.data().projectUrl || '') : '';
    message.textContent = input.value
      ? 'Supabase is connected for private six-hour PDF sharing.'
      : 'Not connected. Complete the Supabase steps below, then paste the Project URL here.';
  } catch (error) {
    message.textContent = `Cloud configuration could not be loaded: ${error.message}`;
  }
}

el('admin_saveSupabaseBtn')?.addEventListener('click', async () => {
  const input = el('admin_supabaseUrl');
  const message = el('admin_supabaseMessage');
  const button = el('admin_saveSupabaseBtn');
  const projectUrl = String(input.value || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(projectUrl)) {
    alert('Enter the Supabase Project URL in this format: https://your-project.supabase.co');
    input.focus();
    return;
  }
  button.disabled = true;
  message.textContent = 'Saving cloud connection…';
  try {
    await setDoc(doc(db, 'appConfig', 'cloudStorage'), {
      projectUrl,
      provider: 'supabase',
      updatedAt: Date.now(),
      updatedBy: window.appState.currentUser.uid
    });
    clearCloudGatewayConfigCache();
    message.textContent = 'Supabase connected. Sellers and assigned managers can now use Cloud PDFs.';
  } catch (error) {
    message.textContent = '';
    alert(`Cloud connection could not be saved: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

async function loadAdminUsers() {
  const tbody = el('adminUserTableBody');
  tbody.innerHTML = '<tr><td colspan="5">Loading users…</td></tr>';
  try {
    const snapshot = await getDocs(collection(db, 'users'));
    tbody.replaceChildren();

    if (snapshot.empty) {
      tbody.innerHTML = '<tr><td colspan="5">No users found.</td></tr>';
      return;
    }

    snapshot.forEach(userDoc => {
      const data = userDoc.data();
      const uid = userDoc.id;
      const expiry = Number(data.expiresAt) || 0;
      const daysLeft = Math.max(0, Math.ceil((expiry - Date.now()) / (1000 * 60 * 60 * 24)));
      const isAdmin = data.role === 'platform_super_admin' || data.role === 'admin';
      const row = document.createElement('tr');

      const userCell = document.createElement('td');
      const userWrap = document.createElement('div');
      const avatar = document.createElement('img');
      const userCopy = document.createElement('span');
      const userName = document.createElement('strong');
      const email = document.createElement('small');
      userWrap.className = 'admin-user';
      avatar.src = data.photo || fallbackAvatar;
      avatar.alt = '';
      avatar.onerror = () => { avatar.src = fallbackAvatar; };
      userName.textContent = data.name || 'User';
      email.textContent = data.email || 'No email';
      userCopy.append(userName, email);
      userWrap.append(avatar, userCopy);
      userCell.appendChild(userWrap);

      const roleCell = document.createElement('td');
      const roleLabel = isAdmin ? 'Super Admin' : (data.role === 'operations_manager' ? 'Operations Manager' : 'Seller');
      roleCell.innerHTML = `<span class="status-badge ${isAdmin ? 'status-badge--brand' : (data.role === 'operations_manager' ? 'status-badge--pink' : '')}">${roleLabel}</span>`;
      const planCell = document.createElement('td');
      const planBadge = document.createElement('span');
      planBadge.className = `status-badge ${data.planType === 'Paid Plan' ? 'status-badge--success' : 'status-badge--warning'}`;
      planBadge.textContent = data.planType || 'Free Trial';
      planCell.appendChild(planBadge);
      const accessCell = document.createElement('td');
      accessCell.textContent = isAdmin ? 'Lifetime' : `${daysLeft} days`;
      const actionCell = document.createElement('td');
      if (!isAdmin) {
        const adjuster = document.createElement('div');
        const daysInput = document.createElement('input');
        const apply = document.createElement('button');
        adjuster.className = 'day-adjuster';
        daysInput.type = 'number';
        daysInput.inputMode = 'numeric';
        daysInput.min = '-3650';
        daysInput.max = '3650';
        daysInput.step = '1';
        daysInput.placeholder = '+ / − days';
        daysInput.setAttribute('aria-label', `Days to add or reduce for ${data.name || 'user'}`);
        apply.type = 'button';
        apply.className = 'mini-button';
        apply.textContent = 'Apply';
        apply.addEventListener('click', () => updateDaysAdmin(uid, daysInput, apply));
        daysInput.addEventListener('keydown', event => {
          if (event.key === 'Enter') updateDaysAdmin(uid, daysInput, apply);
        });
        adjuster.append(daysInput, apply);
        actionCell.appendChild(adjuster);
      }
      row.append(userCell, roleCell, planCell, accessCell, actionCell);
      tbody.appendChild(row);
    });
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="5">Could not load users: ${error.message}</td></tr>`;
  }
}

async function updateDaysAdmin(uid, input, button) {
  const days = Number(input.value);
  if (!Number.isInteger(days) || days === 0 || Math.abs(days) > 3650) {
    alert('Enter a whole number from -3650 to 3650. Use a negative number to reduce days.');
    input.focus();
    return;
  }
  const action = days > 0 ? `add ${days}` : `reduce ${Math.abs(days)}`;
  if (!confirm(`Confirm: ${action} subscription ${Math.abs(days) === 1 ? 'day' : 'days'}?`)) return;
  button.disabled = true;
  try {
    const userRef = doc(db, 'users', uid);
    const snapshot = await getDoc(userRef);
    if (!snapshot.exists()) throw new Error('User record was not found.');
    const data = snapshot.data();
    const currentExpiry = Number(data.expiresAt) || Date.now();
    const baseTime = days > 0 ? Math.max(currentExpiry, Date.now()) : currentExpiry;
    const expiresAt = baseTime + (days * 24 * 60 * 60 * 1000);
    await updateDoc(userRef, {
      expiresAt,
      planType: days > 0 ? 'Paid Plan' : (data.planType || 'Paid Plan'),
      isActive: expiresAt > Date.now()
    });
    await loadAdminUsers();
  } catch (error) {
    alert(`Subscription could not be updated: ${error.message}`);
    button.disabled = false;
  }
}
