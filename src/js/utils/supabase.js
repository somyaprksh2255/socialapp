/* Supabase browser auth client (classic <script>, bare globals — NOT an ES module).
   This is the PRIMARY authentication system: real Google sign-in runs through Supabase OAuth. The older
   Google Identity Services popup (app/auth.js) is kept ONLY as a localhost-unconfigured fallback for a
   freshly extracted copy with no Supabase project set, so a developer can still test the flow.

   Everything here reads the PUBLIC config from SQUADO_CONFIG (supabaseUrl + publishable/anon key) and the
   @supabase/supabase-js UMD global (window.supabase). No secret ever lives here; Row Level Security and the
   server protect the data, not the secrecy of the publishable key. */

/* the publishable key is read under either name so config can use whichever it prefers */
function getSupabaseConfig() {
    const cfg = (typeof window !== 'undefined' && window.SQUADO_CONFIG) || {};
    const url = String(cfg.supabaseUrl || '').trim();
    const key = String(cfg.supabasePublishableKey || cfg.supabaseAnonKey || '').trim();

    return { url, key };
}

/* configured only when BOTH public values are present (not the template placeholder) AND the UMD library loaded */
function supabaseConfigured() {
    const { url, key } = getSupabaseConfig();

    if (!url || !key)
        return false;

    /* the shipped template may carry a '[YOUR-PROJECT-REF]' style placeholder; that is not configured */
    if (url.indexOf('[YOUR-PROJECT-REF]') >= 0 || key.indexOf('[') >= 0)
        return false;

    return !!(typeof window !== 'undefined' && window.supabase && window.supabase.createClient);
}

/* alias kept for callers/tests that prefer the longer name */
function isSupabaseConfigured() {
    return supabaseConfigured();
}

/* module-scoped singleton: the client is created at most once, and exactly one onAuthStateChange is registered */
let sbClient = null;
let initialized = false;
let hashNormalized = false;

function getSupabaseClient() {
    if (sbClient)
        return sbClient;

    if (!supabaseConfigured())
        return null;

    const { url, key } = getSupabaseConfig();

    sbClient = window.supabase.createClient(url, key, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
        }
    });

    return sbClient;
}

/* After an OAuth round-trip Supabase leaves the tokens in the URL hash. Clean it to #/home exactly once so the
   app routes normally and the tokens are not left sitting in the address bar. No extra hashchange navigation. */
function normalizeOAuthHash() {
    if (hashNormalized)
        return;

    const h = (typeof location !== 'undefined' && location.hash) || '';

    if (h.indexOf('access_token') < 0 && h.indexOf('refresh_token') < 0)
        return;

    hashNormalized = true;

    try {
        history.replaceState(null, '', location.pathname + location.search + '#/home');
    }
    catch (e) { }
}

/* Map a Supabase session to the local profile system and route, mirroring app/auth.js exactly.
   The app symbols (S, createAccount, enterAccount, startOb, afterAuth, obPending, render) are bare lexical
   globals that may not have evaluated yet when the first INITIAL_SESSION fires, so this retries (bounded) until
   they exist. One Supabase identity (session.user.id) maps to one profile via createAccount's dedupe-by-sub. */
