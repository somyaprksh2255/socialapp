-- Restore a reliable requester/host SELECT path for persisted join requests.
-- Apply manually to the same Supabase project where 0014_join_city_visibility.sql was applied.
-- This migration changes no table data and does not weaken direct-write restrictions.

begin;

drop policy if exists join_requests_select on public.join_requests;
create policy join_requests_select
on public.join_requests
for select
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1
    from public.plans p
    where p.id = public.join_requests.plan_id
      and p.creator = auth.uid()
  )
);

revoke all on public.join_requests from anon;
grant select on public.join_requests to authenticated;

commit;
