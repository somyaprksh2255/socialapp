-- Squado: QR attendance persistence and shared anonymous feedback.
-- Additive/idempotent; does not delete existing plans, profiles, attendance or feedback.

begin;

create extension if not exists pgcrypto;

-- The existing live deployment may have the shared-plan schema without the later
-- attendance/feedback artifacts. Create their established base shape when absent.
create table if not exists public.attendance (
    id uuid primary key default gen_random_uuid(),
    plan_id text not null references public.plans(id) on delete cascade,
    uid uuid not null references public.profiles(auth_uid) on delete cascade,
    audit jsonb not null default '[]'::jsonb,
    dispute jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (plan_id, uid)
);

create table if not exists public.feedback (
    id uuid primary key default gen_random_uuid(),
    plan_id text not null references public.plans(id) on delete cascade,
    by uuid not null references public.profiles(auth_uid) on delete cascade,
    to_uid uuid references public.profiles(auth_uid) on delete set null,
    rating int,
    notes text,
    created_at timestamptz not null default now()
);

alter table public.plans add column if not exists completion jsonb;

-- Keep the host-scanner API compatible even if the earlier review-only 0003 artifact
-- was not applied. These statements are safe to re-run.
alter table public.attendance add column if not exists status text not null default 'present';
alter table public.attendance add column if not exists method text;
alter table public.attendance add column if not exists marked_by uuid references public.profiles(auth_uid) on delete set null;

do $$
begin
    alter table public.attendance
        add constraint attendance_status_chk check (status in ('present', 'absent', 'claimed'));
exception when duplicate_object then null;
end $$;

create index if not exists attendance_uid_idx on public.attendance(uid);

-- Browser clients may read attendance only for plans where they are accepted members
-- or the host. All attendance writes are performed by the trusted server RPC, not
-- directly from the browser. This also covers installs where the table was created
-- by this migration rather than by the older schema artifact.
alter table public.attendance enable row level security;

drop policy if exists attendance_select on public.attendance;
create policy attendance_select on public.attendance
    for select to authenticated
    using (public.is_member(plan_id) or public.is_host(plan_id));

revoke all on public.attendance from anon, authenticated;
grant select on public.attendance to authenticated;

