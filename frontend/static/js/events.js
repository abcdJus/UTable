// Helper function to keep generated data, saved state, and rendered UI in sync after course changes
function refreshAfterCourseChange() {
  ensureActiveTermIsValid();
  resetGeneratedState();
  saveState();
  renderCourses();
  updateMainView();
}

function applyLoadedTimetableState(stored = {}) {
  const previousAuthState = {
    isAuthenticated: state.isAuthenticated,
    username: state.username,
  };
  const activeSchool = normalizeSchoolValue(stored.activeSchool, state.activeSchool);

  state = {
    courses: normalizeCourses(stored.courses, activeSchool),
    activeSchool,
    isAuthenticated: previousAuthState.isAuthenticated,
    username: previousAuthState.username,
    generatedSchedulesByTerm: createEmptyScheduleBuckets(),
    sortedSchedulesByTerm: createEmptyScheduleBuckets(),
    currentIndexesByTerm: createEmptyTermIndexes(),
    hasGenerated: false,
    activeTerm: normalizeTermValue(stored.activeTerm, TERMS[0]),
    sortBy: stored.sortBy || 'default',
  };

  DOM.sortSelect.value = state.sortBy;
  renderSchoolTabs();
  updateAuthUI();
  updateSchoolAwareCopy();
  renderCourses();
  updateMainView();

  try {
    writeLocalState(state.courses, state.sortBy, state.activeTerm, state.activeSchool);
  } catch {
    // Ignore storage failures
  }
}

async function switchSchool(nextSchool) {
  const normalizedSchool = normalizeSchoolValue(nextSchool, state.activeSchool);
  if (normalizedSchool === state.activeSchool) return;

  clearPendingSync();

  try {
    writeLocalState(state.courses, state.sortBy, state.activeTerm, state.activeSchool);
  } catch {
    // Ignore storage failures
  }

  closeCourseSuggestions();
  closeCourseTermPicker();
  setCourseSearchStatus(`Loading ${getSchoolLabel(normalizedSchool)} courses...`);

  const previousSchool = state.activeSchool;
  state.activeSchool = normalizedSchool;
  state.courses = [];
  resetGeneratedState();
  renderSchoolTabs();
  updateSchoolAwareCopy();
  renderCourses();
  updateMainView();

  try {
    const stored = await getCoursesBySchool(normalizedSchool);
    applyLoadedTimetableState(stored);
    const schoolLabel = getSchoolLabel(normalizedSchool);
    setCourseSearchStatus(
      normalizedSchool === 'mac' && state.courses.length === 0
        ? 'McMaster mode is ready for saved course data, but live course search is not connected yet.'
        : `Switched to ${schoolLabel}.`,
      normalizedSchool === 'mac' && state.courses.length === 0 ? 'warning' : 'success',
    );
  } catch (error) {
    console.error('School switch failed:', error);
    state.activeSchool = previousSchool;
    const stored = readStoredSchoolState(previousSchool);
    applyLoadedTimetableState({ ...stored, activeSchool: previousSchool });
    setCourseSearchStatus('Could not switch schools right now.', 'error');
  }
}

let courseLookupInProgress = false;
let courseSuggestionTimer = null;
let courseSuggestionRequestId = 0;
let courseSuggestions = [];
let activeCourseSuggestionIndex = -1;
let pendingCourseSelection = null;

function setCourseSearchStatus(message = '', tone = 'warning') {
  if (!DOM.courseSearchStatus) return;

  if (!message) {
    DOM.courseSearchStatus.textContent = '';
    DOM.courseSearchStatus.className = 'status-note status-note--warning is-hidden';
    return;
  }

  DOM.courseSearchStatus.textContent = message;
  DOM.courseSearchStatus.className = `status-note status-note--${tone}`;
}

function clearCourseSuggestionTimer() {
  if (courseSuggestionTimer !== null) {
    clearTimeout(courseSuggestionTimer);
    courseSuggestionTimer = null;
  }
}

function closeCourseTermPicker() {
  pendingCourseSelection = null;

  if (!DOM.courseTermPicker) return;

  DOM.courseTermPicker.innerHTML = '';
  DOM.courseTermPicker.classList.add('is-hidden');
}

