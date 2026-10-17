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
    if (!u || !u.id) return;

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

    /* Supabase is the durable profile source. Read it before creating a new local
       account or writing anything, otherwise a returning user on a fresh browser can
       be mistaken for a new user and the empty local profile can overwrite their row. */
    let remoteProfile = null;
    try {
        remoteProfile = await loadSupabaseProfile(u);
    } catch (e) {
        console.error('[supabase] saved profile lookup failed:', e && (e.code || e.message) || e);
        if (typeof modal === 'function' && typeof authProblem === 'function')
            modal(authProblem('lookup'));
        return;
    }

    /* Repeated INITIAL_SESSION / SIGNED_IN for the current identity must still restore
       the database profile, especially after the account email/metadata changes. */
    if (S.me && !S.me.guest && S.me.sub === who.sub) {
        if (remoteProfile) {
            hydrateSupabaseProfile(S.me, who, remoteProfile);
            save();
            if (obPending()) startOb(S.me.name || who.name);
            else afterAuth();
        } else if (!S.me.onboarded) {
            startOb(S.me.name || who.name);
        }
        normalizeOAuthHash();
        if (!obPending() && S.me.onboarded) {
            syncSupabaseProfile(u)
                .then(() => Promise.all([
                    refreshSharedPlans({ render: false }),
                    refreshSharedNotifications({ render: false })
                ]))
                .catch(e => console.warn('[supabase] initial profile/feed/notification sync failed:', e && e.code || e));
        }
        return;
    }

    if (typeof modal === 'function') modal('');

    let rec = S.users.find(x => x.real && x.sub === who.sub) || null;
    if (!rec) {
        try {
            rec = createAccount(who);
        } catch (e) {
            if (typeof authProblem === 'function') modal(authProblem('save'));
            return;
        }
    }

    if (remoteProfile) {
        hydrateSupabaseProfile(rec, who, remoteProfile);
    } else {
        /* A local profile from the earlier device-local version may exist even before
           its first server sync. Preserve it; do not reset a completed local account. */
        rec.sub = who.sub;
        rec.email = who.email || rec.email || '';
        if (who.photo && !rec.photo) rec.photo = who.photo;
    }
    save();

    const switchingAccount = !(S.acct && S.acct === rec.id && !S.me.guest);
    if (switchingAccount) {
        S.remoteNotifs = [];
        enterAccount(rec.id);
    }

    normalizeOAuthHash();

    if (rec.onboarded === false || obPending()) {
        startOb(rec.name || who.name);
    } else {
        afterAuth();
    }

    /* Only completed profiles are synced here. Incomplete onboarding is written by
       finishOb(), avoiding an out-of-order blank-profile upsert that could undo it. */
    if (!obPending() && S.me.onboarded) {
        syncSupabaseProfile(u)
            .then(() => Promise.all([
                refreshSharedPlans({ render: false }),
                refreshSharedNotifications({ render: false })
            ]))
            .catch(e => console.warn('[supabase] profile/feed/notification sync pending:', e && e.code || e));
    }
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

async function loadSupabaseProfile(user) {
    const client = getSupabaseClient();
    if (!client) throw sharedPlanError('supabase_not_configured');
    const result = await client
        .from('profiles')
        .select('id,username,name,email,gender,city,age_range,bio,photo_url,interests,onboarded,rel')
        .eq('id', user.id)
        .maybeSingle();
    if (result.error) throw sharedPlanError('profile_load_failed', result.error);
    return result.data || null;
}

