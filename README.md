# Fall 2026 Schedule Hub

Three phone apps, one codebase. Each is a single HTML file with no build step,
no framework and no server. Open the file and it runs.

| | Folder | Who |
|---|---|---|
| Jack | `index.html` | Astronomy, Micro, Math Modeling, Info Systems |
| Maddox | `b/index.html` | Macro, Innovation, Math Modeling |
| Schedule C | `c/index.html` | Micro, Calculus I, Info Systems |

## What it does

- **Now** — the class happening right now with a live countdown, the floor and
  room read off the room number, and walking directions. Between classes it
  shows what is next and how long the gap is. Below that, assignments due soon.
- **Classes** — every course, its final, its current grade, and a grade
  calculator that works out what a final needs to be. The free windows all
  three schedules share, and your buildings, sit at the bottom.
- **Food** — the eight Cross Village spots with open or closed worked out
  against the clock, closing times, favourites and editable hours.
- **Record** — record a lecture and type timestamped notes. Afterwards,
  **Summary** turns those notes into one page to read: the points that matter
  first, then terms, then what you have to go and do, then the rest. Save as
  PDF prints it.
- **Due** — everything Canvas knows about, as a month calendar with a dot on
  every day that has something on it. Tap a day to see it. Exams ride along the
  top with a countdown, and the next fortnight is listed underneath. Each row
  opens the assignment in Canvas. Work Canvas already has a submission for
  arrives ticked. Below the fortnight sit recent course announcements and the
  assignments posted with no due date yet, so nothing sneaks up.
- **Finals** — every exam, and a button that writes the whole semester into the
  phone's calendar.
- **Plan** — a block calendar with classes placed automatically. Add a block by
  typing or speaking one line ("gym at 3pm for an hour on tue and thu") and the
  form fills itself; Save commits it. **Notify me** turns on a heads-up 10
  minutes before every class and block, plus one as it starts. Alerts are fired
  locally by the app (there is deliberately no server), so they arrive while
  the app is open or recently backgrounded from a home-screen install; a fully
  killed app cannot fire them. On iPhone, add to the home screen first —
  Safari tabs cannot show notifications at all.

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
https://<user>.github.io/<repo>/        Jack
https://<user>.github.io/<repo>/b/      Maddox
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

- Jack's data lives inline in `index.html`, which doubles as the template.
- Maddox and Schedule C live in `data/b.js` and `data/c.js`.

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

## The Due tab and Canvas

Anyone can fill in their own Due tab from their phone. Open Due, tap **Connect
Canvas**, and follow the four steps it shows:

1. Canvas, then **Calendar**.
2. **Calendar Feed** on the right.
3. Copy that address, change `webcal://` to `https://`, open it. The phone
   saves a `.ics` file.
4. Back in the app, load that file.

It is parsed in the browser and kept in that browser under a key naming the
schedule, `schedhub.canvas.b` and so on. No token, no login, nothing uploaded.
One person's coursework cannot surface in another person's app, and the three
apps stay isolated even though they share an origin. **Disconnect** wipes it.

The importer handles what Canvas actually emits: UTC stamps, zoned stamps and
all-day dates, folded lines, and events outside the semester, which it drops.

### The other route, for whoever owns the repo

`canvas_export.py` pulls the same information from the Canvas API and writes
`data/canvas.js`, which an app loads if it is sitting beside it. That script
lives outside this repo, next to a `.env` holding a Canvas token, because **a
token must never be committed here**. This repo is public and a Canvas token
can act as its owner.

```bash
python canvas_export.py     # in the folder holding .env
python build.py             # here
```

An imported file always wins over a shipped one, so importing overrides this
without deleting anything.

The export leaves out names, logins, grades and scores. Even so, a committed
`data/canvas.js` puts a real person's coursework on the open web. Deleting it
and rebuilding removes it, and the import route above then covers it with
nothing public at all.

## How the summary ranks things

The page has no model in it and cannot write prose, so **the summary never
invents anything**. It ranks and sorts what you already typed. Signals, in
rough order of weight:

- a line starting with `!`, `*` or a bullet, which is you flagging it yourself
- words like exam, important, remember, will be on
- A WORD IN CAPS
- numbers, dates and formulas
- words repeated across the whole lecture, which is what it was about
- length, since you bothered to type it out

Anything scoring 4 or more leads the page. If nothing clears that bar the top
three go up anyway, so the summary is never empty when notes exist. Lines
written `term: definition` become Terms, and lines mentioning due, homework,
read, chapter and so on become what you have to do. Nothing appears twice.

If a live transcript was captured, the strongest sentences in it get their own
section, clearly marked as machine-picked rather than quoted.

The threshold is deliberately absolute rather than measured against the top
line. Scoring relative to the strongest note lets one heavily flagged line
drag the bar up and bury everything else.

## Sending it to somebody

Send them the URL for their schedule, `/b/` or `/c/`. They add it to their home
screen and connect their own Canvas. Nothing else is needed. Their schedule of
classes is already built in; only the assignments come from their own import.

## Data provenance

Class times, rooms and finals were transcribed from screenshots of one.ou.edu.
Two things in there are inferred rather than read, and are worth confirming:

- Maddox's Macro final end time. The screenshot was cut off at `10:30 AM –`.
  Every other final in those screenshots ran exactly two hours, so it is set to
  12:30 PM.
- Maddox's finals list was also cut off, so Innovation and Math Modeling
  have no final recorded. The app says so rather than inventing one.

Dining hours were compiled from OU Daily's campus dining listings across recent
semesters, not from a single current publication. The app states that on screen.
Glow Kitchen's Monday was never listed anywhere, so it shows as
`closed (not listed)`. Every venue has an Edit hours control that overrides the
shipped defaults permanently on that device.

Building pins are approximate. Standing at a building, Set pin here replaces the
seed with a real GPS fix and directions switch to exact coordinates.

Directions are sent to Maps as a **street address**, never as a building name.
Searching a name here is unreliable: "Physical Science Ctr" is not what that
building is called, and Maps resolved it to the nearest plausible science
building, which is Nielsen, and walked somebody to the wrong door. The verified
addresses are Nielsen Hall 440 W Brooks St, Physical Sciences Center 601 Elm
Ave, Adams Hall 307 W Brooks St, Dale Hall 455 W Lindsey St. Any new building
added to `PIN_SEED` needs a real address checked against the campus directory,
not a guess.

Venue pictures are original illustrations, not photographs of the places.
Photo walk captures real ones in a single pass, and Share photos writes a pack
file the other two apps can import so nobody shoots the walk twice.

## Layout

```
index.html        Schedule A, and the template every app is built from
b/index.html      generated
c/index.html      generated
data/b.js         Maddox course data
data/c.js         Schedule C course data
build.py          regenerates b/ and c/ and the shared free-time map
icon.png          512px home screen icon, copied into b/ and c/
make_icon.py      redraws icon.png; run build.py after to copy it across
```

## Browser support

Built for iOS Safari and Chrome on a phone, tested from 320px to 768px wide.
Google Fonts is the only outside request; everything else, the icon included, is
inside the file. Times are pinned to America/Chicago so the schedule stays right
off campus.
