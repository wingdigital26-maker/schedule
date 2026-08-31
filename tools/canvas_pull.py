"""Pull Canvas coursework into data/canvas.js, and push a 24-hour due alert.

Self-contained port of ghl-cli/canvas_export.py + canvas_read.py so it can run
on a GitHub Actions runner. Standard library only.

Environment:
    CANVAS_TOKEN      required. Canvas personal access token. Never printed.
    CANVAS_BASE_URL   required. e.g. https://canvas.ou.edu (CANVAS_HOST also
                      accepted for parity with the local ghl-cli .env).
    SCHEDULE_PUSH_URL     optional. Endpoint for the phone push.
    SCHEDULE_PUSH_SECRET  optional. Sent as an Authorization bearer token.
    CANVAS_ALLOW_SHRINK   optional. "1" to bypass the sanity floor once (same
                          as passing --allow-shrink). See sanity_check().

Exit codes:
    0  wrote (or deliberately left) a good data/canvas.js
    1  the pull itself failed (bad token, network, HTTP error)
    2  the pull succeeded but the result failed the sanity floor and was
       REFUSED. The existing file was left untouched.

Deliberately excluded from the export, because the app is published to a
PUBLIC GitHub Pages site: names, logins, grades and scores. Only course codes,
assignment titles and due dates go in.

The output file is written to a temp file and moved into place only after the
whole pull succeeds, so a failed run can never blank out good coursework.
"""
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

CENTRAL = ZoneInfo('America/Chicago')
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'canvas.js'
# Which assignments have already been pushed, so the 6am and 6pm runs do not
# both alert the same 23:59 deadline. Must be COMMITTED by the workflow: a
# GitHub runner is ephemeral, so unpersisted state would dedupe nothing.
PUSH_STATE = ROOT / 'data' / 'push-state.json'

# Anything due before the semester opens is residue from a previous term's
# course copy. Canvas keeps those around and they are pure noise.
SEMESTER_START = datetime(2026, 8, 24, tzinfo=CENTRAL)
SEMESTER_END = datetime(2026, 12, 19, tzinfo=CENTRAL)

# Canvas course codes are ugly. Map them to what the schedule app calls them.
NICE = {
    'ASTR-1504-022 - Fall 2026': ('ASTR 1504', 'Astronomy'),
    'ASTR-1504-020 - Fall 2026': ('ASTR 1504', 'Astro Discussion'),
    'ASTR-1504/1514-020 - Lecture - Fall 2026': ('ASTR 1504', 'Astro Lecture'),
    'MIS-2113-001 - Fall 2026': ('MIS 2113', 'Info Systems'),
    'B AD-1001-005 - Fall 2026': ('B AD 1001', 'Personal Computing'),
    'ECON-1123-002 - Fall 2026': ('ECON 1123', 'Microeconomics'),
    'B AD-1523-Fall 2026': ('B AD 1523', 'Business for People'),
    'MATH-1643-003 - Fall 2026': ('MATH 1643', 'Math Modeling'),
    'Tech Bootcamp 2026': ('BOOTCAMP', 'Tech Bootcamp'),
}

EXAM = re.compile(r'\b(exam|final|midterm|test)\b', re.I)
# "Practice For Exam: Tables" and "Bonus Point Quiz (Exam 1 Material)" match
# the word exam but are ordinary homework.
NOT_EXAM = re.compile(r'practice|bonus|replacement|enter score|test your skills', re.I)


def die(msg):
    """Exit non-zero. Callers must never pass anything token-derived here.

    Also fires the failure alert, because a silent failure is the whole of
    finding 5: the job goes red, Jack never looks at Actions, and a stale but
    perfectly valid canvas.js keeps being served for weeks.
    """
    print(f'ERROR: {msg}', file=sys.stderr)
    alert_failure(msg)
    sys.exit(1)


def load_config():
    token = os.environ.get('CANVAS_TOKEN', '').strip()
    host = (os.environ.get('CANVAS_BASE_URL')
            or os.environ.get('CANVAS_HOST') or '').strip()
    if not token:
        die('CANVAS_TOKEN is not set')
    if not host:
        die('CANVAS_BASE_URL is not set')
    host = host.replace('https://', '').replace('http://', '').strip('/')
    return token, host


class NoCrossHostRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse a redirect that changes host.

    urllib carries manually-set headers through redirects, so a 302 to some
    other host would replay `Authorization: Bearer <canvas token>` at whoever
    answers there. canvas.ou.edu is trusted and this is unlikely, but the fix
    costs nothing: same-host redirects still follow normally, a cross-host one
    becomes a plain HTTP error that get() reports without leaking anything.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old = urllib.parse.urlsplit(req.full_url).netloc.lower()
        new = urllib.parse.urlsplit(newurl).netloc.lower()
        if old != new:
            raise urllib.error.HTTPError(
                req.full_url, code,
                'refused a cross-host redirect (the auth header must not '
                'follow it)', headers, fp,
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(NoCrossHostRedirect)


def get(path, **params):
    """GET one Canvas endpoint, following pagination via the Link header."""
    url = f'https://{HOST}/api/v1/{path.lstrip("/")}'
    if params:
        parts = []
        for k, v in params.items():
            for item in (v if isinstance(v, list) else [v]):
                parts.append(f'{k}={urllib.parse.quote(str(item))}')
        url += '?' + '&'.join(parts)

    out = []
    while url:
        req = urllib.request.Request(
            url, headers={'Authorization': f'Bearer {TOKEN}'}
        )
        try:
            with OPENER.open(req, timeout=30) as r:
                body = json.loads(r.read().decode('utf-8'))
                link = r.headers.get('Link', '')
        except urllib.error.HTTPError as e:
            # Never echo the response body or the request URL query: keep any
            # chance of a token appearing in a public Actions log at zero.
            if e.code == 401:
                die('401 from Canvas: token rejected (expired, revoked, or wrong host)')
            if e.code == 403:
                die('403 from Canvas: token lacks permission, or API use is blocked')
            die(f'HTTP {e.code} from Canvas on /{path.lstrip("/")}')
        except urllib.error.URLError as e:
            die(f'network error reaching Canvas on /{path.lstrip("/")}: {e.reason}')

        if isinstance(body, list):
            out.extend(body)
        else:
            return body

        url = None
        for chunk in link.split(','):
            if 'rel="next"' in chunk:
                url = chunk.split(';')[0].strip().strip('<>')
    return out


def central(iso):
    if not iso:
        return None
    return datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone(CENTRAL)


def kind(name, points):
    n = name or ''
    if EXAM.search(n) and not NOT_EXAM.search(n):
        return 'exam'
    if re.search(r'\bquiz\b', n, re.I):
        return 'quiz'
    if re.search(r'smartbook|reading|journal|discussion', n, re.I):
        return 'reading'
    return 'work'


def is_done(sub):
    """Has Canvas actually finished with this assignment?

    `submitted_at` alone is wrong. It is set only when Canvas ITSELF receives an
    upload, so anything done on paper, in class, or through an external tool
    reads as unsubmitted forever -- even after the instructor has graded it.
    That is the MATH 1643 "IBA" bug: workflow_state 'graded', graded_at set,
    a score entered, and submitted_at still null.

    Three ways an item is genuinely dealt with:
      * submitted_at   -- uploaded through Canvas, the original signal.
      * excused        -- the instructor took it off the table.
      * graded         -- workflow_state 'graded' AND graded_at set. The score
                          is READ to be nowhere near the output; only this
                          boolean leaves the function.

    The graded branch deliberately does NOT trust "graded" on its own, because
    Canvas also reports an auto-zero for a blown deadline as graded. Calling
    that done would hide a real problem, which is the same failure as the old
    "Nothing due" bug. Canvas flags those separately -- `missing`, or
    late_policy_status 'missing' when the missing-submission policy applied it
    -- so both are excluded and such an item keeps showing as not done. Both
    flags are confirmed live on this account (two stale B AD 1001 items carry
    missing=true), so this is a real discriminator, not a guess.

    A zero that is genuinely earned on work Jack turned in is therefore counted
    done, and a zero from never doing it is not. If Canvas ever grades a truly
    missed item without setting either flag, this errs toward marking it done;
    the score is not used to second-guess that, because a legitimately-earned
    zero is indistinguishable from it by score alone and showing a false alarm
    beats hiding a real one only when we can actually tell them apart.
    """
    s = sub or {}
    if s.get('submitted_at') or s.get('excused'):
        return True
    return bool(
        s.get('workflow_state') == 'graded'
        and s.get('graded_at')
        and not s.get('missing')
        and s.get('late_policy_status') != 'missing'
    )


def pull():
    courses = get('courses', enrollment_state='active')
    out = []
    undated = []
    skipped = 0
    course_ids = []

    for c in courses:
        cid = c.get('id')
        if not cid or c.get('access_restricted_by_date'):
            continue
        course_ids.append(cid)
        code, short = NICE.get(
            c.get('course_code', ''), (c.get('course_code', '?'), c.get('name', '?'))
        )
        for a in get(
            f'courses/{cid}/assignments', per_page=100, **{'include[]': 'submission'}
        ):
            done = is_done(a.get('submission'))
            item = {
                'course': code,
                'short': short,
                'title': (a.get('name') or '').strip(),
                'kind': kind(a.get('name'), a.get('points_possible')),
                'points': a.get('points_possible'),
                'url': a.get('html_url'),
                'done': done,
            }
            due = central(a.get('due_at'))
            if due is None:
                # No date yet. Instructors post these and fill the date in
                # later; dropping them hid real coursework from the app.
                if a.get('published', True):
                    undated.append(item)
                continue
            if not (SEMESTER_START <= due <= SEMESTER_END):
                skipped += 1
                continue
            item['due'] = due.strftime('%Y-%m-%d')
            item['time'] = due.strftime('%H:%M')
            out.append(item)

    out.sort(key=lambda x: (x['due'], x['time']))
    undated.sort(key=lambda x: (x['course'], x['title']))

    # Recent instructor announcements: title, when, and a link. Bodies stay
    # out; they can carry personal detail and this file is public.
    ann = []
    for a in get(
        'announcements',
        **{'context_codes[]': [f'course_{i}' for i in course_ids],
           'start_date': SEMESTER_START.strftime('%Y-%m-%d'),
           'end_date': SEMESTER_END.strftime('%Y-%m-%d'),
           'per_page': 50},
    ):
        posted = central(a.get('posted_at'))
        if not posted:
            continue
        ctx = a.get('context_code', '')  # "course_485926"
        cid = int(ctx.split('_')[1]) if '_' in ctx else None
        short = next(
            (NICE.get(c.get('course_code', ''), (None, c.get('course_code')))[1]
             for c in courses if c.get('id') == cid), '')
        ann.append({
            'short': short,
            'title': (a.get('title') or '').strip(),
            'posted': posted.strftime('%Y-%m-%d'),
            'url': a.get('html_url'),
        })
    ann.sort(key=lambda x: x['posted'], reverse=True)
    ann = ann[:20]

    return out, undated, ann, skipped


def existing_item_count():
    """How many dated items the CURRENT data/canvas.js holds.

    Returns None when there is no file (or it is unreadable / not parseable),
    which the caller treats as "nothing to protect".
    """
    if not OUT.exists():
        return None
    try:
        text = OUT.read_text(encoding='utf-8')
    except OSError:
        return None
    m = re.search(r'const CANVAS_ITEMS = (.*?);\nconst CANVAS_UNDATED',
                  text, re.S)
    if not m:
        return None
    try:
        return len(json.loads(m.group(1)))
    except (ValueError, TypeError):
        return None


# A drop this steep has never been a real week of coursework. One whole course
# going quiet is ~20-40 of ~220 items -- around 85% retained, nowhere near this
# line. Losing HALF the semester at once means several courses vanished in the
# same pull, which is an API/enrollment artifact, not homework. The absolute
# floor stops the ratio from firing on a small file, where percentages are
# noise: 6 items down to 2 is a 67% "collapse" and completely ordinary.
SHRINK_RATIO = 0.5
SHRINK_MIN_DROP = 10


def sanity_check(new_count, old_count, allow_shrink):
    """Return None if it is safe to write, else a reason string.

    Guards the one failure this script cannot otherwise survive: a pull that
    succeeds and returns nothing. At end of term enrollments flip to
    'completed', so get('courses', enrollment_state='active') legitimately
    returns [] -- and without this, the first run after grades post would
    overwrite the whole semester with an empty-but-valid file, exit 0, and let
    the workflow push it live.
    """
    if old_count is None:
        return None  # nothing to protect
    if old_count == 0:
        return None  # the existing file is already empty
    if new_count == 0:
        reason = (f'the pull returned 0 dated items but the existing '
                  f'data/canvas.js holds {old_count}')
    elif (new_count < old_count * SHRINK_RATIO
          and old_count - new_count > SHRINK_MIN_DROP):
        reason = (f'the pull returned {new_count} dated items, down from '
                  f'{old_count} -- a {100 * (old_count - new_count) // old_count}% '
                  f'collapse')
    else:
        return None
    if allow_shrink:
        print(f'SANITY FLOOR: {reason}.')
        print('SANITY FLOOR: overridden by --allow-shrink / '
              'CANVAS_ALLOW_SHRINK, writing anyway.')
        return None
    return reason


def write_out(out, undated, ann):
    """Write via a temp file so a good canvas.js is never half-overwritten."""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(CENTRAL).strftime('%Y-%m-%d %H:%M')
    text = (
        '/* Generated by canvas_export.py. Do not edit by hand. */\n'
        f'/* Pulled from Canvas {stamp} Central. */\n'
        f'const CANVAS_PULLED = {json.dumps(stamp)};\n'
        f'const CANVAS_ITEMS = {json.dumps(out, indent=1)};\n'
        f'const CANVAS_UNDATED = {json.dumps(undated, indent=1)};\n'
        f'const CANVAS_ANN = {json.dumps(ann, indent=1)};\n'
    )
    tmp = OUT.with_suffix('.js.tmp')
    tmp.write_text(text, encoding='utf-8')
    os.replace(tmp, OUT)
    return stamp


def due_soon(items, now=None):
    """Unfinished items due between now and now+24h, Central time."""
    now = now or datetime.now(CENTRAL)
    horizon = now + timedelta(hours=24)
    soon = []
    for x in items:
        if x.get('done'):
            continue
        try:
            when = datetime.strptime(
                f"{x['due']} {x['time']}", '%Y-%m-%d %H:%M'
            ).replace(tzinfo=CENTRAL)
        except (KeyError, ValueError):
            continue
        if now <= when <= horizon:
            soon.append(x)
    soon.sort(key=lambda x: (x['due'], x['time']))
    return soon


def fingerprint(item):
    """Stable per-assignment id. The Canvas html_url carries the assignment id,
    which survives a rename; course+title is the fallback."""
    raw = item.get('url') or f"{item.get('course')}|{item.get('title')}"
    return hashlib.sha1(raw.encode('utf-8')).hexdigest()[:16]


def load_push_state():
    try:
        data = json.loads(PUSH_STATE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    return data.get('alerted', {}) if isinstance(data, dict) else {}


def save_push_state(alerted, today):
    """Persist, dropping anything whose deadline is well in the past.

    30 days of slack: long enough that a due date pushed back a couple of weeks
    is still recognised as the same assignment, short enough that the file stays
    a few kilobytes for a whole semester.
    """
    cutoff = (today - timedelta(days=30)).strftime('%Y-%m-%d')
    kept = {k: v for k, v in alerted.items() if v.get('due', '') >= cutoff}
    PUSH_STATE.parent.mkdir(parents=True, exist_ok=True)
    PUSH_STATE.write_text(
        json.dumps({'alerted': kept}, indent=1, sort_keys=True) + '\n',
        encoding='utf-8')
    return len(alerted) - len(kept)


def not_yet_alerted(items, alerted):
    """Drop anything already pushed for this same due date.

    A 23:59 deadline is inside the 24h horizon at BOTH the 6am and the 6pm run,
    so without this every such item notifies twice. A changed due date is real
    news and does re-alert. Note this is also the repeat cap: an item can only
    be alerted once per due date, so a gradebook-only assignment that never gets
    a submitted_at still cannot nag more than once before its deadline passes.
    """
    fresh = []
    for i in items:
        prev = alerted.get(fingerprint(i))
        if prev and prev.get('due') == i['due'] and prev.get('time') == i['time']:
            continue
        fresh.append(i)
    return fresh


def post_push(url, secret, items):
    """POST to the schedule push endpoint. True on success."""
    payload = json.dumps({'items': [
        {'title': i['title'], 'course': i['course'], 'due': i['due'],
         'time': i['time'], 'url': i['url']} for i in items
    ]}).encode('utf-8')
    req = urllib.request.Request(
        url, data=payload, method='POST',
        headers={'Content-Type': 'application/json',
                 'Authorization': f'Bearer {secret}'},
    )
    with OPENER.open(req, timeout=30) as r:
        return r.status


def push_config():
    return (os.environ.get('SCHEDULE_PUSH_URL', '').strip(),
            os.environ.get('SCHEDULE_PUSH_SECRET', '').strip())


def push(items):
    url, secret = push_config()
    if not url or not secret:
        print('push: SCHEDULE_PUSH_URL / SCHEDULE_PUSH_SECRET not set, skipping POST')
        return
    if not items:
        print('push: nothing due in the next 24h, sending nothing')
        return

    alerted = load_push_state()
    fresh = not_yet_alerted(items, alerted)
    if not fresh:
        print(f'push: all {len(items)} item(s) due soon were already alerted, '
              f'sending nothing')
        return
    if len(fresh) < len(items):
        print(f'push: {len(items) - len(fresh)} item(s) already alerted, '
              f'sending the remaining {len(fresh)}')

    try:
        status = post_push(url, secret, fresh)
    except urllib.error.HTTPError as e:
        # A failed push must not fail the data refresh; canvas.js is already
        # good. State is NOT recorded, so the next run retries these.
        print(f'push: FAILED, HTTP {e.code}', file=sys.stderr)
        return
    except urllib.error.URLError as e:
        print(f'push: FAILED, {e.reason}', file=sys.stderr)
        return
    except Exception as e:  # noqa: BLE001
        # Deliberately broad. HTTPError and URLError do NOT cover a socket that
        # is accepted and then dropped mid-read -- a Vercel cold start can do
        # exactly that, and it surfaces as a bare ConnectionResetError or a
        # socket timeout. Left unhandled it killed the whole run AFTER
        # canvas.js had already been written, so the workflow's commit step
        # never ran and a good refresh was thrown away with no alert. The
        # notification is the expendable part here; the coursework is not.
        print(f'push: FAILED, {e.__class__.__name__}: {e}', file=sys.stderr)
        return

    print(f'push: POSTed {len(fresh)} item(s), HTTP {status}')
    now = datetime.now(CENTRAL)
    for i in fresh:
        alerted[fingerprint(i)] = {
            'due': i['due'], 'time': i['time'],
            'sent': now.strftime('%Y-%m-%d %H:%M'),
        }
    pruned = save_push_state(alerted, now)
    print(f'push: state saved to {PUSH_STATE.name} '
          f'({len(alerted) - pruned} tracked, {pruned} pruned)')


def alert_failure(reason):
    """Tell Jack the refresh is broken, so a stale-but-valid canvas.js does not
    quietly keep being served while nothing updates.

    Best effort only: this must never mask or replace the original failure, so
    every error here is swallowed after being printed.
    """
    try:
        url, secret = push_config()
        if not url or not secret:
            print('alert: push not configured, cannot notify about the failure',
                  file=sys.stderr)
            return
        # The endpoint renders one item as "Due tomorrow: <course> / <title>",
        # so the course field carries the warning to keep the headline honest.
        item = {
            'course': 'Canvas refresh BROKEN',
            'title': f'Schedule data is going stale: {reason}',
            'due': datetime.now(CENTRAL).strftime('%Y-%m-%d'),
            'time': datetime.now(CENTRAL).strftime('%H:%M'),
            'url': '',
        }
        post_push(url, secret, [item])
        print('alert: notified that the Canvas refresh failed', file=sys.stderr)
    except Exception as e:  # noqa: BLE001 - never let the alert become the error
        print(f'alert: could not send the failure notice ({e.__class__.__name__})',
              file=sys.stderr)


# Loaded here, at the BOTTOM, on purpose. load_config() can die(), die() calls
# alert_failure(), and alert_failure() POSTs through OPENER -- so every one of
# those has to already exist. Loading the config any earlier makes a missing
# CANVAS_TOKEN raise NameError instead of sending the alert.
TOKEN, HOST = load_config()


def main():
    # Off by default, and it has to be asked for explicitly. The legitimate
    # case is end of term: enrollments flip to 'completed', the pull honestly
    # returns nothing, and Jack runs it once by hand to retire the semester.
    allow_shrink = ('--allow-shrink' in sys.argv[1:]
                    or os.environ.get('CANVAS_ALLOW_SHRINK', '').strip() == '1')

    out, undated, ann, skipped = pull()

    old_count = existing_item_count()
    reason = sanity_check(len(out), old_count, allow_shrink)
    if reason:
        print(f'REFUSED: {reason}.', file=sys.stderr)
        print('REFUSED: data/canvas.js left untouched. If this is real (end of '
              'term), re-run with --allow-shrink.', file=sys.stderr)
        alert_failure(f'refused a collapsed pull -- {reason}')
        sys.exit(2)

    stamp = write_out(out, undated, ann)
    print(f'wrote {OUT}')
    print(f'pulled {stamp} Central')
    print(f'{len(out)} dated items, {len(undated)} undated, '
          f'{len(ann)} announcements, {skipped} stale pre-semester items dropped')

    exams = [x for x in out if x['kind'] == 'exam']
    print(f'{len(exams)} exams:')
    for e in exams:
        print(f"  {e['due']} {e['time']}  {e['course']:<10} {e['title'][:44]}")

    soon = due_soon(out)
    print(f'\ndue in the next 24h, not done: {len(soon)}')
    for s in soon:
        print(f"  {s['due']} {s['time']}  {s['course']:<10} {s['title'][:44]}")
    push(soon)


if __name__ == '__main__':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    main()