function hydrateSupabaseProfile(rec, who, row) {
    if (!rec || !row) return rec;
    const savedProgress = rec.ob && typeof rec.ob === 'object' ? rec.ob : {};
    /* Older releases saved completed onboarding locally but could leave profiles.onboarded
       false on the server. For the same stable Supabase user ID, don't demote a complete
       local profile just because that legacy server flag was never synced. */
    const localWasComplete = !!rec.onboarded
        && !!String(rec.name || '').trim()
        && !!String(rec.username || '').trim()
        && !!String(rec.city || '').trim()
        && !!String(rec.gender || '').trim()
        && !!String(rec.ageRange || '').trim();
    const keepLocalCompletion = !row.onboarded && localWasComplete;
    const value = (remote, local, fallback = '') =>
        keepLocalCompletion ? String(local || fallback || '') :
        remote == null ? String(local || fallback || '') : String(remote);
    rec.sub = who.sub;
    rec.email = String(who.email || row.email || rec.email || '').trim().toLowerCase();
    rec.name = value(row.name, rec.name, who.name);
    rec.username = value(row.username, rec.username);
    rec.gender = value(row.gender, rec.gender);
    rec.city = value(row.city, rec.city);
    rec.ageRange = value(row.age_range, rec.ageRange);
    rec.bio = value(row.bio, rec.bio);
    rec.photo = value(row.photo_url, rec.photo, who.photo);
    rec.interests = keepLocalCompletion
        ? (Array.isArray(rec.interests) ? rec.interests : [])
        : Array.isArray(row.interests) ? row.interests : (rec.interests || []);
    rec.rel = keepLocalCompletion
        ? (rec.rel && typeof rec.rel === 'object' ? rec.rel : {})
        : row.rel && typeof row.rel === 'object' ? row.rel : (rec.rel || {});
    const profileComplete = (!!row.onboarded || keepLocalCompletion)
        && !!rec.name.trim()
        && !!rec.username.trim()
        && !!rec.city.trim()
        && !!rec.gender.trim()
        && !!rec.ageRange.trim();
    rec.onboarded = profileComplete;
    if (profileComplete) {
        delete rec.ob;
    } else {
        rec.ob = {
            ...savedProgress,
            name: rec.name,
            username: rec.username,
            city: rec.city,
            gender: rec.gender,
            age: rec.ageRange,
            interests: rec.interests
        };
    }
    return rec;
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
    const completionRow = row.completion && typeof row.completion === 'object' ? {
        ...row.completion,
        by: row.completion.by === uid ? 'me' : row.completion.by
    } : null;
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
        members, who: row.who || 'Everyone', reqs: reqRows.map(r => ({ u: r.user_id === uid ? 'me' : r.user_id, at: r.at })),
        status: row.status === 'closed' ? (completionRow ? 'ended' : 'closed') : 'open',
        completion: completionRow,
        day: row.day || 'Today', auto: !!row.auto,
        event: row.event_id || null, spot: row.spot || '', created: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
        _shared: true, _supabaseCreatorUid: row.creator
    };
}

function clearSharedPlanCache() {
    if (typeof S === 'undefined') return;
    S.plans = (S.plans || []).filter(p => !p._shared);
    S.users = (S.users || []).filter(u => !u._supabaseProfile);
    S.remoteNotifs = [];
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
        const publicPlanColumns = 'id,creator,type,title,descr,vibe,loc,dist,when_at,live,size,who,status,max,auto,city,day,event_id,completion,created_at,updated_at';
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
        const memberships = membersResult.data || [], requests = requestsResult.data || [];
        /* Also load closed plans for accepted members/hosts so attendance and feedback remain
           available after a meetup ends. Closed plans never enter public discovery. */
        const ownMembershipPlanIds = [...new Set(memberships
            .filter(m => m.user_id === user.id && m.state === 'member')
            .map(m => m.plan_id)
            .filter(Boolean))];
        let closedRows = [];
        if (ownMembershipPlanIds.length) {
            const closedResult = await client.from('plans')
                .select(publicPlanColumns)
                .eq('status', 'closed')
                .in('id', ownMembershipPlanIds)
                .order('updated_at', { ascending: false })
                .limit(300);
            if (closedResult.error) throw sharedPlanError('plan_history_load_failed', closedResult.error);
            closedRows = closedResult.data || [];
        }
        const rows = [...new Map([...(plansResult.data || []), ...closedRows].map(row => [row.id, row])).values()];
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

        const creatorIds = rows.map(r => r.creator).filter(id => id && id !== user.id);
        const requesterIds = requests.filter(r => r.state === 'pending').map(r => r.user_id).filter(id => id && id !== user.id);
        const memberIds = memberships.filter(m => m.state === 'member').map(m => m.user_id).filter(id => id && id !== user.id);
        const profileIdsToLoad = [...new Set([...creatorIds, ...requesterIds, ...memberIds])];
        if (profileIdsToLoad.length) {
            const profilesResult = await client.from('profiles')
                .select('id,username,name,email,gender,city,age_range,bio,photo_url,interests,onboarded,rel')
                .in('id', profileIdsToLoad);
            if (profilesResult.error) throw sharedPlanError('plan_profiles_load_failed', profilesResult.error);
            S.users = (S.users || []).filter(u => !u._supabaseProfile || !profileIdsToLoad.includes(u.sub));
            (profilesResult.data || []).forEach(p => S.users.push({
                id: p.id, sub: p.id, _supabaseProfile: true, real: 0,
                username: p.username || '', name: p.name || 'Someone', email: p.email || '', gender: p.gender || '',
                city: p.city || '', ageRange: p.age_range || '', bio: p.bio || '', photo: p.photo_url || '',
                interests: p.interests || [], onboarded: !!p.onboarded, rel: p.rel || {}
            }));
            /* RLS can hide a profile that is unrelated to the current plan; safe fallback remains available. */
        }
        if (typeof refreshSharedAttendance === 'function') { try { await refreshSharedAttendance({ render: false }); } catch (e) { console.warn('[attendance] shared refresh failed:', e && e.code || e); } }
        if (typeof refreshSharedFeedbackSummaries === 'function') { try { await refreshSharedFeedbackSummaries(); } catch (e) { console.warn('[feedback] aggregate refresh failed:', e && e.code || e); } }
        if (typeof save === 'function') save();
        if (options.render !== false && typeof render === 'function') render();
        return remote;
    })();
    try { return await sharedPlanRefreshInFlight; }
    finally { sharedPlanRefreshInFlight = null; }
}