function sessionCodeToTerm(sessionCode) {
  const normalized = String(sessionCode || '').trim().toUpperCase();
  if (!normalized) return null;

  if (/^\d{5}[FS]$/.test(normalized)) {
    return 'Summer';
  }

  const digits = normalized.replace(/\D/g, '');
  if (digits.length < 5) return null;

  const termDigit = digits[4];
  if (termDigit === '9') return 'Fall';
  if (termDigit === '1') return 'Winter';
  if (termDigit === '5') return 'Summer';
  return null;
}

function isYearLongCourseCode(courseCode) {
  const normalizedCode = String(courseCode || '').trim().toUpperCase();
  return normalizedCode.length >= 2 && normalizedCode.at(-2) === 'Y';
}

function getCourseMeetingTerms(course = {}) {
  const usedTerms = new Set();

  (course.sections || []).forEach((section) => {
    (section.meetings || []).forEach((meeting) => {
      usedTerms.add(normalizeTermValue(meeting.term, TERMS[0]));
    });
  });

  return TERMS.filter((term) => usedTerms.has(term));
}

function getCourseSessionTerms(course = {}) {
  const usedTerms = new Set();

  (course.sessions || []).forEach((sessionCode) => {
    const term = sessionCodeToTerm(sessionCode);
    if (term) {
      usedTerms.add(term);
    }
  });

  return TERMS.filter((term) => usedTerms.has(term));
}

function buildCourseTermOptions(course = {}) {
  const courseCode = String(course.code || '').trim().toUpperCase();
  const sessionTerms = getCourseSessionTerms(course);
  const meetingTerms = getCourseMeetingTerms(course);

  if (
    isYearLongCourseCode(courseCode) &&
    sessionTerms.includes('Fall') &&
    sessionTerms.includes('Winter')
  ) {
    return [
      {
        id: 'fall-winter',
        label: 'Fall + Winter',
        terms: ['Fall', 'Winter'],
      },
    ];
  }

  const availableTerms = meetingTerms.length ? meetingTerms : sessionTerms;
  return availableTerms.map((term) => ({
    id: term.toLowerCase(),
    label: term,
    terms: [term],
  }));
}

function filterCourseBySelectedTerms(course = {}, selectedTerms = []) {
  const allowedTerms = new Set(
    selectedTerms.map((term) => normalizeTermValue(term, TERMS[0])),
  );

  return {
    ...clone(course),
    sections: (course.sections || [])
      .map((section) => ({
        ...clone(section),
        meetings: (section.meetings || []).filter((meeting) =>
          allowedTerms.has(normalizeTermValue(meeting.term, TERMS[0])),
        ),
      }))
      .filter((section) => section.meetings.length > 0),
  };
}

function renderCourseTermPicker(course, termOptions) {
  if (!DOM.courseTermPicker) return;

  DOM.courseTermPicker.innerHTML = `
    <div class="course-term-picker__title">
      Choose a semester for ${escapeHtml(course.code)}
    </div>
    <p class="course-term-picker__description">
      Only the semesters this course actually offers are shown below.
    </p>
    <div class="course-term-picker__options">
      ${termOptions
        .map(
          (option) => `
            <button
              type="button"
              class="course-term-picker__option"
              data-course-term-option="${escapeHtml(option.id)}"
            >
              ${escapeHtml(option.label)}
            </button>
          `,
        )
        .join('')}
    </div>
    <div class="course-term-picker__footer">
      <button
        type="button"
        class="mini-button"
        data-course-term-cancel="true"
      >
        Cancel
      </button>
    </div>
  `;
  DOM.courseTermPicker.classList.remove('is-hidden');
}

function showCourseTermPicker(course, termOptions) {
  pendingCourseSelection = {
    course: clone(course),
    termOptions: termOptions.map((option) => ({
      ...option,
      terms: [...option.terms],
    })),
  };
  renderCourseTermPicker(course, termOptions);
}

function setCourseSuggestionsExpanded(isExpanded) {
  if (DOM.courseCodeInput) {
    DOM.courseCodeInput.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
  }
}

function closeCourseSuggestions() {
  clearCourseSuggestionTimer();
  courseSuggestionRequestId += 1;
  courseSuggestions = [];
  activeCourseSuggestionIndex = -1;

  if (!DOM.courseSuggestions) return;

  DOM.courseSuggestions.innerHTML = '';
  DOM.courseSuggestions.classList.add('is-hidden');
  setCourseSuggestionsExpanded(false);
}

