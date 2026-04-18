// Boots the page by loading saved data, preparing state, and rendering the UI.
async function init() {
  const stored = await loadState();
  if (authRedirectInProgress) return;

  state = {
    courses: stored ? normalizeCourses(stored.courses) : [],
    generatedSchedulesByTerm: createEmptyScheduleBuckets(),
    sortedSchedulesByTerm: createEmptyScheduleBuckets(),
    currentIndexesByTerm: createEmptyTermIndexes(),
    hasGenerated: false,
    activeTerm: normalizeTermValue(stored?.activeTerm, TERMS[0]),
    sortBy: stored?.sortBy || 'default',
  };

  DOM.sortSelect.value = state.sortBy;
  renderGridBackground();
  renderCourses();
  updateMainView();

  try {
    writeLocalState(state.courses, state.sortBy, state.activeTerm);
  } catch {
    // Ignore storage failures
  }
}

init();
