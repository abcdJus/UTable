// Boots the page by loading saved data, preparing state, and rendering the UI.
async function init() {
  const storedSnapshot = readStoredSnapshot();
  const initialSchool = normalizeSchoolValue(storedSnapshot?.activeSchool);
  const stored = await loadState(initialSchool);

  renderGridBackground();
  applyLoadedTimetableState(stored || { activeSchool: initialSchool });
}

init();
