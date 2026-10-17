const usr = id =>
    id == 'me'
        ? S.me
        : S.users.find(u => u.id == id || u.sub == id) || {
            name: 'Someone',
            interests: [],
            city: ''
        };

/* A single non-persistent preview lets guests understand the product without exposing real plans.
   It is deliberately not inserted into S.plans or written to Supabase/localStorage. */
const GUEST_DEMO_PLAN = Object.freeze({
    id: 'demo-preview-plan', demo: true, creator: 'demo-host', type: 'chai',
    title: 'Demo plan · Chai & yap',
    desc: 'This is a sample plan. Sign in and choose your city to discover real meetups.',
    vibe: ['chill'], loc: 'Demo location', city: '', when: 'Sample time',
    live: false, max: 4, members: [], who: 'Everyone', reqs: [], status: 'open',
    day: 'Demo', auto: false, event: null, spot: '', created: 0
});

const pl = id =>
    S.plans.find(p => p.id == id) || (id === GUEST_DEMO_PLAN.id && tier() === 'guest' ? GUEST_DEMO_PLAN : undefined);

/* the supported city this person browses: their saved city if we support it, otherwise every supported city */
const viewCity = () =>
    isCity(S.discoveryCity) ? S.discoveryCity : (isCity(S.me.city) ? S.me.city : null);

const cityKey = value => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const sameCity = (a, b) => !!cityKey(a) && !!cityKey(b) && cityKey(a) === cityKey(b);
const planCity = p => p && (p.city || cityOfLoc(p.loc));

/* Guests receive exactly one local demo preview, never live plans. Real discovery requires a
   supported selected/profile city. Existing accepted groups remain visible if the member changes city. */
const vis = () => {
    if (tier() === 'guest') return [GUEST_DEMO_PLAN];
    const selected = viewCity();
    return S.plans.filter(p =>
        p &&
        p.status === 'open' &&
        (
            groupAccess(p) ||
            (p._shared === true && !!selected && isCity(planCity(p)) && sameCity(planCity(p), selected) && !S.blocked.includes(p.creator))
        )
    );
};

const visibleEvents = () => {
    if (tier() === 'guest') return [];
    const selected = viewCity();
    if (!selected) return [];
    return (Array.isArray(S.events) ? S.events : []).filter(e =>
        e &&
        e.status === 'published' &&
        sameCity(e.city || e.locCity || cityOfLoc(e.loc), selected)
    );
};

const unreadN = () =>
    myNotifs().filter(n => n.u).length;

const isHost = p =>
    !!p &&
    tier() == 'ready' &&
    p.creator == 'me';

const pendingReqs = p =>
    p && isHost(p) && p.status == 'open'
        ? p.reqs
        : [];

/* unread for one squad: a whole number >= 0, and only for squads this person can open right now */
const unreadFor = id => {
    const n = Math.floor(+(S.unread || {})[id]);

    return n > 0 && groupAccess(pl(id)) ? n : 0;
};

const unreadTotal = () =>
    Object.keys(S.unread || {}).reduce(
        (a, id) => a + unreadFor(id),
        0
    );

const unreadBump = id => {
    if (!groupAccess(pl(id)))
        return;

    S.unread[id] = unreadFor(id) + 1;
};

/* drop unread entries that are invalid or belong to a squad that is gone or no longer accessible */
const unreadSanitize = () => {
    if (!S.unread || typeof S.unread != 'object')
        S.unread = {};

    Object.keys(S.unread).forEach(id => {
        if (!unreadFor(id))
            delete S.unread[id];
    });
};

const chatMaxLen = () => Math.max(1, +(window.SQUADO_CONFIG && SQUADO_CONFIG.chatMaxLen) || 300);