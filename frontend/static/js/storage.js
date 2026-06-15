const BACKEND = '/api';

let syncTimer = null;
let authRedirectInProgress = false;

function createStoredSchoolSnapshot(
  courses = [],
  sortBy = 'default',
  activeTerm = TERMS[0],
  school = DEFAULT_SCHOOL,
) {
  return {
    school: normalizeSchoolValue(school),
    courses: Array.isArray(courses) ? courses : [],
    sortBy: String(sortBy || 'default'),
    activeTerm: normalizeTermValue(activeTerm, TERMS[0]),
  };
}

function createEmptyStoredSnapshot(activeSchool = DEFAULT_SCHOOL) {
  return {
    activeSchool: normalizeSchoolValue(activeSchool),
    schools: {},
  };
}

function normalizeStoredSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const activeSchool = normalizeSchoolValue(
    snapshot.activeSchool || snapshot.school,
    DEFAULT_SCHOOL,
  );
  const normalized = createEmptyStoredSnapshot(activeSchool);

  if (snapshot.schools && typeof snapshot.schools === 'object') {
    SCHOOL_OPTIONS.forEach((schoolOption) => {
      const school = schoolOption.id;
      const schoolSnapshot = snapshot.schools[school];
      if (!schoolSnapshot || typeof schoolSnapshot !== 'object') return;

      normalized.schools[school] = createStoredSchoolSnapshot(
        schoolSnapshot.courses,
        schoolSnapshot.sortBy,
        schoolSnapshot.activeTerm,
        school,
      );
    });
  }

  if (Array.isArray(snapshot.courses)) {
    normalized.schools.uoft = createStoredSchoolSnapshot(
      snapshot.courses,
      snapshot.sortBy,
      snapshot.activeTerm,
      'uoft',
    );
  }

  return normalized;
}

// Reads the last locally cached timetable snapshot, if one exists.
function readStoredSnapshot() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeStoredSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

function readStoredSchoolState(school = DEFAULT_SCHOOL) {
  const activeSchool = normalizeSchoolValue(school);
  const storedSnapshot = readStoredSnapshot();
  const schoolSnapshot = storedSnapshot?.schools?.[activeSchool];

  return createStoredSchoolSnapshot(
    schoolSnapshot?.courses,
    schoolSnapshot?.sortBy,
    schoolSnapshot?.activeTerm,
    activeSchool,
  );
}

function getGuestCookieValue() {
  if (typeof document === 'undefined') return '';

  const prefix = `${GUEST_COOKIE_NAME}=`;
  const cookie = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}

function generateGuestId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function ensureGuestCookie() {
  const existingGuestId = getGuestCookieValue();
  if (existingGuestId) return existingGuestId;

  const guestId = generateGuestId();
  const cookieParts = [
    `${GUEST_COOKIE_NAME}=${encodeURIComponent(guestId)}`,
    'Max-Age=31536000',
    'Path=/',
    'SameSite=Lax',
  ];

  if (window.location.protocol === 'https:') {
    cookieParts.push('Secure');
  }

  document.cookie = cookieParts.join('; ');

  return guestId;
}

// Writes the current frontend state to localStorage, grouped by school.
function writeLocalState(
  courses = [],
  sortBy = 'default',
  activeTerm = TERMS[0],
  school = state?.activeSchool || DEFAULT_SCHOOL,
) {
  ensureGuestCookie();

  const activeSchool = normalizeSchoolValue(school);
  const storedSnapshot =
    readStoredSnapshot() || createEmptyStoredSnapshot(activeSchool);

  storedSnapshot.activeSchool = activeSchool;
  storedSnapshot.schools[activeSchool] = createStoredSchoolSnapshot(
    courses,
    sortBy,
    activeTerm,
    activeSchool,
  );

  localStorage.setItem(STORAGE_KEY, JSON.stringify(storedSnapshot));
}

// Cancels any delayed sync that has not been sent to the backend yet.
function clearPendingSync() {
  if (syncTimer !== null) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
}

function setAuthenticatedState(authenticated, username = '') {
  state.isAuthenticated = Boolean(authenticated);
  state.username = authenticated ? String(username || '') : '';
  authRedirectInProgress = false;

  if (typeof updateAuthUI === 'function') {
    updateAuthUI();
  }
}

async function loadSessionState() {
  try {
    const response = await fetch(`${BACKEND}/session`, {
      credentials: 'include',
    });

    if (!response.ok) {
      setAuthenticatedState(false);
      return { authenticated: false, username: '' };
    }

    const payload = await response.json().catch(() => null);
    const authenticated = Boolean(payload?.authenticated);
    const username = payload?.username || '';
    setAuthenticatedState(authenticated, username);
    return { authenticated, username };
  } catch (error) {
    console.error('Failed to load session state:', error);
    setAuthenticatedState(false);
    return { authenticated: false, username: '' };
  }
}