function renderCourseSuggestionStatus(message) {
  if (!DOM.courseSuggestions) return;

  DOM.courseSuggestions.innerHTML = `
    <div class="course-suggestions__status">${escapeHtml(message)}</div>
  `;
  DOM.courseSuggestions.classList.remove('is-hidden');
  setCourseSuggestionsExpanded(true);
}

function renderCourseSuggestions() {
  if (!DOM.courseSuggestions) return;

  if (!courseSuggestions.length) {
    closeCourseSuggestions();
    return;
  }

  DOM.courseSuggestions.innerHTML = courseSuggestions
    .map((suggestion, index) => {
      const alreadyAdded = state.courses.some(
        (course) => course.code === suggestion.code,
      );
      const activeClass =
        index === activeCourseSuggestionIndex
          ? ' course-suggestion__button--active'
          : '';
      const disabledClass = alreadyAdded
        ? ' course-suggestion__button--disabled'
        : '';

      return `
        <button
          type="button"
          class="course-suggestion__button${activeClass}${disabledClass}"
          data-course-code="${escapeHtml(suggestion.code)}"
          data-suggestion-index="${index}"
          role="option"
          aria-selected="${index === activeCourseSuggestionIndex ? 'true' : 'false'}"
          ${alreadyAdded ? 'disabled' : ''}
        >
          <span class="course-suggestion__main">
            <span class="course-suggestion__code">${escapeHtml(suggestion.code)}</span>
            <span class="course-suggestion__title">${escapeHtml(suggestion.title || '')}</span>
            <span class="course-suggestion__campus">${escapeHtml(suggestion.campus || suggestion.campusLabel || getSchoolLabel(suggestion.school || state.activeSchool))}</span>
          </span>
          <span class="course-suggestion__meta">
            ${alreadyAdded ? 'Added' : 'Add'}
          </span>
        </button>
      `;
    })
    .join('');

  DOM.courseSuggestions.classList.remove('is-hidden');
  setCourseSuggestionsExpanded(true);

  if (activeCourseSuggestionIndex >= 0) {
    const activeButton = DOM.courseSuggestions.querySelector(
      `[data-suggestion-index="${activeCourseSuggestionIndex}"]`,
    );
    activeButton?.scrollIntoView({ block: 'nearest' });
  }
}

function moveCourseSuggestionSelection(direction) {
  if (!courseSuggestions.length) return;

  if (activeCourseSuggestionIndex === -1) {
    activeCourseSuggestionIndex = direction > 0 ? 0 : courseSuggestions.length - 1;
  } else {
    activeCourseSuggestionIndex =
      (activeCourseSuggestionIndex + direction + courseSuggestions.length) %
      courseSuggestions.length;
  }

  renderCourseSuggestions();
}

function showCourseSuggestionHint() {
  const query = DOM.courseCodeInput.value.trim().toUpperCase();
  if (query.length >= COURSE_SUGGESTION_MIN_CHARS) {
    queueCourseSuggestions(query);
    return;
  }

  renderCourseSuggestionStatus(
    `Type at least ${COURSE_SUGGESTION_MIN_CHARS} characters to search ${getSchoolLabel(state.activeSchool)} courses.`,
  );
}

function queueCourseSuggestions(query) {
  if (courseLookupInProgress) return;

  const normalizedQuery = query.trim().toUpperCase();
  if (normalizedQuery.length < COURSE_SUGGESTION_MIN_CHARS) {
    showCourseSuggestionHint();
    return;
  }

  clearCourseSuggestionTimer();
  const requestId = ++courseSuggestionRequestId;

  const requestSchool = state.activeSchool;
  const requestSchoolLabel = getSchoolLabel(requestSchool);
  renderCourseSuggestionStatus(
    `Searching ${requestSchoolLabel} courses for "${normalizedQuery}"...`,
  );

  courseSuggestionTimer = setTimeout(async () => {
    try {
      const suggestionResult = await fetchCourseSuggestions(
        normalizedQuery,
        COURSE_SUGGESTION_LIMIT,
        requestSchool,
      );
      if (requestId !== courseSuggestionRequestId || authRedirectInProgress) return;

      const suggestions = suggestionResult.suggestions || [];
      courseSuggestions = suggestions;
      activeCourseSuggestionIndex = suggestions.length ? 0 : -1;

      if (!suggestions.length) {
        renderCourseSuggestionStatus(
          suggestionResult.message ||
            `No ${requestSchoolLabel} courses found for "${normalizedQuery}".`,
        );
        return;
      }

      renderCourseSuggestions();
    } catch (error) {
      if (requestId !== courseSuggestionRequestId || authRedirectInProgress) return;

      console.error('Course suggestions failed:', error);
      renderCourseSuggestionStatus(
        error.message || 'Could not load course suggestions right now.',
      );
    }
  }, 220);
}

