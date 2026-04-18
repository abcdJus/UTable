import os
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from html import unescape
from html.parser import HTMLParser
from pathlib import Path

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:
    psycopg = None
    dict_row = None

from dotenv import load_dotenv
from flask import Flask, redirect, render_template, request, session, url_for
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / 'frontend'
TEMPLATES_DIR = FRONTEND_DIR / 'templates'
STATIC_DIR = FRONTEND_DIR / 'static'

load_dotenv(PROJECT_ROOT / '.env')


def env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default

    return str(value).strip().lower() in {'1', 'true', 'yes', 'on'}


APP_ENV = str(
    os.environ.get('APP_ENV')
    or os.environ.get('FLASK_ENV')
    or 'development'
).strip().lower()
IS_PRODUCTION = APP_ENV == 'production'

app = Flask(
    __name__,
    template_folder=str(TEMPLATES_DIR),
    static_folder=str(STATIC_DIR),
    static_url_path='/static',
)
app.secret_key = os.environ.get('SECRET_KEY', 'timetable_generator_secret_key')
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE=os.environ.get('SESSION_COOKIE_SAMESITE', 'Lax'),
    SESSION_COOKIE_SECURE=env_flag('SESSION_COOKIE_SECURE', IS_PRODUCTION),
    PREFERRED_URL_SCHEME='https' if IS_PRODUCTION else 'http',
)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
DATABASE_URL = str(os.environ.get('DATABASE_URL') or '').strip()
VALID_DAYS = {'Mon', 'Tue', 'Wed', 'Thu', 'Fri'}
VALID_SECTION_TYPES = {'Lecture', 'Tutorial', 'Practical', 'Seminar', 'Lab'}
VALID_TERMS = {'Fall', 'Winter', 'Summer'}
DEFAULT_TERM = 'Fall'
TTB_BASE_URL = 'https://api.easi.utoronto.ca/ttb'
TTB_COURSE_LOOKUP_URL = f'{TTB_BASE_URL}/getCoursesByCodeAndSectionCode'
TTB_TIMEOUT_SECONDS = 12
COURSE_SUGGESTION_CACHE_TTL_SECONDS = 300
MAX_COURSE_SUGGESTIONS = 100
MAX_CALENDAR_SEARCH_PAGES = 6
COURSE_LABEL_PATTERN = re.compile(
    r'^\s*([A-Z]{3,4}\d{2,3}[A-Z]\d)\s*(?:-|•|:)\s*(.+?)\s*$'
)
CALENDAR_PAGE_PATTERN = re.compile(r'[?&]page=(\d+)')
CALENDAR_SEARCH_SOURCES = (
    {
        'campus': 'UTSC',
        'label': 'Scarborough',
        'search_url': 'https://utsc.calendar.utoronto.ca/search-courses',
    },
    {
        'campus': 'UTM',
        'label': 'Mississauga',
        'search_url': 'https://utm.calendar.utoronto.ca/course-search',
    },
    {
        'campus': 'UTSG',
        'label': 'St. George',
        'search_url': 'https://artsci.calendar.utoronto.ca/search-courses',
    },
)
TTB_DAY_MAP = {
    1: 'Mon',
    2: 'Tue',
    3: 'Wed',
    4: 'Thu',
    5: 'Fri',
}
TTB_SECTION_TYPE_MAP = {
    'LAB': 'Lab',
    'LABORATORY': 'Lab',
    'LECTURE': 'Lecture',
    'PRACTICAL': 'Practical',
    'SEMINAR': 'Seminar',
    'TUTORIAL': 'Tutorial',
}
TTB_TEACH_METHOD_MAP = {
    'LAB': 'Lab',
    'LEC': 'Lecture',
    'PRA': 'Practical',
    'SEM': 'Seminar',
    'TUT': 'Tutorial',
}
course_suggestion_cache = {}


@app.after_request
def apply_security_headers(response):
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    if app.config.get('SESSION_COOKIE_SECURE'):
        response.headers.setdefault(
            'Strict-Transport-Security',
            'max-age=31536000; includeSubDomains',
        )
    return response


class TTBLookupError(Exception):
    def __init__(self, message, status_code=502, details=''):
        super().__init__(message)
        self.status_code = status_code
        self.details = details


class CourseSuggestionError(Exception):
    def __init__(self, message, status_code=502, details=''):
        super().__init__(message)
        self.status_code = status_code
        self.details = details


