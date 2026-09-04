import { auth, db } from './firebase-config.js';
import {
  doc,
  getDoc
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

let cachedEndpoint = null;
let endpointPromise = null;

function normalizeProjectUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) return '';
  return url;
}

export function clearCloudGatewayConfigCache() {
  cachedEndpoint = null;
  endpointPromise = null;
}

export async function getCloudGatewayEndpoint() {
  if (cachedEndpoint) return cachedEndpoint;
  if (endpointPromise) return endpointPromise;
  endpointPromise = (async () => {
    if (!db) throw new Error('The application database is unavailable.');
    const snapshot = await getDoc(doc(db, 'appConfig', 'cloudStorage'));
    const projectUrl = normalizeProjectUrl(snapshot.exists() ? snapshot.data().projectUrl : '');
    if (!projectUrl) {
      throw new Error('Cloud PDF setup is not complete. Ask the Platform Super Admin to connect Supabase.');
    }
    cachedEndpoint = `${projectUrl}/functions/v1/pdf-gateway`;
    return cachedEndpoint;
  })();
  try {
    return await endpointPromise;
  } finally {
    endpointPromise = null;
  }
}

export async function cloudGateway(action, payload = {}) {
  const user = auth?.currentUser;
  if (!user) throw new Error('Sign in again to continue.');
  const endpoint = await getCloudGatewayEndpoint();
  const token = await user.getIdToken();
  const isForm = payload instanceof FormData;
  const body = isForm ? payload : JSON.stringify({ action, ...payload });
  if (isForm) body.set('action', action);

  const headers = { Authorization: `Bearer ${token}` };
  if (!isForm) headers['Content-Type'] = 'application/json';
  const response = await fetch(endpoint, { method: 'POST', headers, body });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Cloud request failed (${response.status}).`);
  return result;
}
