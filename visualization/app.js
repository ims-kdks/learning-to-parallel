const TABLE_COLUMNS = 16;
const TOKEN_FONT_SIZE = 14;
const RENDER_DEBOUNCE_MS = 120;

const scriptElement = typeof document !== 'undefined' ? document.currentScript : null;
const scriptDataset = scriptElement?.dataset ?? {};
const BASE_PATH = sanitizeBasePath(scriptDataset.basePath || '');
const MANIFEST_PATH = scriptDataset.manifestPath?.trim()
  || resolveAssetPath('data/manifest.json');

const elements = {
  play: document.getElementById('play'),
  pause: document.getElementById('pause'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  stepNum: document.getElementById('stepNum'),
  total: document.getElementById('total'),
  question: document.getElementById('question'),
  speedInput: document.getElementById('speed'),
  speedLabel: document.getElementById('speedLabel'),
  tablesContainer: document.getElementById('tables-container'),
};

const state = {
  csvFiles: [],
  tables: [],
  renderedTables: [],
  step: 0,
  timerId: null,
  doneSteps: new Map(),
};

let resizeTimerId = null;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function init() {
  attachEventHandlers();
  applyTokenFontSize();
  updateSpeedLabel(elements.speedInput.value);
  loadAllCSVs();
}

function attachEventHandlers() {
  elements.play.addEventListener('click', startPlayback);
  elements.pause.addEventListener('click', stopPlayback);
  elements.prev.addEventListener('click', stepPrevious);
  elements.next.addEventListener('click', stepNext);
  elements.speedInput.addEventListener('input', handleSpeedInput);
  window.addEventListener('resize', handleResize);
}

function handleSpeedInput(event) {
  updateSpeedLabel(event.target.value);
  if (isPlaying()) {
    stopPlayback();
    startPlayback();
  }
}

function updateSpeedLabel(value) {
  elements.speedLabel.textContent = `${value}ms`;
  updateAnimationDurations(value);
}

function applyTokenFontSize() {
  if (elements.tablesContainer) {
    elements.tablesContainer.style.setProperty('--token-font-size', `${TOKEN_FONT_SIZE}px`);
  }
}

function setQuestion(text) {
  if (elements.question) {
    elements.question.textContent = text;
  }
}

function updateAnimationDurations(value) {
  const duration = Number(value);
  const fadeInSeconds = Math.max(duration / 1000, 0.05);

  const root = document.documentElement;
  if (root) {
    root.style.setProperty('--fade-in-duration', `${fadeInSeconds}s`);
  }
}

async function loadAllCSVs() {
  stopPlayback();
  state.doneSteps.clear();
  state.step = 0;
  state.tables = [];
  state.renderedTables = [];
  elements.tablesContainer.replaceChildren();

  state.csvFiles = await listCsvFiles();
  const tables = await Promise.all(
    state.csvFiles.map(async metadata => {
      const table = await loadCsv(metadata.path);
      return table ? { ...table, title: metadata.title } : null;
    })
  );
  state.tables = tables.filter(Boolean);

  setStep(0);
}

async function listCsvFiles() {
  try {
    const response = await fetch(MANIFEST_PATH);
    const manifest = await response.json();
    if (manifest && typeof manifest.question === 'string') {
      setQuestion(manifest.question);
    } else {
      setQuestion('Question unavailable.');
    }
    if (!manifest || !Array.isArray(manifest.files)) {
      throw new Error('Manifest is missing a "files" array.');
    }
    const entries = manifest.files
      .map(fileEntry => normalizeManifestEntry(fileEntry))
      .filter(Boolean);
    if (!entries.length) {
      throw new Error('Manifest did not contain any valid file entries.');
    }
    return entries;
  } catch (error) {
    console.warn('Using default CSV list; manifest unavailable or invalid.', error);
    throw error;
  }
}

function normalizeManifestEntry(entry) {
  if (typeof entry === 'string') {
    return buildManifestMetadata(entry, null);
  }
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const fileName = typeof entry.file_name === 'string' ? entry.file_name : null;
  const title = typeof entry.title === 'string' ? entry.title : null;
  if (!fileName) {
    return null;
  }
  return buildManifestMetadata(fileName, title);
}

function buildManifestMetadata(fileName, title) {
  const trimmed = fileName.trim();
  if (!trimmed.endsWith('.csv')) {
    return null;
  }
  const relativePath = trimmed.startsWith('data/') ? trimmed : `data/${trimmed}`;
  const path = resolveAssetPath(relativePath);
  const fallbackTitle = extractFilename(trimmed);
  const displayTitle = title && title.trim().length ? title.trim() : fallbackTitle;
  return { path, title: displayTitle };
}

async function loadCsv(path) {
  try {
    const response = await fetch(path);
    const text = await response.text();
    const rows = parseCsv(text);
    return { file: path, rows };
  } catch (error) {
    console.warn('Failed to load CSV', path, error);
    return null;
  }
}

function parseCsv(text) {
  const parsed = Papa.parse(text.trim(), { delimiter: ',', skipEmptyLines: true });
  return parsed.data
    .map(normalizeRow)
    .filter(row => row.length > 0);
}

function normalizeRow(fields) {
  const tokens = Array.isArray(fields) ? fields : [fields];
  const normalized = tokens.map(normalizeToken);
  const hasContent = normalized.some(token => token !== null);
  return hasContent ? normalized.map(token => token ?? '') : [];
}

function normalizeToken(token) {
  if (token === null || token === undefined) {
    return null;
  }
  return String(token)
    .replace(/<\|endoftext\|>/g, '[EoT]')
    .replace(/<\|eot_id\|>/g, '[eot]')
    .replace(/<\|mdm_mask\|>/g, '[MASK]');
}

function handleResize() {
  if (resizeTimerId) {
    window.clearTimeout(resizeTimerId);
  }
  resizeTimerId = window.setTimeout(() => {
    renderStep();
    resizeTimerId = null;
  }, RENDER_DEBOUNCE_MS);
}

function currentSpeed() {
  const value = Number(elements.speedInput.value);
  return Number.isFinite(value) && value > 0 ? value : 500;
}

function isPlaying() {
  return state.timerId !== null;
}

function startPlayback() {
  if (isPlaying() || state.tables.length === 0) {
    return;
  }
  state.timerId = window.setInterval(stepNext, currentSpeed());
  updateControls();
}

function stopPlayback() {
  if (!isPlaying()) {
    return;
  }
  window.clearInterval(state.timerId);
  state.timerId = null;
  updateControls();
}

function stepNext() {
  if (state.tables.length === 0) {
    return;
  }
  const lastIndex = computeLastStepIndex();
  if (state.step < lastIndex) {
    setStep(state.step + 1);
  } else {
    setStep(lastIndex);
    stopPlayback();
  }
}

function stepPrevious() {
  if (state.tables.length === 0) {
    return;
  }
  if (state.step > 0) {
    setStep(state.step - 1);
  }
}

function setStep(nextStep) {
  state.step = clampStep(nextStep);
  renderStep();
}

function clampStep(step) {
  if (!Number.isFinite(step)) {
    return 0;
  }
  const lastIndex = computeLastStepIndex();
  const upperBound = Math.max(lastIndex, 0);
  return Math.min(Math.max(step, 0), upperBound);
}

function renderStep() {
  const lastIndex = computeLastStepIndex();
  elements.total.textContent = lastIndex;
  elements.stepNum.textContent = Math.min(state.step, lastIndex);

  ensureRenderedTables();
  state.renderedTables.forEach(updateRenderedTable);

  updateControls();
}

function ensureRenderedTables() {
  if (state.renderedTables.length || state.tables.length === 0) {
    return;
  }

  state.renderedTables = state.tables.map(createRenderedTable);
  const blocks = state.renderedTables.map(entry => entry.block);
  elements.tablesContainer.replaceChildren(...blocks);
}

function createRenderedTable(table) {
  const { file, rows, title: tableTitle } = table;
  const block = document.createElement('div');
  block.className = 'table-block';

  const header = document.createElement('div');
  header.className = 'table-header';

  const titleElement = document.createElement('span');
  titleElement.textContent = tableTitle || extractFilename(file);
  header.appendChild(titleElement);

  const badge = document.createElement('span');
  badge.className = 'done-badge';
  badge.style.display = 'none';
  header.appendChild(badge);

  block.appendChild(header);

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'table-empty';
    empty.textContent = 'No data in this CSV.';
    block.appendChild(empty);
    return { file, rows, title: tableTitle, block, header, badge, cells: [] };
  }

  const columns = Math.max(1, Math.floor(TABLE_COLUMNS));
  const maxTokens = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const totalCells = Math.max(maxTokens, columns);
  const totalRows = Math.ceil(totalCells / columns);

  const tableEl = document.createElement('table');
  tableEl.className = 'token-table';
  tableEl.style.setProperty('--cols', String(columns));

  const tbody = document.createElement('tbody');
  tableEl.appendChild(tbody);

  const cells = [];
  for (let rowIndex = 0; rowIndex < totalRows; rowIndex += 1) {
    const tr = document.createElement('tr');
    for (let colIndex = 0; colIndex < columns; colIndex += 1) {
      const td = document.createElement('td');
      td.className = 'token empty';
      td.innerHTML = '&nbsp;';
      cells.push(td);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  block.appendChild(tableEl);

  return {
    file,
    rows,
    block,
    header,
    badge,
    table: tableEl,
    cells,
    columns,
    title: tableTitle,
  };
}

function updateRenderedTable(entry) {
  const { file, rows, badge, cells, columns } = entry;
  if (!rows.length) {
    badge.style.display = 'none';
    state.doneSteps.delete(file);
    return;
  }

  const lastRow = rows[rows.length - 1] || [];
  const currentRow = rows[state.step] || [];
  const previousRow = state.step > 0 ? rows[state.step - 1] || [] : [];

  if (JSON.stringify(currentRow) === JSON.stringify(lastRow)) {
    if (!state.doneSteps.has(file)) {
      state.doneSteps.set(file, state.step);
    }
    badge.textContent = `Done at step ${state.doneSteps.get(file)}`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
    state.doneSteps.delete(file);
  }

  const totalCells = cells.length;
  const isInitialStep = state.step === 0;

  for (let index = 0; index < totalCells; index += 1) {
    const previousToken = previousRow[index];
    const currentToken = currentRow[index];
    const cell = cells[index];
    if (!cell) {
      continue;
    }
    updateTokenCell(cell, previousToken, currentToken, isInitialStep);
  }

  const relevantLength = Math.max(currentRow.length, previousRow.length, 1);
  const requiredRows = Math.ceil(relevantLength / columns);
  const table = entry.table;
  if (table) {
    table.style.setProperty('--cols', String(columns));
    Array.from(table.tBodies[0]?.rows || []).forEach((tr, idx) => {
      tr.style.display = idx < requiredRows ? '' : 'none';
    });
  }
}

function updateTokenCell(cell, previousToken, currentToken, isInitialStep) {
  const displayToken = currentToken ?? '';
  const previousDisplayToken = previousToken ?? '';
  const isRemovedToken = !isInitialStep && displayToken === '' && previousDisplayToken !== '';
  const isChangedToken = !isInitialStep && !isRemovedToken && previousDisplayToken !== displayToken;

  cell.className = displayToken === '' ? 'token empty' : 'token';

  if (displayToken === '') {
    cell.innerHTML = '&nbsp;';
  } else {
    cell.textContent = displayToken;
  }

  if (isRemovedToken) {
    cell.classList.add('diff-removed', 'token-removed');
  }

  if (isChangedToken) {
    cell.classList.add('diff-added', 'token-changed');
  }

  if (displayToken === '[EoT]' || displayToken == '\\n') {
    cell.classList.add('token-gray-out');
  }
}

function extractFilename(path) {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function computeMaxStepCount() {
  if (!state.tables.length) {
    return 0;
  }
  return Math.max(...state.tables.map(table => table.rows.length));
}

function computeLastStepIndex() {
  const maxCount = computeMaxStepCount();
  return maxCount > 0 ? maxCount - 1 : 0;
}

function updateControls() {
  const hasTables = state.tables.length > 0;
  const lastIndex = computeLastStepIndex();
  const atStart = state.step === 0;
  const atEnd = state.step >= lastIndex;

  elements.prev.disabled = !hasTables || atStart;
  elements.next.disabled = !hasTables || atEnd;
  elements.play.disabled = !hasTables || isPlaying();
  elements.pause.disabled = !hasTables || !isPlaying();
}

function sanitizeBasePath(rawPath) {
  if (!rawPath) {
    return '';
  }
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === '.' || trimmed === './') {
    return '';
  }
  return trimmed.replace(/^[./]+/, '').replace(/\/+$/, '');
}

function resolveAssetPath(path) {
  if (!path) {
    return path;
  }
  if (/^(?:[a-z]+:)?\/\//i.test(path) || path.startsWith('/')) {
    return path;
  }
  const sanitized = path.replace(/^\.\/?/, '');
  if (!BASE_PATH) {
    return sanitized;
  }
  return `${BASE_PATH}/${sanitized}`;
}
