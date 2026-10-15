try {
    const th = localStorage.getItem('squado-theme');
    if (th)
        document.documentElement.dataset.theme = th;
}
catch (e) { }
addEventListener('hashchange', () => {
    modal('');
    /* opening a squad chat (#/gc/:id): re-mint the signed URLs for any stored private chat media */
    if (typeof supabaseConfigured === 'function' && supabaseConfigured() && location.hash.indexOf('#/gc/') === 0 && typeof A !== 'undefined' && A.refreshChatMedia)
        A.refreshChatMedia(location.hash.slice('#/gc/'.length));
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
