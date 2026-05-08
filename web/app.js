const editor = document.getElementById('editor');
const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');

const encoder = new TextEncoder();

let config = {
  maxBodyBytes: 262144,
  ttlSeconds: 86400
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

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTTL(seconds) {
  if (!seconds || seconds <= 0) {
    return 'no auto-clear';
  }
  if (seconds % 86400 === 0) {
    const days = seconds / 86400;
    return `${days}d auto-clear`;
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours}h auto-clear`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes}m auto-clear`;
  }
  return `${seconds}s auto-clear`;
}

function bodyBytes(content) {
  return encoder.encode(JSON.stringify({ content })).length;
}

function isTooLarge(content) {
  return bodyBytes(content) > config.maxBodyBytes;
}

function updateMeta() {
  const limit = formatBytes(config.maxBodyBytes);
  const ttl = formatTTL(config.ttlSeconds);

  metaEl.textContent = `${ttl} - ${limit} limit`;
}

async function loadConfig() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('config load failed');
  }
  config = await response.json();
  updateMeta();
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
  isApplyingRemote = true;
  editor.value = snapshot.content || '';
  isApplyingRemote = false;
  dirty = false;
  pendingRemoteSnapshot = null;
  updateMeta();
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
    updateMeta();

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
    updateMeta();
  });
}

editor.addEventListener('input', () => {
  localEditVersion += 1;
  scheduleSave();
});

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
