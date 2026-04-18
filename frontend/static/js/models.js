// Normalizes a saved section so the rest of the app can trust its shape.
function normalizeSection(section = {}) {
  return {
    id: section.id != null ? String(section.id) : generateId(),
    type: SECTION_TYPES.includes(section.type) ? section.type : 'Lecture',
    label: String(section.label || '').toUpperCase(),
    meetings:
      Array.isArray(section.meetings) && section.meetings.length > 0
        ? section.meetings.map((meeting) => normalizeMeeting(meeting))
        : [createMeeting()],
  };
}

// Normalizes the temporary section the user is currently editing.
function normalizeDraftSection(draftSection = {}, fallbackType = 'Lecture') {
  return {
    type: SECTION_TYPES.includes(draftSection.type)
      ? draftSection.type
      : fallbackType,
    label: String(draftSection.label || '').toUpperCase(),
    meetings:
      Array.isArray(draftSection.meetings) && draftSection.meetings.length > 0
        ? draftSection.meetings.map((meeting) => normalizeMeeting(meeting))
        : [createMeeting()],
  };
}

// Normalizes one course record from storage or the backend into UI state.
function normalizeCourse(course = {}, index = 0) {
  const sections = Array.isArray(course.sections)
    ? course.sections.map((section) => normalizeSection(section))
    : [];
  const normalizedEditingSectionId =
    course.editingSectionId != null ? String(course.editingSectionId) : null;
  const defaultType = sections[0]?.type || 'Lecture';
  const editingSectionId = sections.some(
    (section) => section.id === normalizedEditingSectionId,
  )
    ? normalizedEditingSectionId
    : null;

  return {
    id: course.id != null ? String(course.id) : generateId(),
    code: String(course.code || '').trim().toUpperCase(),
    colorIndex: Number.isInteger(course.colorIndex)
      ? course.colorIndex
      : index % COLORS.length,
    expanded: Boolean(course.expanded),
    sections,
    draftSection: normalizeDraftSection(course.draftSection, defaultType),
    editingSectionId,
    editingDraftSection: editingSectionId
      ? normalizeSection(
          course.editingDraftSection ||
            sections.find((section) => section.id === editingSectionId),
        )
      : null,
  };
}

// Normalizes the full course list and drops invalid blank entries.
function normalizeCourses(courses = []) {
  return courses
    .map((course, index) => normalizeCourse(course, index))
    .filter((course) => course.code);
}

// Builds the demo timetable set used by the "Load Sample Data" button.
function buildSampleCourses() {
  return SAMPLE_COURSES.map((course, index) =>
    createCourse(
      course.code,
      course.colorIndex ?? index % COLORS.length,
      course.sections,
    ),
  );
}

// Central frontend state shared by the UI, scheduler, and storage modules.
let state = {
  courses: [],
  generatedSchedulesByTerm: createEmptyScheduleBuckets(),
  sortedSchedulesByTerm: createEmptyScheduleBuckets(),
  currentIndexesByTerm: createEmptyTermIndexes(),
  hasGenerated: false,
  activeTerm: TERMS[0],
  sortBy: 'default',
};
