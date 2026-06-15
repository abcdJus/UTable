// Creates a lightweight unique id for courses, sections, and meetings in the UI.
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Makes a deep copy so edits do not accidentally mutate the original object.
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Escapes user-provided text before putting it into HTML strings.
function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// Validates a HH:MM time string and falls back when the value is invalid.
function normalizeTimeValue(value, fallback) {
  if (typeof value !== 'string') return fallback;

  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return fallback;
  }

  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}

// Keeps term values limited to the three timetable buckets shown in the UI.
function normalizeTermValue(value, fallback = TERMS[0]) {
  return TERMS.includes(value) ? value : fallback;
}

// Keeps school values limited to supported course providers.
function normalizeSchoolValue(value, fallback = DEFAULT_SCHOOL) {
  const normalized = String(value || '').trim().toLowerCase();
  const school = SCHOOL_OPTIONS.some((option) => option.id === normalized)
    ? normalized
    : fallback;

  return SCHOOL_OPTIONS.some((option) => option.id === school)
    ? school
    : DEFAULT_SCHOOL;
}

function getSchoolLabel(school = DEFAULT_SCHOOL) {
  return SCHOOL_LABELS[normalizeSchoolValue(school)] || SCHOOL_LABELS[DEFAULT_SCHOOL];
}

// Builds a per-term object so each semester can keep independent state.
function createTermMap(createValue) {
  return Object.fromEntries(
    TERMS.map((term) => [term, createValue(term)]),
  );
}

// Creates empty schedule buckets for Fall, Winter, and Summer.
function createEmptyScheduleBuckets() {
  return createTermMap(() => []);
}

// Creates one independent current-page counter per term.
function createEmptyTermIndexes() {
  return createTermMap(() => 0);
}

// Creates one meeting object with safe default values.
function createMeeting(day = DAYS[0], start = '09:00', end = '10:00', term) {
  const fallbackTerm =
    typeof state === 'object' ? normalizeTermValue(state.activeTerm, TERMS[0]) : TERMS[0];

  return {
    id: generateId(),
    term: normalizeTermValue(term, fallbackTerm),
    day: DAYS.includes(day) ? day : DAYS[0],
    start: normalizeTimeValue(start, '09:00'),
    end: normalizeTimeValue(end, '10:00'),
  };
}

// Normalizes meeting data coming from storage, the backend, or the editor UI.
function normalizeMeeting(meeting = {}) {
  return {
    id: meeting.id != null ? String(meeting.id) : generateId(),
    term: normalizeTermValue(meeting.term, TERMS[0]),
    day: DAYS.includes(meeting.day) ? meeting.day : DAYS[0],
    start: normalizeTimeValue(meeting.start, '09:00'),
    end: normalizeTimeValue(meeting.end, '10:00'),
  };
}

// Creates the empty section form state shown when adding a new section.
function createDraftSection(type = 'Lecture') {
  return {
    type: SECTION_TYPES.includes(type) ? type : 'Lecture',
    label: '',
    meetings: [createMeeting()],
  };
}

// Creates one course object in the frontend format the app expects.
function createCourse(code, colorIndex = 0, sections = [], school = DEFAULT_SCHOOL) {
  const normalizedSections = Array.isArray(sections)
    ? sections.map((section) => normalizeSection(section))
    : [];
  const activeSchool =
    typeof state === 'object' ? normalizeSchoolValue(state.activeSchool) : DEFAULT_SCHOOL;

  return {
    id: generateId(),
    school: normalizeSchoolValue(school, activeSchool),
    code: String(code || '').trim().toUpperCase(),
    colorIndex: Number.isInteger(colorIndex) ? colorIndex : 0,
    expanded: false,
    sections: normalizedSections,
    draftSection: createDraftSection(normalizedSections[0]?.type || 'Lecture'),
    editingSectionId: null,
    editingDraftSection: null,
  };
}

// Converts a time string like 09:30 into total minutes for comparisons.
function timeToMins(time = '00:00') {
  const normalized = normalizeTimeValue(time, '00:00');
  const [hours, minutes] = normalized.split(':').map(Number);
  return hours * 60 + minutes;
}

// Converts total minutes back into the HH:MM format used on screen.
function minsToTime(totalMinutes = 0) {
  const safeMinutes = Math.max(0, Math.floor(Number(totalMinutes) || 0));
  const hours = Math.floor(safeMinutes / 60);
  const minutes = safeMinutes % 60;
  
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}
