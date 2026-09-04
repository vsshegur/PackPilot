create extension if not exists pgcrypto;

create table if not exists public.seller_managers (
  seller_uid text not null,
  manager_email text not null check (manager_email = lower(manager_email)),
  created_at timestamptz not null default now(),
  primary key (seller_uid, manager_email)
);

create table if not exists public.pdf_files (
  id uuid primary key default gen_random_uuid(),
  seller_uid text not null,
  uploaded_by_uid text not null,
  uploaded_by_email text not null default '',
  file_name text not null,
  storage_path text not null unique,
  size_bytes bigint not null check (size_bytes >= 0 and size_bytes <= 26214400),
  platform text not null default 'uploaded',
  label_format text not null default '',
  total_orders integer not null default 0,
  total_pieces integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '6 hours')
);

create index if not exists pdf_files_seller_expiry_idx
  on public.pdf_files (seller_uid, expires_at desc);

create index if not exists pdf_files_expiry_idx
  on public.pdf_files (expires_at);

alter table public.seller_managers enable row level security;
alter table public.pdf_files enable row level security;

revoke all on table public.seller_managers from anon, authenticated;
revoke all on table public.pdf_files from anon, authenticated;

comment on table public.seller_managers is 'Operations Managers assigned to one Seller. Access is enforced by the PDF gateway.';
comment on table public.pdf_files is 'Private temporary PDF metadata. File bytes are stored in the private seller-pdfs bucket.';
