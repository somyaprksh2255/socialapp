-- Squado join persistence and city-scoped plan discovery.
-- Safe to apply after the current live shared-plan schema (profiles.id references auth.users.id).
-- Does not drop tables or alter existing plan data.

begin;

-- Guests are denied by the authenticated-only grants/policies; authenticated users see:
-- (1) plans they host, (2) plans where they are already accepted members, or
-- (3) open plans in the same saved city, unless either side has blocked the other.
drop policy if exists plans_select on public.plans;
create policy plans_select on public.plans
for select to authenticated
using (
  creator = auth.uid()
  or public.is_member(id)
  or (
    creator = auth.uid()
    and status = 'open'
  )
  or (
    status = 'open'
    and nullif(btrim(city), '') is not null
    and exists (
      select 1
      from public.profiles me
      where me.id = auth.uid()
        and nullif(btrim(me.city), '') is not null
        and lower(btrim(me.city)) = lower(btrim(public.plans.city))
    )
    and not exists (
      select 1 from public.blocks b
      where (b.blocker = auth.uid() and b.blocked = public.plans.creator)
         or (b.blocker = public.plans.creator and b.blocked = auth.uid())
    )
  )
);

-- A join request must be performed transactionally through these RPCs.
-- This prevents a client from faking membership/request rows and makes the result authoritative.
create or replace function public.request_shared_plan_join(p_plan_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.plans%rowtype;
  v_gender text;
  v_count integer;
  v_city text;
begin
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;

  select * into v_plan from public.plans where id = p_plan_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_plan.status <> 'open' then return jsonb_build_object('status','closed'); end if;
  if v_plan.creator = auth.uid() then return jsonb_build_object('status','host'); end if;

  select city, gender into v_city, v_gender from public.profiles where id = auth.uid();
  if nullif(btrim(v_city), '') is null
     or nullif(btrim(v_plan.city), '') is null
     or lower(btrim(v_city)) <> lower(btrim(v_plan.city)) then
    return jsonb_build_object('status','location_mismatch');
  end if;

  if exists (
    select 1 from public.blocks b
    where (b.blocker = auth.uid() and b.blocked = v_plan.creator)
       or (b.blocker = v_plan.creator and b.blocked = auth.uid())
  ) then return jsonb_build_object('status','blocked'); end if;

  if exists(select 1 from public.memberships m where m.plan_id=p_plan_id and m.user_id=auth.uid() and m.state='removed')
    then return jsonb_build_object('status','removed'); end if;
  if exists(select 1 from public.memberships m where m.plan_id=p_plan_id and m.user_id=auth.uid() and m.state='member')
    then return jsonb_build_object('status','member'); end if;
  if exists(select 1 from public.join_requests r where r.plan_id=p_plan_id and r.user_id=auth.uid() and r.state='pending')
    then return jsonb_build_object('status','pending'); end if;
  if exists(select 1 from public.join_requests r where r.plan_id=p_plan_id and r.user_id=auth.uid() and r.state='rejected')
    then return jsonb_build_object('status','rejected'); end if;

  if v_plan.who = 'Girls only' and coalesce(v_gender,'') <> 'Girl'
    then return jsonb_build_object('status','gender'); end if;
  if v_plan.who = 'Boys only' and coalesce(v_gender,'') <> 'Boy'
    then return jsonb_build_object('status','gender'); end if;

  select count(*) into v_count from public.memberships where plan_id=p_plan_id and state='member';
  if v_count >= v_plan.max then return jsonb_build_object('status','full'); end if;

  if v_plan.auto then
    insert into public.memberships(plan_id,user_id,role,state)
    values(p_plan_id,auth.uid(),'member','member')
    on conflict(plan_id,user_id) do update set role='member',state='member',updated_at=now();
    return jsonb_build_object('status','accepted');
  end if;

  insert into public.join_requests(plan_id,user_id,state,at)
  values(p_plan_id,auth.uid(),'pending',now())
  on conflict(plan_id,user_id) do update set state='pending',at=now();
  return jsonb_build_object('status','pending');
end;
$$;

create or replace function public.decide_shared_plan_join(p_plan_id text,p_user_id uuid,p_approve boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.plans%rowtype;
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  select * into v_plan from public.plans where id=p_plan_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_plan.creator <> auth.uid() then return jsonb_build_object('status','forbidden'); end if;
  if v_plan.status <> 'open' then return jsonb_build_object('status','closed'); end if;
  if not exists(select 1 from public.join_requests where plan_id=p_plan_id and user_id=p_user_id and state='pending')
    then return jsonb_build_object('status','not_pending'); end if;

  if p_approve then
    if exists(select 1 from public.blocks where (blocker=auth.uid() and blocked=p_user_id) or (blocker=p_user_id and blocked=auth.uid()))
      then return jsonb_build_object('status','blocked'); end if;
    select count(*) into v_count from public.memberships where plan_id=p_plan_id and state='member';
    if v_count >= v_plan.max then return jsonb_build_object('status','full'); end if;
    insert into public.memberships(plan_id,user_id,role,state)
    values(p_plan_id,p_user_id,'member','member')
    on conflict(plan_id,user_id) do update set role='member',state='member',updated_at=now();
    delete from public.join_requests where plan_id=p_plan_id and user_id=p_user_id;
    return jsonb_build_object('status','accepted');
  end if;

  update public.join_requests set state='rejected',at=now()
  where plan_id=p_plan_id and user_id=p_user_id and state='pending';
  return jsonb_build_object('status','rejected');
end;
$$;

create or replace function public.cancel_shared_plan_join(p_plan_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  delete from public.join_requests
  where plan_id=p_plan_id and user_id=auth.uid() and state='pending';
  if found then return jsonb_build_object('status','ok'); end if;
  return jsonb_build_object('status','not_pending');
end;
$$;

revoke all on function public.request_shared_plan_join(text) from public, anon;
revoke all on function public.decide_shared_plan_join(text,uuid,boolean) from public, anon;
revoke all on function public.cancel_shared_plan_join(text) from public, anon;
grant execute on function public.request_shared_plan_join(text) to authenticated;
grant execute on function public.decide_shared_plan_join(text,uuid,boolean) to authenticated;
grant execute on function public.cancel_shared_plan_join(text) to authenticated;

-- Prevent clients from bypassing the transactional RPCs.
revoke insert, update, delete on public.memberships from anon, authenticated;
revoke insert, update, delete on public.join_requests from anon, authenticated;
grant select on public.memberships to authenticated;
grant select on public.join_requests to authenticated;

commit;
