// Groups a course's sections by type so generation can pick one lecture, one lab, and so on.
function groupSectionsByType(sections) {
  return sections.reduce((acc, section) => {
    if (!acc[section.type]) acc[section.type] = [];
    acc[section.type].push(section);
    return acc;
  }, {});
}

// Returns the terms used anywhere inside one meeting list.
function getAvailableTermsFromMeetings(meetings = []) {
  const usedTerms = new Set(
    meetings.map((meeting) => normalizeTermValue(meeting.term, TERMS[0])),
  );
  return TERMS.filter((term) => usedTerms.has(term));
}

// Returns the terms currently represented across every added course.
function getAvailableTermsForCourses(courses = []) {
  const usedTerms = new Set();

  courses.forEach((course) => {
    course.sections.forEach((section) => {
      section.meetings.forEach((meeting) => {
        usedTerms.add(normalizeTermValue(meeting.term, TERMS[0]));
      });
    });
  });

  return TERMS.filter((term) => usedTerms.has(term));
}

// Reads the generated schedules for one term from the shared frontend state.
function getGeneratedSchedulesForTerm(term = TERMS[0]) {
  const normalizedTerm = normalizeTermValue(term, TERMS[0]);
  const schedules = state.generatedSchedulesByTerm?.[normalizedTerm];
  return Array.isArray(schedules) ? schedules : [];
}

// Reads the currently sorted schedules for one term.
function getSortedSchedulesForTerm(term = TERMS[0]) {
  const normalizedTerm = normalizeTermValue(term, TERMS[0]);
  const schedules = state.sortedSchedulesByTerm?.[normalizedTerm];
  return Array.isArray(schedules) ? schedules : [];
}

// Reads and clamps the active page number for one term.
function getCurrentIndexForTerm(term = TERMS[0]) {
  const normalizedTerm = normalizeTermValue(term, TERMS[0]);
  const rawIndex = state.currentIndexesByTerm?.[normalizedTerm];
  const maxIndex = Math.max(0, getSortedSchedulesForTerm(normalizedTerm).length - 1);

  if (!Number.isInteger(rawIndex)) {
    return 0;
  }

  return Math.min(Math.max(rawIndex, 0), maxIndex);
}

// Stores a safe page number for one term.
function setCurrentIndexForTerm(term = TERMS[0], nextIndex = 0) {
  const normalizedTerm = normalizeTermValue(term, TERMS[0]);
  const schedules = getSortedSchedulesForTerm(normalizedTerm);
  const maxIndex = Math.max(0, schedules.length - 1);
  const safeIndex = schedules.length
    ? Math.min(Math.max(Math.floor(Number(nextIndex) || 0), 0), maxIndex)
    : 0;

  if (!state.currentIndexesByTerm || typeof state.currentIndexesByTerm !== 'object') {
    state.currentIndexesByTerm = createEmptyTermIndexes();
  }

  state.currentIndexesByTerm[normalizedTerm] = safeIndex;
  return safeIndex;
}

// Returns true when at least one term has generated schedules to show.
function hasAnyGeneratedSchedules() {
  return TERMS.some((term) => getSortedSchedulesForTerm(term).length > 0);
}

// Returns true when two meetings happen in the same term, on the same day, and overlap in time.
function meetingsOverlap(a, b) {
  if (
    normalizeTermValue(a.term, TERMS[0]) !==
    normalizeTermValue(b.term, TERMS[0])
  ) {
    return false;
  }

  if (a.day !== b.day) return false;
  return (
    Math.max(timeToMins(a.start), timeToMins(b.start)) <
    Math.min(timeToMins(a.end), timeToMins(b.end))
  );
}

// Checks that each meeting is complete, ordered correctly, and does not overlap itself.
function validateMeetings(meetings) {
  if (!meetings.length) return false;

  for (const meeting of meetings) {
    if (!meeting.term || !meeting.day || !meeting.start || !meeting.end) {
      return false;
    }
    if (!TERMS.includes(meeting.term)) return false;
    if (timeToMins(meeting.start) >= timeToMins(meeting.end)) return false;
  }

  for (let i = 0; i < meetings.length; i++) {
    for (let j = i + 1; j < meetings.length; j++) {
      if (meetingsOverlap(meetings[i], meetings[j])) return false;
    }
  }

  return true;
}

// Checks whether a section conflicts with meetings that are already selected.
function sectionConflictsWithMeetings(section, selectedMeetings) {
  return section.meetings.some((meeting) =>
    selectedMeetings.some((existing) => meetingsOverlap(meeting, existing)),
  );
}

// Measures how much idle time exists between classes across the week.
function scheduleCompactness(selections) {
  const byDay = Object.fromEntries(DAYS.map((day) => [day, []]));
  selections.forEach((section) => {
    section.meetings.forEach((meeting) => {
      byDay[meeting.day].push(meeting);
    });
  });

  let idle = 0;
  for (const day of DAYS) {
    const meetings = byDay[day]
      .map((meeting) => ({
        start: timeToMins(meeting.start),
        end: timeToMins(meeting.end),
      }))
      .sort((a, b) => a.start - b.start);

    for (let i = 1; i < meetings.length; i++) {
      idle += Math.max(0, meetings[i].start - meetings[i - 1].end);
    }
  }

  return idle;
}

