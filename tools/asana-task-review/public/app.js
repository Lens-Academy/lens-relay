const state = {
  tasks: [],
  filters: { search: '', selection: 'all', fit: 'all', repository: 'all', visual: 'all' },
  pendingSaves: new Map(),
  saveChains: new Map(),
  saveErrors: new Map(),
  dirtyTasks: new Set(),
  activeSaves: 0
};

const reviewToken = new URLSearchParams(window.location.search).get('token') ?? '';

const elements = {
  list: document.querySelector('#task-list'),
  template: document.querySelector('#task-template'),
  empty: document.querySelector('#empty-state'),
  search: document.querySelector('#search'),
  selection: document.querySelector('#selection-filter'),
  fit: document.querySelector('#fit-filter'),
  repository: document.querySelector('#repository-filter'),
  visual: document.querySelector('#visual-filter'),
  selectedCount: document.querySelector('#selected-count'),
  visualCount: document.querySelector('#visual-count'),
  commentCount: document.querySelector('#comment-count'),
  resultCount: document.querySelector('#result-count'),
  saveStatus: document.querySelector('#save-status'),
  sourceNote: document.querySelector('#source-note')
};

const fitLabels = {
  autonomous: 'Autonomous',
  'autonomous-with-validation': 'Human validation',
  'needs-clarification': 'Needs clarification',
  defer: 'Defer'
};

function updateSaveStatus(mode, detail) {
  elements.saveStatus.className = mode === 'error' ? 'is-error' : mode === 'saving' ? 'is-saving' : '';
  elements.saveStatus.textContent = mode === 'error' ? 'Save failed' : mode === 'saving' ? 'Saving…' : 'All marks saved';
  if (detail) elements.sourceNote.textContent = detail;
}

function refreshSaveStatus() {
  if (state.saveErrors.size) {
    updateSaveStatus('error', `${state.saveErrors.size} task${state.saveErrors.size === 1 ? '' : 's'} could not be saved`);
  } else if (state.activeSaves || state.pendingSaves.size) {
    updateSaveStatus('saving');
  } else {
    updateSaveStatus('saved');
  }
}

function taskMatches(task) {
  const query = state.filters.search.toLowerCase().trim();
  if (query && ![task.name, task.description, task.rationale, task.repository, task.verification].join(' ').toLowerCase().includes(query)) return false;
  if (state.filters.fit !== 'all' && task.fit !== state.filters.fit) return false;
  if (state.filters.repository !== 'all' && task.repository !== state.filters.repository) return false;
  if (state.filters.visual === 'visual' && !task.visualValidation) return false;
  if (state.filters.visual === 'automated' && task.visualValidation) return false;
  if (state.filters.selection === 'selected' && !task.review.selected) return false;
  if (state.filters.selection === 'unselected' && task.review.selected) return false;
  if (state.filters.selection === 'recommended' && !task.selected) return false;
  if (state.filters.selection === 'commented' && !task.review.comment.trim()) return false;
  return true;
}

function updateCounts(visible) {
  const selected = state.tasks.filter(task => task.review.selected);
  elements.selectedCount.textContent = selected.length;
  elements.visualCount.textContent = selected.filter(task => task.visualValidation).length;
  elements.commentCount.textContent = state.tasks.filter(task => task.review.comment.trim()).length;
  elements.resultCount.textContent = `${visible.length} of ${state.tasks.length} tasks`;
}