async function loadBackendCoursesBySchool(school = DEFAULT_SCHOOL) {
  const activeSchool = normalizeSchoolValue(school);
  const params = new URLSearchParams({ school: activeSchool });
  const response = await fetch(`${BACKEND}/courses?${params.toString()}`, {
    credentials: 'include',
  });

  if (response.status === 401) {
    setAuthenticatedState(false);
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to load ${getSchoolLabel(activeSchool)} courses: ${response.status}`);
  }

  const backendCourses = await response.json();
  const courses = [];

  for (const course of backendCourses) {
    const sectionResponse = await fetch(
      `${BACKEND}/courses/${course.id}/sections`,
      {
        credentials: 'include',
      },
    );

    if (sectionResponse.status === 401) {
      setAuthenticatedState(false);
      return null;
    }

    if (sectionResponse.status === 404) {
      continue;
    }

    if (!sectionResponse.ok) {
      throw new Error(
        `Failed to load sections for course ${course.id}: ${sectionResponse.status}`,
      );
    }

    const sections = await sectionResponse.json();
    courses.push({
      id: String(course.id),
      school: normalizeSchoolValue(course.school, activeSchool),
      code: course.code,
      colorIndex: course.color_index,
      expanded: false,
      sections: sections.map((section) => ({
        ...section,
        id: String(section.id),
        meetings: section.meetings.map((meeting) => ({
          ...meeting,
          id: String(meeting.id),
        })),
      })),
    });
  }

  return courses;
}

// Saves locally first, then schedules a delayed backend sync for signed-in users.
function saveState() {
  clearPendingSync();

  try {
    writeLocalState(state.courses, state.sortBy, state.activeTerm, state.activeSchool);
  } catch {
    // Ignore storage failures
  }

  if (state.isAuthenticated) {
    syncTimer = setTimeout(syncToBackend, 1000);
  }
}

// Loads timetable data for the selected school from account storage or guest storage.
async function loadState(school = state?.activeSchool || DEFAULT_SCHOOL) {
  const activeSchool = normalizeSchoolValue(school);
  ensureGuestCookie();

  const storedSnapshot = readStoredSchoolState(activeSchool);
  const sessionState = await loadSessionState();

  if (!sessionState.authenticated) {
    return {
      ...storedSnapshot,
      activeSchool,
    };
  }

  try {
    let courses = await loadBackendCoursesBySchool(activeSchool);
    if (courses === null) {
      return {
        ...storedSnapshot,
        activeSchool,
      };
    }

    if (!courses.length && storedSnapshot.courses.length) {
      courses = storedSnapshot.courses;
      await syncCoursesToBackend(courses, activeSchool);
    }

    try {
      writeLocalState(
        courses,
        storedSnapshot.sortBy,
        storedSnapshot.activeTerm,
        activeSchool,
      );
    } catch {
      // Ignore storage failures
    }

    return {
      courses,
      sortBy: storedSnapshot.sortBy,
      activeTerm: storedSnapshot.activeTerm,
      activeSchool,
    };
  } catch (error) {
    console.error('Failed to load timetable state:', error);
    return {
      ...storedSnapshot,
      activeSchool,
    };
  }
}

async function getCoursesBySchool(school = DEFAULT_SCHOOL) {
  return loadState(normalizeSchoolValue(school));
}

// Fetches one exact course by code from the selected school's provider route.
async function searchCourseByCode(courseCode, school = state?.activeSchool || DEFAULT_SCHOOL) {
  const activeSchool = normalizeSchoolValue(school);
  const response = await fetch(`${BACKEND}/ttb/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ courseCode, school: activeSchool }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error || `Failed to load course "${courseCode}".`,
    );
  }

  return payload?.course || null;
}

// Fetches autocomplete suggestions for the current course search text.
async function fetchCourseSuggestions(
  query,
  limit = COURSE_SUGGESTION_LIMIT,
  school = state?.activeSchool || DEFAULT_SCHOOL,
) {
  const activeSchool = normalizeSchoolValue(school);
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    school: activeSchool,
  });
  const response = await fetch(`${BACKEND}/ttb/suggestions?${params.toString()}`, {
    credentials: 'include',
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error || `Failed to load suggestions for "${query}".`,
    );
  }

  return {
    suggestions: Array.isArray(payload?.suggestions) ? payload.suggestions : [],
    message: payload?.message || '',
    school: normalizeSchoolValue(payload?.school, activeSchool),
  };
}

async function syncCoursesToBackend(
  courses = state.courses,
  school = state.activeSchool,
) {
  if (!state.isAuthenticated || authRedirectInProgress) return false;

  const activeSchool = normalizeSchoolValue(school);
  const response = await fetch(`${BACKEND}/courses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      school: activeSchool,
      courses: courses.map((course) => ({
        ...course,
        school: activeSchool,
      })),
    }),
  });

  if (response.status === 401) {
    setAuthenticatedState(false);
    return false;
  }

  if (!response.ok) {
    throw new Error(`Backend sync failed: ${response.status}`);
  }

  return true;
}

// Pushes the current timetable state to the backend for the signed-in user.
async function syncToBackend() {
  clearPendingSync();
  if (!state.isAuthenticated || authRedirectInProgress) return;

  try {
    await syncCoursesToBackend(state.courses, state.activeSchool);
  } catch (error) {
    console.error('Backend sync failed:', error);
  }
}

// Logs the user out without clearing the guest-local timetable cache.
async function logoutUser() {
  if (authRedirectInProgress) return;

  clearPendingSync();

  try {
    await fetch('/logout', {
      method: 'POST',
      credentials: 'include',
    });
  } catch (error) {
    console.error('Logout failed:', error);
  }

  setAuthenticatedState(false);
}
