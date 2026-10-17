import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const selectors = read('src/js/state/selectors.js');
const access = read('src/js/state/access.js');
const actions = read('src/js/app/actions.js');
const events = read('src/js/app/events.js');
const api = read('server/admin.mjs');
const migration = read('supabase/migrations/0014_join_city_visibility.sql');

assert.match(selectors, /if \(tier\(\) === 'guest'\) return \[GUEST_DEMO_PLAN\]/, 'guests should receive only the in-memory demo plan');
assert.match(selectors, /if \(!selected\) return \[\]/, 'real Event discovery must require a selected/profile city');
assert.match(selectors, /!!selected && isCity\(planCity\(p\)\) && sameCity\(planCity\(p\), selected\)/, 'real plan discovery must require a city match');
assert.match(access, /!!viewCity\(\)[\s\S]*sameCity\(planCity\(p\), viewCity\(\)\)/, 'direct plan visibility must require a city match');
assert.match(actions, /rpc\('request_shared_plan_join'/, 'join must be persisted with the authoritative RPC');
assert.match(actions, /rpc\('decide_shared_plan_join'/, 'host decisions must be persisted with the authoritative RPC');
assert.match(actions, /rpc\('cancel_shared_plan_join'/, 'request cancellation must be persisted with the authoritative RPC');
assert.match(events, /S\.me\.guest[\s\S]*S\.events = \[\]/, 'guest Event cache must be cleared');
assert.match(events, /Authorization: 'Bearer ' \+ token/, 'Event API request must carry the authenticated token');
assert.match(api, /app\.get\('\/api\/events',requireAuth/, 'Event API must require authentication');
assert.match(api, /payload\?\.city[\s\S]*city\.toLocaleLowerCase\(\)/, 'Event API must scope results to the profile city');
assert.match(migration, /lower\(btrim\(me\.city\)\) = lower\(btrim\(public\.plans\.city\)\)/, 'database plan policy must enforce city matching');
assert.match(migration, /grant execute on function public\.request_shared_plan_join\(text\) to authenticated/, 'join RPC must be granted only to authenticated users');
console.log('City visibility and join workflow source checks passed.');
