const COLORS = ['blue', 'emerald', 'purple', 'amber', 'rose', 'cyan'];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const TERMS = ['Fall', 'Winter', 'Summer'];
const SECTION_TYPES = ['Lecture', 'Tutorial', 'Practical', 'Seminar', 'Lab'];
const GRID_START_HOUR = 8;
const GRID_END_HOUR = 21;
const HOUR_HEIGHT = 64;
const GRID_HEIGHT = (GRID_END_HOUR - GRID_START_HOUR) * HOUR_HEIGHT;
const STORAGE_KEY = 'timetable-builder-upgraded-v1';
const COURSE_SUGGESTION_MIN_CHARS = 2;
const COURSE_SUGGESTION_LIMIT = 100;

const DOM = {
  courseList: document.getElementById('course-list'),
  addCourseForm: document.getElementById('add-course-form'),
  courseCodeInput: document.getElementById('course-code-input'),
  courseSuggestions: document.getElementById('course-suggestions'),
  courseSearchStatus: document.getElementById('course-search-status'),
  courseTermPicker: document.getElementById('course-term-picker'),
  generateBtn: document.getElementById('generate-btn'),
  generateHelp: document.getElementById('generate-help'),
  resetBtn: document.getElementById('reset-btn'),
  emptyState: document.getElementById('empty-state'),
  resultsState: document.getElementById('results-state'),
  gridRows: document.getElementById('grid-rows'),
  gridColumns: document.getElementById('grid-columns'),
  prevBtn: document.getElementById('prev-btn'),
  nextBtn: document.getElementById('next-btn'),
  paginationText: document.getElementById('pagination-text'),
  termTabs: document.getElementById('term-tabs'),
  sortSelect: document.getElementById('sort-select'),
  statDays: document.getElementById('stat-days'),
  statStart: document.getElementById('stat-start'),
  statEnd: document.getElementById('stat-end'),
  scheduleStats: document.getElementById('schedule-stats'),
  errorState: document.getElementById('error-state'),
  termEmptyState: document.getElementById('term-empty-state'),
  paginationControls: document.getElementById('pagination-controls'),
  sortControls: document.getElementById('sort-controls'),
  timetableContainer: document.getElementById('timetable-container'),
  courseCount: document.getElementById('course-count'),
  sectionCount: document.getElementById('section-count'),
  logoutBtn: document.getElementById('logout-btn'),
};

const SAMPLE_COURSES = [
  {
    code: 'CSCA08',
    colorIndex: 0,
    sections: [
      {
        type: 'Lecture',
        label: 'LEC01',
        meetings: [
          { term: 'Fall', day: 'Mon', start: '09:00', end: '11:00' },
          { term: 'Fall', day: 'Wed', start: '09:00', end: '10:00' },
        ],
      },
      {
        type: 'Lecture',
        label: 'LEC02',
        meetings: [
          { term: 'Fall', day: 'Tue', start: '13:00', end: '15:00' },
          { term: 'Fall', day: 'Thu', start: '13:00', end: '14:00' },
        ],
      },
      {
        type: 'Tutorial',
        label: 'TUT01',
        meetings: [{ term: 'Fall', day: 'Fri', start: '10:00', end: '11:00' }],
      },
      {
        type: 'Tutorial',
        label: 'TUT02',
        meetings: [{ term: 'Fall', day: 'Thu', start: '15:00', end: '16:00' }],
      },
    ],
  },
  {
    code: 'MATA31',
    colorIndex: 1,
    sections: [
      {
        type: 'Lecture',
        label: 'LEC01',
        meetings: [
          { term: 'Winter', day: 'Mon', start: '11:00', end: '13:00' },
          { term: 'Winter', day: 'Wed', start: '11:00', end: '12:00' },
        ],
      },
      {
        type: 'Lecture',
        label: 'LEC02',
        meetings: [
          { term: 'Winter', day: 'Tue', start: '09:00', end: '11:00' },
          { term: 'Winter', day: 'Thu', start: '09:00', end: '10:00' },
        ],
      },
      {
        type: 'Practical',
        label: 'PRA01',
        meetings: [{ term: 'Winter', day: 'Fri', start: '09:00', end: '10:00' }],
      },
      {
        type: 'Practical',
        label: 'PRA02',
        meetings: [{ term: 'Winter', day: 'Wed', start: '14:00', end: '15:00' }],
      },
    ],
  },
  {
    code: 'STAB52',
    colorIndex: 2,
    sections: [
      {
        type: 'Lecture',
        label: 'LEC01',
        meetings: [{ term: 'Fall', day: 'Tue', start: '11:00', end: '13:00' }],
      },
      {
        type: 'Lecture',
        label: 'LEC02',
        meetings: [{ term: 'Fall', day: 'Thu', start: '11:00', end: '13:00' }],
      },
      {
        type: 'Tutorial',
        label: 'TUT01',
        meetings: [{ term: 'Fall', day: 'Fri', start: '11:00', end: '12:00' }],
      },
      {
        type: 'Tutorial',
        label: 'TUT02',
        meetings: [{ term: 'Fall', day: 'Wed', start: '15:00', end: '16:00' }],
      },
    ],
  },
];
