const token = new URLSearchParams(location.search).get('token') ?? '';
const headers = { 'content-type': 'application/json', 'x-validation-token': token };
const humanRoot = document.querySelector('#humanItems');
const automatedRoot = document.querySelector('#automatedItems');
const template = document.querySelector('#cardTemplate');
const saveState = document.querySelector('#saveState');
const local = new Map();
const timers = new Map();

document.querySelector('#stateLink').href = `/api/state.json?token=${encodeURIComponent(token)}`;

function link(label, url) {
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = label; return a;
}

function applyStatus(card, status) {
  card.dataset.status = status;
  card.querySelectorAll('.verdict button').forEach(button => button.classList.toggle('active', button.dataset.status === status));
}

async function persist(item, card) {
  const update = local.get(item.id);
  saveState.textContent = 'Saving…'; card.querySelector('.saved').textContent = 'Saving field notes…';
  try {
    const response = await fetch(`/api/validation/${item.id}`, { method: 'PUT', headers, body: JSON.stringify(update) });
    if (!response.ok) throw new Error(`Save failed (${response.status})`);
    const { validation } = await response.json();
    card.querySelector('.saved').textContent = `Saved ${new Date(validation.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    saveState.textContent = 'All notes saved'; count();
  } catch (error) { saveState.textContent = error.message; card.querySelector('.saved').textContent = 'Not saved—please retry'; }
}

function schedule(item, card, immediate = false) {
  clearTimeout(timers.get(item.id));
  if (immediate) persist(item, card); else timers.set(item.id, setTimeout(() => persist(item, card), 450));
}

function count() {
  const states = [...local.values()].map(v => v.status);
  document.querySelector('#verifiedCount').textContent = states.filter(s => s === 'verified').length;
  document.querySelector('#pendingCount').textContent = states.filter(s => s === 'pending').length;
  document.querySelector('#issueCount').textContent = states.filter(s => s === 'issue').length;
}

function render(item) {
  const card = template.content.firstElementChild.cloneNode(true);
  card.querySelector('.stamp').textContent = item.group === 'human' ? `Field check · PR ${item.pr.number}` : `Evidence logged · PR ${item.pr.number}`;
  const links = card.querySelector('.links'); links.append(link(`PR #${item.pr.number}`, item.pr.url)); item.asana.forEach((task, i) => links.append(link(item.asana.length > 1 ? `ASANA ${i + 1}` : 'ASANA', task.url)));
  card.querySelector('h3').textContent = item.title; card.querySelector('.summary').textContent = item.summary;
  const list = card.querySelector('.instructions'); item.instructions.forEach(text => { const li = document.createElement('li'); li.textContent = text; list.append(li); });
  const validation = { status: item.validation.status, notes: item.validation.notes }; local.set(item.id, validation); applyStatus(card, validation.status);
  const textarea = card.querySelector('textarea'); textarea.value = validation.notes;
  card.querySelectorAll('.verdict button').forEach(button => button.addEventListener('click', () => { validation.status = validation.status === button.dataset.status ? 'pending' : button.dataset.status; applyStatus(card, validation.status); schedule(item, card, true); count(); }));
  textarea.addEventListener('input', () => { validation.notes = textarea.value; card.querySelector('.saved').textContent = 'Writing…'; schedule(item, card); });
  if (item.group === 'automated') card.querySelector('.saved').textContent = 'Automated checks passed';
  else if (item.validation.updatedAt) card.querySelector('.saved').textContent = `Saved ${new Date(item.validation.updatedAt).toLocaleString()}`;
  (item.group === 'human' ? humanRoot : automatedRoot).append(card);
}

try {
  const response = await fetch('/api/validation', { headers });
  if (!response.ok) throw new Error(response.status === 401 ? 'This validation link is missing its session token.' : `Could not open notebook (${response.status}).`);
  const data = await response.json(); data.items.forEach(render); count(); saveState.textContent = 'All notes saved';
} catch (error) { saveState.textContent = error.message; humanRoot.innerHTML = `<p>${error.message}</p>`; }