function setCourseLookupPending(isPending) {
  courseLookupInProgress = isPending;

  DOM.courseCodeInput.disabled = isPending;
  if (isPending) closeCourseSuggestions();

  const submitButton = DOM.addCourseForm?.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = isPending;
    submitButton.textContent = isPending ? 'Searching...' : 'Add';
  }
}

async function addCourseByCode(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code || courseLookupInProgress) return;

  closeCourseSuggestions();
  closeCourseTermPicker();

  if (state.courses.some((course) => course.code === code)) {
    setCourseSearchStatus(`Course "${code}" has already been added.`, 'error');
    return;
  }

  setCourseLookupPending(true);
  setCourseSearchStatus(
    `Looking up ${code} in ${getSchoolLabel(state.activeSchool)} courses...`,
    'warning',
  );

  let releaseLookupInFinally = true;

  try {
    const fetchedCourse = await searchCourseByCode(code, state.activeSchool);
    if (!fetchedCourse) return;

    if (!Array.isArray(fetchedCourse.sections) || fetchedCourse.sections.length === 0) {
      throw new Error(
        `No scheduled lecture, tutorial, or lab times were found for "${code}".`,
      );
    }

    const termOptions = buildCourseTermOptions(fetchedCourse);
    const requiresTermChoice =
      termOptions.length > 1 ||
      termOptions.some((option) => option.terms.length > 1);
    if (requiresTermChoice) {
      releaseLookupInFinally = false;
      setCourseLookupPending(false);
      setCourseSearchStatus(`Choose a semester for ${code} before adding it.`, 'warning');
      showCourseTermPicker(fetchedCourse, termOptions);
      return;
    }

    state.courses.forEach((course) => {
      course.expanded = false;
    });

    const selectedOption = termOptions[0] || {
      label: 'all offered terms',
      terms: getCourseMeetingTerms(fetchedCourse),
    };
    const filteredCourse = filterCourseBySelectedTerms(
      fetchedCourse,
      selectedOption.terms,
    );
    if (!filteredCourse.sections.length) {
      throw new Error(
        `No scheduled lecture, tutorial, or lab times were returned for "${code}" in ${selectedOption.label}.`,
      );
    }

    const newCourse = createCourse(
      filteredCourse.code || code,
      state.courses.length % COLORS.length,
      filteredCourse.sections,
      state.activeSchool,
    );

    newCourse.expanded = true;
    state.courses.push(newCourse);
    DOM.courseCodeInput.value = '';
    setCourseSearchStatus(
      `${newCourse.code} added for ${selectedOption.label} with ${newCourse.sections.length} section options.`,
      'success',
    );
    refreshAfterCourseChange();
  } catch (error) {
    if (!authRedirectInProgress) {
      console.error('Course lookup failed:', error);
      const exampleCode = state.activeSchool === 'uoft' ? 'CSCB20H3' : 'CHEM 1A03';
      setCourseSearchStatus(
        error.message || `Could not load "${code}". Try a full course code like ${exampleCode}.`,
        'error',
      );
    }
  } finally {
    if (!authRedirectInProgress && releaseLookupInFinally) {
      setCourseLookupPending(false);
      DOM.courseCodeInput.focus();
    }
  }
}

// Handles adding a new course from the sidebar form.
DOM.addCourseForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (
    activeCourseSuggestionIndex >= 0 &&
    activeCourseSuggestionIndex < courseSuggestions.length
  ) {
    await addCourseByCode(courseSuggestions[activeCourseSuggestionIndex].code);
    return;
  }

  await addCourseByCode(DOM.courseCodeInput.value);
});

DOM.courseCodeInput.addEventListener('input', () => {
  if (!courseLookupInProgress) {
    setCourseSearchStatus('');
  }

  closeCourseTermPicker();
  queueCourseSuggestions(DOM.courseCodeInput.value);
});

