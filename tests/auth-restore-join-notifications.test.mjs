import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const supabase = read('src/js/utils/supabase.js');
const auth = read('src/js/app/auth.js');
const notify = read('src/js/state/notify.js');
const store = read('src/js/state/store.js');
const access = read('src/js/state/access.js');
const actions = read('src/js/app/actions.js');
const boot = read('src/js/app/boot.js');
const migration = read('supabase/migrations/0016_shared_join_notifications.sql');

const handler = supabase.slice(supabase.indexOf('async function handleSupabaseUser'), supabase.indexOf('/* Register exactly one auth listener'));
assert(handler.includes('await loadSupabaseProfile(u)'), 'Sign-in must load the saved server profile before account creation');
assert(handler.indexOf('await loadSupabaseProfile(u)') < handler.indexOf('rec = createAccount(who)'), 'Profile lookup must precede creating a blank account');
assert(handler.includes('hydrateSupabaseProfile'), 'Sign-in must hydrate an existing account from its saved profile');

const hydrate = supabase.slice(supabase.indexOf('function hydrateSupabaseProfile'), supabase.indexOf('function sharedPlanToRow'));
assert(hydrate.includes('keepLocalCompletion'), 'Legacy completed onboarding must not be undone by a stale server flag');
assert(hydrate.includes('rec.email = String(who.email'), 'Email changes must update the current identity profile without changing its stable ID');

const finish = auth.slice(auth.indexOf('window.finishOb = async'), auth.indexOf('window.signOutUser'));
assert(finish.includes('await syncSupabaseProfile()'), 'Completing onboarding must persist the profile to Supabase');
assert(finish.includes('refreshSharedNotifications'), 'Onboarding completion must refresh the durable inbox');

assert(supabase.includes("reqs: reqRows.map(r => ({ u: r.user_id === uid ? 'me' : r.user_id, at: r.at }))"), 'Pending requests must map the current requester UUID to local identity');
assert(supabase.includes('const requesterIds = requests.filter(r => r.state === \'pending\')'), 'Host feed must load profiles for pending requesters');
assert(supabase.includes("from('squado_notifications')"), 'Shared notifications must be read from the server');
assert(supabase.includes('async function markSharedNotificationsRead'), 'Notification read state must be persisted server-side');

assert(notify.includes('[...(S.remoteNotifs || []), ...(S.notifs || [])]'), 'Inbox must combine persisted and local notifications');
assert(notify.includes('.sort((a, b) => Number(b.at || 0) - Number(a.at || 0))'), 'Inbox must order local and shared notifications newest first');
assert(store.includes('remoteNotifs: []') && access.includes('S.remoteNotifs = []'), 'Shared notification cache must be initialized and cleared on account changes');
assert(actions.includes('markSharedNotificationsRead(remoteIds)'), 'Opening the inbox must mark shared notifications read in the database');
assert(boot.includes('refreshSharedNotifications({ render: false })'), 'Signed-in sessions must poll for new shared notifications');

assert(migration.includes('create table if not exists public.squado_notifications'), 'Migration must create the shared inbox');
assert(migration.includes('alter table public.squado_notifications enable row level security'), 'Shared notification table must have RLS enabled');
assert(migration.includes('using (recipient = auth.uid())'), 'Users must only read their own notifications');
assert(migration.includes('grant update (read_at) on public.squado_notifications to authenticated'), 'Users may only update notification read state');
assert(migration.includes('create trigger squado_join_request_notify'), 'New join requests must trigger a host notification');
assert(migration.includes('create trigger squado_join_request_deleted_notify'), 'Accepted requests must notify the requester');
assert(migration.includes('where m.plan_id = old.plan_id'), 'Approval notification must require a persisted accepted membership');
assert(migration.includes('Backfill a notification for already-pending requests'), 'Pre-existing pending requests must get a one-time host alert');

console.log('Auth restoration and shared join notification regression checks passed.');
