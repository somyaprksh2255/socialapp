const msgs = id => {
    const plan = pl(id);
    if (plan && plan._shared && Array.isArray(S.msgs[id])) {
        /* Older releases cached fake/local-only messages in a shared chat. Keep only rows with a server ID. */
        S.msgs[id] = S.msgs[id].filter(m => m && m._remoteId);
    }
    if (!S.msgs[id]) {
        const p = pl(id);
        /* Published shared plans must start from the server inbox, not local starter messages. */
        S.msgs[id] = p && p._shared ? [] : p ? [
            { sys: 1, x: `${usr(p.creator).name} started the plan 🪩` },
            { by: p.creator, x: 'Pull up whenever. I\'ll share the exact spot here 📍' }
        ] : [];
    }
    return S.msgs[id];
};

const sys = (id, x) =>
    msgs(id).push({
        sys: 1,
        x
    });