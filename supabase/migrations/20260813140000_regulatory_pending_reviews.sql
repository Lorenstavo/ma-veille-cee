create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

drop policy if exists admin_users_select_self on public.admin_users;
create policy admin_users_select_self
on public.admin_users
for select
to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.is_regulatory_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_regulatory_admin() from public;
grant execute on function public.is_regulatory_admin() to authenticated;

create table if not exists public.regulatory_pending_reviews (
  external_id text primary key,
  status text not null default 'pending' check (status in ('pending', 'ignored', 'analysis-ready')),
  notes text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists regulatory_pending_reviews_status_updated_idx
  on public.regulatory_pending_reviews (status, updated_at desc);

alter table public.regulatory_pending_reviews enable row level security;

drop policy if exists regulatory_pending_reviews_select_admin on public.regulatory_pending_reviews;
create policy regulatory_pending_reviews_select_admin
on public.regulatory_pending_reviews
for select
to authenticated
using ((select public.is_regulatory_admin()));

drop policy if exists regulatory_pending_reviews_insert_admin on public.regulatory_pending_reviews;
create policy regulatory_pending_reviews_insert_admin
on public.regulatory_pending_reviews
for insert
to authenticated
with check (
  (select public.is_regulatory_admin())
  and reviewed_by = (select auth.uid())
);

drop policy if exists regulatory_pending_reviews_update_admin on public.regulatory_pending_reviews;
create policy regulatory_pending_reviews_update_admin
on public.regulatory_pending_reviews
for update
to authenticated
using ((select public.is_regulatory_admin()))
with check (
  (select public.is_regulatory_admin())
  and reviewed_by = (select auth.uid())
);

create or replace function public.set_regulatory_pending_review_updated_at()
returns trigger
language plpgsql
security invoker
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists regulatory_pending_reviews_set_updated_at
on public.regulatory_pending_reviews;

create trigger regulatory_pending_reviews_set_updated_at
before update on public.regulatory_pending_reviews
for each row
execute function public.set_regulatory_pending_review_updated_at();
