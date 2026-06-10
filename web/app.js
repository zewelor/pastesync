const editor = document.getElementById('editor');
const statusEl = document.getElementById('status');
const copyButton = document.getElementById('copyButton');
const clearButton = document.getElementById('clearButton');

const encoder = new TextEncoder();

let config = {
  maxBodyBytes: 262144
};
let currentRevision = -1;
let isApplyingRemote = false;
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

function unlockEditor() {
  editor.readOnly = false;
}

function updateContentButtons() {
  const isEmpty = editor.value.length === 0;
  copyButton.disabled = isEmpty || !canCopy();
  clearButton.disabled = isEmpty;
}

function setEditorValue(content) {
  isApplyingRemote = true;
  editor.value = content;
  isApplyingRemote = false;
  updateContentButtons();
}

function canCopy() {
  return window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText;
}

function bodyBytes(content) {
  return encoder.encode(JSON.stringify({ content })).length;
}

function isTooLarge(content) {
  return bodyBytes(content) > config.maxBodyBytes;
}

async function loadConfig() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('config load failed');
  }
  config = await response.json();
}

async function loadPaste() {
  const response = await fetch('/api/paste', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('load failed');
  }
  const snapshot = await response.json();
  applySnapshot(snapshot, false, true);
}

function clearTimers() {
  window.clearTimeout(saveTimer);
  window.clearTimeout(retryTimer);
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
    if (dirty && !isTooLarge(editor.value)) {
      setStatus('Retrying', 'saving');
      savePaste().catch(() => markSaveFailed());
    }
  }, delay);
}

function applySnapshot(snapshot, markRemote = true, force = false) {
  if (!force && snapshot.revision <= currentRevision) {
    return;
  }
  currentRevision = snapshot.revision;
  setEditorValue(snapshot.content || '');
  dirty = false;
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
  dirty = true;
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

  if (isTooLarge(editor.value)) {
    dirty = true;
    setStatus('Too large', 'error');
    return;
  }

  saveInFlight = true;
  queuedSave = false;
  const submittedEditVersion = localEditVersion;
  const submittedContent = editor.value;
  setStatus('Saving', 'saving');

  try {
    const response = await fetch('/api/paste', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: submittedContent })
    });

    if (response.status === 413) {
      dirty = true;
      setStatus('Too large', 'error');
      return;
    }
    if (!response.ok) {
      throw new Error('save failed');
    }

    const snapshot = await response.json();
    const hasNewLocalEdits = localEditVersion !== submittedEditVersion;

    currentRevision = Math.max(currentRevision, snapshot.revision);

    if (hasNewLocalEdits) {
      dirty = true;
      queuedSave = true;
      setStatus('Unsaved', 'dirty');
    } else {
      dirty = false;
      setStatus('Saved', 'saved');
    }
  } catch {
    markSaveFailed();
  } finally {
    saveInFlight = false;
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
  if (isApplyingRemote) {
    return;
  }
  dirty = true;
  window.clearTimeout(retryTimer);

  if (isTooLarge(editor.value)) {
    window.clearTimeout(saveTimer);
    setStatus('Too large', 'error');
    return;
  }

  setStatus(pendingRemoteSnapshot ? 'Remote update pending' : 'Unsaved', 'dirty');
  scheduleQueuedSave();
}

function connectEvents() {
  const events = new EventSource('/api/events');

  events.addEventListener('open', () => {
    if (dirty) {
      setStatus(pendingRemoteSnapshot ? 'Remote update pending' : 'Unsaved', 'dirty');
    } else {
      setStatus('Connected', 'saved');
    }
  });

  events.addEventListener('error', () => {
    setStatus(dirty ? 'Offline' : 'Reconnecting', dirty ? 'error' : 'saving');
  });

  events.addEventListener('paste', (event) => {
    const snapshot = JSON.parse(event.data);
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
  if (dirty && !isTooLarge(editor.value)) {
    setStatus('Retrying', 'saving');
    scheduleQueuedSave(0);
  }
});

window.addEventListener('offline', () => {
  if (dirty) {
    setStatus('Offline', 'error');
  }
});

Promise.allSettled([loadConfig(), loadPaste()])
  .then((results) => {
    unlockEditor();
    const failed = results.some((result) => result.status === 'rejected');
    setStatus(failed ? 'Load failed' : 'Ready', failed ? 'error' : 'idle');
    connectEvents();
  })
  .catch(() => {
    unlockEditor();
    setStatus('Load failed', 'error');
    connectEvents();
  });

window.addEventListener('beforeunload', () => {
  clearTimers();
  if (dirty && !isTooLarge(editor.value)) {
    fetch('/api/paste', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editor.value }),
      keepalive: true
    }).catch(() => {});
  }
});
