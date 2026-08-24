# Fall 2026 Schedule Hub

Three phone apps, one codebase. Each is a single HTML file with no build step,
no framework and no server. Open the file and it runs.

| | Folder | Who |
|---|---|---|
| Schedule A | `index.html` | Astronomy, Micro, Math Modeling, Info Systems |
| Schedule B | `b/index.html` | Macro, Innovation, Math Modeling |
| Schedule C | `c/index.html` | Micro, Calculus I, Info Systems |

## What it does

- **Now** — the class happening right now with a live countdown, the floor and
  room read off the room number, and walking directions. Between classes it
  shows what is next and how long the gap is. Below that, assignments due soon.
- **Week** — a scrollable timetable with a live time marker, plus the free
  windows all three schedules share.
- **Classes** — every course, its final, its current grade, and a grade
  calculator that works out what a final needs to be.
- **Food** — the eight Cross Village spots with open or closed worked out
  against the clock, closing times, favourites and editable hours.
- **Record** — record a lecture, type timestamped notes, turn them into
  flashcards, quiz yourself, export a study pack.
- **Finals** — every exam, and a button that writes the whole semester into the
  phone's calendar.

Everything a person enters (notes, audio, grades, photos, favourites) stays in
that browser. Nothing is uploaded and there is no account.

## Putting it online

Deploy from a branch. No build server, no Actions workflow.

1. Create a **public** repo on GitHub. Public matters: Pages on a private repo
   needs a paid plan.
2. Push these files to `main` with the folder structure intact.
3. Settings, then Pages, then Deploy from a branch, `main`, folder `/ (root)`.
4. Wait about a minute. The URLs are then:

```
https://<user>.github.io/<repo>/        Schedule A
https://<user>.github.io/<repo>/b/      Schedule B
https://<user>.github.io/<repo>/c/      Schedule C
```

Add each to a phone with Share, then Add to Home Screen. It launches full
screen with its own icon.

### Why hosting matters

Inside an embedded viewer the browser refuses the page a microphone, a camera,
a location and the ability to open Apple Maps. On real hosting, all four work.
The app detects each refusal and degrades cleanly rather than failing silently,
but recording, the campus map and directions are only fully usable once it is
served from a normal URL or a home screen icon.

## Editing a schedule

Every app is generated from the same template. Schedule data sits between two
markers near the top of the `<script>`:

```
/* ==DATA:START== */   ...one schedule's courses...   /* ==DATA:END== */
```

- Schedule A's data lives inline in `index.html`, which doubles as the template.
- Schedule B and C live in `data/b.js` and `data/c.js`.

A course looks like this. Days are `M T W R F`, where `R` is Thursday. Times are
24 hour. `code` is optional and only shown when present.

```js
{ title:'Principles of Economics-Micro', short:'Microeconomics',
  days:'MWF', start:'10:00', end:'10:50', bldg:'Dale Hall', room:'0200',
  final:{ date:'2026-12-16', start:'08:00', end:'10:00',
          bldg:'Dale Hall', room:'0200' } }
```

For a final with no room announced yet use `bldg:null, room:null`. For one with
no date at all use `final:{ tba:true }`. For no final, `final:null`.

After any edit:

```bash
python3 build.py
```

That regenerates `b/index.html` and `c/index.html` from the template, and
refreshes the shared free-time map inside all three so it cannot drift from the
schedules it describes. Then commit and push; Pages redeploys itself.

To change one app's look or behaviour, edit `index.html` and rebuild. Editing
`b/index.html` or `c/index.html` directly is pointless, the next build
overwrites them.

## Data provenance

Class times, rooms and finals were transcribed from screenshots of one.ou.edu.
Two things in there are inferred rather than read, and are worth confirming:

- Schedule B's Macro final end time. The screenshot was cut off at `10:30 AM –`.
  Every other final in those screenshots ran exactly two hours, so it is set to
  12:30 PM.
- Schedule B's finals list was also cut off, so Innovation and Math Modeling
  have no final recorded. The app says so rather than inventing one.

Dining hours were compiled from OU Daily's campus dining listings across recent
semesters, not from a single current publication. The app states that on screen.
Glow Kitchen's Monday was never listed anywhere, so it shows as
`closed (not listed)`. Every venue has an Edit hours control that overrides the
shipped defaults permanently on that device.

Building pins are approximate. Standing at a building, Set pin here replaces the
seed with a real GPS fix and directions switch to exact coordinates.

Venue pictures are original illustrations, not photographs of the places.
Photo walk captures real ones in a single pass, and Share photos writes a pack
file the other two apps can import so nobody shoots the walk twice.

## Layout

```
index.html        Schedule A, and the template every app is built from
b/index.html      generated
c/index.html      generated
data/b.js         Schedule B course data
data/c.js         Schedule C course data
build.py          regenerates b/ and c/ and the shared free-time map
icon.png          512px home screen icon, copied into b/ and c/
```

## Browser support

Built for iOS Safari and Chrome on a phone, tested from 320px to 768px wide.
Google Fonts is the only outside request; everything else, the icon included, is
inside the file. Times are pinned to America/Chicago so the schedule stays right
off campus.