class CalendarCourseSearchParser(HTMLParser):
    def __init__(self, campus):
        super().__init__()
        self.campus = campus
        self.in_course_heading = False
        self.seen_codes = set()
        self.courses = []
        self.current_heading_parts = []
        self.current_aria_label = ''

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        class_names = attributes.get('class', '').split()

        if tag == 'h3' and 'js-views-accordion-group-header' in class_names:
            self.in_course_heading = True
            self.current_heading_parts = []
            self.current_aria_label = ''
            return

        if not self.in_course_heading:
            return

        aria_label = attributes.get('aria-label')
        if aria_label:
            self.current_aria_label = unescape(aria_label)

    def handle_data(self, data):
        if self.in_course_heading and data:
            self.current_heading_parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'h3':
            if self.in_course_heading:
                normalized_heading = ' '.join(
                    unescape(' '.join(self.current_heading_parts)).split()
                )
                if not normalized_heading and self.current_aria_label:
                    normalized_heading = ' '.join(self.current_aria_label.split())

                match = COURSE_LABEL_PATTERN.match(normalized_heading)
                if match:
                    code = match.group(1).upper()
                    title = match.group(2).strip()
                    if code not in self.seen_codes:
                        self.seen_codes.add(code)
                        self.courses.append({
                            'code': code,
                            'title': title,
                            'label': f'{code} - {title}',
                            'campus': self.campus,
                        })
            self.in_course_heading = False
            self.current_heading_parts = []
            self.current_aria_label = ''


# Open a PostgreSQL connection with dict-style row access enabled.
def get_db_connection():
    if psycopg is None:
        raise RuntimeError(
            'PostgreSQL support requires the "psycopg" package. '
            'Run "pip install -r requirements.txt".'
        )

    if not DATABASE_URL:
        raise RuntimeError(
            'DATABASE_URL is not set. '
            'Set it locally or have your hosting platform inject it before starting the app.'
        )

    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def get_table_columns(conn, table_name):
    rows = conn.execute(
        '''
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s
        ''',
        (table_name,),
    ).fetchall()
    return {row['column_name'] for row in rows}


