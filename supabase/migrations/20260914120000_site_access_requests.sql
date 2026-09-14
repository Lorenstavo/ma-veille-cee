-- Accès sur validation manuelle au site (demande du 2026-09-14) : tout compte doit être
-- validé par un administrateur (table admin_users, is_regulatory_admin() — déjà utilisées par
-- regulatory_pending_reviews) avant de pouvoir consulter le site. Garde-fou côté client
-- ("écran de connexion simple") : cette table est la source de vérité du statut, le blocage
-- visuel lui-même vit dans index.html (accessGate).
create table if not exists public.site_access_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz
);

create index if not exists site_access_requests_status_idx
  on public.site_access_requests (status, requested_at desc);

alter table public.site_access_requests enable row level security;

grant select, insert, update on public.site_access_requests to authenticated;

-- Un utilisateur voit sa propre demande (pour connaître son statut) ; un admin voit tout
-- (pour instruire les demandes en attente).
drop policy if exists site_access_requests_select on public.site_access_requests;
create policy site_access_requests_select
on public.site_access_requests
for select
to authenticated
using (
  user_id = (select auth.uid())
  or (select public.is_regulatory_admin())
);

-- Un utilisateur ne peut créer que sa propre demande, jamais déjà validée/rejetée par
-- lui-même (reviewed_by doit rester vide à la création).
drop policy if exists site_access_requests_insert_self on public.site_access_requests;
create policy site_access_requests_insert_self
on public.site_access_requests
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and status = 'pending'
  and reviewed_by is null
);

-- Seul un admin peut changer le statut (approuver/rejeter) — en pratique, l'administrateur
-- le fait directement dans le Table Editor de Supabase Studio (aucune interface dédiée sur
-- le site pour l'instant), mais cette politique protège aussi un futur appel côté client.
drop policy if exists site_access_requests_update_admin on public.site_access_requests;
create policy site_access_requests_update_admin
on public.site_access_requests
for update
to authenticated
using ((select public.is_regulatory_admin()))
with check (
  (select public.is_regulatory_admin())
  and reviewed_by = (select auth.uid())
);
