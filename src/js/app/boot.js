/* Keep a per-tab, in-app route trail so Back controls return to the user's actual previous screen.
   Hash routes already preserve the active screen across refresh; this trail makes app Back controls reliable
   and avoids sending users to a hard-coded/random page. */
const ROUTE_TRAIL_KEY = 'squado-route-trail-v1';
function readRouteTrail() {
    try {
        const v = JSON.parse(sessionStorage.getItem(ROUTE_TRAIL_KEY) || '[]');
        return Array.isArray(v) ? v.filter(x => typeof x === 'string' && /^#\//.test(x)) : [];
    } catch (e) { return []; }
}
function writeRouteTrail(trail) {
    try { sessionStorage.setItem(ROUTE_TRAIL_KEY, JSON.stringify(trail.slice(-40))); } catch (e) { }
}
function syncRouteTrail() {
    const route = location.hash || '#/home';
    const trail = readRouteTrail();
    if (!trail.length) trail.push(route);
    else if (trail[trail.length - 1] !== route) {
        const prior = trail.lastIndexOf(route);
        if (prior >= 0) trail.splice(prior + 1);
        else trail.push(route);
    }
    writeRouteTrail(trail);
}
syncRouteTrail();
addEventListener('hashchange', syncRouteTrail);

try {
    const th = localStorage.getItem('squado-theme');
    /* First-time visitors and guests start in the bright theme. Respect an explicit saved choice. */
    document.documentElement.dataset.theme = th === 'dark' || th === 'light' ? th : 'light';
}
catch (e) { document.documentElement.dataset.theme = 'light'; }
addEventListener('hashchange', () => {
    modal('');
    /* opening a squad chat (#/gc/:id): re-mint the signed URLs for any stored private chat media */
    if (typeof supabaseConfigured === 'function' && supabaseConfigured() && location.hash.indexOf('#/gc/') === 0) {
        const chatId = location.hash.slice('#/gc/'.length);
        if (typeof A !== 'undefined' && A.refreshChatMedia) A.refreshChatMedia(chatId);
        if (typeof refreshSharedChatMessages === 'function')
            refreshSharedChatMessages(chatId).catch(e => console.warn('[chat] initial load failed:', e && e.code || e));
    }
    render();
    /* Refresh published Events as users navigate so newly published admin Events become visible
       without requiring a hard reload. */
    if (typeof refreshPublishedEvents === 'function') refreshPublishedEvents();
});
setInterval(() => {
    if (S.me && !S.me.guest && checkSession()) {
        render();
        return;
    }
}, 2000);

/* Supabase is the primary auth: register the one auth listener and restore/consume any session exactly once.
   Deterministic (not auto-on-load) so it runs after every app global is defined. Inert when not configured. */
if (typeof initSupabase === 'function' && typeof supabaseConfigured === 'function' && supabaseConfigured())
    initSupabase();

render();
if (typeof refreshPublishedEvents === 'function') refreshPublishedEvents();

/* Shared group messages are fetched while the chat is open. No fake polling for local-only demo groups. */
setInterval(() => {
    if (!S.me || S.me.guest || !location.hash || location.hash.indexOf('#/gc/') !== 0) return;
    const id = location.hash.slice('#/gc/'.length);
    const p = typeof pl === 'function' ? pl(id) : null;
    if (p && p._shared && typeof refreshSharedChatMessages === 'function')
        refreshSharedChatMessages(id).catch(e => console.warn('[chat] refresh failed:', e && e.code || e));
}, 5000);

/* Shared plans are server-owned; refresh across users/tabs without replacing local UI state. */
setInterval(() => {
    if (!S.me || S.me.guest) return;
    if (typeof refreshSharedPlans === 'function')
        refreshSharedPlans({ render: false }).catch(e => console.warn('[plans] refresh failed:', e && e.code || e));
    if (typeof refreshSharedNotifications === 'function')
        refreshSharedNotifications({ render: false }).catch(e => console.warn('[notifications] refresh failed:', e && e.code || e));
    if (typeof refreshSharedBlocks === 'function')
        refreshSharedBlocks({ render: false }).catch(e => console.warn('[blocks] refresh failed:', e && e.code || e));
}, 15000);
