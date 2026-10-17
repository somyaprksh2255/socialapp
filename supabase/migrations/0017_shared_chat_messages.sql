-- Squado: shared group-chat persistence and per-member message reactions.
-- Additive/idempotent. Safe to re-run; does not delete existing plans, messages, or users.
begin;

create table if not exists public.messages (
    id uuid primary key default gen_random_uuid(),
    plan_id text not null references public.plans(id) on delete cascade,
    by uuid references public.profiles(auth_uid) on delete set null,
    kind text not null default 'text',
    text text,
    media_path text,
    loc jsonb,
    created_at timestamptz not null default now(),
    constraint messages_kind_chk check (kind in ('text', 'photo', 'location', 'photo-location', 'sys'))
);

alter table public.messages add column if not exists media_path text;
alter table public.messages add column if not exists loc jsonb;
alter table public.messages add column if not exists created_at timestamptz not null default now();
create index if not exists messages_plan_created_idx on public.messages(plan_id, created_at);

alter table public.messages enable row level security;

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
    for select to authenticated
    using (public.is_member(plan_id));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
    for insert to authenticated
    with check (public.is_member(plan_id) and by = auth.uid() and kind <> 'sys');

grant select, insert on public.messages to authenticated;

create table if not exists public.message_reactions (
    message_id uuid not null references public.messages(id) on delete cascade,
    user_id uuid not null references public.profiles(auth_uid) on delete cascade,
    emoji text not null check (emoji in ('🔥', '🕺', '😭')),
    created_at timestamptz not null default now(),
    primary key (message_id, user_id)
);

create index if not exists message_reactions_message_idx on public.message_reactions(message_id);
alter table public.message_reactions enable row level security;

drop policy if exists message_reactions_select on public.message_reactions;
create policy message_reactions_select on public.message_reactions
    for select to authenticated
    using (
        exists (
            select 1 from public.messages m
            where m.id = message_id and public.is_member(m.plan_id)
        )
    );

drop policy if exists message_reactions_insert on public.message_reactions;
create policy message_reactions_insert on public.message_reactions
    for insert to authenticated
    with check (
        user_id = auth.uid()
        and exists (
            select 1 from public.messages m
            where m.id = message_id and public.is_member(m.plan_id)
        )
    );

drop policy if exists message_reactions_update on public.message_reactions;
create policy message_reactions_update on public.message_reactions
    for update to authenticated
    using (user_id = auth.uid())
    with check (
        user_id = auth.uid()
        and exists (
            select 1 from public.messages m
            where m.id = message_id and public.is_member(m.plan_id)
        )
    );

drop policy if exists message_reactions_delete on public.message_reactions;
create policy message_reactions_delete on public.message_reactions
    for delete to authenticated
    using (user_id = auth.uid());

grant select, insert, update, delete on public.message_reactions to authenticated;

commit;