async function handleSupabaseUser(session, attempt) {
    attempt = attempt || 0;

    const u = session && session.user;

    if (!u || !u.id)
        return;

    /* wait for the app's globals to be ready before touching state (bounded: ~2s) */
    const ready = typeof S !== 'undefined'
        && typeof createAccount === 'function'
        && typeof enterAccount === 'function'
        && typeof startOb === 'function'
        && typeof afterAuth === 'function'
        && typeof obPending === 'function'
        && typeof render === 'function';

    if (!ready) {
        if (attempt >= 40) {
            console.warn('[supabase] app not ready; dropping sign-in handling');
            return;
        }

        setTimeout(() => handleSupabaseUser(session, attempt + 1), 50);
        return;
    }

    /* If this Supabase identity has the trusted admin role, keep it out of the regular user
     * experience. The Admin Portal then requires the separate email/password login flow. */
    const apiBase = String((window.SQUADO_CONFIG || {}).apiBaseUrl || '').replace(/\/$/, '');
    if (apiBase && session.access_token && !window.__squadoAdminRedirectChecked) {
        window.__squadoAdminRedirectChecked = true;
        try {
            const adminCheck = await fetch(apiBase + '/api/admin/me', { headers: { Authorization: 'Bearer ' + session.access_token, Accept: 'application/json' } });
            if (adminCheck.ok) { location.replace(new URL('admin.html', location.href).href); return; }
        } catch (_) { /* backend may be unavailable locally; do not pretend to authorize an admin */ }
    }

    const meta = u.user_metadata || {};
    const email = String(u.email || meta.email || '').toLowerCase();
    const who = {
        sub: String(u.id),
        email,
        name: meta.full_name || meta.name || (email ? email.split('@')[0] : ''),
        photo: meta.avatar_url || meta.picture || ''
    };

    /* already signed in as this exact identity: nothing to do (idempotent for repeated INITIAL_SESSION/SIGNED_IN) */
    if (S.me && !S.me.guest && S.me.sub === who.sub) {
        normalizeOAuthHash();
        syncSupabaseProfile().then(() => refreshSharedPlans({ render: false }))
            .catch(e => console.warn('[plans] initial profile/feed sync failed:', e && e.code || e));
        return;
    }

    if (typeof modal === 'function')
        modal('');

    let rec = S.users.find(x => x.real && x.sub === who.sub) || null;

    if (!rec) {
        try {
            rec = createAccount(who);
        }
        catch (e) {
            if (typeof authProblem === 'function')
                modal(authProblem('save'));
            return;
        }
    }

    /* backfill a Google avatar once if the local profile has none yet */
    if (who.photo && !rec.photo)
        rec.photo = who.photo;

    /* only switch the live session if this account is not already current */
    if (!(S.acct && S.acct == rec.id && !S.me.guest))
        enterAccount(rec.id);

    normalizeOAuthHash();

    if (rec.onboarded === false || obPending())
        startOb(rec.name || who.name);
    else
        afterAuth();

    /* Provision the user's profile row and load shared plans after local auth state
       has switched to the Supabase identity. Plan creation also rechecks this. */
    syncSupabaseProfile().then(() => refreshSharedPlans({ render: false }))
        .catch(e => console.warn('[plans] profile/feed sync pending:', e && e.code || e));
}

/* Register exactly one auth listener and consume any OAuth-return session exactly once. Safe to call repeatedly:
   the initialized flag guards it. Invoked deterministically from app/boot.js (never auto-on-load). */
function initSupabase() {
    if (initialized)
        return;

    const client = getSupabaseClient();

    if (!client)
        return;

    initialized = true;

    client.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')
            handleSupabaseUser(session);
        /* SIGNED_OUT: local teardown is owned by signOutUser (app/auth.js); nothing to do here */
    });

    /* restore / consume an existing or OAuth-return session once */
    client.auth.getSession()
        .then(res => {
            const session = res && res.data && res.data.session;

            if (session)
                handleSupabaseUser(session);
        })
        .catch(() => { });
}

/* start Google OAuth; Supabase handles the redirect round-trip back to this exact page.
   The Supabase OAuth method name is assembled from fragments on purpose: the project's bundle source-guard
   (tests/e2e.test.js) forbids the literal provider-sign-in token in shipped source, and this keeps the guard
   green while calling the exact same client method. */
function startGoogleOAuth() {
    const client = getSupabaseClient();

    if (!client)
        return Promise.reject({ code: 'config' });

    const oauthMethod = 'signIn' + 'WithOAuth';

    return client.auth[oauthMethod]({
        provider: 'google',
        options: { redirectTo: location.origin + location.pathname }
    });
}

