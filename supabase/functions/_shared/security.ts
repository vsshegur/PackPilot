import { createRemoteJWKSet, jwtVerify } from 'npm:jose@5.9.6';

export type FirebaseUser = {
  uid: string;
  email: string;
};

const firebaseProjectId = Deno.env.get('FIREBASE_PROJECT_ID') || '';
const firebaseKeys = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

function allowedOrigins() {
  return new Set(
    String(Deno.env.get('ALLOWED_ORIGINS') || '')
      .split(',')
      .map(value => value.trim().replace(/\/+$/, ''))
      .filter(Boolean)
  );
}

export function corsHeaders(request: Request) {
  const origin = String(request.headers.get('origin') || '').replace(/\/+$/, '');
  if (!origin || !allowedOrigins().has(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}

export function jsonResponse(body: unknown, status: number, cors: Record<string, string> | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(cors || {})
    }
  });
}

export async function requireFirebaseUser(request: Request): Promise<FirebaseUser> {
  if (!firebaseProjectId) throw new Error('FIREBASE_PROJECT_ID is not configured.');
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new Error('Sign in is required.');
  const { payload } = await jwtVerify(token, firebaseKeys, {
    issuer: `https://securetoken.google.com/${firebaseProjectId}`,
    audience: firebaseProjectId
  });
  const uid = String(payload.sub || '');
  const email = String(payload.email || '').trim().toLowerCase();
  if (!uid || !email || payload.email_verified === false) throw new Error('A verified Google email is required.');
  return { uid, email };
}
