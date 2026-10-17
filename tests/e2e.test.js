const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const store = read('src/js/state/store.js');
const create = read('src/js/pages/create.js');
const eventPage = read('src/js/pages/event.js');
const eventCard = read('src/js/components/events/eventCard.js');
const actions = read('src/js/app/actions.js');
const access = read('src/js/state/access.js');
const html = read('index.html');

assert(/users:\s*\[\]/.test(store) && /plans:\s*\[\]/.test(store) && /events:\s*\[\]/.test(store), 'Fresh state must not seed users, plans, or events');
assert(!html.includes('src/js/demo/') && !html.includes('mockSim.js'), 'Production HTML must not load demo fixtures or mock activity');
assert(/function create\(\)\s*{\s*return createPlanForm\(\);\s*}/.test(create), 'Regular Create route must stay focused on the original Plan/Group form');
assert(!create.includes('What are we creating?') && !create.includes('Create an Event'), 'Event publishing must not be offered in the regular Create menu');
assert(read('admin.html').includes('Event Manager') && read('src/js/admin/admin.js').includes('Publish Event'), 'Events must be published through the separate Admin Panel');
assert(read('src/js/admin/admin.js').includes("api('/api/admin/events'") && read('server/admin.mjs').includes("app.get('/api/events'"), 'Admin-published Events must be served to the regular app');
assert(access.includes('const canManageEvents') && actions.includes('if (!canManageEvents())'), 'Privileged event actions must remain restricted in the regular app');
assert(actions.includes("status: publish ? 'published' : 'draft'") && actions.includes("e.status === 'published'"), 'Only published Events may be linked to new Plans');
assert(actions.includes("when: 'Custom'") && actions.includes("eventStartTime: ev.startTime"), 'Event-created Plans must prefill organizer-selected time');
assert(actions.includes("loc: ev.loc") && actions.includes("event: ev.id"), 'Event-created Plans must inherit location and link to Event');
assert(actions.includes('notifyLinkedPlanMembers') && actions.includes("cancelPlans ? 'Plan cancelled with its Event' : 'Linked Event updated'"), 'Event changes must notify linked Plan members');
assert(!/I'm Going|Who's going|people are going|data-a="going"/.test(eventPage + eventCard), 'Event UI must not track attendance');
assert(/Attendance.*Plan\/Group|attendance.*Plan\/Group/i.test(eventPage), 'Event page must clarify attendance is Plan/Group-only');
assert(!actions.includes('going(e)') && !store.includes('e.going'), 'Event-level going state must be removed');
assert(read('src/js/data/users.js').includes('const U = [];') && read('src/js/data/plans.js').includes('const P0 = [];') && read('src/js/data/events.js').includes('const E0 = [];'), 'Live data modules must start empty');
const explore = read('src/js/pages/explore.js');
const home = read('src/js/pages/home.js');
const selectors = read('src/js/state/selectors.js');
const chatState = read('src/js/state/chat.js');
const groupChat = read('src/js/components/squads/GroupChat.js');
const attendanceSheet = read('src/js/components/squads/AttendanceSheet.js');
const feedback = read('src/js/state/feedback.js');
const supabase = read('src/js/utils/supabase.js');
const qrMigration = read('supabase/migrations/0018_qr_feedback_shared_completion.sql');
const chatMigration = read('supabase/migrations/0017_shared_chat_messages.sql');

assert(/function eventVisibleInCurrentCity/.test(selectors), 'Events need a shared city-visibility predicate');
assert(/\.filter\(eventVisibleInCurrentCity\)/.test(explore), 'Discover Events must be filtered to the selected city');
assert(/\.filter\(eventVisibleInCurrentCity\)/.test(home), 'Home Events must be filtered to the selected city');
assert(/!!selected && !!actual && selected === actual/.test(selectors), 'An event with no city must not leak to every city feed');

assert(chatState.includes("p && p._shared ? []"), 'Shared group chats must not seed browser-local messages');
assert(supabase.includes('async function publishSharedChatMessage') && supabase.includes('async function refreshSharedChatMessages'), 'Shared chat needs server send and reload helpers');
assert(supabase.includes("client.from('messages')") && supabase.includes("client.from('message_reactions')"), 'Shared chat messages and reactions must persist through Supabase');
assert(groupChat.includes('No messages yet. Say hi'), 'Shared chat must display an empty state without mock messages');
assert(chatMigration.includes('create table if not exists public.message_reactions') && chatMigration.includes('using (public.is_member(plan_id))'), 'Shared chat migration must protect message access by membership');

assert(!/qrcode\.js["']\s+async|qrcode\.js["']\s+defer/.test(html), 'The QR creation library must load before profile rendering');
assert(!/jsQR\.js["']\s+async|jsQR\.js["']\s+defer/.test(html), 'The QR scanner decoder must load before the scanner can start');
assert(attendanceSheet.includes("typeof jsQR !== 'function'") && attendanceSheet.includes("det = null"), 'The camera scanner must report missing decoder and fall back when native detection fails');
assert(supabase.includes('async function refreshSharedAttendance') && supabase.includes('async function completeSharedPlanRemote'), 'QR attendance and completed-plan state must sync across devices');

assert(feedback.includes('submitSharedFeedback('), 'Feedback save path must invoke the shared feedback adapter');
assert(supabase.includes('async function submitSharedFeedback') && supabase.includes('async function refreshSharedFeedbackSummaries'), 'Shared feedback submit and aggregate read helpers must exist');
assert(qrMigration.includes('create or replace function public.record_checkin') && qrMigration.includes('create or replace function public.complete_shared_plan'), 'QR and meetup completion RPCs must be included in the forward migration');
assert(qrMigration.includes('create or replace function public.shared_feedback_summaries') && qrMigration.includes('using (by = auth.uid())'), 'Feedback should expose aggregate summaries without selecting other users\' individual feedback');

console.log('Current product workflow checks passed.');