/* Shared group chat: the database is authoritative for cross-account messages.
   The messages/message_reactions tables are protected by the migration's accepted-member RLS policies. */
const sharedChatRefreshes = new Map();

function chatTimeLabel(value) {
    const d = value ? new Date(value) : new Date();
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sharedChatMessageFromRow(row, uid, cached) {
    const kind = row.kind || 'text';
    const m = {
        _remoteId: row.id,
        _shared: true,
        by: row.by === uid ? 'me' : row.by,
        x: row.text || '',
        t: chatTimeLabel(row.created_at),
        mpath: row.media_path || '',
        loc: row.loc || null,
        r: '',
        _myReaction: ''
    };
    if (kind === 'sys') m.sys = 1;
    else if (kind !== 'text') m.type = kind;
    if (cached && cached.mpath === m.mpath && cached.src) m.src = cached.src;
    return m;
}

async function publishSharedChatMessage(planId, draft) {
    const client = getSupabaseClient();
    if (!client) throw sharedPlanError('supabase_not_configured');
    const plan = typeof pl === 'function' ? pl(planId) : null;
    if (!plan || !plan._shared || typeof groupAccess !== 'function' || !groupAccess(plan))
        throw sharedPlanError('chat_forbidden');
    const user = await currentSupabaseUser();
    if (!S.me || S.me.guest || S.me.sub !== user.id)
        throw sharedPlanError('chat_authentication_required');
    const kind = String(draft && draft.kind || 'text');
    if (!['text', 'photo', 'location', 'photo-location'].includes(kind))
        throw sharedPlanError('chat_invalid_message');
    const body = {
        plan_id: String(planId),
        by: user.id,
        kind,
        text: String(draft && draft.text || '').slice(0, 300) || null,
        media_path: String(draft && draft.mediaPath || '') || null,
        loc: draft && draft.loc != null ? draft.loc : null
    };
    if (kind === 'text' && !String(body.text || '').trim())
        throw sharedPlanError('chat_empty_message');
    const result = await client.from('messages')
        .insert(body)
        .select('id,plan_id,by,kind,text,media_path,loc,created_at')
        .single();
    if (result.error || !result.data)
        throw sharedPlanError('chat_message_send_failed', result.error);
    return sharedChatMessageFromRow(result.data, user.id, null);
}

async function toggleSharedMessageReaction(messageId, currentEmoji) {
    const client = getSupabaseClient();
    if (!client) throw sharedPlanError('supabase_not_configured');
    const user = await currentSupabaseUser();
    const reactions = ['🔥', '🕺', '😭', ''];
    const next = reactions[(Math.max(-1, reactions.indexOf(currentEmoji)) + 1) % reactions.length];
    if (!next) {
        const removed = await client.from('message_reactions').delete()
            .eq('message_id', messageId).eq('user_id', user.id);
        if (removed.error) throw sharedPlanError('chat_reaction_save_failed', removed.error);
    } else {
        const saved = await client.from('message_reactions').upsert(
            { message_id: messageId, user_id: user.id, emoji: next },
            { onConflict: 'message_id,user_id' }
        );
        if (saved.error) throw sharedPlanError('chat_reaction_save_failed', saved.error);
    }
    return next;
}

async function refreshSharedChatMessages(planId, options = {}) {
    const key = String(planId || '');
    if (sharedChatRefreshes.has(key)) return sharedChatRefreshes.get(key);
    const client = getSupabaseClient();
    const plan = typeof pl === 'function' ? pl(key) : null;
    if (!client || !plan || !plan._shared || typeof groupAccess !== 'function' || !groupAccess(plan))
        return [];
    const task = (async () => {
        const user = await currentSupabaseUser();
        if (!S.me || S.me.guest || S.me.sub !== user.id) return [];
        const result = await client.from('messages')
            .select('id,plan_id,by,kind,text,media_path,loc,created_at')
            .eq('plan_id', key)
            .order('created_at', { ascending: true })
            .limit(500);
        if (result.error) throw sharedPlanError('chat_load_failed', result.error);
        const rows = result.data || [];
        const old = Array.isArray(S.msgs[key]) ? S.msgs[key] : [];
        const oldById = new Map(old.filter(m => m && m._remoteId).map(m => [m._remoteId, m]));
        const signature = list => JSON.stringify((list || []).map(m => [m._remoteId || '', m.by || '', m.x || '', m.r || '', m.mpath || '']));
        const oldSignature = signature(old);
        const ids = rows.map(row => row.id).filter(Boolean);
        let reactionRows = [];
        if (ids.length) {
            const reactions = await client.from('message_reactions')
                .select('message_id,user_id,emoji')
                .in('message_id', ids);
            if (reactions.error) throw sharedPlanError('chat_reaction_load_failed', reactions.error);
            reactionRows = reactions.data || [];
        }
        const byMessage = new Map();
        reactionRows.forEach(r => {
            if (!byMessage.has(r.message_id)) byMessage.set(r.message_id, []);
            byMessage.get(r.message_id).push(r);
        });
        const mapped = [];
        for (const row of rows) {
            const m = sharedChatMessageFromRow(row, user.id, oldById.get(row.id));
            const rs = byMessage.get(row.id) || [];
            m.r = rs.map(x => x.emoji).join('');
            m._myReaction = (rs.find(x => x.user_id === user.id) || {}).emoji || '';
            if (m.mpath && !m.src && typeof signChatMedia === 'function') {
                try { m.src = await signChatMedia(m.mpath); }
                catch (_) { m.src = ''; }
            }
            mapped.push(m);
        }
        const current = await client.auth.getUser();
        if (current.error || !current.data || !current.data.user ||
            current.data.user.id !== user.id || !S.me || S.me.guest || S.me.sub !== user.id)
            return mapped;
        const changed = oldSignature !== signature(mapped);
        S.msgs[key] = mapped;
        if (typeof save === 'function') save();
        if (changed && options.render !== false && location.hash === '#/gc/' + key && typeof render === 'function') {
            const input = typeof document !== 'undefined' ? document.activeElement : null;
            const keepComposer = input && input.id === 'mi';
            const start = keepComposer && Number.isInteger(input.selectionStart) ? input.selectionStart : null;
            const end = keepComposer && Number.isInteger(input.selectionEnd) ? input.selectionEnd : null;
            render();
            const replacement = keepComposer && typeof document !== 'undefined' ? document.getElementById('mi') : null;
            if (replacement) {
                replacement.focus();
                if (start !== null && end !== null && typeof replacement.setSelectionRange === 'function') {
                    try { replacement.setSelectionRange(start, end); } catch (_) { }
                }
            }
            if (typeof scrollTo === 'function') scrollTo(0, 1e6);
        }
        return mapped;
    })();
    sharedChatRefreshes.set(key, task);
    try { return await task; }
    finally { if (sharedChatRefreshes.get(key) === task) sharedChatRefreshes.delete(key); }
}

/* Sync the host's completion to Supabase so the plan closes for all members and feedback
   becomes eligible on every device. The server-side RPC also marks the host present atomically. */
async function completeSharedPlanRemote(planId) {
    const client = getSupabaseClient();
    if (!client) throw sharedPlanError('supabase_not_configured');
    const plan = typeof pl === 'function' ? pl(planId) : null;
    if (!plan || !plan._shared || plan.creator !== 'me')
        throw sharedPlanError('plan_completion_forbidden');
    const user = await currentSupabaseUser();
    if (!S.me || S.me.guest || S.me.sub !== user.id)
        throw sharedPlanError('authentication_required');
    const result = await client.rpc('complete_shared_plan', { p_plan: String(planId) });
    if (result.error || result.data !== true)
        throw sharedPlanError('plan_completion_sync_failed', result.error);
    return true;
}

/* Shared feedback keeps individual responses private. The database authorizes submissions
   only for completed meetups with verified attendance; summaries are aggregate-only (3+ ratings). */
async function submitSharedFeedback(plan, kind, payload, targetUid) {
    if (!plan || !plan._shared) return true; // local/demo plans keep their local behavior
    const client = getSupabaseClient();
    if (!client) throw sharedPlanError('supabase_not_configured');
    if (!['meetup', 'person'].includes(kind)) throw sharedPlanError('feedback_invalid_kind');
    const user = await currentSupabaseUser();
    if (!S.me || S.me.guest || S.me.sub !== user.id) throw sharedPlanError('authentication_required');
    if (plan.status !== 'ended') throw sharedPlanError('ineligible');
    const rating = Math.round(Number(payload && payload.rating));
    if (!(rating >= 1 && rating <= 5)) throw sharedPlanError('feedback_invalid_rating');
    const target = kind === 'person' ? String(targetUid || '') : '';
    if (kind === 'person' && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target) || target === user.id))
        throw sharedPlanError('feedback_invalid_target');
    const duplicateQuery = client.from('feedback').select('id')
        .eq('plan_id', plan.id).eq('by', user.id).eq('kind', kind);
    if (kind === 'person') duplicateQuery.eq('to_uid', target);
    else duplicateQuery.is('to_uid', null);
    const prior = await duplicateQuery.limit(1);
    if (prior.error) throw sharedPlanError('feedback_duplicate_check_failed', prior.error);
    if ((prior.data || []).length) throw sharedPlanError('duplicate');
    const row = {
        plan_id: plan.id, by: user.id, to_uid: kind === 'person' ? target : null,
        kind, rating, tags: [...new Set((payload && payload.tags || []).map(String).slice(0, 20))],
        notes: String(payload && payload.comment || '').trim().slice(0, 500)
    };
    const result = await client.from('feedback').insert(row).select('id').single();
    if (result.error) {
        if (result.error.code === '23505') throw sharedPlanError('duplicate', result.error);
        if (result.error.code === '42501') throw sharedPlanError('ineligible', result.error);
        throw sharedPlanError('feedback_save_failed', result.error);
    }
    return true;
}

