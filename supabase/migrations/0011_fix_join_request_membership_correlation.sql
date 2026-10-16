-- Fix the membership correlation in the join-request insert policy.
-- Safe to apply more than once: this replaces only this named policy and does not alter data.
-- Based on the live schema inspected on 2026-10-16 (plans.id/status and memberships.plan_id/user_id/state).
drop policy if exists join_requests_insert on public.join_requests;

create policy join_requests_insert
    on public.join_requests
    for insert
    to authenticated
    with check (
        user_id = auth.uid()
        and exists (
            select 1
            from public.plans p
            where p.id = join_requests.plan_id
              and p.status = 'open'
        )
        and not exists (
            select 1
            from public.memberships m
            where m.plan_id = join_requests.plan_id
              and m.user_id = auth.uid()
              and m.state in ('member', 'removed')
        )
    );