DOM.courseCodeInput.addEventListener('focus', () => {
  if (!courseLookupInProgress) {
    showCourseSuggestionHint();
  }
});

DOM.courseCodeInput.addEventListener('keydown', async (e) => {
  if (courseLookupInProgress) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (DOM.courseSuggestions.classList.contains('is-hidden')) {
      showCourseSuggestionHint();
      return;
    }

    moveCourseSuggestionSelection(1);
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (DOM.courseSuggestions.classList.contains('is-hidden')) {
      showCourseSuggestionHint();
      return;
    }

    moveCourseSuggestionSelection(-1);
    return;
  }

  if (e.key === 'Escape') {
    closeCourseSuggestions();
    return;
  }

  if (
    e.key === 'Enter' &&
    activeCourseSuggestionIndex >= 0 &&
    activeCourseSuggestionIndex < courseSuggestions.length
  ) {
    e.preventDefault();
    await addCourseByCode(courseSuggestions[activeCourseSuggestionIndex].code);
  }
});

if (DOM.courseSuggestions) {
  DOM.courseSuggestions.addEventListener('mousemove', (e) => {
    const button = e.target.closest('[data-suggestion-index]');
    if (!button || button.disabled) return;

    const nextIndex = Number(button.getAttribute('data-suggestion-index'));
    if (!Number.isInteger(nextIndex) || nextIndex === activeCourseSuggestionIndex) {
      return;
    }

    activeCourseSuggestionIndex = nextIndex;
    renderCourseSuggestions();
  });

  DOM.courseSuggestions.addEventListener('mousedown', async (e) => {
    const button = e.target.closest('[data-course-code]');
    if (!button || button.disabled) return;

    e.preventDefault();
    await addCourseByCode(button.getAttribute('data-course-code'));
  });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.course-search-shell')) {
    closeCourseSuggestions();
  }
});

if (DOM.courseTermPicker) {
  DOM.courseTermPicker.addEventListener('click', (e) => {
    const cancelButton = e.target.closest('[data-course-term-cancel]');
    if (cancelButton) {
      closeCourseTermPicker();
      setCourseSearchStatus('');
      DOM.courseCodeInput.focus();
      return;
    }

    const optionButton = e.target.closest('[data-course-term-option]');
    if (!optionButton || !pendingCourseSelection) return;

    const optionId = optionButton.getAttribute('data-course-term-option');
    const selectedOption = pendingCourseSelection.termOptions.find(
      (option) => option.id === optionId,
    );
    if (!selectedOption) return;

    if (
      state.courses.some(
        (course) => course.code === pendingCourseSelection.course.code,
      )
    ) {
      closeCourseTermPicker();
      setCourseSearchStatus(
        `Course "${pendingCourseSelection.course.code}" has already been added.`,
        'error',
      );
      return;
    }

    const filteredCourse = filterCourseBySelectedTerms(
      pendingCourseSelection.course,
      selectedOption.terms,
    );

    if (!filteredCourse.sections.length) {
      setCourseSearchStatus(
        `No scheduled section times were returned for ${pendingCourseSelection.course.code} in ${selectedOption.label}. Try another offered term.`,
        'error',
      );
      return;
    }

    state.courses.forEach((course) => {
      course.expanded = false;
    });

    const newCourse = createCourse(
      filteredCourse.code || pendingCourseSelection.course.code,
      state.courses.length % COLORS.length,
      filteredCourse.sections,
      state.activeSchool,
    );

    newCourse.expanded = true;
    state.courses.push(newCourse);
    DOM.courseCodeInput.value = '';
    closeCourseTermPicker();
    setCourseSearchStatus(
      `${newCourse.code} added for ${selectedOption.label} with ${newCourse.sections.length} section options.`,
      'success',
    );
    refreshAfterCourseChange();
    DOM.courseCodeInput.focus();
  });
}

if (DOM.schoolTabs) {
  DOM.schoolTabs.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-school]');
    if (!button) return;

    await switchSchool(button.getAttribute('data-school'));
  });
}

