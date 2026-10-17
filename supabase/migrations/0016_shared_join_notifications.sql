-- Squado shared join notifications
-- Additive: adds a server-owned notification inbox and triggers for the existing
-- shared-plan join workflow. Does not modify or delete plans, profiles, or requests.
-- Apply manually to the same Supabase project after 0014 and 0015.

begin;

create table if not exists public.squado_notifications (
    id uuid primary key default gen_random_uuid(),
    recipient uuid not null references auth.users(id) on delete cascade,
    actor uuid references auth.users(id) on delete set null,
    kind text not null check (kind in ('join_request', 'join-approved')),
    plan_id text not null references public.plans(id) on delete cascade,
    title text not null,
    body text not null default '',
    created_at timestamptz not null default now(),
    read_at timestamptz
);

create index if not exists squado_notifications_recipient_created_idx
    on public.squado_notifications(recipient, created_at desc);

create index if not exists squado_notifications_recipient_unread_idx
    on public.squado_notifications(recipient, created_at desc)
    where read_at is null;

alter table public.squado_notifications enable row level security;

drop policy if exists squado_notifications_select_own on public.squado_notifications;
create policy squado_notifications_select_own
    on public.squado_notifications
    for select to authenticated
    using (recipient = auth.uid());

drop policy if exists squado_notifications_update_own on public.squado_notifications;
create policy squado_notifications_update_own
    on public.squado_notifications
    for update to authenticated
    using (recipient = auth.uid())
    with check (recipient = auth.uid());

revoke all on public.squado_notifications from anon, authenticated;
grant select on public.squado_notifications to authenticated;
grant update (read_at) on public.squado_notifications to authenticated;

-- Create one durable notification for every new pending request. Repeated requests
-- that are already pending do not produce duplicates. A rejected-to-pending transition
-- creates a fresh alert; a transition away from pending resolves its previous alert.
create or replace function public.squado_notify_join_request()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_creator uuid;
    v_title text;
begin
    if new.state = 'pending' then
        if tg_op = 'UPDATE' and old.state = 'pending' then
            return new;
        end if;

        select p.creator, coalesce(nullif(btrim(p.title), ''), 'your plan')
          into v_creator, v_title
          from public.plans p
         where p.id = new.plan_id;

        if v_creator is not null and v_creator <> new.user_id then
            insert into public.squado_notifications
                (recipient, actor, kind, plan_id, title, body)
            values
                (v_creator, new.user_id, 'join_request', new.plan_id,
                 'New join request',
                 'Someone requested to join "' || v_title || '". Open your plan to review the request.');
        end if;
    else
        update public.squado_notifications
           set read_at = coalesce(read_at, now())
         where kind = 'join_request'
           and plan_id = new.plan_id
           and actor = new.user_id
           and read_at is null;
    end if;

    return new;
end;
$$;

drop trigger if exists squado_join_request_notify on public.join_requests;
create trigger squado_join_request_notify
    after insert or update of state on public.join_requests
    for each row execute function public.squado_notify_join_request();

-- The existing approval RPC inserts the membership first and then deletes the request.
-- This trigger distinguishes approval from cancellation by checking that membership.
-- Request withdrawals resolve the host alert but do not notify the requester.
create or replace function public.squado_notify_join_request_deleted()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_creator uuid;
    v_title text;
    v_approved boolean;
begin
    select p.creator, coalesce(nullif(btrim(p.title), ''), 'your plan')
      into v_creator, v_title
      from public.plans p
     where p.id = old.plan_id;

    update public.squado_notifications
       set read_at = coalesce(read_at, now())
     where kind = 'join_request'
       and plan_id = old.plan_id
       and actor = old.user_id
       and read_at is null;

    select exists (
        select 1
          from public.memberships m
         where m.plan_id = old.plan_id
           and m.user_id = old.user_id
           and m.state = 'member'
    ) into v_approved;

    if old.state = 'pending' and v_approved and v_creator is not null then
        insert into public.squado_notifications
            (recipient, actor, kind, plan_id, title, body)
        values
            (old.user_id, v_creator, 'join-approved', old.plan_id,
             'Your join request was accepted',
             'The host accepted your request for "' || v_title || '". You can now open the squad.');
    end if;

    return old;
end;
$$;

drop trigger if exists squado_join_request_deleted_notify on public.join_requests;
create trigger squado_join_request_deleted_notify
    after delete on public.join_requests
    for each row execute function public.squado_notify_join_request_deleted();

-- Backfill a notification for already-pending requests only when no prior host alert
-- exists at all. This lets a live installation pick up existing pending requests once.
insert into public.squado_notifications (recipient, actor, kind, plan_id, title, body)
select p.creator, jr.user_id, 'join_request', jr.plan_id, 'New join request',
       'Someone requested to join "' || coalesce(nullif(btrim(p.title), ''), 'your plan') ||
       '". Open your plan to review the request.'
  from public.join_requests jr
  join public.plans p on p.id = jr.plan_id
 where jr.state = 'pending'
   and p.creator <> jr.user_id
   and not exists (
       select 1
         from public.squado_notifications n
        where n.recipient = p.creator
          and n.actor = jr.user_id
          and n.kind = 'join_request'
          and n.plan_id = jr.plan_id
   );

revoke all on function public.squado_notify_join_request() from public, anon, authenticated;
revoke all on function public.squado_notify_join_request_deleted() from public, anon, authenticated;

commit;
