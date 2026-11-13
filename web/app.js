const editor = document.getElementById('editor');
const statusEl = document.getElementById('status');
const copyButton = document.getElementById('copyButton');
const clearButton = document.getElementById('clearButton');


let currentRevision = -1;
let currentGeneration = null;
let syncEpoch = 0;
let events = null;
let saveTimer = null;
let retryTimer = null;
let localEditVersion = 0;
let saveInFlight = false;
let dirty = false;
let queuedSave = false;
let pendingRemoteSnapshot = null;

function setStatus(text, state = 'idle') {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function guardUnsavedChanges(event) {
  event.preventDefault();
  event.returnValue = true;
}

function updateNavigationGuard() {
  if (dirty || saveInFlight) {
    window.addEventListener('beforeunload', guardUnsavedChanges);
  } else {
    window.removeEventListener('beforeunload', guardUnsavedChanges);
  }
}

function setDirty(value) {
  dirty = value;
  updateNavigationGuard();
}

function unlockEditor() {
  editor.readOnly = false;
}

function updateContentButtons() {
  const isEmpty = editor.value.length === 0;
  copyButton.disabled = isEmpty || !canCopy();
  clearButton.disabled = isEmpty;
}

function setEditorValue(content) {
  editor.value = content;
  updateContentButtons();
}

function canCopy() {
  return window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText;
}



async function loadPaste() {
  const epoch = syncEpoch;
  const response = await fetch('/api/paste', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('load failed');
  }
  const snapshot = await response.json();
  if (acceptGeneration(snapshot, epoch)) {
    applySnapshot(snapshot, false);
  }
}

function acceptGeneration(snapshot, epoch) {
  if (epoch !== syncEpoch) {
    return false;
  }
  if (snapshot.generation !== currentGeneration) {
    currentGeneration = snapshot.generation;
    currentRevision = -1;
    pendingRemoteSnapshot = null;
    syncEpoch += 1;
    // Fence queued callbacks from the previous server's event stream.
    if (events) {
      connectEvents();
    }
  }
  return true;
}

function scheduleQueuedSave(delay = 350) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    savePaste().catch(() => markSaveFailed());
  }, delay);
}

function scheduleRetry(delay = 1500) {
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    if (dirty) {
      setStatus('Retrying', 'saving');
      savePaste().catch(() => markSaveFailed());
    }
  }, delay);
}

function applySnapshot(snapshot, markRemote = true) {
  if (snapshot.revision <= currentRevision) {
    return;
  }
  currentRevision = snapshot.revision;
  setEditorValue(snapshot.content || '');
  setDirty(false);
  pendingRemoteSnapshot = null;
  if (markRemote) {
    setStatus('Synced', 'saved');
  }
}

function applyPendingRemoteIfIdle() {
  if (!dirty && !saveInFlight && pendingRemoteSnapshot) {
    const snapshot = pendingRemoteSnapshot;
    pendingRemoteSnapshot = null;
    applySnapshot(snapshot, true);
  }
}

function markSaveFailed() {
  setDirty(true);
  if (!navigator.onLine) {
    setStatus('Offline', 'error');
    return;
  }
  setStatus('Unsaved', 'error');
  scheduleRetry();
}

async function savePaste() {
  if (saveInFlight) {
    queuedSave = true;
    return;
  }

  saveInFlight = true;
  updateNavigationGuard();
  queuedSave = false;
  const submittedEditVersion = localEditVersion;
  const submittedContent = editor.value;
  const epoch = syncEpoch;
  setStatus('Saving', 'saving');

  try {
    const response = await fetch('/api/paste', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: submittedContent })
    });

    if (response.status === 413) {
      setDirty(true);
      setStatus('Too large', 'error');
      return;
    }
    if (!response.ok) {
      throw new Error('save failed');
    }

    const snapshot = await response.json();
    // SSE may have already announced the generation reached by this PUT.
    if (snapshot.generation !== currentGeneration && !acceptGeneration(snapshot, epoch)) {
      setDirty(true);
      queuedSave = true;
      setStatus('Unsaved', 'dirty');
      return;
    }
    const hasNewLocalEdits = localEditVersion !== submittedEditVersion;

    currentRevision = Math.max(currentRevision, snapshot.revision);
    queuedSave = hasNewLocalEdits;

    if (hasNewLocalEdits) {
      setDirty(true);
      setStatus('Unsaved', 'dirty');
    } else {
      setDirty(false);
      setStatus('Saved', 'saved');
    }
  } catch {
    markSaveFailed();
  } finally {
    saveInFlight = false;
    updateNavigationGuard();
    if (queuedSave) {
      queuedSave = false;
      scheduleQueuedSave();
    } else {
      // Remote updates received during the PUT can only apply after saveInFlight is cleared.
      applyPendingRemoteIfIdle();
    }
  }
}

function scheduleSave() {
  setDirty(true);
  window.clearTimeout(retryTimer);

  setStatus(pendingRemoteSnapshot ? 'Remote update pending' : 'Unsaved', 'dirty');
  scheduleQueuedSave();
}

function connectEvents() {
  if (events) {
    events.close();
  }
  const source = new EventSource('/api/events');
  const epoch = syncEpoch;
  events = source;

  source.addEventListener('open', () => {
    if (epoch !== syncEpoch) {
      return;
    }
    if (dirty) {
      setStatus(pendingRemoteSnapshot ? 'Remote update pending' : 'Unsaved', 'dirty');
    } else {
      setStatus('Connected', 'saved');
    }
  });

  source.addEventListener('error', () => {
    if (epoch !== syncEpoch) {
      return;
    }
    setStatus(dirty ? 'Offline' : 'Reconnecting', dirty ? 'error' : 'saving');
  });

  source.addEventListener('paste', (event) => {
    const snapshot = JSON.parse(event.data);
    if (!acceptGeneration(snapshot, epoch)) {
      return;
    }
    if (snapshot.revision <= currentRevision) {
      return;
    }
    if (dirty || saveInFlight) {
      pendingRemoteSnapshot = snapshot;
      setStatus('Remote update pending', 'dirty');
      return;
    }
    if (snapshot.content !== editor.value) {
      applySnapshot(snapshot, true);
      return;
    }
    currentRevision = snapshot.revision;
  });
}

editor.addEventListener('input', () => {
  localEditVersion += 1;
  updateContentButtons();
  scheduleSave();
});

copyButton.addEventListener('click', async () => {
  if (!canCopy()) {
    setStatus('Copy blocked', 'error');
    return;
  }

  try {
    await navigator.clipboard.writeText(editor.value);
    setStatus('Copied', dirty ? 'dirty' : 'saved');
  } catch {
    setStatus('Copy blocked', 'error');
  }
});

clearButton.addEventListener('click', () => {
  if (editor.value.length === 0) {
    return;
  }

  setEditorValue('');
  localEditVersion += 1;
  scheduleSave();
  editor.focus();
});

updateContentButtons();

window.addEventListener('online', () => {
  if (dirty) {
    setStatus('Retrying', 'saving');
    scheduleQueuedSave(0);
  }
});

window.addEventListener('offline', () => {
  if (dirty) {
    setStatus('Offline', 'error');
  }
});

loadPaste()
  .then(() => {
    unlockEditor();
    setStatus('Ready', 'idle');
    connectEvents();
  })
  .catch(() => {
    unlockEditor();
    setStatus('Load failed', 'error');
    connectEvents();
  });