if (DOM.authActionBtn) {
  DOM.authActionBtn.addEventListener('click', async () => {
    if (DOM.authActionBtn.disabled) return;

    if (!state.isAuthenticated) {
      window.location.href = '/login';
      return;
    }

    const originalLabel = DOM.authActionBtn.textContent;
    DOM.authActionBtn.disabled = true;
    DOM.authActionBtn.textContent = 'Logging out...';

    try {
      await syncToBackend();
      await logoutUser();
      updateAuthUI();
      setCourseSearchStatus('You are now using guest mode on this browser.', 'success');
    } finally {
      DOM.authActionBtn.disabled = false;
      DOM.authActionBtn.textContent = state.isAuthenticated ? originalLabel : 'Login';
    }
  });
}

// Handles all button clicks inside the course list using event delegation.
DOM.courseList.addEventListener('click', (e) => {
  const button = e.target.closest('button');
  const toggle = e.target.closest('.toggle-course-btn');

  if (button) {
    const courseId = button.getAttribute('data-course-id');
    const course = getCourse(courseId);

    if (button.classList.contains('delete-course-btn')) {
      e.stopPropagation();
      state.courses = state.courses.filter((c) => c.id !== courseId);
      refreshAfterCourseChange();
      return;
    }

    if (!course) return;

    if (button.classList.contains('delete-section-btn')) {
      e.stopPropagation();
      const sectionId = button.getAttribute('data-section-id');
      course.sections = course.sections.filter(
        (section) => section.id !== sectionId,
      );

      if (course.editingSectionId === sectionId) {
        stopEditingSection(course);
      }

      refreshAfterCourseChange();
      return;
    }

    if (button.classList.contains('edit-section-btn')) {
      e.stopPropagation();
      const sectionId = button.getAttribute('data-section-id');
      const section = course.sections.find((s) => s.id === sectionId);
      if (!section) return;
      startEditingSection(course, section);
      renderCourses();
      return;
    }

    if (button.classList.contains('cancel-edit-btn')) {
      e.stopPropagation();
      stopEditingSection(course);
      renderCourses();
      return;
    }

    if (button.classList.contains('add-draft-meeting-btn')) {
      e.stopPropagation();
      const scope = button.getAttribute('data-draft-scope') || 'add';
      const draft = getDraftSection(course, scope);
      if (!draft) return;
      draft.meetings.push(createMeeting());
      renderCourses();
      return;
    }

    if (button.classList.contains('remove-draft-meeting-btn')) {
      e.stopPropagation();
      const scope = button.getAttribute('data-draft-scope') || 'add';
      const draft = getDraftSection(course, scope);
      if (!draft || draft.meetings.length === 1) return;
      const meetingId = button.getAttribute('data-meeting-id');
      draft.meetings = draft.meetings.filter(
        (meeting) => meeting.id !== meetingId,
      );
      renderCourses();
      return;
    }

    if (button.classList.contains('save-section-btn')) {
      e.stopPropagation();
      const scope = button.getAttribute('data-draft-scope') || 'add';
      const draft = getDraftSection(course, scope);
      if (!draft) return;
      const cleanLabel = draft.label.trim().toUpperCase();
      const duplicateSection = course.sections.find((section) => {
        if (scope === 'edit' && section.id === course.editingSectionId) {
          return false;
        }

        return section.label.trim().toUpperCase() === cleanLabel;
      });

      if (!cleanLabel) {
        alert('Please enter a section label.');
        return;
      }

      if (duplicateSection) {
        alert(
          `Section label "${cleanLabel}" already exists in ${course.code}. Please use a different label.`,
        );
        return;
      }

      if (!validateMeetings(draft.meetings)) {
        alert(
          'Please enter valid meeting times. End time must be after start time, and meetings inside the same section cannot overlap.',
        );
        return;
      }

      const savedSection = {
        id:
          scope === 'edit' && course.editingSectionId
            ? course.editingSectionId
            : generateId(),
        type: draft.type,
        label: cleanLabel,
        meetings: clone(draft.meetings),
      };

      if (scope === 'edit' && course.editingSectionId) {
        course.sections = course.sections.map((section) =>
          section.id === course.editingSectionId ? savedSection : section,
        );
        stopEditingSection(course);
      } else {
        course.sections.push(savedSection);
        course.draftSection = createDraftSection(draft.type);
      }

      refreshAfterCourseChange();
      return;
    }
  }

  if (toggle && !button) {
    const courseId = toggle.getAttribute('data-course-id');

    state.courses.forEach((course) => {
      if (course.id === courseId) {
        course.expanded = !course.expanded;
      } else {
        course.expanded = false;
      }
    });

    renderCourses();
  }
});

