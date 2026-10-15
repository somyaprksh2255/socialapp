function explore() {
  const { f, s } = O.ui;

  let L = vis();

  if (f == "Live Now") {
    L = L.filter((p) => p.live);
  } else if (f == "Food") {
    L = L.filter(
      (p) =>
        p.type == "food" ||
        p.type == "chai" ||
        /food|poha|chaat/i.test(
          p.title + p.desc,
        ),
    );
  } else if (f != "All" && f != "Events") {
    L = L.filter(
      (p) => p.type == f.toLowerCase(),
    );
  }

  const q = (O.ui.q || "").trim().toLowerCase();

  if (q) {
    L = L.filter((p) =>
      (
        p.title +
        " " +
        p.desc +
        " " +
        p.loc +
        " " +
        T[p.type][1] +
        " " +
        (p.custom || "")
      )
        .toLowerCase()
        .includes(q),
    );
  }

  L.sort(
    {
      "For you": (a, b) =>
        score(b) - score(a),

      Nearby: (a, b) =>
        b.live - a.live || byDist(a, b),

      "Starting soon": (a, b) =>
        mins(a.when) - mins(b.when),

      "Most people": (a, b) =>
        b.members.length - a.members.length,

      New: (a, b) =>
        b.created - a.created,
    }[s],
  );

  return `
    <main class="wrap">
      <h1>What's happening?</h1>

      <p class="mut">
        Find a squad. Find a plan. Pull up.
      </p>

      ${geoBar()}

      <label class="search">
        ${I("search")}

        <input
          type="text"
          data-in="ui.q"
          value="${esc(O.ui.q || "")}"
          placeholder="Search plans, places, vibes"
          aria-label="Search"
        >
      </label>

      <div
        class="chips"
        role="group"
        aria-label="Filter"
      >
        ${[
          "All",
          "Live Now",
          "Events",
          "Garba",
          "Pandal",
          "Bhandara",
          "Food",
          "Chai",
          "Photo",
          "City",
        ]
          .map(
            (c) =>
              `<button
                class="chip"
                aria-pressed="${f == c}"
                data-a="set"
                data-k="ui.f"
                data-v="${c}"
              >
                ${c == "Live Now" ? "🔴 " : ""}${c}
              </button>`,
          )
          .join("")}
      </div>

      ${
        f == "Events"
          ? ""
          : `
            <div
              class="chips"
              style="margin:12px 0 18px"
            >
              ${[
                "For you",
                "Nearby",
                "Starting soon",
                "Most people",
                "New",
              ]
                .map(
                  (c) =>
                    `<button
                      class="chip"
                      style="padding:4px 12px;font-size:.85rem"
                      aria-pressed="${s == c}"
                      data-a="set"
                      data-k="ui.s"
                      data-v="${c}"
                    >
                      ${c}
                    </button>`,
                )
                .join("")}
            </div>
          `
      }

      ${
        !O.loaded.ex
          ? loader("Finding the squad...")
          : f == "Events"
            ? `
              <div
                class="grid"
                style="margin-top:16px"
              >
                ${
                  S.events
                    .filter(e => e.status === 'published')
                    .filter(
                      (e) =>
                        !q ||
                        (
                          e.title +
                          " " +
                          e.loc
                        )
                          .toLowerCase()
                          .includes(q),
                    )
                    .map(evCard)
                    .join("") ||
                  empty(
                    "No events match.",
                    "Try another search.",
                    "Clear search",
                    "#/explore",
                  )
                }
              </div>
            `
            : L.length
              ? `
                <div class="grid">
                  ${L.map(card).join("")}
                </div>
              `
              : empty(
                  "Nothing nearby.",
                  "Wanna start something?",
                  "Make a plan",
                  "#/create",
                )
      }
    </main>
  `;
}