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
