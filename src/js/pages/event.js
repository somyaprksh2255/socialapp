/* Events are organized occasions. Attendance is never tracked at Event level; check-in belongs to Plans/Groups. */
function eventPage(id) {
  if (!idOk(id)) return fallbackPage('invalid');
  if (tier() === 'guest') return fallbackPage('event');
  const e = visibleEvents().find(x => x.id == id);
  if (!e || e.status === 'cancelled') return fallbackPage('event');
  const admin = canManageEvents();
  /* Use the same city/visibility gate as Explore, then keep only plans linked to this Event. */
  const plans = vis().filter(p => p.event === id);
  const dateRange = (e.endDateISO && e.endDateISO !== e.dateISO) ? `${e.dateLabel || e.date} – ${e.endDate || e.endDateISO}` : (e.dateLabel || e.date);
  const when = [dateRange, e.when].filter(Boolean).join(' · ');
  const place = e.visibility === 'area' && !admin ? e.loc : [e.venue, e.loc].filter(Boolean).join(' · ');
  return `
    <main class="wrap">
      <a class="back" href="#" data-a="goBack">← Back to Discover</a>
      <div class="dt">
        <div>
          <article class="card ev big">
            <div class="row">
              <span class="tag" style="background:var(--org);color:#fff">${I('ticket')} EVENT</span>
              <span class="pill">${esc(e.status === 'draft' ? 'Draft' : e.dateLabel || e.date || 'Date to be announced')}</span>
            </div>
            <h1 style="margin-top:12px">${esc(e.title)}</h1>
            <div class="meta" style="font-size:1rem">
              <span>🕘 ${esc(when || 'Time to be announced')}</span>
              <span>📍 ${esc(place || 'Location to be announced')}</span>
              ${e.ageGroup ? `<span>👥 ${esc(e.ageGroup)}</span>` : ''}
            </div>
            ${e.capacity ? `<p class="mut">Event capacity: ${esc(String(e.capacity))}</p>` : ''}
            <div class="tear"></div>
            <p>${esc(e.info || '')}</p>
            <p class="mut">Organized by ${esc(e.host || 'Squado organizers')}.</p>
            ${e.status === 'cancelled' ? `<p class="tag">Cancelled</p>` : ''}
            ${admin ? `<div class="row" style="margin-top:16px;flex-wrap:wrap">
              <button class="btn ghost" data-a="eventEdit" data-v="${e.id}">${I('pencil')} Edit Event</button>
              ${e.status === 'published' ? `<button class="btn ghost" data-a="eventCancel" data-v="${e.id}">Cancel Event</button>` : ''}
            </div>` : ''}
          </article>
          <div class="row sp" style="margin-top:24px">
            <div><h2 style="margin:0">Plans &amp; Groups for this Event</h2><p class="mut">Join a smaller meetup or create one around this occasion.</p></div>
          </div>
          ${plans.length ? `<div class="grid">${plans.map(card).join('')}</div>` : empty('No Plans yet','Start a smaller meetup around this Event.','Create a Plan','#/create')}
        </div>
        <aside class="card">
          <h3 style="margin-top:0">Make it your plan</h3>
          <p class="mut">Events do not have attendance lists or check-ins. Join a Plan/Group to connect with people and use its group chat and attendance features.</p>
          <button class="btn pink wide" data-a="evPlan" data-v="${e.id}">${I('users-round')} Create a Plan for this</button>
        </aside>
      </div>
    </main>`;
}