-- Only the trusted server (which verifies the host's access token and plan membership)
-- may execute this RPC. It writes the attendance row atomically and never clears a dispute.
create or replace function public.record_checkin(
    p_plan text,
    p_uid uuid,
    p_host uuid
) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
    v_entry jsonb;
begin
    insert into public.attendance (plan_id, uid, status, method, marked_by, audit)
    values (
        p_plan, p_uid, 'present', 'in_app_scanner', p_host,
        jsonb_build_array(jsonb_build_object(
            'at', v_now_ms, 'by', p_host::text, 'action', 'host_scan',
            'from', 'none', 'to', 'present', 'reason', 'Scanned in by the host'
        ))
    )
    on conflict (plan_id, uid) do nothing;

    if found then return 'checked_in'; end if;

    perform 1 from public.attendance
      where plan_id = p_plan and uid = p_uid and dispute is not null;
    if found then return 'disputed'; end if;

    perform 1 from public.attendance
      where plan_id = p_plan and uid = p_uid and status = 'present';
    if found then return 'duplicate'; end if;

    select jsonb_build_object(
        'at', v_now_ms, 'by', p_host::text, 'action', 'host_scan',
        'from', status, 'to', 'present', 'reason', 'Scanned in by the host'
    )
      into v_entry
      from public.attendance
     where plan_id = p_plan and uid = p_uid;

    update public.attendance
       set status = 'present', method = 'in_app_scanner', marked_by = p_host,
           updated_at = now(), audit = audit || jsonb_build_array(v_entry)
     where plan_id = p_plan and uid = p_uid;

    return 'checked_in';
end;
$$;

revoke all on function public.record_checkin(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_checkin(text, uuid, uuid) to service_role;

-- Store the host's shared completion and host attendance in one transaction.
-- This lets every accepted member reload an ended plan and submit feedback on another device.
create or replace function public.complete_shared_plan(p_plan text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_uid uuid := auth.uid();
    v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
    v_entry jsonb;
begin
    if v_uid is null then return false; end if;

    if exists (
        select 1 from public.plans p
        where p.id = p_plan and p.creator = v_uid
          and p.status = 'closed' and p.completion->>'by' = v_uid::text
    ) then
        return true; -- idempotent retry if the earlier response was lost
    end if;

    if not exists (
        select 1 from public.plans p
        where p.id = p_plan and p.creator = v_uid and p.status = 'open'
    ) then
        return false;
    end if;

    if exists (
        select 1 from public.attendance a
        where a.plan_id = p_plan
          and a.status in ('present', 'claimed')
          and a.dispute is not null
    ) then
        return false;
    end if;

    update public.plans
       set status = 'closed',
           completion = jsonb_build_object(
               'by', v_uid::text, 'at', v_now_ms,
               'confirms', '[]'::jsonb, 'disputes', '[]'::jsonb
           ),
           updated_at = now()
     where id = p_plan and creator = v_uid and status = 'open';

    if not found then return false; end if;

    v_entry := jsonb_build_object(
        'at', v_now_ms, 'by', v_uid::text, 'action', 'organizer_present',
        'from', 'none', 'to', 'present', 'reason', 'Host confirmed the meetup ended'
    );

    insert into public.attendance as existing_attendance
        (plan_id, uid, status, method, marked_by, audit)
    values (p_plan, v_uid, 'present', 'organizer', v_uid, jsonb_build_array(v_entry))
    on conflict (plan_id, uid) do update
       set status = 'present', method = 'organizer', marked_by = v_uid,
           updated_at = now(),
           audit = existing_attendance.audit || jsonb_build_array(v_entry)
     where existing_attendance.dispute is null;

    if not found then
        raise exception 'host attendance could not be finalized';
    end if;

    return true;
end;
$$;

revoke all on function public.complete_shared_plan(text) from public, anon;
grant execute on function public.complete_shared_plan(text) to authenticated, service_role;

-- Extend the existing feedback rows without replacing their contents.
alter table public.feedback add column if not exists kind text;
alter table public.feedback add column if not exists tags text[] not null default '{}';

update public.feedback
   set kind = case when to_uid is null then 'meetup' else 'person' end
 where kind is null;

alter table public.feedback alter column kind set default 'meetup';
alter table public.feedback alter column kind set not null;

do $$
begin
    alter table public.feedback
        add constraint feedback_kind_chk check (kind in ('meetup', 'person'));
exception when duplicate_object then null;
end $$;

create index if not exists feedback_plan_kind_idx on public.feedback(plan_id, kind, to_uid);
alter table public.feedback enable row level security;

-- Authors can read back their own submission to prevent accidental duplicate feedback.
-- Individual feedback from other people is never directly selectable.
drop policy if exists feedback_select on public.feedback;
create policy feedback_select on public.feedback
    for select to authenticated
    using (by = auth.uid());

-- A submission must be for a completed shared plan and verified attendance. Person ratings
-- require the target to have verified, undisputed attendance too.
drop policy if exists feedback_insert on public.feedback;
create policy feedback_insert on public.feedback
    for insert to authenticated
    with check (
        by = auth.uid()
        and (
            (kind = 'meetup' and to_uid is null)
            or (kind = 'person' and to_uid is not null and to_uid <> auth.uid())
        )
        and exists (
            select 1 from public.plans p
            where p.id = public.feedback.plan_id
              and p.status = 'closed'
              and p.completion is not null
              and public.is_member(p.id)
        )
        and exists (
            select 1 from public.attendance a
            where a.plan_id = public.feedback.plan_id
              and a.uid = auth.uid()
              and a.status = 'present'
              and a.dispute is null
        )
        and (
            kind = 'meetup'
            or exists (
                select 1 from public.attendance target_attendance
                where target_attendance.plan_id = public.feedback.plan_id
                  and target_attendance.uid = public.feedback.to_uid
                  and target_attendance.status = 'present'
                  and target_attendance.dispute is null
            )
        )
    );

grant select, insert on public.feedback to authenticated;

-- Serialize duplicate checks per plan/reviewer/type/target so concurrent taps cannot
-- create duplicate submissions. This protects legacy rows without deleting any of them.
create or replace function public.prevent_duplicate_feedback()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_lock_key text;
begin
    if new.kind = 'meetup' then
        if new.to_uid is not null then
            raise exception 'meetup feedback cannot target a person' using errcode = '23514';
        end if;
        v_lock_key := new.plan_id || ':' || new.by::text || ':meetup';
    elsif new.kind = 'person' then
        if new.to_uid is null or new.to_uid = new.by then
            raise exception 'person feedback needs a different target' using errcode = '23514';
        end if;
        v_lock_key := new.plan_id || ':' || new.by::text || ':person:' || new.to_uid::text;
    else
        raise exception 'invalid feedback kind' using errcode = '23514';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

    if exists (
        select 1 from public.feedback f
        where f.plan_id = new.plan_id and f.by = new.by and f.kind = new.kind
          and (
              (new.kind = 'meetup' and f.to_uid is null)
              or (new.kind = 'person' and f.to_uid = new.to_uid)
          )
    ) then
        raise exception 'feedback already submitted' using errcode = '23505';
    end if;
    return new;
end;
$$;

drop trigger if exists feedback_duplicate_guard on public.feedback;
create trigger feedback_duplicate_guard
before insert on public.feedback
for each row execute function public.prevent_duplicate_feedback();

-- Public/profile surfaces receive aggregates only. The function never returns reviewer ids,
-- comments, individual tags, or individual feedback rows, and suppresses groups smaller than 3.
create or replace function public.shared_feedback_summaries()
returns table (
    kind text,
    plan_id text,
    target_uid uuid,
    n bigint,
    avg numeric,
    tags jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with valid_feedback as (
        select f.plan_id, f.by, f.to_uid, f.kind, f.rating, f.tags
        from public.feedback f
        join public.plans p on p.id = f.plan_id
        join public.attendance reviewer_attendance
          on reviewer_attendance.plan_id = f.plan_id
         and reviewer_attendance.uid = f.by
         and reviewer_attendance.status = 'present'
         and reviewer_attendance.dispute is null
        where p.status = 'closed'
          and p.completion is not null
          and f.rating between 1 and 5
          and (
              f.kind = 'meetup'
              or exists (
                  select 1 from public.attendance target_attendance
                  where target_attendance.plan_id = f.plan_id
                    and target_attendance.uid = f.to_uid
                    and target_attendance.status = 'present'
                    and target_attendance.dispute is null
              )
          )
    )
    select
        'meetup'::text,
        v.plan_id,
        null::uuid,
        count(*)::bigint,
        round(avg(v.rating)::numeric, 1),
        coalesce((
            select jsonb_object_agg(t.tag, t.tag_count)
            from (
                select tags.tag, count(*)::int as tag_count
                from valid_feedback vf
                cross join lateral unnest(vf.tags) as tags(tag)
                where vf.kind = 'meetup' and vf.plan_id = v.plan_id
                group by tags.tag
            ) t
        ), '{}'::jsonb)
    from valid_feedback v
    where v.kind = 'meetup'
    group by v.plan_id
    having count(*) >= 3

    union all

    select
        'person'::text,
        null::text,
        v.to_uid,
        count(*)::bigint,
        round(avg(v.rating)::numeric, 1),
        coalesce((
            select jsonb_object_agg(t.tag, t.tag_count)
            from (
                select tags.tag, count(*)::int as tag_count
                from valid_feedback vf
                cross join lateral unnest(vf.tags) as tags(tag)
                where vf.kind = 'person' and vf.to_uid = v.to_uid
                group by tags.tag
            ) t
        ), '{}'::jsonb)
    from valid_feedback v
    where v.kind = 'person'
    group by v.to_uid
    having count(*) >= 3;
$$;

revoke all on function public.shared_feedback_summaries() from public, anon;
grant execute on function public.shared_feedback_summaries() to authenticated;

commit;