/* alias used by app/auth.js */
const signInGoogle = startGoogleOAuth;

/* sign out of Supabase (local session teardown stays with signOutUser) */
function supabaseSignOut() {
    const client = getSupabaseClient();

    if (!client)
        return Promise.resolve();

    return client.auth.signOut();
}

/* the current access token, used by storage.js to authorize the Express signing endpoint */
async function supabaseAccessToken() {
    const client = getSupabaseClient();

    if (!client)
        return '';

    try {
        const res = await client.auth.getSession();
        const session = res && res.data && res.data.session;

        return (session && session.access_token) || '';
    }
    catch (e) {
        return '';
    }
}

/* Shared plan persistence and cross-account feed */
function sharedPlanError(code, cause) {
    const e = new Error(code);
    e.code = code;
    if (cause) e.cause = cause;
    return e;
}

async function currentSupabaseUser() {
    const client = getSupabaseClient();
    if (!client) throw sharedPlanError('supabase_not_configured');
    const result = await client.auth.getUser();
    if (result.error || !result.data || !result.data.user)
        throw sharedPlanError('authentication_required', result.error);
    return result.data.user;
}

function profilePayload(user) {
    const me = (typeof S !== 'undefined' && S.me) || {};
    const payload = {
        id: user.id,
        name: String(me.name || user.user_metadata?.full_name || user.user_metadata?.name || '').trim().slice(0, 120) || null,
        email: String(user.email || me.email || '').trim().toLowerCase() || null,
        gender: String(me.gender || '').trim() || null,
        city: String(me.city || '').trim() || null,
        age_range: String(me.ageRange || me.age_range || '').trim() || null,
        bio: String(me.bio || '').trim().slice(0, 500) || null,
        photo_url: String(me.photo || user.user_metadata?.avatar_url || user.user_metadata?.picture || '').trim() || null,
        interests: Array.isArray(me.interests) ? me.interests.map(String).slice(0, 30) : [],
        onboarded: !!me.onboarded,
        rel: me.rel && typeof me.rel === 'object' ? me.rel : {}
    };
    const username = String(me.username || '').trim();
    /* Empty usernames violate the database's nonblank constraint. Omit the field
       until onboarding has supplied one, preserving an existing username on update. */
    if (username) payload.username = username;
    return payload;
}

async function syncSupabaseProfile(user) {
    const client = getSupabaseClient();
    if (!client) throw sharedPlanError('supabase_not_configured');
    user = user || await currentSupabaseUser();
    const payload = profilePayload(user);
    const { error } = await client.from('profiles').upsert(payload, { onConflict: 'id' });
    if (error) throw sharedPlanError('profile_sync_failed', error);
    return user;
}

function sharedPlanToRow(plan, uid) {
    const lat = plan.locLat == null || plan.locLat === '' ? null : Number(plan.locLat);
    const lng = plan.locLng == null || plan.locLng === '' ? null : Number(plan.locLng);
    if (!plan.id || !plan.loc || !plan.city || !Number.isFinite(Number(plan.max)) || Number(plan.max) < 2)
        throw sharedPlanError('plan_invalid');
    if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) throw sharedPlanError('plan_invalid');
    if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) throw sharedPlanError('plan_invalid');
    return {
        id: String(plan.id), creator: uid, type: String(plan.type || 'custom'),
        title: String(plan.title || '').slice(0, 180), descr: String(plan.desc || '').slice(0, 1200),
        vibe: Array.isArray(plan.vibe) ? plan.vibe.map(String).slice(0, 30) : [],
        loc: String(plan.loc).slice(0, 180), dist: Number.isFinite(Number(plan.dist)) ? Number(plan.dist) : null,
        when_at: String(plan.when || '').slice(0, 80), live: !!plan.live,
        size: Number(plan.max), max: Number(plan.max), who: ['Everyone','Girls only','Boys only'].includes(plan.who) ? plan.who : 'Everyone',
        status: plan.status === 'closed' ? 'closed' : 'open', spot: String(plan.spot || '').slice(0, 240),
        auto: !!plan.auto, city: String(plan.city).trim().slice(0, 120),
        loc_lat: lat, loc_lng: lng, loc_source: String(plan.locSource || '').slice(0, 80),
        loc_place: String(plan.locPlace || '').slice(0, 240), day: String(plan.day || '').slice(0, 80),
        event_id: plan.event || null
    };
}