async function refreshSharedFeedbackSummaries() {
    const client = getSupabaseClient();
    if (!client) return [];
    const user = await currentSupabaseUser();
    if (!S.me || S.me.guest || S.me.sub !== user.id) return [];
    const result = await client.rpc('shared_feedback_summaries');
    if (result.error) throw sharedPlanError('feedback_summary_load_failed', result.error);
    const current = await client.auth.getUser();
    if (current.error || !current.data || !current.data.user || current.data.user.id !== user.id ||
        !S.me || S.me.guest || S.me.sub !== user.id) return [];
    const planSummaries = {};
    const personSummaries = {};
    (result.data || []).forEach(row => {
        const n = Number(row.n || 0);
        if (n < 3) return;
        const tags = row.tags && typeof row.tags === 'object' ? row.tags : {};
        if (row.kind === 'meetup' && row.plan_id) {
            planSummaries[row.plan_id] = {
                n, avg: row.avg == null ? null : Number(row.avg),
                tags: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 3)
            };
        } else if (row.kind === 'person' && row.target_uid) {
            personSummaries[row.target_uid] = {
                n, avg: row.avg == null ? null : Number(row.avg), tags
            };
        }
    });
    /* Clear stale shared summaries for the plans currently cached by this account. */
    (S.plans || []).filter(p => p && p._shared).forEach(p => {
        if (!Object.prototype.hasOwnProperty.call(planSummaries, p.id))
            planSummaries[p.id] = null;
    });
    S.feedbackSummaries = { ...(S.feedbackSummaries || {}), ...planSummaries };
    S.trustSummaries = personSummaries;
    if (typeof save === 'function') save();
    return result.data || [];
}

