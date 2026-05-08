const editor = document.getElementById('editor');
const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');

let currentRevision = -1;
let isApplyingRemote = false;
let saveTimer = null;
let localEditVersion = 0;
let saveInFlight = false;
let queuedSave = false;

function setStatus(text) {
  statusEl.textContent = text;
}

function unlockEditor() {
  editor.readOnly = false;
}

function setMeta(updatedAt) {
  if (!updatedAt) {
    metaEl.textContent = 'Auto-clear after inactivity';
    return;
  }
  const date = new Date(updatedAt);
  metaEl.textContent = `Last change ${date.toLocaleString()}`;
}

async function loadPaste() {
  const response = await fetch('/api/paste', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('load failed');
  }
  const snapshot = await response.json();
  applySnapshot(snapshot, false, true);
}

function scheduleQueuedSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    savePaste().catch(() => setStatus('Save failed'));
  }, 350);
}

function applySnapshot(snapshot, markRemote = true, force = false) {
  if (!force && snapshot.revision <= currentRevision) {
    return;
  }
  currentRevision = snapshot.revision;
  isApplyingRemote = true;
  editor.value = snapshot.content || '';
  isApplyingRemote = false;
  setMeta(snapshot.updatedAt);
  if (markRemote) {
    setStatus('Synced');
  }
}

async function savePaste() {
  if (saveInFlight) {
    queuedSave = true;
    return;
  }

  saveInFlight = true;
  queuedSave = false;
  const submittedEditVersion = localEditVersion;
  const submittedContent = editor.value;
  setStatus('Saving');

  try {
    const response = await fetch('/api/paste', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: submittedContent })
    });
    if (!response.ok) {
      throw new Error('save failed');
    }

    const snapshot = await response.json();
    const hasNewLocalEdits = localEditVersion !== submittedEditVersion;

    if (hasNewLocalEdits) {
      if (snapshot.revision >= currentRevision) {
        setMeta(snapshot.updatedAt);
      }
      currentRevision = Math.max(currentRevision, snapshot.revision);
    } else if (snapshot.revision > currentRevision) {
      applySnapshot(snapshot, false, true);
    } else if (snapshot.revision === currentRevision) {
      setMeta(snapshot.updatedAt);
    }

    setStatus(hasNewLocalEdits ? 'Editing' : 'Saved');
    queuedSave = queuedSave || hasNewLocalEdits;
  } catch {
    setStatus('Save failed');
  } finally {
    saveInFlight = false;
    if (queuedSave) {
      queuedSave = false;
      scheduleQueuedSave();
    }
  }
}

function scheduleSave() {
  if (isApplyingRemote) {
    return;
  }
  setStatus('Editing');
  scheduleQueuedSave();
}

function connectEvents() {
  const events = new EventSource('/api/events');

  events.addEventListener('open', () => setStatus('Connected'));
  events.addEventListener('error', () => setStatus('Reconnecting'));
  events.addEventListener('paste', (event) => {
    const snapshot = JSON.parse(event.data);
    const shouldReplace = snapshot.revision > currentRevision && snapshot.content !== editor.value;
    applySnapshot(snapshot, shouldReplace);
  });
}

editor.addEventListener('input', () => {
  localEditVersion += 1;
  scheduleSave();
});

loadPaste()
  .then(() => {
    unlockEditor();
    setStatus('Ready');
    connectEvents();
  })
  .catch(() => {
    unlockEditor();
    setStatus('Load failed');
    connectEvents();
  });