# Create the tables the app needs if they do not already exist.
def init_db():
    conn = get_db_connection()
    try:
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS courses (
                id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                user_id INTEGER NOT NULL,
                code TEXT NOT NULL,
                color_index INTEGER DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS sections (
                id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                course_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                label TEXT NOT NULL,
                FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS meetings (
                id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                section_id INTEGER NOT NULL,
                term TEXT NOT NULL DEFAULT 'Fall',
                day TEXT NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT NOT NULL,
                FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
            )
            '''
        )
        meeting_columns = get_table_columns(conn, 'meetings')
        if 'start' in meeting_columns and 'start_time' not in meeting_columns:
            conn.execute('ALTER TABLE meetings RENAME COLUMN "start" TO start_time')
            meeting_columns.discard('start')
            meeting_columns.add('start_time')
        if 'end' in meeting_columns and 'end_time' not in meeting_columns:
            conn.execute('ALTER TABLE meetings RENAME COLUMN "end" TO end_time')
            meeting_columns.discard('end')
            meeting_columns.add('end_time')
        conn.execute(
            'CREATE INDEX IF NOT EXISTS idx_courses_user_id ON courses (user_id)'
        )
        conn.execute(
            'CREATE INDEX IF NOT EXISTS idx_sections_course_id ON sections (course_id)'
        )
        conn.execute(
            'CREATE INDEX IF NOT EXISTS idx_meetings_section_id ON meetings (section_id)'
        )
        conn.execute(
            f'''
            ALTER TABLE meetings
            ADD COLUMN IF NOT EXISTS term TEXT NOT NULL DEFAULT '{DEFAULT_TERM}'
            '''
        )
        conn.execute(
            'UPDATE meetings SET term = %s WHERE term IS NULL OR BTRIM(term) = %s',
            (DEFAULT_TERM, ''),
        )
        conn.commit()
    finally:
        conn.close()


# Delete one user's saved courses and all related child records.
def clear_saved_courses(conn, user_id):
    # Child rows are removed automatically because the tables use ON DELETE CASCADE.
    conn.execute('DELETE FROM courses WHERE user_id = %s', (user_id,))


# Builds the one-time message shown on the login or register page after a redirect.
def build_page_message():
    return {
        'message': request.args.get('message'),
        'message_type': request.args.get('message_type', 'error'),
    }


def password_looks_hashed(value):
    normalized = str(value or '').strip()
    return normalized.startswith('pbkdf2:') or normalized.startswith('scrypt:')


def verify_user_password(stored_password, candidate_password):
    normalized_password = str(stored_password or '')
    if not normalized_password:
        return False, None

    if password_looks_hashed(normalized_password):
        return check_password_hash(normalized_password, candidate_password), None

    if normalized_password == candidate_password:
        return True, generate_password_hash(candidate_password)

    return False, None


# Converts an HH:MM string into total minutes and returns None when invalid.
def time_to_minutes(value):
    if not isinstance(value, str):
        return None

    parts = value.split(':')
    if len(parts) != 2 or not parts[0].isdigit() or not parts[1].isdigit():
        return None

    hours = int(parts[0])
    minutes = int(parts[1])
    if hours < 0 or hours > 23 or minutes < 0 or minutes > 59:
        return None

    return hours * 60 + minutes


def normalize_term_value(value, fallback=DEFAULT_TERM):
    normalized = str(value or '').strip().title()
    if normalized in VALID_TERMS:
        return normalized
    return fallback


def session_code_to_term(session_code, fallback=DEFAULT_TERM):
    normalized = str(session_code or '').strip().upper()
    if not normalized:
        return fallback

    # Summer sub-session codes such as 20265F / 20265S still belong in Summer.
    if len(normalized) >= 6 and normalized[:5].isdigit() and normalized[-1] in {'F', 'S'}:
        return 'Summer'

    digits = ''.join(ch for ch in normalized if ch.isdigit())
    if len(digits) < 5:
        return fallback

    term_digit = digits[4]
    if term_digit == '9':
        return 'Fall'
    if term_digit == '1':
        return 'Winter'
    if term_digit == '5':
        return 'Summer'

    return fallback


# Returns True when two meetings happen on the same day and overlap in time.
def meetings_overlap(first_meeting, second_meeting):
    if first_meeting.get('term', DEFAULT_TERM) != second_meeting.get('term', DEFAULT_TERM):
        return False

    if first_meeting['day'] != second_meeting['day']:
        return False

    return (
        max(first_meeting['start_minutes'], second_meeting['start_minutes']) <
        min(first_meeting['end_minutes'], second_meeting['end_minutes'])
    )


# Checks that each course payload uses valid course, section, and meeting data.
def validate_course_payload(courses):
    if not isinstance(courses, list):
        return 'Courses payload must be a list.'

    seen_course_codes = set()

    for course in courses:
        if not isinstance(course, dict):
            return 'Each course must be an object.'

        course_code = str(course.get('code', '')).strip().upper()
        if not course_code:
            return 'Every course needs a code.'
        if course_code in seen_course_codes:
            return f'Course "{course_code}" has been added more than once.'

        sections = course.get('sections', [])
        if not isinstance(sections, list):
            return f'Sections for {course_code} must be a list.'

        seen_labels = set()

        for section in sections:
            if not isinstance(section, dict):
                return f'Each section in {course_code} must be an object.'

            section_type = str(section.get('type', '')).strip()
            label = str(section.get('label', '')).strip().upper()
            meetings = section.get('meetings', [])

            if not section_type:
                return f'Every section in {course_code} needs a type.'
            if section_type not in VALID_SECTION_TYPES:
                return (
                    f'Section "{label or "unknown"}" in {course_code} uses '
                    'an invalid section type.'
                )
            if not label:
                return 'Every section needs a label.'
            if label in seen_labels:
                return f'Duplicate section label "{label}" found in {course_code}.'
            if not isinstance(meetings, list) or not meetings:
                return f'Section "{label}" in {course_code} needs at least one meeting.'

            normalized_meetings = []
            for meeting in meetings:
                if not isinstance(meeting, dict):
                    return f'Each meeting in section "{label}" must be an object.'

                term = normalize_term_value(meeting.get('term'), DEFAULT_TERM)
                day = str(meeting.get('day', '')).strip()
                start = str(meeting.get('start', '')).strip()
                end = str(meeting.get('end', '')).strip()
                if not day or not start or not end:
                    return (
                        f'Each meeting in section "{label}" needs a term, day, '
                        'start time, and end time.'
                    )
                if day not in VALID_DAYS:
                    return f'Meeting day "{day}" in section "{label}" is invalid.'
                if term not in VALID_TERMS:
                    return f'Meeting term "{term}" in section "{label}" is invalid.'

                start_minutes = time_to_minutes(start)
                end_minutes = time_to_minutes(end)
                if start_minutes is None or end_minutes is None:
                    return f'Meeting times in section "{label}" must use HH:MM format.'
                if start_minutes >= end_minutes:
                    return f'Each meeting in section "{label}" must end after it starts.'

                normalized_meetings.append({
                    'term': term,
                    'day': day,
                    'start_minutes': start_minutes,
                    'end_minutes': end_minutes,
                })

            for meeting_index, current_meeting in enumerate(normalized_meetings):
                for other_meeting in normalized_meetings[meeting_index + 1:]:
                    if meetings_overlap(current_meeting, other_meeting):
                        return (
                            f'Meetings in section "{label}" cannot overlap each other.'
                        )

            seen_labels.add(label)
        seen_course_codes.add(course_code)

    return None


def minutes_to_hhmm(total_minutes):
    safe_minutes = max(0, int(total_minutes))
    hours = safe_minutes // 60
    minutes = safe_minutes % 60
    return f'{hours:02d}:{minutes:02d}'


def normalize_ttb_section_type(section):
    raw_type = str(section.get('type', '')).strip().upper()
    if raw_type in TTB_SECTION_TYPE_MAP:
        return TTB_SECTION_TYPE_MAP[raw_type]

    teach_method = str(section.get('teachMethod', '')).strip().upper()
    if teach_method in TTB_TEACH_METHOD_MAP:
        return TTB_TEACH_METHOD_MAP[teach_method]

    return None


def normalize_ttb_meeting(meeting):
    start = meeting.get('start') or {}
    end = meeting.get('end') or {}
    start_day = start.get('day')
    end_day = end.get('day')

    if start_day != end_day or start_day not in TTB_DAY_MAP:
        return None

    start_millis = start.get('millisofday')
    end_millis = end.get('millisofday')
    if start_millis is None or end_millis is None:
        return None

    start_minutes = int(start_millis) // 60000
    end_minutes = int(end_millis) // 60000
    if start_minutes >= end_minutes:
        return None

    return {
        'term': session_code_to_term(meeting.get('sessionCode')),
        'day': TTB_DAY_MAP[start_day],
        'start': minutes_to_hhmm(start_minutes),
        'end': minutes_to_hhmm(end_minutes),
    }


def normalize_ttb_section(section):
    label = str(section.get('name', '')).strip().upper()
    section_type = normalize_ttb_section_type(section)
    if not label or not section_type:
        return None

    seen_meetings = set()
    meetings = []
    for meeting in section.get('meetingTimes', []):
        normalized_meeting = normalize_ttb_meeting(meeting)
        if not normalized_meeting:
            continue

        meeting_key = (
            normalized_meeting['term'],
            normalized_meeting['day'],
            normalized_meeting['start'],
            normalized_meeting['end'],
        )
        if meeting_key in seen_meetings:
            continue

        seen_meetings.add(meeting_key)
        meetings.append(normalized_meeting)

    if not meetings:
        return None

    instructors = []
    for instructor in section.get('instructors', []):
        full_name = ' '.join(
            part.strip()
            for part in [
                str(instructor.get('firstName', '')).strip(),
                str(instructor.get('lastName', '')).strip(),
            ]
            if part and part.strip()
        )
        if full_name:
            instructors.append(full_name)

    normalized_section = {
        'type': section_type,
        'label': label,
        'meetings': meetings,
    }

    if instructors:
        normalized_section['instructors'] = instructors

    if section.get('currentEnrolment') is not None:
        normalized_section['currentEnrolment'] = section.get('currentEnrolment')
    if section.get('maxEnrolment') is not None:
        normalized_section['maxEnrolment'] = section.get('maxEnrolment')

    return normalized_section


def normalize_ttb_course(course):
    course_code = str(course.get('code', '')).strip().upper()
    if not course_code:
        return None

    seen_labels = set()
    sections = []
    for section in course.get('sections', []):
        normalized_section = normalize_ttb_section(section)
        if not normalized_section:
            continue

        label = normalized_section['label']
        if label in seen_labels:
            continue

        seen_labels.add(label)
        sections.append(normalized_section)

    cm_course_info = course.get('cmCourseInfo') or {}
    return {
        'code': course_code,
        'name': str(course.get('name') or cm_course_info.get('title') or '').strip(),
        'description': str(cm_course_info.get('description') or '').strip(),
        'sessions': course.get('sessions', []),
        'sections': sections,
        'cmCourseInfo': cm_course_info,
    }


def merge_normalized_ttb_courses(courses):
    merged_course = None
    seen_sessions = set()
    sections_by_key = {}

    for course in courses:
        normalized_course = normalize_ttb_course(course)
        if not normalized_course:
            continue

        if merged_course is None:
            merged_course = {
                'code': normalized_course['code'],
                'name': normalized_course.get('name', ''),
                'description': normalized_course.get('description', ''),
                'sessions': [],
                'sections': [],
                'cmCourseInfo': normalized_course.get('cmCourseInfo') or {},
            }
        else:
            if not merged_course.get('name') and normalized_course.get('name'):
                merged_course['name'] = normalized_course['name']
            if (
                not merged_course.get('description')
                and normalized_course.get('description')
            ):
                merged_course['description'] = normalized_course['description']
            if (
                not merged_course.get('cmCourseInfo')
                and normalized_course.get('cmCourseInfo')
            ):
                merged_course['cmCourseInfo'] = normalized_course['cmCourseInfo']

        for session_code in normalized_course.get('sessions', []):
            clean_session_code = str(session_code).strip()
            if not clean_session_code or clean_session_code in seen_sessions:
                continue
            seen_sessions.add(clean_session_code)
            merged_course['sessions'].append(clean_session_code)

        for section in normalized_course.get('sections', []):
            section_key = (
                str(section.get('type', '')).strip(),
                str(section.get('label', '')).strip().upper(),
            )
            existing_section = sections_by_key.get(section_key)
            if existing_section is None:
                new_section = {
                    'type': section.get('type'),
                    'label': section.get('label'),
                    'meetings': [],
                }

                if section.get('instructors'):
                    new_section['instructors'] = list(section['instructors'])
                if section.get('currentEnrolment') is not None:
                    new_section['currentEnrolment'] = section['currentEnrolment']
                if section.get('maxEnrolment') is not None:
                    new_section['maxEnrolment'] = section['maxEnrolment']

                sections_by_key[section_key] = new_section
                merged_course['sections'].append(new_section)
                existing_section = new_section
            else:
                if (
                    not existing_section.get('instructors')
                    and section.get('instructors')
                ):
                    existing_section['instructors'] = list(section['instructors'])
                if (
                    existing_section.get('currentEnrolment') is None
                    and section.get('currentEnrolment') is not None
                ):
                    existing_section['currentEnrolment'] = section['currentEnrolment']
                if (
                    existing_section.get('maxEnrolment') is None
                    and section.get('maxEnrolment') is not None
                ):
                    existing_section['maxEnrolment'] = section['maxEnrolment']

            seen_meetings = {
                (
                    meeting.get('term'),
                    meeting.get('day'),
                    meeting.get('start'),
                    meeting.get('end'),
                )
                for meeting in existing_section.get('meetings', [])
            }

            for meeting in section.get('meetings', []):
                meeting_key = (
                    meeting.get('term'),
                    meeting.get('day'),
                    meeting.get('start'),
                    meeting.get('end'),
                )
                if meeting_key in seen_meetings:
                    continue

                seen_meetings.add(meeting_key)
                existing_section['meetings'].append(meeting)

    return merged_course


def build_ttb_course_lookup_url(course_code, section_code=''):
    safe_course_code = urllib.parse.quote(course_code, safe='')
    url = f'{TTB_COURSE_LOOKUP_URL}/{safe_course_code}'

    clean_section_code = str(section_code or '').strip().upper()
    if clean_section_code:
        query = urllib.parse.urlencode({'sectionCode': clean_section_code})
        url = f'{url}?{query}'

    return url


def build_calendar_course_search_url(search_url, query, page=0):
    params = {'course_keyword': query}
    if page > 0:
        params['page'] = page
    encoded_query = urllib.parse.urlencode(params)
    return f'{search_url}?{encoded_query}'


def fetch_remote_text(
    url,
    accept_header,
    error_class=CourseSuggestionError,
    failure_message='Remote request failed.',
    unreachable_message='Could not reach the remote service.',
):
    request_headers = {
        'Accept': accept_header,
        'User-Agent': 'Timetable-Generator/1.0',
    }
    req = urllib.request.Request(url, headers=request_headers)

    try:
        with urllib.request.urlopen(req, timeout=TTB_TIMEOUT_SECONDS) as response:
            return response.read().decode('utf-8')
    except urllib.error.HTTPError as exc:
        details = ''
        try:
            details = exc.read().decode('utf-8').strip()
        except Exception:
            details = ''
        raise error_class(
            failure_message,
            502,
            details or str(exc),
        ) from exc
    except urllib.error.URLError as exc:
        raise error_class(
            unreachable_message,
            502,
            str(exc.reason),
        ) from exc


def fetch_ttb_json(url):
    payload = fetch_remote_text(
        url,
        'application/json',
        error_class=TTBLookupError,
        failure_message='TTB lookup failed.',
        unreachable_message='Could not reach the TTB service.',
    )

    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise TTBLookupError(
            'TTB returned an invalid response.',
            502,
            payload[:300],
        ) from exc

    status_entries = data.get('status') or []
    for status_entry in status_entries:
        if status_entry.get('code') not in (0, '0'):
            message = str(status_entry.get('message') or 'TTB lookup failed.').strip()
            raise TTBLookupError(message, 502)

    return data


def lookup_ttb_course(course_code, section_code=''):
    data = fetch_ttb_json(build_ttb_course_lookup_url(course_code, section_code))
    courses = data.get('payload', {}).get('pageableCourse', {}).get('courses', [])

    matching_courses = [
        course
        for course in courses
        if str(course.get('code', '')).strip().upper() == course_code
    ]

    if not matching_courses and courses:
        matching_courses = [courses[0]]

    if not matching_courses:
        return None

    return merge_normalized_ttb_courses(matching_courses)


def get_cached_course_suggestions(query, limit):
    cache_key = (query, limit)
    cached_entry = course_suggestion_cache.get(cache_key)
    if not cached_entry:
        return None

    if cached_entry['expires_at'] < time.time():
        course_suggestion_cache.pop(cache_key, None)
        return None

    return cached_entry['suggestions']


def set_cached_course_suggestions(query, limit, suggestions):
    course_suggestion_cache[(query, limit)] = {
        'suggestions': suggestions,
        'expires_at': time.time() + COURSE_SUGGESTION_CACHE_TTL_SECONDS,
    }


def extract_calendar_search_max_page(html_content):
    page_numbers = [
        int(match)
        for match in CALENDAR_PAGE_PATTERN.findall(html_content or '')
        if str(match).isdigit()
    ]
    if not page_numbers:
        return 0
    return min(max(page_numbers), MAX_CALENDAR_SEARCH_PAGES - 1)


def fetch_calendar_source_suggestions(source, query):
    suggestions = []
    seen_codes = set()
    max_page = 0

    for page in range(MAX_CALENDAR_SEARCH_PAGES):
        html_content = fetch_remote_text(
            build_calendar_course_search_url(source['search_url'], query, page),
            'text/html,application/xhtml+xml',
            error_class=CourseSuggestionError,
            failure_message='Course suggestion lookup failed.',
            unreachable_message='Could not reach the course suggestion service.',
        )

        parser = CalendarCourseSearchParser(source['campus'])
        parser.feed(html_content)
        parser.close()

        for course in parser.courses:
            code = course['code']
            if code in seen_codes:
                continue

            seen_codes.add(code)
            course['campusLabel'] = source['label']
            suggestions.append(course)

        max_page = extract_calendar_search_max_page(html_content)
        if page >= max_page:
            break

    return suggestions


def score_course_suggestion(course, query):
    normalized_query = query.casefold()
    code = str(course.get('code', '')).casefold()
    title = str(course.get('title', '')).casefold()

    if code == normalized_query:
        return (0, code, title)
    if code.startswith(normalized_query):
        return (1, code, title)
    if normalized_query in code:
        return (2, code, title)
    if title.startswith(normalized_query):
        return (3, code, title)
    return (4, code, title)


def lookup_course_suggestions(query, limit=MAX_COURSE_SUGGESTIONS):
    normalized_query = str(query or '').strip().upper()
    if len(normalized_query) < 2:
        return []

    limit = max(1, min(int(limit), MAX_COURSE_SUGGESTIONS))
    cached_suggestions = get_cached_course_suggestions(normalized_query, limit)
    if cached_suggestions is not None:
        return cached_suggestions

    suggestions = []
    seen_codes = set()
    lookup_errors = []

    for source in CALENDAR_SEARCH_SOURCES:
        try:
            source_suggestions = fetch_calendar_source_suggestions(source, normalized_query)
        except CourseSuggestionError as exc:
            lookup_errors.append(f"{source['campus']}: {exc}")
            continue

        for course in source_suggestions:
            searchable_text = f"{course['code']} {course['title']}".casefold()
            if normalized_query.casefold() not in searchable_text:
                continue

            code = course['code']
            if code in seen_codes:
                continue

            seen_codes.add(code)
            suggestions.append(course)

    if not suggestions and lookup_errors:
        raise CourseSuggestionError(
            'Course suggestion lookup failed.',
            502,
            ' | '.join(lookup_errors),
        )

    suggestions.sort(key=lambda course: score_course_suggestion(course, normalized_query))
    suggestions = suggestions[:limit]

    set_cached_course_suggestions(normalized_query, limit, suggestions)
    return suggestions


init_db()

# Redirect the root URL to the login screen.
@app.route('/')
def home():
    return redirect(url_for('login'))


@app.route('/health')
def health():
    try:
        conn = get_db_connection()
        try:
            conn.execute('SELECT 1').fetchone()
        finally:
            conn.close()
    except Exception:
        return {'status': 'error'}, 500

    return {'status': 'ok'}

# Show the login page and create a session when credentials match.
@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']

        conn = get_db_connection()
        user = conn.execute(
            'SELECT * FROM users WHERE username = %s',
            (username,),
        ).fetchone()
        conn.close()

        if not user:
            return redirect(
                url_for(
                    'login',
                    message='Your email does not appear to be registered. Please register!',
                    message_type='error',
                )
            )

        password_matches, upgraded_password_hash = verify_user_password(
            user.get('password'),
            password,
        )
        if not password_matches:
            return redirect(
                url_for(
                    'login',
                    message='Incorrect password.',
                    message_type='error',
                )
            )

        if upgraded_password_hash:
            conn = get_db_connection()
            conn.execute(
                'UPDATE users SET password = %s WHERE id = %s',
                (upgraded_password_hash, user['id']),
            )
            conn.commit()
            conn.close()

        session['username'] = username
        session['user_id'] = user['id']
        return redirect(url_for('index'))
    return render_template('login.html', **build_page_message())

# Show the registration form and create a new user account.
@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        confirm = request.form['confirm_password']

        if password != confirm:
            return redirect(
                url_for(
                    'register',
                    message="Passwords don't match.",
                    message_type='error',
                )
            )

        conn = get_db_connection()
        existing = conn.execute(
            'SELECT * FROM users WHERE username = %s',
            (username,),
        ).fetchone()
        if existing:
            conn.close()
            return redirect(
                url_for(
                    'register',
                    message='Your email is already in use. Please choose a different one.',
                    message_type='error',
                )
            )

        conn.execute(
            'INSERT INTO users (username, password) VALUES (%s, %s)',
            (username, generate_password_hash(password)),
        )
        conn.commit()
        conn.close()

        return redirect(
            url_for(
                'login',
                message='Account created! Please log in.',
                message_type='success',
            )
        )
    return render_template('register.html', **build_page_message())

# Render the timetable builder for signed-in users only.
@app.route('/index')
def index():
    if 'username' not in session:
        return redirect(url_for('login'))
    return render_template('index.html')

# Clear the current session and send the user back to login.
@app.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return {'message': 'Logged out', 'redirect_url': url_for('login')}

# Return the signed-in user's saved courses.
@app.route('/api/courses', methods=['GET'])
def get_courses():
    if 'user_id' not in session:
        return {'error': 'Not logged in'}, 401
    conn = get_db_connection()
    courses = conn.execute(
        'SELECT * FROM courses WHERE user_id = %s',
        (session['user_id'],),
    ).fetchall()
    conn.close()
    return [
        {'id': c['id'], 'code': c['code'], 'color_index': c['color_index']}
        for c in courses
    ]

# Replace the signed-in user's saved timetable data with the latest version.
@app.route('/api/courses', methods=['POST'])
def save_courses():
    if 'user_id' not in session:
        return {'error': 'Not logged in'}, 401
    req_data = request.get_json(silent=True)
    if not isinstance(req_data, dict):
        return {'error': 'Request body must be a JSON object.'}, 400

    courses = req_data.get('courses', [])
    error_message = validate_course_payload(courses)
    if error_message:
        return {'error': error_message}, 400

    conn = get_db_connection()
    clear_saved_courses(conn, session['user_id'])

    for course in courses:
        course_row = conn.execute(
            'INSERT INTO courses (user_id, code, color_index) VALUES (%s, %s, %s) RETURNING id',
            (
                session['user_id'],
                str(course.get('code', '')).strip().upper(),
                course.get('colorIndex', 0),
            ),
        ).fetchone()
        course_id = course_row['id']
        for section in course.get('sections', []):
            section_label = str(section.get('label', '')).strip().upper()
            section_row = conn.execute(
                'INSERT INTO sections (course_id, type, label) VALUES (%s, %s, %s) RETURNING id',
                (course_id, section['type'], section_label),
            ).fetchone()
            section_id = section_row['id']
            for meeting in section.get('meetings', []):
                conn.execute(
                    'INSERT INTO meetings (section_id, term, day, start_time, end_time) VALUES (%s, %s, %s, %s, %s)',
                    (
                        section_id,
                        normalize_term_value(meeting.get('term'), DEFAULT_TERM),
                        meeting['day'],
                        meeting['start'],
                        meeting['end'],
                    ),
                )
    conn.commit()
    conn.close()
    return {'message': 'Saved!'}

# Return sections only when the requested course belongs to the current user.
@app.route('/api/courses/<int:course_id>/sections', methods=['GET'])
def get_sections(course_id):
    if 'user_id' not in session:
        return {'error': 'Not logged in'}, 401

    conn = get_db_connection()
    owned_course = conn.execute(
        'SELECT id FROM courses WHERE id = %s AND user_id = %s',
        (course_id, session['user_id']),
    ).fetchone()
    if not owned_course:
        conn.close()
        return {'error': 'Course not found'}, 404

    sections = conn.execute(
        'SELECT * FROM sections WHERE course_id = %s',
        (course_id,),
    ).fetchall()
    result = []
    for section in sections:
        meetings = conn.execute(
            'SELECT * FROM meetings WHERE section_id = %s',
            (section['id'],),
        ).fetchall()
        result.append({
            'id': section['id'],
            'type': section['type'],
            'label': section['label'],
            'meetings': [
                {
                    'id': m['id'],
                    'term': normalize_term_value(m['term'], DEFAULT_TERM),
                    'day': m['day'],
                    'start': m['start_time'],
                    'end': m['end_time'],
                }
                for m in meetings
            ],
        })
    conn.close()
    return result


@app.route('/api/ttb/search', methods=['POST'])
def search_ttb_course():
    if 'user_id' not in session:
        return {'error': 'Not logged in'}, 401

    req_data = request.get_json(silent=True)
    if not isinstance(req_data, dict):
        return {'error': 'Request body must be a JSON object.'}, 400

    course_code = str(req_data.get('courseCode', '')).strip().upper()
    section_code = str(req_data.get('sectionCode', '')).strip().upper()

    if not course_code:
        return {'error': 'Course code is required.'}, 400

    try:
        course = lookup_ttb_course(course_code, section_code)
    except TTBLookupError as exc:
        response_body = {'error': str(exc)}
        if exc.details:
            response_body['details'] = exc.details
        return response_body, exc.status_code

    if not course:
        return {'error': f'Could not find course "{course_code}".'}, 404

    if not course['sections']:
        return {
            'error': (
                f'No scheduled lecture, tutorial, or lab times were found for '
                f'"{course_code}".'
            )
        }, 422

    return {'course': course}


@app.route('/api/ttb/suggestions', methods=['GET'])
def get_course_suggestions():
    if 'user_id' not in session:
        return {'error': 'Not logged in'}, 401

    query = str(request.args.get('q', '')).strip()
    limit = request.args.get('limit', MAX_COURSE_SUGGESTIONS)

    if len(query) < 2:
        return {'suggestions': []}

    try:
        suggestions = lookup_course_suggestions(query, limit)
    except CourseSuggestionError as exc:
        response_body = {'error': str(exc)}
        if exc.details:
            response_body['details'] = exc.details
        return response_body, exc.status_code

    return {'suggestions': suggestions}
