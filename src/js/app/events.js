document.addEventListener('click', e => {
    const b = e.target.closest('[data-a]');
    if (!b)
        return;
    const a = b.dataset.a;
    if (a === 'goBack' && b.tagName === 'A') e.preventDefault();
    if (a == 'close' && b.tagName == 'A') {
        modal('');
        return;
    }
    if (A[a]) {
        A[a](b.dataset.a == 'send' ? b.dataset.v : b);
        if (
            ![
                'send',
                'join',
                'report',
                'members',
                'user',
                'close',
                'submitRep',
                'leave',
                'cjoin',
                'block',
                'postOut',
                'post',
                'login',
                'react',
                'home',
                'attachments',
                'sendMedia',
                'reviewRequest',
                'openMediaCamera',
                'capturePhoto',
                'mediaRetry',
                'attachLocation',
                'detachLocation',
                'openMediaLocation',
                'notifGo',
                'fbStar',
                'fbTag',
                'fbSubmit',
                'fbPeople',
                'fbTog',
                'fbPick',
                'fbCont',
                'fbBack',
                'fbPStar',
                'fbSend',
                'attStart',
                'attQr',
                'attClose',
                'attClaim',
                'compOk',
                'compNo',
                'compUndo',
                'checkinSignIn',
                'checkinGo',
                'scanOpen',
                'scanManual',
                'gDevSave',
                'gDevClear',
                'linkAcct',
                'newGoogleAcct'
            ].includes(a) ||
            ['react', 'block', 'unblock'].includes(a) && 0
        )
            render();
        if (['home'].includes(a))
            return;
    }
});
document.addEventListener('input', e => {
    const el = e.target,
        k = el.dataset.in;
    if (!k)
        return;
    const [t, f] = path(k);
    if (f == 'username')
        el.value = el.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
    t[f] = el.value;
    if (k == 'chat.draft') {
        const sb = document.querySelector('#sendbtn');
        if (sb)
            sb.disabled = !el.value.trim();
    }
    if (k == 'ui.q') {
        render();
        const i = document.querySelector('[data-in="ui.q"]');
        if (i) {
            i.focus();
            try {
                i.setSelectionRange(99, 99);
            }
            catch (x) { }
        }
    }
    if (f == 'username') {
        const u = $('#un');
        if (u)
            u.textContent = unMsg(
                el.value,
                k == 'ed.username' ? S.me.username : ''
            );
    }
    const b = document.querySelector('[data-a=obNext]');
    if (b && k.startsWith('ob.'))
        b.disabled = !obOk();
});
document.addEventListener('change', e => {
    const i = e.target;
    if (i.dataset.photo && i.files[0])
        photo(i.files[0], u => {
            if (i.dataset.photo == 'ob') {
                O.ob.photo = u;
                render();
            }
            else {
                O.ed.photo = u;
                editSheet();
            }
        });
});
/* Load real, published Events from the backend when it is configured. Local draft records are
 * preserved; backend published records replace matching IDs and never create demo placeholders. */
async function refreshPublishedEvents() {
    const cfg = window.SQUADO_CONFIG || {};
    const base = String(cfg.apiBaseUrl || '').replace(/\/$/, '');
    if (!base || typeof S === 'undefined' || typeof save !== 'function') return;
    /* A guest must never retain a previously cached real Event list. */
    if (!S.me || S.me.guest || typeof supabaseAccessToken !== 'function') {
        S.events = [];
        save();
        return [];
    }
    try {
        const token = await supabaseAccessToken();
        if (!token) { S.events = []; save(); return []; }
        const res = await fetch(base + '/api/events', {
            headers: { Accept: 'application/json', Authorization: 'Bearer ' + token }
        });
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) { S.events = []; save(); }
            return [];
        }
        const data = await res.json();
        const remote = Array.isArray(data.events) ? data.events : [];
        const byId = new Map(remote.map(row => [row.id, { ...(row.payload || {}), id: row.id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, serverManaged: true }]));
        /* The API returns only published Events for this authenticated profile's city. */
        S.events = [...byId.values()];
        save();
        if (typeof render === 'function') render();
        return S.events;
    } catch (_) { return []; }
}