// Builds one term-specific view of the selected sections.
function analyzeTermSchedule(selections, term) {
  const termSelections = [];
  const usedDays = new Set();
  let earliestStart = 24 * 60;
  let latestEnd = 0;

  selections.forEach((section) => {
    const termMeetings = section.meetings
      .filter((meeting) => normalizeTermValue(meeting.term, TERMS[0]) === term)
      .map((meeting) => ({ ...meeting, term }));

    if (!termMeetings.length) return;

    termSelections.push({
      ...clone(section),
      meetings: termMeetings,
    });

    termMeetings.forEach((meeting) => {
      const start = timeToMins(meeting.start);
      const end = timeToMins(meeting.end);
      usedDays.add(meeting.day);
      earliestStart = Math.min(earliestStart, start);
      latestEnd = Math.max(latestEnd, end);
    });
  });

  const hasMeetings = termSelections.length > 0;
  return {
    term,
    hasMeetings,
    selections: termSelections,
    daysCount: usedDays.size,
    earliestStart: hasMeetings ? earliestStart : 0,
    latestEnd: hasMeetings ? latestEnd : 0,
    compactness: hasMeetings ? scheduleCompactness(termSelections) : 0,
  };
}

// Keeps only the meetings that belong to one term, dropping empty sections.
function filterSectionForTerm(section, term) {
  const normalizedTerm = normalizeTermValue(term, TERMS[0]);
  const meetings = section.meetings
    .filter((meeting) => normalizeTermValue(meeting.term, TERMS[0]) === normalizedTerm)
    .map((meeting) => ({ ...clone(meeting), term: normalizedTerm }));

  if (!meetings.length) {
    return null;
  }

  return {
    ...clone(section),
    meetings,
  };
}

// Builds a term-specific course list before generation so each semester is calculated independently.
function buildCoursesForTerm(courses, term) {
  const normalizedTerm = normalizeTermValue(term, TERMS[0]);

  return courses
    .map((course) => {
      const sections = course.sections
        .map((section) => filterSectionForTerm(section, normalizedTerm))
        .filter(Boolean);

      if (!sections.length) {
        return null;
      }

      return {
        ...course,
        sections,
      };
    })
    .filter(Boolean);
}

// Generates every conflict-free timetable combination for one term only.
function generateSchedulesForTerm(term, courses = []) {
  const normalizedTerm = normalizeTermValue(term, TERMS[0]);
  const termCourses = buildCoursesForTerm(courses, normalizedTerm);

  if (!termCourses.length) {
    return [];
  }

  const results = [];

  function walkCourses(courseIndex, selectedSections, selectedMeetings) {
    if (courseIndex === termCourses.length) {
      const analyzedSchedule = analyzeTermSchedule(clone(selectedSections), normalizedTerm);
      if (analyzedSchedule.hasMeetings) {
        results.push(analyzedSchedule);
      }
      return;
    }

    const course = termCourses[courseIndex];
    const grouped = groupSectionsByType(course.sections);
    const sectionTypes = Object.keys(grouped);

    function chooseOnePerType(typeIndex, chosenForCourse, courseMeetings) {
      if (typeIndex === sectionTypes.length) {
        walkCourses(
          courseIndex + 1,
          [...selectedSections, ...chosenForCourse],
          [...selectedMeetings, ...courseMeetings],
        );
        return;
      }

      const candidates = grouped[sectionTypes[typeIndex]];

      for (const section of candidates) {
        const meetingsInPlay = [...selectedMeetings, ...courseMeetings];
        if (sectionConflictsWithMeetings(section, meetingsInPlay)) continue;

        chooseOnePerType(
          typeIndex + 1,
          [
            ...chosenForCourse,
            {
              ...clone(section),
              courseCode: course.code,
              colorName: getCourseColorName(course),
            },
          ],
          [...courseMeetings, ...clone(section.meetings)],
        );
      }
    }

    chooseOnePerType(0, [], []);
  }

  walkCourses(0, [], []);
  return results;
}

// Sorts the generated schedules for one term according to the current dropdown choice.
function sortSchedulesForTerm(term = TERMS[0]) {
  const normalizedTerm = normalizeTermValue(term, TERMS[0]);
  const sorted = [...getGeneratedSchedulesForTerm(normalizedTerm)];

  if (state.sortBy === 'fewer-days') {
    sorted.sort(
      (a, b) =>
        a.daysCount - b.daysCount || a.earliestStart - b.earliestStart,
    );
  } else if (state.sortBy === 'earliest-finish') {
    sorted.sort(
      (a, b) =>
        a.latestEnd - b.latestEnd || a.daysCount - b.daysCount,
    );
  } else if (state.sortBy === 'latest-start') {
    sorted.sort(
      (a, b) =>
        b.earliestStart - a.earliestStart || a.daysCount - b.daysCount,
    );
  } else if (state.sortBy === 'compact') {
    sorted.sort(
      (a, b) =>
        a.compactness - b.compactness || a.daysCount - b.daysCount,
    );
  }

  state.sortedSchedulesByTerm[normalizedTerm] = sorted;
  setCurrentIndexForTerm(normalizedTerm, 0);
}

// Sorts every term's generated schedules independently.
function sortSchedules() {
  state.sortedSchedulesByTerm = createEmptyScheduleBuckets();
  state.currentIndexesByTerm = createEmptyTermIndexes();

  TERMS.forEach((term) => {
    sortSchedulesForTerm(term);
  });
}