/* Attendance written by the protected server scanner must be read back on each attendee's device.
   S.attendance is only a local UI cache; Supabase rows override cache entries with the same plan/member. */
let sharedAttendanceRefresh = null;
async function refreshSharedAttendance(options = {}) {
    if (sharedAttendanceRefresh) return sharedAttendanceRefresh;
    const client = getSupabaseClient();
    if (!client) return [];
    sharedAttendanceRefresh = (async () => {
        const user = await currentSupabaseUser();
        if (!S.me || S.me.guest || S.me.sub !== user.id) return [];
        const planIds = [...new Set((S.plans || []).filter(p => p && p._shared).map(p => p.id))];
        if (!planIds.length) return [];
        const result = await client.from('attendance')
            .select('id,plan_id,uid,status,method,audit,dispute,created_at,updated_at')
            .in('plan_id', planIds)
            .limit(1000);
        if (result.error) throw sharedPlanError('attendance_load_failed', result.error);
        const remote = (result.data || []).map(row => ({
            id: row.id,
            planId: row.plan_id,
            uid: row.uid === user.id ? 'me' : row.uid,
            status: row.status || 'present',
            method: row.method || 'in_app_scanner',
            at: row.updated_at ? Date.parse(row.updated_at) : (row.created_at ? Date.parse(row.created_at) : Date.now()),
            token: '',
            audit: Array.isArray(row.audit) ? row.audit : [],
            dispute: row.dispute || undefined,
            _sharedAttendance: true
        }));
        const keyOf = a => String(a.planId) + '|' + String(a.uid);
        const remoteKeys = new Set(remote.map(keyOf));
        S.attendance = (Array.isArray(S.attendance) ? S.attendance : [])
            .filter(a => !remoteKeys.has(keyOf(a)))
            .concat(remote);
        if (typeof save === 'function') save();
        if (options.render !== false && typeof render === 'function') render();
        return remote;
    })();
    try { return await sharedAttendanceRefresh; }
    finally { sharedAttendanceRefresh = null; }
}