// Updates draft text/time inputs as the user types.
DOM.courseList.addEventListener('input', (e) => {
  const target = e.target;
  const courseId = target.getAttribute('data-course-id');
  if (!courseId) return;

  const course = getCourse(courseId);
  if (!course) return;

  const scope = target.getAttribute('data-draft-scope') || 'add';
  const draft = getDraftSection(course, scope);
  if (!draft) return;

  if (target.classList.contains('draft-label-input')) {
    draft.label = target.value.toUpperCase();
    return;
  }

  if (target.classList.contains('draft-start-input')) {
    const meeting = getDraftMeeting(
      course,
      target.getAttribute('data-meeting-id'),
      scope,
    );
    if (meeting) meeting.start = target.value;
    return;
  }

  if (target.classList.contains('draft-end-input')) {
    const meeting = getDraftMeeting(
      course,
      target.getAttribute('data-meeting-id'),
      scope,
    );
    if (meeting) meeting.end = target.value;
  }
});

// Updates draft dropdown values after the user changes them.
DOM.courseList.addEventListener('change', (e) => {
  const target = e.target;
  const courseId = target.getAttribute('data-course-id');
  if (!courseId) return;

  const course = getCourse(courseId);
  if (!course) return;

  const scope = target.getAttribute('data-draft-scope') || 'add';
  const draft = getDraftSection(course, scope);
  if (!draft) return;

  if (target.classList.contains('draft-type-select')) {
    draft.type = target.value;
    return;
  }

  if (target.classList.contains('draft-term-select')) {
    const meeting = getDraftMeeting(
      course,
      target.getAttribute('data-meeting-id'),
      scope,
    );
    if (meeting) meeting.term = normalizeTermValue(target.value, TERMS[0]);
    return;
  }

  if (target.classList.contains('draft-day-select')) {
    const meeting = getDraftMeeting(
      course,
      target.getAttribute('data-meeting-id'),
      scope,
    );
    if (meeting) meeting.day = target.value;
  }
});

// Starts timetable generation when the main action button is pressed.
DOM.generateBtn.addEventListener('click', generateAlgorithm);

// Replaces the current course list with the demo sample data.
DOM.resetBtn.addEventListener('click', () => {
  const sampleCourses = buildSampleCourses(state.activeSchool);
  if (!sampleCourses.length) {
    setCourseSearchStatus('Sample data is only available for UofT right now.', 'warning');
    return;
  }

  state.courses = sampleCourses;
  refreshAfterCourseChange();
});

// Moves to the previous generated timetable option.
DOM.prevBtn.addEventListener('click', () => {
  const activeTerm = normalizeTermValue(state.activeTerm, TERMS[0]);
  const currentIndex = getCurrentIndexForTerm(activeTerm);

  if (currentIndex > 0) {
    setCurrentIndexForTerm(activeTerm, currentIndex - 1);
    renderTimetable();
  }
});

// Moves to the next generated timetable option.
DOM.nextBtn.addEventListener('click', () => {
  const activeTerm = normalizeTermValue(state.activeTerm, TERMS[0]);
  const schedules = getSortedSchedulesForTerm(activeTerm);
  const currentIndex = getCurrentIndexForTerm(activeTerm);

  if (currentIndex < schedules.length - 1) {
    setCurrentIndexForTerm(activeTerm, currentIndex + 1);
    renderTimetable();
  }
});

// Re-sorts the generated results when the user changes the dropdown.
DOM.sortSelect.addEventListener('change', (e) => {
  state.sortBy = e.target.value;
  sortSchedules();
  if (state.hasGenerated) updateMainView();
  saveState();
});

if (DOM.termTabs) {
  DOM.termTabs.addEventListener('click', (e) => {
    const button = e.target.closest('[data-term]');
    if (!button) return;

    const nextTerm = normalizeTermValue(button.getAttribute('data-term'), state.activeTerm);
    if (nextTerm === state.activeTerm) return;

    state.activeTerm = nextTerm;
    updateMainView();

    try {
      writeLocalState(state.courses, state.sortBy, state.activeTerm, state.activeSchool);
    } catch {
      // Ignore storage failures
    }
  });
}