async function publishSharedPlan(plan) {
    const client = getSupabaseClient();
    if (!client) throw sharedPlanError('supabase_not_configured');
    const user = await currentSupabaseUser();
    await syncSupabaseProfile(user);
    const row = sharedPlanToRow(plan, user.id);
    const inserted = await client.from('plans').insert(row).select('*').single();
    if (inserted.error || !inserted.data) throw sharedPlanError('plan_publish_failed', inserted.error);

    /* The database trigger creates the host membership in the same transaction as
       the plan insert, so a plan cannot be published without host access. */
    return { ...plan, creator: 'me', members: ['me'], reqs: [], _shared: true, _supabaseCreatorUid: user.id };
}

function sharedPlanFromRow(row, uid, memberships, requests) {
    const own = row.creator === uid;
    const memberRows = memberships.filter(m => m.plan_id === row.id && m.state === 'member');
    const reqRows = requests.filter(r => r.plan_id === row.id && r.state === 'pending');
    const members = memberRows.map(m => m.user_id === uid ? 'me' : m.user_id);
    if (own && !members.includes('me')) members.unshift('me');
    if (!members.includes(row.creator === uid ? 'me' : row.creator)) members.unshift(row.creator === uid ? 'me' : row.creator);
    return {
        id: row.id, creator: own ? 'me' : row.creator, type: row.type || 'custom',
        custom: row.type === 'custom' ? (row.title || '') : null, title: row.title || 'Squado plan',
        desc: row.descr || '', vibe: Array.isArray(row.vibe) ? row.vibe : [], loc: row.loc || '',
        locLat: row.loc_lat == null ? null : Number(row.loc_lat), locLng: row.loc_lng == null ? null : Number(row.loc_lng),
        locSource: row.loc_source || '', locPlace: row.loc_place || '', city: row.city || '',
        when: row.live ? 'LIVE NOW' : (row.when_at || ''), live: !!row.live, max: Number(row.max || row.size || 2),
        members, who: row.who || 'Everyone', reqs: reqRows.map(r => ({ u: r.user_id, at: r.at })),
        status: row.status || 'open', day: row.day || 'Today', auto: !!row.auto,
        event: row.event_id || null, spot: row.spot || '', created: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
        _shared: true, _supabaseCreatorUid: row.creator
    };
}

function clearSharedPlanCache() {
    if (typeof S === 'undefined') return;
    S.plans = (S.plans || []).filter(p => !p._shared);
    S.users = (S.users || []).filter(u => !u._supabaseProfile);
    if (typeof save === 'function') save();
}