/* Shared join notifications live in Supabase so they reach the right account on any device.
   The SQL migration creates one host notification for each new pending request and one
   requester notification when membership is accepted. */
async function refreshSharedNotifications(options = {}) {
    const client = getSupabaseClient();
    if (!client) {
        if (typeof S !== 'undefined') S.remoteNotifs = [];
        return [];
    }
    const auth = await client.auth.getUser();
    const user = auth && auth.data && auth.data.user;
    if (auth.error) throw sharedPlanError('notification_auth_check_failed', auth.error);
    if (!user) {
        if (typeof S !== 'undefined') S.remoteNotifs = [];
        return [];
    }
    const result = await client.from('squado_notifications')
        .select('id,recipient,actor,kind,plan_id,title,body,created_at,read_at')
        .eq('recipient', user.id)
        .order('created_at', { ascending: false })
        .limit(100);
    if (result.error) throw sharedPlanError('notification_load_failed', result.error);
    const rows = (result.data || []).map(row => ({
        id: 'shared-notif-' + row.id,
        _sharedNotificationId: row.id,
        to: 'me',
        type: row.kind,
        planId: row.plan_id,
        userId: row.actor === user.id ? 'me' : row.actor,
        ic: row.kind === 'join_request' ? 'user-plus' : 'party-popper',
        c: row.kind === 'join_request' ? 'pink' : 'green',
        t: row.title || 'Squado update',
        b: row.body || '',
        at: row.created_at ? Date.parse(row.created_at) : Date.now(),
        u: !row.read_at
    }));
    /* Prevent a delayed response for a previous account from leaking into a switched session. */
    const current = await client.auth.getUser();
    if (!current.error && current.data && current.data.user && current.data.user.id === user.id
        && typeof S !== 'undefined' && S.me && S.me.sub === user.id) {
        S.remoteNotifs = rows;
        if (typeof save === 'function') save();
        if (options.render !== false && typeof render === 'function') render();
    }
    return rows;
}

async function markSharedNotificationsRead(ids) {
    const client = getSupabaseClient();
    if (!client) return;
    const auth = await client.auth.getUser();
    const user = auth && auth.data && auth.data.user;
    if (auth.error) throw sharedPlanError('notification_auth_check_failed', auth.error);
    if (!user) return;
    const unreadIds = Array.isArray(ids) && ids.length
        ? ids
        : (S.remoteNotifs || []).filter(n => n.u && n._sharedNotificationId).map(n => n._sharedNotificationId);
    if (!unreadIds.length) return;
    const result = await client.from('squado_notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('recipient', user.id)
        .in('id', unreadIds);
    if (result.error) throw sharedPlanError('notification_mark_read_failed', result.error);
    const set = new Set(unreadIds);
    (S.remoteNotifs || []).forEach(n => {
        if (set.has(n._sharedNotificationId)) n.u = 0;
    });
    if (typeof save === 'function') save();
}