async function performSave(task) {
  const sent = { selected: task.review.selected, comment: task.review.comment };
  state.activeSaves += 1;
  refreshSaveStatus();
  try {
    const response = await fetch(`/api/reviews/${task.gid}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-review-token': reviewToken },
      body: JSON.stringify(sent),
      keepalive: true
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Save failed');
    task.review.updatedAt = result.review.updatedAt;
    state.saveErrors.delete(task.gid);
    if (task.review.selected === sent.selected && task.review.comment === sent.comment) {
      state.dirtyTasks.delete(task.gid);
    }
    return true;
  } catch (error) {
    state.saveErrors.set(task.gid, error.message);
    return false;
  } finally {
    state.activeSaves -= 1;
    refreshSaveStatus();
  }
}

function saveTask(task) {
  state.dirtyTasks.add(task.gid);
  const previous = state.saveChains.get(task.gid) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => performSave(task));
  state.saveChains.set(task.gid, next);
  next.finally(() => {
    if (state.saveChains.get(task.gid) === next) state.saveChains.delete(task.gid);
  });
  return next;
}

function queueCommentSave(task) {
  clearTimeout(state.pendingSaves.get(task.gid));
  state.pendingSaves.set(task.gid, setTimeout(() => {
    state.pendingSaves.delete(task.gid);
    saveTask(task);
  }, 550));
  refreshSaveStatus();
}

function renderCard(task, index) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector('.task-card');
  const checkbox = fragment.querySelector('.task-select');
  const comment = fragment.querySelector('.task-comment');
  const fit = fragment.querySelector('.fit-badge');

  card.dataset.gid = task.gid;
  card.classList.toggle('is-selected', task.review.selected);
  fragment.querySelector('.task-number').textContent = `${task.section} · ${String(index + 1).padStart(2, '0')}`;
  checkbox.checked = task.review.selected;
  checkbox.setAttribute('aria-label', `Select ${task.name}`);
  fit.textContent = fitLabels[task.fit] ?? task.fit;
  fit.dataset.fit = task.fit;
  fragment.querySelector('.size-badge').textContent = `${task.size} · ${task.confidence} confidence`;
  const visual = fragment.querySelector('.visual-badge');
  visual.hidden = !task.visualValidation;
  fragment.querySelector('.delivery-badge').textContent = task.delivery === 'staging-eligible' ? 'Staging eligible' : 'PR only';
  fragment.querySelector('.repository').textContent = task.repository;
  fragment.querySelector('.task-name').textContent = task.name;
  fragment.querySelector('.task-description').textContent = task.description || 'No description supplied in Asana.';
  fragment.querySelector('.rationale').textContent = task.rationale;
  fragment.querySelector('.verification').textContent = task.verification;
  comment.value = task.review.comment;
  const link = fragment.querySelector('.asana-link');
  link.href = task.url;
  link.setAttribute('aria-label', `Open ${task.name} in Asana`);

  checkbox.addEventListener('change', () => {
    task.review.selected = checkbox.checked;
    card.classList.toggle('is-selected', checkbox.checked);
    updateCounts(state.tasks.filter(taskMatches));
    saveTask(task);
  });
  comment.addEventListener('input', () => {
    task.review.comment = comment.value;
    updateCounts(state.tasks.filter(taskMatches));
    queueCommentSave(task);
  });
  comment.addEventListener('blur', () => {
    const timer = state.pendingSaves.get(task.gid);
    if (!timer) return;
    clearTimeout(timer);
    state.pendingSaves.delete(task.gid);
    saveTask(task);
  });
  return fragment;
}

function render() {
  const visible = state.tasks.filter(taskMatches);
  elements.list.replaceChildren(...visible.map(renderCard));
  elements.empty.hidden = visible.length > 0;
  updateCounts(visible);
}

async function updateVisibleSelections(selector) {
  const visible = state.tasks.filter(taskMatches);
  for (const task of visible) task.review.selected = selector(task);
  render();
  await Promise.all(visible.map(saveTask));
  refreshSaveStatus();
}

function initializeFilters() {
  const repositories = [...new Set(state.tasks.map(task => task.repository))].sort();
  for (const repository of repositories) {
    const option = document.createElement('option');
    option.value = repository;
    option.textContent = repository;
    elements.repository.append(option);
  }
  elements.search.addEventListener('input', () => { state.filters.search = elements.search.value; render(); });
  elements.selection.addEventListener('change', () => { state.filters.selection = elements.selection.value; render(); });
  elements.fit.addEventListener('change', () => { state.filters.fit = elements.fit.value; render(); });
  elements.repository.addEventListener('change', () => { state.filters.repository = elements.repository.value; render(); });
  elements.visual.addEventListener('change', () => { state.filters.visual = elements.visual.value; render(); });
  document.querySelector('#apply-recommendations').addEventListener('click', () => updateVisibleSelections(task => task.selected));
  document.querySelector('#clear-selection').addEventListener('click', () => updateVisibleSelections(() => false));
}

async function boot() {
  try {
    const response = await fetch('/api/tasks', { headers: { 'x-review-token': reviewToken } });
    const snapshot = await response.json();
    if (!response.ok) throw new Error(snapshot.error || 'Unable to load tasks');
    state.tasks = snapshot.tasks;
    elements.sourceNote.textContent = `${snapshot.source} · snapshot ${new Date(snapshot.generatedAt).toLocaleDateString()}`;
    initializeFilters();
    render();
    updateSaveStatus('saved');
  } catch (error) {
    updateSaveStatus('error', error.message);
    elements.empty.hidden = false;
    elements.empty.querySelector('h2').textContent = 'The ledger could not be loaded.';
    elements.empty.querySelector('p').textContent = error.message;
  }
}

window.addEventListener('pagehide', () => {
  for (const timer of state.pendingSaves.values()) clearTimeout(timer);
  for (const gid of state.dirtyTasks) {
    const task = state.tasks.find(candidate => candidate.gid === gid);
    if (!task) continue;
    fetch(`/api/reviews/${gid}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-review-token': reviewToken },
      body: JSON.stringify({ selected: task.review.selected, comment: task.review.comment }),
      keepalive: true
    });
  }
  state.pendingSaves.clear();
});

boot();
