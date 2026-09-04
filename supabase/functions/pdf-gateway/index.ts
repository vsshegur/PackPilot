import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { corsHeaders, jsonResponse, requireFirebaseUser, type FirebaseUser } from '../_shared/security.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const BUCKET = 'seller-pdfs';
const SIX_HOURS = 6 * 60 * 60 * 1000;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

function safeName(value: unknown) {
  return String(value || 'print-file.pdf').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 150);
}

function safeInteger(value: unknown, maximum: number) {
  const parsed = Math.round(Number(value) || 0);
  return Math.max(0, Math.min(maximum, parsed));
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function canReadSeller(user: FirebaseUser, sellerUid: string) {
  if (user.uid === sellerUid) return true;
  const { data, error } = await admin
    .from('seller_managers')
    .select('seller_uid')
    .eq('seller_uid', sellerUid)
    .eq('manager_email', user.email)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function parseRequest(request: Request) {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    return {
      action: String(form.get('action') || ''),
      sellerUid: String(form.get('sellerUid') || ''),
      file: form.get('file'),
      metadata: String(form.get('metadata') || '{}')
    };
  }
  return await request.json();
}

Deno.serve(async request => {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') {
    return cors ? new Response(null, { status: 204, headers: cors }) : jsonResponse({ error: 'Origin not allowed.' }, 403, null);
  }
  if (request.method !== 'POST' || !cors) return jsonResponse({ error: 'Request not allowed.' }, 403, cors);

  try {
    const user = await requireFirebaseUser(request);
    const input = await parseRequest(request);
    const action = String(input.action || '');
    const sellerUid = String(input.sellerUid || '');
    if (!sellerUid) return jsonResponse({ error: 'Seller workspace is missing.' }, 400, cors);

    if (action === 'manager-upsert' || action === 'manager-remove') {
      if (user.uid !== sellerUid) return jsonResponse({ error: 'Only the Seller can change manager access.' }, 403, cors);
      const managerEmail = String(input.managerEmail || '').trim().toLowerCase();
      if (!validEmail(managerEmail) || managerEmail === user.email) {
        return jsonResponse({ error: 'Enter a different valid manager email.' }, 400, cors);
      }
      if (action === 'manager-upsert') {
        const { error } = await admin.from('seller_managers').upsert({ seller_uid: sellerUid, manager_email: managerEmail });
        if (error) throw error;
      } else {
        const { error } = await admin.from('seller_managers').delete().eq('seller_uid', sellerUid).eq('manager_email', managerEmail);
        if (error) throw error;
      }
      return jsonResponse({ ok: true }, 200, cors);
    }

    if (action === 'upload') {
      if (user.uid !== sellerUid) return jsonResponse({ error: 'Only the Seller can upload PDFs.' }, 403, cors);
      if (!(input.file instanceof File)) return jsonResponse({ error: 'Choose a PDF file.' }, 400, cors);
      const file = input.file as File;
      const fileName = safeName(file.name);
      if ((!fileName.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') || file.size <= 0 || file.size > MAX_PDF_BYTES) {
        return jsonResponse({ error: 'Upload a PDF smaller than 25 MB.' }, 400, cors);
      }
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(input.metadata || '{}'); } catch { metadata = {}; }
      const generatedAt = Number(metadata.generatedAt) || 0;
      const platform = String(metadata.platform || '').toLowerCase();
      const labelFormat = String(metadata.format || '');
      const totalOrders = safeInteger(metadata.totalOrders, 5000);
      if (
        metadata.source !== 'label-cutter'
        || !['flipkart', 'meesho'].includes(platform)
        || !labelFormat
        || totalOrders < 1
        || generatedAt < Date.now() - SIX_HOURS
        || generatedAt > Date.now() + (5 * 60 * 1000)
      ) {
        return jsonResponse({ error: 'Only a label PDF processed in PackPilot during the last six hours can be shared.' }, 400, cors);
      }
      const id = crypto.randomUUID();
      const storagePath = `${sellerUid}/${id}.pdf`;
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + SIX_HOURS);
      const { error: uploadError } = await admin.storage.from(BUCKET).upload(storagePath, file, {
        contentType: 'application/pdf',
        cacheControl: '0',
        upsert: false
      });
      if (uploadError) throw uploadError;
      const record = {
        id,
        seller_uid: sellerUid,
        uploaded_by_uid: user.uid,
        uploaded_by_email: user.email,
        file_name: fileName,
        storage_path: storagePath,
        size_bytes: file.size,
        platform: platform.slice(0, 40),
        label_format: labelFormat.slice(0, 80),
        total_orders: totalOrders,
        total_pieces: safeInteger(metadata.totalPieces, 50000),
        created_at: createdAt.toISOString(),
        expires_at: expiresAt.toISOString()
      };
      const { error: insertError } = await admin.from('pdf_files').insert(record);
      if (insertError) {
        await admin.storage.from(BUCKET).remove([storagePath]);
        throw insertError;
      }
      return jsonResponse({ ok: true, id, expiresAt: expiresAt.getTime() }, 201, cors);
    }

    const mayRead = await canReadSeller(user, sellerUid);
    if (!mayRead) return jsonResponse({ error: 'You do not have access to this Seller’s PDFs.' }, 403, cors);

    if (action === 'list') {
      const { data, error } = await admin
        .from('pdf_files')
        .select('id,file_name,size_bytes,platform,label_format,total_orders,total_pieces,created_at,expires_at')
        .eq('seller_uid', sellerUid)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      const files = (data || []).map(file => ({
        id: file.id,
        fileName: file.file_name,
        size: Number(file.size_bytes),
        platform: file.platform,
        format: file.label_format,
        totalOrders: file.total_orders,
        totalPieces: file.total_pieces,
        createdAt: new Date(file.created_at).getTime(),
        expiresAt: new Date(file.expires_at).getTime()
      }));
      return jsonResponse({ files }, 200, cors);
    }

    if (action === 'download-url') {
      const pdfId = String(input.pdfId || '');
      const { data: file, error } = await admin
        .from('pdf_files')
        .select('id,file_name,storage_path,expires_at')
        .eq('id', pdfId)
        .eq('seller_uid', sellerUid)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
      if (error) throw error;
      if (!file) return jsonResponse({ error: 'This PDF has expired or was deleted.' }, 404, cors);
      const options = input.mode === 'download' ? { download: safeName(file.file_name) } : undefined;
      const { data, error: signError } = await admin.storage.from(BUCKET).createSignedUrl(file.storage_path, 60, options);
      if (signError) throw signError;
      return jsonResponse({ url: data.signedUrl }, 200, cors);
    }

    if (action === 'delete') {
      if (user.uid !== sellerUid) return jsonResponse({ error: 'Only the Seller can delete PDFs.' }, 403, cors);
      const pdfId = String(input.pdfId || '');
      const { data: file, error } = await admin
        .from('pdf_files')
        .select('id,storage_path')
        .eq('id', pdfId)
        .eq('seller_uid', sellerUid)
        .maybeSingle();
      if (error) throw error;
      if (!file) return jsonResponse({ ok: true }, 200, cors);
      const { error: removeError } = await admin.storage.from(BUCKET).remove([file.storage_path]);
      if (removeError) throw removeError;
      const { error: deleteError } = await admin.from('pdf_files').delete().eq('id', pdfId).eq('seller_uid', sellerUid);
      if (deleteError) throw deleteError;
      return jsonResponse({ ok: true }, 200, cors);
    }

    return jsonResponse({ error: 'Unknown cloud action.' }, 400, cors);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : 'Cloud PDF request failed.';
    return jsonResponse({ error: message }, /sign in|token|jwt/i.test(message) ? 401 : 500, cors);
  }
});
