const usr = id =>
    id == 'me'
        ? S.me
        : S.users.find(u => u.id == id || u.sub == id) || {
            name: 'Someone',
            interests: [],
            city: ''
        };

const pl = id =>
    S.plans.find(p => p.id == id);

/* the supported city this person browses: their saved city if we support it, otherwise every supported city */
const viewCity = () =>
    isCity(S.discoveryCity) ? S.discoveryCity : (isCity(S.me.city) ? S.me.city : null);

/* Events are city-scoped. Unknown/missing city is never treated as a match for every feed. */
const cityKey = value => String(value || '').trim().toLocaleLowerCase().replace(/\\s+/g, ' ');
const eventCity = e => e && (e.city || e.locCity || cityOfLoc(e.loc));
const eventVisibleInCurrentCity = e => {
    const selected = cityKey(viewCity());
    const actual = cityKey(eventCity(e));
    return !!selected && !!actual && selected === actual;
};

const planCity = p =>
    p.city || cityOfLoc(p.loc);

const vis = () =>
    S.plans.filter(
        p =>
            !S.blocked.includes(p.creator) &&
            p.status == 'open' &&
            isCity(planCity(p)) &&
            (!viewCity() || planCity(p) == viewCity())
    );

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