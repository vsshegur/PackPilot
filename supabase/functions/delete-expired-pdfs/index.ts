import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const cleanupSecret = Deno.env.get('CLEANUP_SECRET') || '';
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

Deno.serve(async request => {
  if (request.method !== 'POST' || !cleanupSecret || request.headers.get('x-cleanup-secret') !== cleanupSecret) {
    return new Response(JSON.stringify({ error: 'Not allowed.' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  try {
    const { data: expired, error } = await admin
      .from('pdf_files')
      .select('id,storage_path')
      .lte('expires_at', new Date().toISOString())
      .limit(500);
    if (error) throw error;
    if (!expired?.length) {
      return new Response(JSON.stringify({ deleted: 0 }), { headers: { 'Content-Type': 'application/json' } });
    }

    const paths = expired.map(item => item.storage_path);
    const { error: storageError } = await admin.storage.from('seller-pdfs').remove(paths);
    if (storageError) throw storageError;
    const { error: databaseError } = await admin.from('pdf_files').delete().in('id', expired.map(item => item.id));
    if (databaseError) throw databaseError;

    return new Response(JSON.stringify({ deleted: expired.length }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Cleanup failed.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
});