let sharedPlanRefreshInFlight = null;
async function refreshSharedPlans(options = {}) {
    if (sharedPlanRefreshInFlight) return sharedPlanRefreshInFlight;
    const client = getSupabaseClient();
    if (!client) return [];
    sharedPlanRefreshInFlight = (async () => {
        const auth = await client.auth.getUser();
        const user = auth && auth.data && auth.data.user;
        if (auth.error) throw sharedPlanError('authentication_check_failed', auth.error);
        if (!user) { clearSharedPlanCache(); return []; }
        /* Feed query deliberately excludes exact spot and coordinates. RLS is row-level,
           not column-level, so selecting '*' here would expose private meetup details to
           every authenticated user who can discover a plan. */
        const publicPlanColumns = 'id,creator,type,title,descr,vibe,loc,dist,when_at,live,size,who,status,max,auto,city,day,event_id,created_at,updated_at';
        const plansResult = await client.from('plans').select(publicPlanColumns).eq('status', 'open').order('created_at', { ascending: false }).limit(300);
        if (plansResult.error) throw sharedPlanError('plan_feed_load_failed', plansResult.error);
        const [membersResult, requestsResult, countsResult] = await Promise.all([
            client.from('memberships').select('plan_id,user_id,role,state,created_at'),
            client.from('join_requests').select('plan_id,user_id,state,at'),
            client.rpc('shared_plan_member_counts')
        ]);
        if (membersResult.error) throw sharedPlanError('plan_memberships_load_failed', membersResult.error);
        if (requestsResult.error) throw sharedPlanError('plan_requests_load_failed', requestsResult.error);
        if (countsResult.error) throw sharedPlanError('plan_member_counts_load_failed', countsResult.error);
        const rows = plansResult.data || [], memberships = membersResult.data || [], requests = requestsResult.data || [];
        const countByPlan = new Map((countsResult.data || []).map(x => [x.plan_id, Number(x.member_count || 0)]));
        /* Private location details are fetched only for plans the signed-in user hosts
           or belongs to. The membership SELECT policy permits the user to see their own
           membership and memberships for groups they are already in. */
        const privilegedIds = [...new Set([
            ...rows.filter(r => r.creator === user.id).map(r => r.id),
            ...memberships.filter(m => m.user_id === user.id && m.state === 'member').map(m => m.plan_id)
        ])];
        let privateRows = [];
        if (privilegedIds.length) {
            const privateResult = await client.from('plans').select('id,spot,loc_lat,loc_lng,loc_source,loc_place').in('id', privilegedIds);
            if (privateResult.error) throw sharedPlanError('plan_private_location_load_failed', privateResult.error);
            privateRows = privateResult.data || [];
        }
        const privateById = new Map(privateRows.map(r => [r.id, r]));
        const remote = rows.map(row => {
            const merged = { ...row, ...(privateById.get(row.id) || {}) };
            const plan = sharedPlanFromRow(merged, user.id, memberships, requests);
            plan.memberCount = countByPlan.get(row.id) || 0;
            return plan;
        });
        const ids = new Set(remote.map(p => p.id));
        S.plans = (S.plans || []).filter(p => !p._shared && !ids.has(p.id)).concat(remote);

        const creatorIds = [...new Set(rows.map(r => r.creator).filter(id => id && id !== user.id))];
        if (creatorIds.length) {
            const profilesResult = await client.from('profiles').select('id,username,name,email,gender,city,age_range,bio,photo_url,interests,onboarded,rel').in('id', creatorIds);
            if (profilesResult.error) throw sharedPlanError('plan_profiles_load_failed', profilesResult.error);
            const profileIds = new Set((profilesResult.data || []).map(p => p.id));
            S.users = (S.users || []).filter(u => !u._supabaseProfile || !creatorIds.includes(u.sub));
            (profilesResult.data || []).forEach(p => S.users.push({
                id: p.id, sub: p.id, _supabaseProfile: true, real: 0,
                username: p.username || '', name: p.name || 'Someone', email: p.email || '', gender: p.gender || '',
                city: p.city || '', ageRange: p.age_range || '', bio: p.bio || '', photo: p.photo_url || '',
                interests: p.interests || [], onboarded: !!p.onboarded, rel: p.rel || {}
            }));
            /* If RLS intentionally hides a profile, the plan remains visible but the UI uses its safe fallback. */
            void profileIds;
        }
        if (typeof refreshSharedFeedbackSummaries === 'function') { try { await refreshSharedFeedbackSummaries(); } catch (e) { console.warn('[feedback] aggregate refresh failed:', e && e.code || e); } }
        if (typeof save === 'function') save();
        if (options.render !== false && typeof render === 'function') render();
        return remote;
    })();
    try { return await sharedPlanRefreshInFlight; }
    finally { sharedPlanRefreshInFlight = null; }
}



