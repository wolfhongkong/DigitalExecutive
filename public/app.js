const $ = selector => document.querySelector(selector);
let state;
let memoryContext;
let memoryState;
let memoryDocuments = [];
let memorySupersedes;
let chatMemoryState;
let profileId = 'alex';
let executiveId = 'alex-executive';
let executiveEditId;
let mode = 'public';
let conversationId;
let projectId;
let conversations = [];
let projects = [];
let navigationVersion = 0;
let knowledgeDocuments = [];
let knowledgeCategory = 'all';
let knowledgeRefreshId = 0;
const knowledgeTypes = [
  { id: 'mails', label: 'Mails', icon: 'Mail' },
  { id: 'videos', label: 'Videos', icon: 'Video' },
  { id: 'presentations', label: 'Presentations', icon: 'Presentation' },
  { id: 'others', label: 'Others', icon: 'Files' },
];
$('#upload-form-slot').append($('#upload-form-template').content.cloneNode(true));
try {
  const saved = JSON.parse(localStorage.getItem('ue-workspace') || 'null');
  if (saved) {
    profileId = saved.profileId || profileId;
    executiveId = saved.executiveId || executiveId;
    mode = ['public', 'enriched', 'twin'].includes(saved.mode) ? saved.mode : mode;
    conversationId = saved.conversationId;
    projectId = saved.projectId;
  }
} catch {}
let busy = false;
let refreshId = 0;
let soulExecutiveId;
let speakerReview;
let savedSpeakerAssignments;
let savedVoiceProfiles = [];
let speakerQueue = [];
let speakerFrameLoading = false;
let speakerFrameWanted;
let speakerPreviewCache = new Map();
let speakerFrameTasks = Promise.resolve();
let speakerPlaybackEnd;
let activeSpeakerSample;
let selectedFiles = [];
let attachmentPreviewUrls = [];
let dreamingPollTimer;
let dreamingJobs = [];
let dreamingErrors = [];
const isVideoFile = file => /\.(mp4|mov|webm|mkv)$/i.test(file.name);
const isAudioFile = file => /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(file.name);
const isMediaFile = file => isVideoFile(file) || isAudioFile(file);
const isImageFile = file => /\.(png|jpe?g|webp)$/i.test(file.name);
const participantEditors = new Map();
const restartMessage = 'The server is running an older version. Stop it with Ctrl+C, run npm start again, then refresh this page to enable file uploads.';

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}
function icon(name) {
  return lucide.createElement(lucide.icons[name], { width: 18, height: 18, 'aria-hidden': 'true' });
}
function knowledgeTitle(content) {
  return content.trim().split(/\r?\n/).find(line => line.trim())?.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Pasted knowledge';
}
lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
function showError(error) {
  $('#error').textContent = error.message;
  $('#error').hidden = false;
  const dialog = document.querySelector('dialog[open]');
  if (dialog) {
    let message = dialog.querySelector('.error');
    if (!message) {
      message = node('p', 'error');
      message.setAttribute('role', 'alert');
      (dialog.querySelector('.management-notices') || dialog.querySelector('form') || dialog).append(message);
    }
    message.textContent = error.message;
  }
}
function clearError() {
  $('#error').hidden = true;
  for (const message of document.querySelectorAll('dialog .error')) message.remove();
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`/api/${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}
function context() { return { executiveId, profileId, mode, ...(conversationId ? { conversationId } : {}) }; }
function personaMode(id = executiveId) {
  return state?.executives.find(executive => executive.id === id)?.owner_id === profileId ? 'twin' : 'enriched';
}
function profileName(id) { return state?.profiles.find(profile => profile.id === id)?.name || 'Unknown person'; }
function renderLogin() {
  $('#login-profile').replaceChildren(...state.profiles.map(profile => {
    const option = node('option', '', profile.name);
    option.value = profile.id;
    return option;
  }));
  $('#login-profile').value = profileId;
  $('#login-profile').disabled = busy;
}
function dreamingProgress(jobs, now = Date.now()) {
  const total = jobs.reduce((sum, job) => sum + job.totalBatches, 0);
  const completed = jobs.reduce((sum, job) => sum + job.completedBatches, 0);
  const queued = jobs.some(job => job.phase === 'queued');
  const percent = total ? Math.min(99, Math.floor(completed / total * 100)) : 0;
  let timing;
  if (queued) timing = 'Time estimate pending queued work';
  else if (jobs.every(job => job.phase === 'saving')) timing = 'Finishing: saving memory and soul';
  else if (jobs.some(job => !job.completedBatches || !Number.isFinite(job.startedAt) || !Number.isFinite(job.lastBatchAt))) {
    timing = 'Estimating time after the first text batch';
  } else {
    const durations = new Map();
    for (const job of jobs) {
      const average = (job.lastBatchAt - job.startedAt) / job.completedBatches;
      const remaining = Math.max(0, average * (job.totalBatches - job.completedBatches) - (now - job.lastBatchAt));
      durations.set(job.executiveId, (durations.get(job.executiveId) || 0) + remaining);
    }
    const seconds = Math.ceil(Math.max(...durations.values()) / 1000);
    timing = seconds > 0 ? `Estimated ${seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${seconds} sec`} remaining`
      : 'Taking longer than estimated; still processing';
  }
  return { percent, indeterminate: !total || queued, text: `${completed}/${total} text batches processed. ${timing}.` };
}
function renderDreamingIndicator() {
  $('#dreaming-indicator').hidden = false;
  $('#dreaming-indicator').disabled = busy || !state?.dreaming?.enabled ||
    !state.executives.some(item => item.id === executiveId) || dreamingJobs.some(job => job.executiveId === executiveId);
  $('#dreaming-label').textContent = dreamingJobs.length ? 'Currently Dreaming' : 'Not dreaming';
  if (!dreamingJobs.length) {
    $('#dreaming-progress').value = 0;
    $('#dreaming-percent').textContent = '';
    const error = dreamingErrors.find(item => item.executiveId === executiveId);
    const description = error ? `Dreaming failed for ${error.scope}: ${error.error} Click to retry.`
      : !state.dreaming?.status ? 'Restart this server to enable live Dreaming status.'
      : !state.dreaming.enabled ? 'Configure an AI provider to enable Dreaming.'
        : 'No information is currently being processed. Click to dream now.';
    $('#dreaming-label').textContent = error ? 'Dreaming failed' : 'Not dreaming';
    $('#dreaming-indicator-text').textContent = description;
    $('#dreaming-indicator').title = description;
    return;
  }
  const progress = dreamingProgress(dreamingJobs);
  const bar = $('#dreaming-progress');
  if (progress.indeterminate) bar.removeAttribute('value');
  else bar.value = progress.percent;
  $('#dreaming-percent').textContent = progress.indeterminate ? '' : `${progress.percent}%`;
  const names = [...new Set(dreamingJobs.map(job => {
    const name = state.executives.find(item => item.id === job.executiveId)?.name || 'Executive';
    return name;
  }))].join(', ');
  const description = `${names}: ${progress.text}`;
  $('#dreaming-indicator-text').textContent = description;
  $('#dreaming-indicator').title = `${description} Estimates cover current Dreaming jobs, not files still waiting to upload. AI request times vary.`;
}
async function pollDreaming() {
  clearTimeout(dreamingPollTimer);
  let delay = 1000;
  try {
    const result = await api('dreaming');
    dreamingJobs = result.jobs;
    dreamingErrors = result.errors || [];
    renderDreamingIndicator();
  } catch (error) {
    renderDreamingIndicator();
    $('#dreaming-indicator').hidden = false;
    $('#dreaming-progress').removeAttribute('value');
    $('#dreaming-percent').textContent = '';
    $('#dreaming-label').textContent = 'Dreaming status unavailable';
    $('#dreaming-indicator-text').textContent = `Dreaming status unavailable: ${error.message}`;
    delay = 5000;
  } finally {
    dreamingPollTimer = setTimeout(pollDreaming, delay);
  }
}
function dreamingSummary(result) {
  return (result.dreaming || []).map(item => item.status === 'completed'
    ? `Dreaming ${item.scope}: ${item.documents} source(s) indexed in ${item.sourceMonths} dated file(s); ${item.memories} memories and ${item.traits} tone/character observations saved.${!item.memories ? ' No durable memories were extracted; the dated source index is available in Executive memory.' : ''}`
    : item.status === 'no-sources' ? `Dreaming ${item.scope}: no eligible sources to process. Upload documents or publish assigned speech first.`
    : item.status === 'queued' ? `Dreaming ${item.scope} started in the background. You can continue using the application.`
    : item.status === 'failed' ? `Dreaming ${item.scope} failed: ${item.error}`
      : 'Dreaming waits for published speaker assignments.').join(' ');
}
async function readImportResponse(response, onProgress) {
  return readEventStream(response, { progress: onProgress }, 'Import',
    'Analysis connection ended before completion. Check the library before retrying.');
}
async function readEventStream(response, handlers, label, endedMessage) {
  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `${label} failed (${response.status}).`);
    return result;
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  let result;
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += value || '';
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const event = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (event.type === 'error') throw new Error(event.error);
        if (event.type === 'result') result = event.result;
        else if (handlers[event.type]) handlers[event.type](event);
        else throw new Error(`Unrecognized ${label.toLowerCase()} response.`);
      }
      if (done) break;
    }
    if (pending.trim() || !result) throw new Error(endedMessage);
    return result;
  } finally { reader.releaseLock(); }
}
function params() { return new URLSearchParams(context()).toString(); }
function run(action) {
  return async event => {
    event?.preventDefault();
    clearError();
    try { await action(event); } catch (error) { showError(error); }
  };
}
function setBusy(value) {
  busy = value;
  for (const element of document.querySelectorAll('button, select, input, textarea')) {
    element.disabled = value;
  }
  $('#send').replaceChildren(icon(value ? 'LoaderCircle' : 'ArrowUp'));
  $('#send').classList.toggle('is-loading', value);
  $('#send').setAttribute('aria-label', value ? 'Working' : 'Send message');
  updateUploadState();
  $('#open-memory').disabled = value || !state?.memory;
  $('#dream-now').disabled = value || !state?.dreaming?.enabled;
  if (memoryContext) {
    $('#memory-save').disabled = value || !memoryDocuments.length;
    for (const button of document.querySelectorAll('[data-memory-superseded]')) {
      button.disabled = value || button.dataset.memorySuperseded === 'true';
    }
  }
  if (speakerReview) {
    updateSpeakerCount();
    for (const seek of document.querySelectorAll('.speaker-seek')) seek.disabled = value || !$('#speaker-player video');
    for (const next of document.querySelectorAll('.speaker-next-sample')) next.disabled = value || Number(next.dataset.samples) < 2;
    for (const listen of document.querySelectorAll('.speaker-listen')) listen.disabled = value || !speakerReview.hasOriginal;
    updateSpeakerTracking();
    updateVoiceMemory();
  }
  updateExecutiveActions();
}
function updateExecutiveActions() {
  const available = state?.executives.some(executive => executive.id === executiveId);
  $('#open-soul').disabled = busy || !available || !state?.soul;
  $('#open-memory').disabled = busy || !available || !state?.memory;
  $('#dreaming-indicator').disabled = busy || !available || !state?.dreaming?.enabled ||
    dreamingJobs.some(job => job.executiveId === executiveId);
  $('#open-upload').disabled = busy || !available;
  $('#composer-upload').disabled = busy || !available;
  $('#executive-details').disabled = busy || !available;
  $('#new-chat').disabled = busy || !available;
  $('#edit-conversation').disabled = busy || !conversationId;
  $('#send').disabled = busy || !available;
  $('#question').disabled = busy || !available;
  $('#login-profile').disabled = busy;
}
function updateUploadState() {
  const transfer = new DataTransfer();
  for (const file of selectedFiles) transfer.items.add(file);
  $('#file').files = transfer.files;
  const hasFiles = selectedFiles.length > 0;
  const hasVideo = selectedFiles.some(isMediaFile);
  $('#file').disabled = busy || !state?.documents;
  $('#clear-files').hidden = !hasFiles;
  $('#document-content').required = !hasFiles;
  $('#video-info-group').hidden = !hasVideo;
  $('#upload-submit').textContent = hasFiles
    ? `Import ${selectedFiles.length} attachment${selectedFiles.length === 1 ? '' : 's'}${hasVideo ? ' and analyze recording' : ''}`
    : 'Add to knowledge library';
  $('#upload-submit').disabled = busy || !state?.executives.some(executive => executive.id === executiveId) || (hasVideo && !state?.video.enabled)
    || (selectedFiles.some(isImageFile) && !state?.images?.enabled);
}
async function loadState() {
  state = await api('state');
  $('#file').accept = [
    ...state.documents.extensions,
    ...state.media.audioExtensions,
    '.mp4', '.mov', '.webm', '.mkv',
  ].join(',');
  if (!state.profiles.some(profile => profile.id === profileId)) profileId = state.profiles[0].id;
  if (!state.executives.some(executive => executive.id === executiveId)) executiveId = state.executives[0]?.id;
  renderLogin();
  $('#engine').textContent = state.aiConfigured ? 'AI + RETRIEVAL' : 'SOURCE PREVIEW';
  $('#provider-notice').textContent = state.aiConfigured
    ? ''
    : state.configurationError || 'No API key configured. Chat will show retrieved source excerpts, not generated AI answers.';
  $('#recording-provider').textContent = state.providerName || 'the configured AI provider';
  updateUploadState();
  if (!state.documents) showError(new Error(restartMessage));
  if (state.configurationError) showError(new Error(state.configurationError));
  renderExecutives();
  renderCompanyButton();
  refreshSetupStatus().catch(() => {});
  await refresh();
}
const SETUP_LABELS = { ok: 'OK', warn: 'Attention', error: 'Problem' };
let setupState;
function renderSetupLight() {
  const status = setupState?.overall;
  $('#setup-light').className = `status-light ${status || ''}`;
  $('#setup-label').textContent = status ? `Setup status: ${SETUP_LABELS[status]}` : 'Setup status';
}
function renderSetup() {
  renderSetupLight();
  if (!setupState?.checks) return;
  const counts = Object.fromEntries(Object.keys(SETUP_LABELS).map(status => [status, setupState.checks.filter(item => item.status === status).length]));
  $('#setup-summary').textContent = `${counts.ok} OK, ${counts.warn} need attention, ${counts.error} problem(s). ${setupState.live ? 'Including live checks' : 'Configuration checks'} at ${new Date(setupState.checkedAt).toLocaleTimeString()}.`;
  $('#setup-checks').replaceChildren(...setupState.checks.map(item => {
    const row = node('li', `setup-check ${item.status}`);
    const light = node('span', `status-light ${item.status}`);
    light.setAttribute('aria-hidden', 'true');
    const body = node('div', 'setup-check-body');
    body.append(node('strong', '', `${item.title} · ${SETUP_LABELS[item.status]}`), node('p', '', item.summary));
    if (item.action) body.append(node('p', 'setup-action', `What to do: ${item.action}`));
    if (item.details.length) {
      const details = node('details');
      details.append(node('summary', '', 'Details'), ...item.details.map(line => node('p', '', line)));
      body.append(details);
    }
    row.append(light, body);
    return row;
  }));
}
async function refreshSetupStatus(live = false) {
  try {
    setupState = await api('setup', live ? 'POST' : 'GET', live ? {} : undefined);
  } catch (error) {
    setupState = { overall: 'error', checkedAt: new Date().toISOString(), live, checks: [{
      id: 'server', title: 'Server', status: 'error', details: [error.message],
      summary: /not found/i.test(error.message) ? 'The server is running an older version without setup checks.' : `Setup checks failed: ${error.message}`,
      action: 'Stop the server with Ctrl+C, run npm start again, then refresh this page.',
    }] };
  }
  renderSetup();
}
$('#open-setup').addEventListener('click', run(async () => {
  $('#setup-summary').textContent = 'Checking...';
  $('#setup-dialog').showModal();
  await refreshSetupStatus();
}));
$('#setup-refresh').addEventListener('click', run(async () => {
  $('#setup-summary').textContent = 'Checking...';
  await refreshSetupStatus();
}));
$('#setup-live').addEventListener('click', run(async () => {
  $('#setup-live').disabled = true;
  $('#setup-summary').textContent = 'Running live checks. Loading the voice libraries can take up to a minute...';
  try { await refreshSetupStatus(true); } finally { $('#setup-live').disabled = false; }
}));

let companyState;
let companyTranscript = [];
function renderCompanyButton() {
  const company = state?.company;
  $('#company-light').className = `status-light ${company ? (company.filled ? 'ok' : 'warn') : ''}`;
  $('#company-label').textContent = company?.filled ? 'Company profile' : 'Company profile: not set up';
}
function renderCompanyMeta(message = '') {
  const filled = companyState.fields.filter(field => companyState.profile[field.id]?.length).length;
  $('#company-meta').textContent = message || (companyState.updatedAt
    ? `${filled} of ${companyState.fields.length} fields filled. Last saved ${new Date(companyState.updatedAt).toLocaleString()}${companyState.updatedByName ? ` by ${companyState.updatedByName}` : ''}.`
    : 'Not saved yet. Every field is optional; leave unknown fields empty.');
}
function renderCompanyFields(profile) {
  $('#company-fields').replaceChildren(...companyState.fields.map(field => {
    const wrapper = node('div', field.list || field.max > 300 ? 'wide' : '');
    const label = node('label', '', field.list ? `${field.label} (one per line)` : field.label);
    label.htmlFor = `company-${field.id}`;
    const input = node(field.list || field.max > 300 ? 'textarea' : 'input');
    input.id = `company-${field.id}`;
    input.dataset.field = field.id;
    if (field.list) {
      input.rows = 3;
      input.value = (profile[field.id] || []).join('\n');
    } else {
      if (input.tagName === 'TEXTAREA') input.rows = 2;
      input.maxLength = field.max;
      input.value = profile[field.id] || '';
    }
    if (field.placeholder) input.placeholder = field.placeholder;
    wrapper.append(label, input);
    return wrapper;
  }));
}
function readCompanyForm() {
  return Object.fromEntries([...document.querySelectorAll('#company-fields [data-field]')].map(input => {
    const field = companyState.fields.find(item => item.id === input.dataset.field);
    return [field.id, field.list ? input.value.split('\n').map(item => item.trim()).filter(Boolean) : input.value.trim()];
  }).filter(([, value]) => value.length));
}
function renderCompanyInterview(status) {
  const asked = companyTranscript.filter(message => message.role === 'assistant').length;
  const limit = companyState.interview.questionLimit;
  $('#company-transcript').replaceChildren(...companyTranscript.map(message =>
    node('li', message.role, `${message.role === 'assistant' ? 'Interviewer' : 'You'}: ${message.content}`)));
  $('#company-transcript').scrollTop = $('#company-transcript').scrollHeight;
  $('#company-interview-status').textContent = status || (companyTranscript.length
    ? `Question ${asked} of at most ${limit}. Answer it, or draft the profile now.`
    : `Describe your company in a few sentences. The AI asks up to ${limit} follow-up questions, then drafts the profile below for you to review. Nothing is saved until you click Save profile.`);
  $('#company-answer').placeholder = companyTranscript.length ? 'Your answer' : 'What does the company do, for whom, and where does it stand?';
  $('#company-draft').disabled = !companyTranscript.length;
  $('#company-restart').disabled = !companyTranscript.length;
}
async function companyInterviewStep(draftNow) {
  const answer = $('#company-answer').value.trim();
  if (!answer && !draftNow) throw new Error(companyTranscript.length ? 'Write an answer first.' : 'Describe the company first.');
  const messages = answer ? [...companyTranscript, { role: 'user', content: answer }] : [...companyTranscript];
  // Saving or editing while a draft is pending would be overwritten by the arriving draft.
  const locked = ['#company-send', '#company-draft', '#company-restart', '#company-save', '#company-clear', '#company-answer']
    .map(selector => $(selector)).concat([...document.querySelectorAll('#company-fields [data-field]')]);
  for (const element of locked) element.disabled = true;
  renderCompanyInterview(draftNow ? 'Drafting the profile. This can take up to a minute...' : 'Thinking about the next question...');
  try {
    const result = await api('company/interview', 'POST', { profileId, messages, draftNow });
    companyTranscript = messages;
    $('#company-answer').value = '';
    if (result.question) {
      companyTranscript.push({ role: 'assistant', content: result.question });
      renderCompanyInterview();
    } else {
      renderCompanyFields(result.draft);
      renderCompanyInterview('Draft ready below. Review and edit it, then click Save profile. Nothing has been saved yet.');
      renderCompanyMeta('Unsaved draft from the interview.');
      $('#company-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } finally {
    for (const element of [...locked, ...document.querySelectorAll('#company-fields [data-field]')]) element.disabled = false;
    $('#company-draft').disabled = !companyTranscript.length;
    $('#company-restart').disabled = !companyTranscript.length;
  }
}
async function refreshCompanyIndicator() {
  state.company = (await api('state')).company;
  renderCompanyButton();
  refreshSetupStatus().catch(() => {});
}
$('#open-company').addEventListener('click', run(async () => {
  companyState = await api('company');
  renderCompanyFields(companyState.profile);
  renderCompanyMeta();
  $('#company-interview').hidden = !companyState.interview.enabled;
  renderCompanyInterview();
  $('#company-dialog').showModal();
}));
$('#company-send').addEventListener('click', run(() => companyInterviewStep(false)));
$('#company-draft').addEventListener('click', run(() => companyInterviewStep(true)));
$('#company-answer').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#company-send').click(); }
});
$('#company-restart').addEventListener('click', () => {
  companyTranscript = [];
  $('#company-answer').value = '';
  renderCompanyInterview();
});
$('#company-form').addEventListener('submit', run(async () => {
  Object.assign(companyState, await api('company', 'PATCH', { profileId, profile: readCompanyForm() }));
  renderCompanyFields(companyState.profile);
  renderCompanyMeta();
  await refreshCompanyIndicator();
}));
$('#company-clear').addEventListener('click', run(async () => {
  if (!confirm('Clear the company profile for every executive?')) return;
  Object.assign(companyState, await api(`company?${new URLSearchParams({ profileId })}`, 'DELETE'));
  renderCompanyFields(companyState.profile);
  renderCompanyMeta();
  await refreshCompanyIndicator();
}));
function renderExecutives() {
  $('#executives').replaceChildren(...state.executives.map(executive => {
    const option = node('option', '', executive.name);
    option.value = executive.id;
    return option;
  }));
  if (!state.executives.length) $('#executives').append(node('option', '', 'No executives'));
  $('#executives').value = executiveId || '';
  $('#executives').disabled = busy || !state.executives.length;
}
async function loadNavigation() {
  const version = ++navigationVersion;
  const selectedProfile = profileId;
  const query = new URLSearchParams({ profileId: selectedProfile });
  const [chatList, projectList] = await Promise.all([api(`conversations?${query}`), api(`projects?${query}`)]);
  if (version !== navigationVersion || selectedProfile !== profileId) return;
  conversations = chatList;
  projects = projectList;
  if (projectId && !projects.some(project => project.id === projectId)) projectId = undefined;
  if (conversationId && !conversations.some(chat => chat.id === conversationId && chat.executive_id === executiveId && chat.mode === mode)) conversationId = undefined;
  renderNavigation();
}
function renderNavigation() {
  $('#projects').replaceChildren(...projects.map(project => {
    const button = node('button', `nav-item${project.id === projectId ? ' selected' : ''}`);
    button.append(icon('Folder'), node('span', '', project.name));
    button.title = project.name;
    button.setAttribute('aria-pressed', String(project.id === projectId));
    button.disabled = busy;
    button.addEventListener('click', run(async () => {
      projectId = project.id;
      conversationId = undefined;
      $('#question').value = '';
      await refresh();
      closeMobileSidebar();
    }));
    return button;
  }));
  const search = $('#chat-search').value.trim().toLowerCase();
  const visible = conversations.filter(chat => (!projectId || chat.project_id === projectId) && chat.title.toLowerCase().includes(search));
  $('#history-heading').textContent = projectId ? 'Project chats' : 'Recent chats';
  $('#all-chats').setAttribute('aria-pressed', String(!projectId));
  $('#conversations').replaceChildren(...visible.map(chat => {
    const button = node('button', `nav-item chat-link${chat.id === conversationId ? ' selected' : ''}`);
    const executive = state.executives.find(item => item.id === chat.executive_id);
    const label = node('span', 'chat-link-label');
    label.append(node('span', 'chat-link-title', chat.title), node('small', '', executive?.name || 'Executive'));
    button.append(label);
    button.title = `${chat.title} · ${executive?.name || 'Executive'}`;
    button.setAttribute('aria-current', chat.id === conversationId ? 'page' : 'false');
    button.disabled = busy;
    button.addEventListener('click', run(async () => {
      conversationId = chat.id;
      executiveId = chat.executive_id;
      mode = chat.mode;
      projectId = chat.project_id || undefined;
      $('#question').value = '';
      renderExecutives();
      await refresh();
      closeMobileSidebar();
    }));
    return button;
  }));
  $('#no-chats').hidden = visible.length > 0;
  $('#no-chats').textContent = search ? 'No matching conversations' : projectId ? 'No chats in this project yet' : 'No conversations yet';
  const chat = conversations.find(item => item.id === conversationId);
  const project = projects.find(item => item.id === projectId);
  $('#conversation-title').textContent = chat?.title || 'New conversation';
  $('#active-project-status').textContent = project?.name || '';
  $('#active-project-status').hidden = !project;
  $('#delete-project').hidden = !project;
  $('#edit-conversation').disabled = busy || !chat;
}
function saveWorkspace() {
  try { localStorage.setItem('ue-workspace', JSON.stringify({ ...context(), projectId })); } catch {}
}
async function refresh() {
  const version = ++refreshId;
  if (!conversationId) mode = personaMode();
  await loadNavigation();
  if (version !== refreshId) return;
  saveWorkspace();
  const executive = state.executives.find(item => item.id === executiveId);
  updateExecutiveActions();
  if (!executive) {
    $('#executive-name').textContent = 'No executives';
    $('#executive-role').textContent = '';
    $('#executive-bio').textContent = '';
    $('#soul-status').textContent = '';
    $('#mode-description').textContent = '';
    $('#scope-help').textContent = '';
    $('#persona-mode').textContent = '';
    $('#upload-destination').textContent = '';
    $('#question').value = '';
    $('#messages').replaceChildren();
    renderDocuments([]);
    return;
  }
  $('#executive-name').textContent = executive.name;
  $('#executive-role').textContent = executive.role;
  $('#executive-bio').textContent = executive.bio;
  $('#open-soul').disabled = busy || !state.soul;
  $('#open-memory').disabled = busy || !state.memory;
  $('#soul-status').textContent = '';
  const me = profileName(profileId);
  const descriptions = {
    public: 'Evidence: public general knowledge only (earlier conversation). Relevant sources take priority; general LLM knowledge fills gaps.',
    enriched: `Evidence: public general knowledge + concrete knowledge uploaded by ${me}. Relevant sources take priority; general LLM knowledge fills gaps.`,
    twin: `Evidence: public general knowledge + ${me}’s digital twin collection. Relevant sources take priority; general LLM knowledge fills gaps.`,
  };
  $('#persona-mode').textContent = mode === 'twin' ? `Your digital twin · logged in as ${me}`
    : mode === 'enriched' ? `Public persona + your private knowledge · logged in as ${me}` : `Public persona · logged in as ${me}`;
  $('#mode-description').textContent = descriptions[mode];
  $('#scope-help').textContent = 'Where knowledge goes is inferred from who is logged in. Concrete knowledge is only available to the person who uploaded it; uploading to your own executive enriches your digital twin. With AI configured, general non-confidential knowledge is extracted into a public source for everyone.';
  $('#upload-destination').textContent = executive.owner_id === profileId
    ? `Logged in as ${me}: this is your own executive, so uploads enrich your digital twin (only you can use the concrete details).`
    : `Logged in as ${me}: concrete details stay private to you. ${executive.name}'s public persona only receives AI-extracted general knowledge.`;
  $('#messages').replaceChildren(node('p', 'hint', 'Loading conversation...'));
  $('#documents').replaceChildren();
  const [documents, messages] = await Promise.all([api(`documents?${params()}`), conversationId ? api(`messages?${params()}`) : Promise.resolve([])]);
  if (version !== refreshId) return;
  renderDocuments(documents);
  if ($('#executive-dialog').open && executiveEditId === executiveId) await loadKnowledge();
  renderMessages(messages);
}
async function openSource(id) {
  const source = await api(`documents/${encodeURIComponent(id)}`);
  $('#source-title').textContent = source.title;
  $('#source-content').textContent = source.content;
  $('#source-dialog').showModal();
}
function renderDocuments(documents) {
  knowledgeDocuments = documents;
  renderKnowledge();
}
async function loadKnowledge() {
  const version = ++knowledgeRefreshId;
  const id = executiveEditId;
  if (!id) return;
  $('#document-count').textContent = 'Loading sources...';
  const collections = await Promise.all(['public', 'enriched', 'twin'].map(collection =>
    api(`documents?${new URLSearchParams({ executiveId: id, profileId, mode: collection })}`)));
  if (version !== knowledgeRefreshId || id !== executiveEditId) return;
  const sources = [...new Map(collections.flat().map(document => [document.id, document])).values()]
    .sort((first, second) => second.created_at.localeCompare(first.created_at));
  renderDocuments(sources);
}
function renderKnowledge() {
  const search = $('#knowledge-search').value.trim().toLowerCase();
  const scoped = knowledgeItems(knowledgeDocuments);
  // Type tabs are toggles: with no tab selected, every source type is listed.
  $('#knowledge-categories').replaceChildren(...knowledgeTypes.map((category, index) => {
    const count = scoped.filter(document => (document.type || 'others') === category.id).length;
    const button = node('button', `knowledge-tab${knowledgeCategory === category.id ? ' active' : ''}`);
    button.id = `knowledge-tab-${category.id}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(knowledgeCategory === category.id));
    button.setAttribute('aria-controls', 'documents');
    button.tabIndex = knowledgeCategory === category.id || (knowledgeCategory === 'all' && index === 0) ? 0 : -1;
    button.disabled = busy;
    button.append(icon(category.icon), node('span', '', category.label), node('span', 'category-count', String(count)));
    button.addEventListener('click', () => {
      knowledgeCategory = knowledgeCategory === category.id ? 'all' : category.id;
      renderKnowledge();
      $(`#knowledge-tab-${category.id}`).focus();
    });
    return button;
  }));
  if (knowledgeCategory === 'all') $('#documents').removeAttribute('aria-labelledby');
  else $('#documents').setAttribute('aria-labelledby', `knowledge-tab-${knowledgeCategory}`);
  const visible = scoped.filter(document => (knowledgeCategory === 'all' || (document.type || 'others') === knowledgeCategory)
    && document.parts.some(part => `${part.title} ${part.sourceFilename || ''}`.toLowerCase().includes(search)));
  $('#document-count').textContent = `${scoped.length} source${scoped.length === 1 ? '' : 's'}${search ? ` · ${visible.length} matching` : ''}`;
  const groups = knowledgeTypes.filter(category => knowledgeCategory === 'all' || category.id === knowledgeCategory).map(category => {
    const documents = visible.filter(document => (document.type || 'others') === category.id);
    const section = node('section', 'knowledge-group');
    const heading = node('h4');
    heading.append(icon(category.icon), node('span', '', category.label), node('span', 'category-count', String(documents.length)));
    section.append(heading);
    if (!documents.length) section.append(node('p', 'knowledge-empty', search ? 'No matching sources.' : `No ${category.label.toLowerCase()} yet.`));
    section.append(...documents.map(item => item.type === 'videos' ? renderVideo(item) : renderDocument(item.parts[0])));
    return section;
  });
  $('#documents').replaceChildren(...groups);
}
// All sources derived from one video file (archive, published speech, general knowledge, re-uploads) share one library line.
function knowledgeItems(documents) {
  const items = new Map();
  for (const document of documents) {
    const key = document.type === 'videos' ? `video:${(document.sourceFilename || document.title).toLowerCase()}` : `source:${document.id}`;
    if (!items.has(key)) items.set(key, { type: document.type, parts: [] });
    items.get(key).parts.push(document);
  }
  return [...items.values()];
}
function renderVideo(item) {
  const { parts } = item;
  const filename = parts.find(part => part.sourceFilename)?.sourceFilename || parts[0].title.replace(/^General knowledge: /, '').replace(/(\.(?:mp4|mov|webm|mkv)) - .*$/i, '$1');
  const archive = parts.find(part => part.speakerReview);
  const withOriginal = parts.find(part => part.hasOriginal);
  const details = [];
  if (parts.some(part => part.reviewStatus === 'pending')) details.push('awaiting speaker review');
  if (parts.some(part => !part.speakerReview && !part.derivedFrom)) details.push('assigned speech published');
  if (parts.some(part => part.derivedFrom)) details.push('AI general knowledge');
  const card = node('div', 'document');
  const info = node('div', 'document-info');
  info.append(node('strong', '', filename),
    node('p', '', [...details, `${parts.length} source${parts.length === 1 ? '' : 's'}`,
      `${parts.reduce((sum, part) => sum + part.characters, 0).toLocaleString()} characters`].join(' · ')));
  const actions = node('div', 'document-actions');
  if (archive && state.media?.speakerReview) {
    const review = node('button', 'view-source', 'Identify speakers');
    review.disabled = busy;
    review.addEventListener('click', run(() => openSpeakerReview(archive.id)));
    actions.append(review);
  }
  if (withOriginal) {
    const original = node('a', 'tool-button view-source');
    original.append(icon('ExternalLink'));
    original.title = 'Open original';
    original.href = `/api/documents/${encodeURIComponent(withOriginal.id)}/original`;
    original.target = '_blank';
    original.rel = 'noopener';
    original.setAttribute('aria-label', `Open original: ${filename}`);
    actions.append(original);
  }
  const view = node('button', 'tool-button view-source');
  view.append(icon('Eye'));
  view.title = `View ${filename}`;
  view.setAttribute('aria-label', view.title);
  view.disabled = busy;
  view.addEventListener('click', run(async () => {
    const sources = await Promise.all(parts.map(part => api(`documents/${encodeURIComponent(part.id)}`)));
    $('#source-title').textContent = filename;
    $('#source-content').textContent = sources.map(source => `===== ${source.title} =====\n\n${source.content}`).join('\n\n');
    $('#source-dialog').showModal();
  }));
  const remove = node('button', 'tool-button delete');
  remove.append(icon('Trash2'));
  remove.title = `Delete ${filename}`;
  remove.setAttribute('aria-label', remove.title);
  remove.disabled = busy;
  remove.addEventListener('click', run(async () => {
    if (!confirm(`Delete "${filename}" and all ${parts.length} sources derived from it (recording archive, published speech and general knowledge)? Existing chat excerpts remain.`)) return;
    setBusy(true);
    try {
      for (const part of parts) {
        const response = await fetch(`/api/documents/${encodeURIComponent(part.id)}`, { method: 'DELETE' });
        if (!response.ok && response.status !== 404) throw new Error((await response.json()).error || `Delete failed (${response.status}).`);
      }
      await refresh();
    } finally { setBusy(false); }
  }));
  actions.append(view, remove);
  card.append(info, actions);
  return card;
}
function renderDocument(document) {
    const card = node('div', 'document');
    const info = node('div', 'document-info');
    const status = document.reviewStatus === 'pending' ? ' · awaiting speaker review (not indexed)'
      : document.reviewStatus === 'published' ? ' · recording archive (assigned speech published separately)' : '';
    info.append(node('strong', '', document.title));
    if (document.originalFilename && document.originalFilename !== document.title) info.append(node('span', 'source-filename', document.originalFilename));
    info.append(node('p', '', `${document.characters.toLocaleString()} characters${status}`));
    const remove = node('button', 'tool-button delete');
    remove.append(icon('Trash2'));
    remove.title = `Delete ${document.title}`;
    remove.setAttribute('aria-label', remove.title);
    remove.disabled = busy;
    remove.addEventListener('click', run(async () => {
      if (!confirm(`Delete "${document.title}"? For a recording review, this also deletes its published speaker sources. Existing chat excerpts remain.`)) return;
      setBusy(true);
      try {
        await api(`documents/${encodeURIComponent(document.id)}`, 'DELETE');
        await refresh();
      } finally { setBusy(false); }
    }));
    const view = node('button', 'tool-button view-source');
    view.append(icon('Eye'));
    view.title = `View ${document.title}`;
    view.disabled = busy;
    view.setAttribute('aria-label', `View ${document.title}`);
    view.addEventListener('click', run(() => openSource(document.id)));
    const actions = node('div', 'document-actions');
    if (document.speakerReview && state.media?.speakerReview) {
      const review = node('button', 'view-source', 'Identify speakers');
      review.disabled = busy;
      review.addEventListener('click', run(() => openSpeakerReview(document.id)));
      actions.append(review);
    }
    if (document.hasOriginal) {
      const original = node('a', 'tool-button view-source');
      original.append(icon('ExternalLink'));
      original.title = 'Open original';
      original.href = `/api/documents/${encodeURIComponent(document.id)}/original`;
      original.target = '_blank';
      original.rel = 'noopener';
      original.setAttribute('aria-label', `Open original: ${document.title}`);
      actions.append(original);
    }
    actions.append(view, remove);
    card.append(info, actions);
    return card;
}
function renderMessages(messages) {
  $('#messages').replaceChildren();
  if (!messages.length) {
    const empty = node('div', 'empty');
    const mark = node('span', 'empty-icon');
    mark.append(icon('MessagesSquare'));
    empty.append(mark, node('h2', '', 'What\'s on your mind?'),
      node('p', '', state.executives.find(item => item.id === executiveId)?.role || ''));
    $('#messages').append(empty);
  }
  for (const message of messages) {
    const card = node('article', `message ${message.role}`);
    const engineLabel = message.engine.endsWith('-general') ? 'GENERAL LLM KNOWLEDGE'
      : message.engine.endsWith('-role-based') ? 'GENERAL ROLE-BASED PERSPECTIVE' : message.engine.toUpperCase();
    card.append(node('div', 'message-label', message.role === 'user' ? 'YOU' : `AI REPRESENTATION · ${engineLabel}`),
      node('div', 'message-text', message.content));
    if (message.sources?.length) {
      const sources = node('div', 'sources');
      const citations = Array.from(message.content.matchAll(/\[(S\d+)(?:\s*@\s*(\d{2,}:\d{2}:\d{2}))?\]/g),
        match => ({ label: match[1], timestamp: match[2] }));
      const citedLabels = new Set(citations.map(citation => citation.label));
      const linkedDocuments = new Set();
      const links = node('div', 'source-links');
      for (const source of message.sources) {
        if (!citedLabels.has(source.label) || !source.documentId || linkedDocuments.has(source.documentId)) continue;
        linkedDocuments.add(source.documentId);
        const citedTimes = [...new Set(citations.filter(citation => citation.label === source.label)
          .map(citation => citation.timestamp).filter(timestamp => source.videoTimestamps?.includes(timestamp)))];
        const sourceTimes = source.video ? (citedTimes.length ? citedTimes : source.videoTimestamps || []) : [];
        const linkText = sourceTimes.length ? `${source.title} · ${sourceTimes.join(', ')}` : source.title;
        const link = node('a', 'source-document-link', linkText);
        link.href = `/api/documents/${encodeURIComponent(source.documentId)}${source.hasOriginal ? '/original' : ''}`;
        link.setAttribute('aria-label', `Open source document: ${linkText}`);
        if (source.hasOriginal) {
          link.target = '_blank';
          link.rel = 'noopener';
        } else {
          link.addEventListener('click', run(() => openSource(source.documentId)));
        }
        links.append(link);
      }
      if (linkedDocuments.size) sources.append(node('strong', '', 'Referenced documents'), links);
      const excerpts = node('details', 'retrieved-excerpts');
      excerpts.append(node('summary', '', 'Retrieved excerpts'));
      for (const source of message.sources) {
        const detail = node('details');
        const timestamps = source.videoTimestamps?.length ? ` · timestamps ${source.videoTimestamps.join(', ')}` : '';
        detail.append(node('summary', '', `[${source.label}] ${source.title} · ${source.builtin ? 'built-in reference' : source.scope}${timestamps}`), node('p', '', source.text));
        if (source.documentId) {
          const fullText = node('button', 'view-source', 'View full extracted text');
          fullText.addEventListener('click', run(() => openSource(source.documentId)));
          detail.append(fullText);
        }
        excerpts.append(detail);
      }
      sources.append(excerpts);
      card.append(sources);
    }
    $('#messages').append(card);
  }
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function memoryRoute() {
  return `executives/${encodeURIComponent(memoryContext.executiveId)}/memory`;
}
function memoryFile() {
  const month = $('#memory-month').value;
  return month === 'index' ? { name: 'memory.md', content: memoryState.index }
    : { name: `${month}.md`, content: memoryState.months.find(file => file.month === month)?.content || '' };
}
function resetMemoryEditor() {
  memorySupersedes = undefined;
  $('#memory-content').value = '';
  $('#memory-date').value = new Date().toISOString().slice(0, 10);
  $('#memory-status').value = 'inference';
  $('#memory-edit-status').textContent = '';
  $('#memory-cancel-replacement').hidden = true;
}
function renderMemoryView() {
  const selected = $('#memory-month').value;
  const index = node('option', '', 'memory.md');
  index.value = 'index';
  $('#memory-month').replaceChildren(index, ...memoryState.months.map(file => {
    const option = node('option', '', `${file.month}.md`);
    option.value = file.month;
    return option;
  }));
  $('#memory-month').value = memoryState.months.some(file => file.month === selected) ? selected : 'index';
  $('#memory-preview').textContent = memoryFile().content;
  $('#memory-count').textContent = `${memoryState.entries.filter(entry => !entry.supersededBy).length} active memories. ${memoryState.entries.length} total entries in this mode.`;
  $('#memory-entries').replaceChildren(...memoryState.entries.map(entry => {
    const row = node('article', 'memory-entry');
    row.append(node('strong', '', `${entry.date} | ${entry.category} | ${entry.supersededBy ? 'superseded' : entry.status === 'inference' ? 'interpretation' : 'user-confirmed'} | ${entry.scope}`),
      node('p', '', entry.content));
    const actions = node('div', 'speaker-tools');
    const source = node('button', 'view-source', `Source: ${entry.sourceTitle}`);
    source.type = 'button';
    source.addEventListener('click', run(() => openSource(entry.sourceId)));
    const replace = node('button', 'view-source', 'Supersede');
    replace.type = 'button';
    replace.dataset.memorySuperseded = String(Boolean(entry.supersededBy));
    replace.disabled = Boolean(entry.supersededBy);
    replace.addEventListener('click', () => {
      memorySupersedes = entry.id;
      $('#memory-source').value = entry.sourceId;
      $('#memory-category').value = entry.category;
      $('#memory-content').value = entry.content;
      $('#memory-date').value = new Date().toISOString().slice(0, 10);
      $('#memory-status').value = 'inference';
      $('#memory-edit-status').textContent = `Replacing the entry dated ${entry.date}.`;
      $('#memory-cancel-replacement').hidden = false;
      $('#memory-editor').open = true;
      $('#memory-content').focus();
    });
    const remove = node('button', 'delete', 'Delete memory');
    remove.type = 'button';
    remove.addEventListener('click', run(async () => {
      if (!confirm('Delete this curated memory? The original source is kept.')) return;
      await api(`${memoryRoute()}/${encodeURIComponent(entry.id)}?${new URLSearchParams(memoryContext)}`, 'DELETE');
      memoryState = await api(`${memoryRoute()}?${new URLSearchParams(memoryContext)}`);
      resetMemoryEditor();
      renderMemoryView();
    }));
    actions.append(source, replace, remove);
    row.append(actions);
    return row;
  }));
  $('#memory-save').disabled = busy || !memoryDocuments.length;
}
function chatMemoryRoute() {
  return `executives/${encodeURIComponent(memoryContext.executiveId)}/chat-memory`;
}
function chatMemoryQuery() {
  const { executiveId, profileId, mode } = memoryContext;
  return new URLSearchParams({ executiveId, profileId, mode });
}
const CHAT_MEMORY_LABELS = { decision: 'your decision', commitment: 'your commitment', 'open-question': 'open question', advice: 'executive advice' };
function renderChatMemory(chatMemory) {
  chatMemoryState = chatMemory;
  $('#chat-memory-file').textContent = chatMemory.relationship.content
    ? `Saved in the data directory as ${chatMemory.relationship.path} (generated from the database).` : 'No relationship file yet.';
  $('#chat-memory-download').hidden = !chatMemory.relationship.content;
  const active = chatMemory.entries.filter(entry => !entry.supersededBy).length;
  $('#chat-memory-status').textContent = [
    chatMemory.enabled ? `${active} active, ${chatMemory.entries.length} total.` : 'Conversation memory is off (no AI provider or CHAT_MEMORY=off). Existing entries are not used in chats.',
    chatMemory.pending ? `Remembering ${chatMemory.pending} recent exchange(s)...` : '',
    chatMemory.error || '',
  ].filter(Boolean).join(' ');
  $('#chat-memory-entries').replaceChildren(...chatMemory.entries.map(entry => {
    const row = node('article', 'memory-entry');
    row.append(node('strong', '', `${entry.date} | ${CHAT_MEMORY_LABELS[entry.kind] || entry.kind} | ${entry.topic}${entry.supersededBy ? ' | superseded' : ''}`),
      node('p', '', entry.content), node('p', 'hint', `Quote: "${entry.evidence}" | Chat: ${entry.conversationTitle || 'Earlier conversation'}`));
    const actions = node('div', 'speaker-tools');
    const forget = node('button', 'delete', 'Forget');
    forget.type = 'button';
    forget.addEventListener('click', run(async () => {
      if (!confirm('Forget this conversation memory? The chat itself is kept.')) return;
      await api(`${chatMemoryRoute()}/${encodeURIComponent(entry.id)}?${chatMemoryQuery()}`, 'DELETE');
      renderChatMemory(await api(`${chatMemoryRoute()}?${chatMemoryQuery()}`));
    }));
    actions.append(forget);
    row.append(actions);
    return row;
  }));
}
$('#open-memory').addEventListener('click', run(async () => {
  memoryContext = context();
  const [memories, documents, chatMemory] = await Promise.all([
    api(`${memoryRoute()}?${new URLSearchParams(memoryContext)}`), api(`documents?${new URLSearchParams(memoryContext)}`),
    api(`${chatMemoryRoute()}?${chatMemoryQuery()}`),
  ]);
  memoryState = memories;
  renderChatMemory(chatMemory);
  $('#dream-now').disabled = busy || !state?.dreaming?.enabled;
  $('#dream-status').textContent = state?.dreaming?.enabled ? '' : 'Configure an AI provider to enable Dreaming.';
  memoryDocuments = documents.filter(document => !document.speakerReview);
  const placeholder = node('option', '', 'Choose a reviewed source');
  placeholder.value = '';
  $('#memory-source').replaceChildren(placeholder, ...memoryDocuments.map(document => {
    const option = node('option', '', `${document.title} | ${document.scope}`);
    option.value = document.id;
    return option;
  }));
  $('#memory-title').textContent = `${state.executives.find(item => item.id === memoryContext.executiveId)?.name} | Executive memory`;
  $('#memory-editor').open = !memoryState.entries.length;
  resetMemoryEditor();
  renderMemoryView();
  $('#memory-dialog').showModal();
}));
async function triggerDreaming(input, statusSelector) {
  if (busy || !state?.dreaming?.enabled || dreamingJobs.some(job => job.executiveId === input.executiveId)) return;
  setBusy(true);
  $('#dreaming-label').textContent = 'Starting Dreaming';
  $('#dreaming-indicator-text').textContent = 'Starting source processing...';
  $('#dreaming-progress').removeAttribute('value');
  $(statusSelector).textContent = 'Starting Dreaming in the background...';
  try {
    const result = await api(`executives/${encodeURIComponent(input.executiveId)}/dream`, 'POST', input);
    if (statusSelector === '#dream-status') {
      memoryState = await api(`${memoryRoute()}?${new URLSearchParams(input)}`);
      renderMemoryView();
    }
    const summary = dreamingSummary(result);
    $(statusSelector).textContent = summary;
    $('#upload-result').textContent = summary;
    $('#upload-result').hidden = false;
  } catch (error) {
    const message = `Dreaming failed: ${error.message}`;
    $(statusSelector).textContent = message;
    $('#upload-result').textContent = message;
    $('#upload-result').hidden = false;
    throw error;
  } finally { setBusy(false); }
}
$('#dream-now').addEventListener('click', run(() => triggerDreaming(memoryContext, '#dream-status')));
$('#dreaming-indicator').addEventListener('click', run(() => triggerDreaming(context(), '#soul-status')));
$('#memory-month').addEventListener('change', () => { $('#memory-preview').textContent = memoryFile().content; });
$('#memory-cancel-replacement').addEventListener('click', resetMemoryEditor);
$('#memory-form').addEventListener('submit', run(async () => {
  if (busy) return;
  setBusy(true);
  try {
    await api(memoryRoute(), 'POST', { ...memoryContext, sourceId: $('#memory-source').value,
      category: $('#memory-category').value, status: $('#memory-status').value, date: $('#memory-date').value,
      content: $('#memory-content').value, ...(memorySupersedes ? { supersedes: memorySupersedes } : {}),
    });
    memoryState = await api(`${memoryRoute()}?${new URLSearchParams(memoryContext)}`);
    resetMemoryEditor();
    renderMemoryView();
    $('#memory-edit-status').textContent = 'Memory saved.';
  } finally { setBusy(false); }
}));
function downloadMarkdown(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const link = node('a');
  link.href = url;
  link.download = name;
  $('#memory-dialog').append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#memory-download').addEventListener('click', () => {
  const file = memoryFile();
  downloadMarkdown(file.name, file.content);
});
$('#chat-memory-download').addEventListener('click', () => {
  if (chatMemoryState?.relationship.content) {
    downloadMarkdown(chatMemoryState.relationship.path.split('/').pop(), chatMemoryState.relationship.content);
  }
});
function syncSidebar() {
  const mobile = matchMedia('(max-width: 700px)').matches;
  const open = mobile ? document.body.classList.contains('sidebar-open') : !document.body.classList.contains('sidebar-collapsed');
  $('#sidebar-backdrop').hidden = !mobile || !open;
  $('#toggle-sidebar').setAttribute('aria-expanded', String(open));
  $('#sidebar').inert = !open;
  $('main').inert = mobile && open;
}
function closeMobileSidebar() {
  if (matchMedia('(max-width: 700px)').matches) {
    document.body.classList.remove('sidebar-open');
    syncSidebar();
    $('#toggle-sidebar').focus();
  }
}
$('#toggle-sidebar').addEventListener('click', () => {
  document.body.classList.toggle(matchMedia('(max-width: 700px)').matches ? 'sidebar-open' : 'sidebar-collapsed');
  syncSidebar();
  if (document.body.classList.contains('sidebar-open')) $('#close-sidebar').focus();
});
$('#close-sidebar').addEventListener('click', () => {
  document.body.classList.remove('sidebar-open');
  document.body.classList.add('sidebar-collapsed');
  syncSidebar();
  $('#toggle-sidebar').focus();
});
$('#sidebar-backdrop').addEventListener('click', closeMobileSidebar);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMobileSidebar(); });
matchMedia('(max-width: 700px)').addEventListener('change', syncSidebar);
syncSidebar();
$('#executive-details').addEventListener('click', run(() => openExecutiveForm(executiveId)));
$('#composer-upload').addEventListener('click', run(async () => { await openExecutiveForm(executiveId); openUploadEditor(); }));
$('#knowledge-search').addEventListener('input', renderKnowledge);
$('#knowledge-categories').addEventListener('keydown', event => {
  const tabs = [...$('#knowledge-categories').querySelectorAll('[role="tab"]')];
  const index = tabs.indexOf(event.target);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].click();
});
$('#new-chat').addEventListener('click', run(async () => {
  conversationId = undefined;
  $('#question').value = '';
  await refresh();
  closeMobileSidebar();
  $('#question').focus();
}));
$('#executives').addEventListener('change', run(async () => {
  executiveId = $('#executives').value;
  conversationId = undefined;
  $('#question').value = '';
  await refresh();
}));
$('#chat-search').addEventListener('input', renderNavigation);
$('#all-chats').addEventListener('click', run(async () => {
  projectId = undefined;
  conversationId = undefined;
  await refresh();
}));
$('#add-project').addEventListener('click', () => { $('#project-form').reset(); $('#project-dialog').showModal(); });
$('#project-form').addEventListener('submit', run(async () => {
  if (busy) return;
  setBusy(true);
  try {
    const project = await api('projects', 'POST', { profileId, name: $('#project-name').value.trim() });
    projectId = project.id;
    conversationId = undefined;
    $('#question').value = '';
    $('#project-dialog').close();
    await refresh();
    closeMobileSidebar();
  } finally { setBusy(false); }
}));
$('#delete-project').addEventListener('click', run(async () => {
  if (!projectId || !confirm('Delete this project? Its conversations will be kept in Recent chats.')) return;
  setBusy(true);
  try {
    await api(`projects/${encodeURIComponent(projectId)}?${new URLSearchParams({ profileId })}`, 'DELETE');
    projectId = undefined;
    await refresh();
  } finally { setBusy(false); }
}));
$('#edit-conversation').addEventListener('click', () => {
  const chat = conversations.find(item => item.id === conversationId);
  if (!chat) return;
  $('#conversation-name').value = chat.title;
  $('#conversation-project').replaceChildren(...[{ id: '', name: 'No project' }, ...projects].map(project => {
    const option = node('option', '', project.name);
    option.value = project.id;
    return option;
  }));
  $('#conversation-project').value = chat.project_id || '';
  $('#conversation-dialog').showModal();
});
$('#conversation-form').addEventListener('submit', run(async () => {
  if (busy || !conversationId) return;
  setBusy(true);
  try {
    const chat = await api(`conversations/${encodeURIComponent(conversationId)}`, 'PATCH', {
      profileId, title: $('#conversation-name').value.trim(), projectId: $('#conversation-project').value || null,
    });
    projectId = chat.project_id || undefined;
    $('#conversation-dialog').close();
    await refresh();
  } finally { setBusy(false); }
}));
$('#delete-conversation').addEventListener('click', run(async () => {
  if (!conversationId || !confirm('Permanently delete this conversation?')) return;
  setBusy(true);
  try {
    await api(`conversations/${encodeURIComponent(conversationId)}?${new URLSearchParams({ profileId })}`, 'DELETE');
    conversationId = undefined;
    $('#conversation-dialog').close();
    await refresh();
  } finally { setBusy(false); }
}));
$('#login-profile').addEventListener('change', run(async () => {
  profileId = $('#login-profile').value;
  conversationId = undefined;
  projectId = undefined;
  $('#question').value = '';
  await refresh();
}));
function openUploadEditor() {
  $('#upload-editor').hidden = false;
  $('#upload-editor').scrollIntoView({ block: 'nearest' });
  $('#document-content').focus();
}
$('#open-upload').addEventListener('click', openUploadEditor);
for (const button of document.querySelectorAll('[data-cancel-upload]')) {
  button.addEventListener('click', run(() => {
    if (busy) return;
    $('#upload-form').reset();
    selectedFiles = [];
    renderParticipantEditors();
    renderSelectedFiles();
    $('#upload-details').replaceChildren();
    $('#upload-status').textContent = '';
    $('#analysis-progress').hidden = true;
    $('#upload-result').hidden = true;
    updateUploadState();
    $('#upload-editor').hidden = true;
    $('#open-upload').focus();
    $('#open-upload').scrollIntoView({ block: 'nearest' });
  }));
}
async function openExecutiveForm(id) {
  const executive = id ? state.executives.find(item => item.id === id) : undefined;
  if (id && !executive) throw new Error('Executive no longer exists. Refresh the directory.');
  if (executiveEditId !== executive?.id) {
    $('#upload-form').reset();
    selectedFiles = [];
    renderParticipantEditors();
    renderSelectedFiles();
    $('#upload-details').replaceChildren();
    $('#upload-result').hidden = true;
    $('#upload-editor').hidden = true;
    updateUploadState();
  }
  executiveEditId = executive?.id;
  knowledgeCategory = 'all';
  $('#knowledge-search').value = '';
  $('#profile-save-status').hidden = true;
  $('#knowledge-library').hidden = !executive;
  $('#knowledge-unavailable').hidden = Boolean(executive);
  $('#executive-tools').hidden = !executive;
  $('#executive-name').textContent = executive?.name || 'New executive';
  $('#executive-role').textContent = executive?.role || '';
  $('#executive-form').reset();
  $('#executive-form-title').textContent = executive ? 'Profile' : 'Add an executive';
  $('#executive-submit').textContent = executive ? 'Save changes' : 'Create executive';
  $('#executive-create-note').hidden = Boolean(executive);
  $('#delete-executive').hidden = !executive;
  $('#executive-owner-note').textContent = executive
    ? `Only ${profileName(executive.owner_id)} can enrich this digital twin by logging in as themselves.`
    : 'Creating an executive also creates a person you can log in as. Use material you have permission to process.';
  if (executive) {
    $('#new-name').value = executive.name;
    $('#new-role').value = executive.role;
    $('#new-bio').value = executive.bio;
  }
  renderKnowledgeDomains(executive);
  renderDocuments([]);
  if (!$('#executive-dialog').open) $('#executive-dialog').showModal();
  if (executive) await loadKnowledge();
}
$('#add-executive').addEventListener('click', run(() => openExecutiveForm()));
function renderKnowledgeDomains(executive) {
  const domains = state?.builtinKnowledge?.domains || [];
  $('#knowledge-domains').hidden = !executive || !domains.length;
  if (!executive) return;
  $('#knowledge-domain-options').replaceChildren(...domains.map(domain => {
    const label = node('label', 'domain-option');
    const input = node('input');
    input.type = 'checkbox';
    input.name = 'knowledgeDomains';
    input.value = domain.id;
    input.checked = executive.knowledgeDomains?.includes(domain.id);
    input.addEventListener('change', renderBuiltinDocuments);
    label.append(input, ` ${domain.title} (${domain.documents.length})`);
    return label;
  }));
  renderBuiltinDocuments();
}
function renderBuiltinDocuments() {
  const selected = new Set(new FormData($('#executive-form')).getAll('knowledgeDomains'));
  const documents = (state?.builtinKnowledge?.domains || []).filter(domain => selected.has(domain.id)).flatMap(domain => domain.documents);
  $('#builtin-document-list').replaceChildren(...(documents.length ? documents.map(document => {
    const button = node('button', 'view-source', document.title);
    button.type = 'button';
    button.addEventListener('click', run(() => openSource(document.id)));
    return button;
  }) : [node('p', 'hint', 'No built-in knowledge selected. Answers use uploaded sources and general model knowledge only.')]));
}
for (const button of document.querySelectorAll('.close')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}
$('#open-soul').addEventListener('click', run(async () => {
  const id = executiveId;
  const executive = state.executives.find(item => item.id === id);
  const soul = await api(`executives/${encodeURIComponent(id)}/soul`);
  if (id !== executiveId) return;
  soulExecutiveId = id;
  $('#soul-title').textContent = `${executive.name} - executive soul`;
  $('#soul-content').value = soul.content;
  $('#soul-content').maxLength = state.soul.maxCharacters;
  $('#soul-dialog').showModal();
}));
$('#soul-form').addEventListener('submit', run(async () => {
  if (busy) return;
  const id = soulExecutiveId;
  setBusy(true);
  try {
    await api(`executives/${encodeURIComponent(id)}/soul`, 'POST', { content: $('#soul-content').value });
    $('#soul-dialog').close();
    if (id === executiveId) $('#soul-status').textContent = 'Executive soul saved. Future AI answers will use this style in all modes.';
  } finally { setBusy(false); }
}));
$('#executive-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('#executive-form').addEventListener('submit', run(async () => {
  if (busy) return;
  const form = $('#executive-form');
  const values = Object.fromEntries(new FormData(form));
  delete values.knowledgeDomains;
  if (executiveEditId) values.knowledgeDomains = new FormData(form).getAll('knowledgeDomains');
  $('#upload-result').hidden = true;
  setBusy(true);
  try {
    const executive = executiveEditId
      ? await api(`executives/${encodeURIComponent(executiveEditId)}`, 'PATCH', values)
      : await api('executives', 'POST', values);
    executiveId = executive.id;
    if (!executiveEditId) conversationId = undefined;
    executiveEditId = executive.id;
    $('#executive-form-title').textContent = 'Profile';
    $('#executive-submit').textContent = 'Save changes';
    $('#executive-create-note').hidden = true;
    $('#delete-executive').hidden = false;
    $('#executive-owner-note').textContent = `Only ${values.name} can enrich this digital twin by logging in as themselves.`;
    $('#knowledge-library').hidden = false;
    $('#knowledge-unavailable').hidden = true;
    $('#executive-tools').hidden = false;
    await loadState();
    renderKnowledgeDomains(state.executives.find(item => item.id === executive.id));
    $('#profile-save-status').textContent = 'Executive saved.';
    $('#profile-save-status').hidden = false;
  } finally { setBusy(false); }
}));
$('#delete-executive').addEventListener('click', run(async () => {
  if (busy || !executiveEditId) return;
  const executive = state.executives.find(item => item.id === executiveEditId);
  if (!confirm(`Delete "${executive.name}"? This permanently removes this executive's sources, conversation history, soul, memory files, and saved voice identity. Other executives' published speech and shared recordings are kept.`)) return;
  setBusy(true);
  try {
    await api(`executives/${encodeURIComponent(executiveEditId)}`, 'DELETE');
    $('#executive-dialog').close();
    executiveEditId = undefined;
    memoryContext = undefined;
    memoryState = undefined;
    speakerReview = undefined;
    speakerQueue = [];
    selectedFiles = [];
    participantEditors.clear();
    await loadState();
  } finally { setBusy(false); }
}));
function speakerOptions(value = '') {
  const unknown = node('option', '', 'Unknown / exclude from executive RAG');
  unknown.value = '';
  const recognized = new Map();
  for (const id of speakerReview?.voiceSuggestions || []) if (id) recognized.set(id, (recognized.get(id) || 0) + 1);
  const executives = [...state.executives].sort((a, b) => (recognized.get(b.id) || 0) - (recognized.get(a.id) || 0));
  return [unknown, ...executives.map(executive => {
    const count = recognized.get(executive.id);
    const option = node('option', '', `${executive.name} - ${executive.role}${count ? ` · voice recognized in ${count} turn(s)` : ''}`);
    option.value = executive.id;
    option.selected = executive.id === value;
    return option;
  })];
}
function renderSpeakerOptions() {
  $('#speaker-bulk').replaceChildren(...speakerOptions($('#speaker-bulk').value));
  for (const select of document.querySelectorAll('.speaker-assignment')) {
    select.replaceChildren(...speakerOptions(speakerReview.assignments[Number(select.dataset.index)] || ''));
  }
  renderSpeakerGroups();
}
function updateSpeakerTracking() {
  const media = speakerReview?.hasOriginal && /\.(mp4|mov|webm|mkv|mp3|wav|m4a|ogg|flac|aac)$/i.test(speakerReview.originalFilename);
  const detected = speakerReview?.segments.some(segment => segment.speakerId);
  $('#speaker-regroup').disabled = busy || !state.media?.voiceFingerprints?.enabled ||
    (!speakerReview?.hasOriginal && !speakerReview?.hasVoiceFingerprints);
  $('#speaker-detect').disabled = busy || !media || !state.media?.speakerTracking || !speakerReview?.segments.length;
  $('#speaker-detect').textContent = detected ? 'Re-analyze speaker tracks (AI)' : 'Detect speaker tracks across recording (AI)';
  $('#speaker-track-status').textContent = !media ? 'Tracking requires a retained audio/video original, not just a text export.'
    : !state.media?.speakerTracking ? 'Configure Gemini audio input to enable anonymous speaker tracking.'
    : speakerReview.trackingError ? speakerReview.trackingError
    : detected ? 'Speaker tracks saved. Label a voice card once to assign all its matching turns. Unknown speech stays excluded; no automatic publishing.'
    : 'Analyze speech across the recording using voice characteristics and, for video, time-aligned frames. Match the detected speaker cards to executives yourself; the AI does not infer names.';
}
function renderSpeakerGroups() {
  stopSpeakerSample();
  const groups = new Map();
  speakerReview.segments.forEach((segment, index) => {
    const matched = speakerReview.voiceSuggestions?.[index];
    const id = matched && matched === speakerReview.assignments[index] ? `voice-match-${matched}` : segment.speakerId;
    if (!id) return;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(index);
  });
  const cards = [...groups].map(([id, indices]) => {
    const card = node('section', 'speaker-group');
    const seconds = indices.reduce((total, index) => total + speakerReview.segments[index].end - speakerReview.segments[index].start, 0);
    const name = id.startsWith('voice-match-')
      ? state.executives.find(executive => executive.id === id.slice('voice-match-'.length))?.name || 'Saved voice'
      : id.replace('speaker-', 'Speaker ');
    const title = node('h3', '', `${name} · ${indices.length} turn(s)`);
    card.append(title, node('p', 'hint', `${Math.round(seconds)} seconds of speech across this recording`));
    const recognized = indices.filter(index => speakerReview.voiceSuggestions?.[index] &&
      speakerReview.voiceSuggestions[index] === speakerReview.assignments[index]);
    if (recognized.length) card.append(node('p', 'hint', 'Saved voice match (unverified)'));
    const representatives = [...indices].sort((a, b) =>
      Number(Boolean(speakerReview.segments[b].speakerVisual)) - Number(Boolean(speakerReview.segments[a].speakerVisual)) ||
      (speakerReview.segments[b].end - speakerReview.segments[b].start) - (speakerReview.segments[a].end - speakerReview.segments[a].start));
    let turn = 0;
    const video = /\.(mp4|mov|webm|mkv)$/i.test(speakerReview.originalFilename);
    const image = node('img', 'speaker-portrait');
    image.alt = `Video still during ${name}; AI-suggested association requires review`;
    const caption = node('p', 'hint');
    caption.setAttribute('role', 'status');
    const cue = node('p', 'speaker-visual-cue');
    const updateCue = () => {
      const visual = speakerReview.segments[representatives[turn]].speakerVisual;
      cue.textContent = visual
        ? `AI visual cue: ${visual.description} (verify against playback)`
        : 'No confident visible-speaker association for this sample. Identify this speaker by listening.';
    };
    updateCue();
    if (video && speakerReview.hasOriginal) {
      card.append(cue, image, caption);
      loadSpeakerImage(representatives[turn], image, caption);
    } else {
      card.append(node('p', 'hint', 'Voice sample only — no video still is available.'));
    }
    const values = new Set(indices.map(index => speakerReview.assignments[index]));
    const select = node('select', 'speaker-group-assignment');
    select.disabled = busy;
    select.setAttribute('aria-label', `Executive for ${id}`);
    select.replaceChildren(...speakerOptions(values.size === 1 ? [...values][0] || '' : ''));
    if (values.size > 1) {
      const mixed = node('option', '', 'Mixed assignments — review or choose to replace all');
      mixed.value = 'mixed';
      mixed.disabled = true;
      mixed.selected = true;
      select.prepend(mixed);
    }
    select.addEventListener('change', () => {
      for (const index of indices) speakerReview.assignments[index] = select.value || null;
      renderSpeakerOptions();
      updateSpeakerCount();
    });
    const inspect = node('button', '', 'Listen to voice sample');
    inspect.className = 'speaker-listen';
    inspect.type = 'button';
    inspect.disabled = busy || !speakerReview.hasOriginal;
    const audio = node('audio', 'speaker-sample');
    audio.controls = true;
    audio.preload = 'none';
    audio.hidden = true;
    const sampleStatus = node('p', 'hint');
    sampleStatus.setAttribute('role', 'status');
    let sampleUrl;
    let sampleController;
    let sampleFailed = false;
    audio.addEventListener('sample-reset', () => {
      sampleController?.abort();
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      if (sampleUrl) URL.revokeObjectURL(sampleUrl);
      sampleUrl = undefined;
      audio.hidden = true;
      inspect.textContent = 'Listen to voice sample';
      sampleStatus.textContent = '';
    });
    audio.addEventListener('play', () => {
      if (activeSpeakerSample && activeSpeakerSample !== audio) activeSpeakerSample.pause();
      $('#speaker-player video')?.pause();
      speakerPlaybackEnd = undefined;
      activeSpeakerSample = audio;
    });
    audio.addEventListener('playing', () => {
      if (audio.hidden) return;
      sampleStatus.textContent = 'Playing voice sample';
      inspect.textContent = 'Pause voice sample';
    });
    audio.addEventListener('pause', () => {
      if (sampleFailed) return;
      inspect.textContent = 'Listen to voice sample';
      if (!audio.hidden && !sampleFailed) sampleStatus.textContent = audio.ended ? 'Sample finished' : 'Sample paused';
    });
    audio.addEventListener('waiting', () => { if (!audio.hidden) sampleStatus.textContent = 'Loading voice sample...'; });
    audio.addEventListener('error', () => {
      sampleFailed = true;
      sampleStatus.className = 'error';
      sampleStatus.textContent = 'Voice sample could not be loaded. Retry, or use recording playback below.';
      inspect.textContent = 'Retry voice sample';
    });
    inspect.addEventListener('click', run(async () => {
      if (!audio.paused) { audio.pause(); return; }
      const review = speakerReview;
      const index = representatives[turn % representatives.length];
      const segment = review.segments[index];
      const end = Math.min(segment.end, segment.start + 12);
      sampleFailed = false;
      audio.hidden = false;
      sampleStatus.className = 'hint';
      sampleStatus.textContent = `Loading ${segment.start.toFixed(2)}s - ${end.toFixed(2)}s voice sample...`;
      try {
        if (!audio.getAttribute('src') || audio.error) {
          sampleController?.abort();
          const controller = new AbortController();
          sampleController = controller;
          const response = await fetch(`/api/documents/${encodeURIComponent(review.id)}/voice-sample?${new URLSearchParams({ start: segment.start, end })}`, { signal: controller.signal });
          if (!response.ok) {
            const result = await response.json();
            throw new Error(response.status === 404
              ? 'Voice sample endpoint or recording is unavailable. Restart the server with npm start, refresh, and reopen speaker review.'
              : result.error || `Voice sample request failed (${response.status}).`);
          }
          if (!response.headers.get('content-type')?.startsWith('audio/mpeg')) throw new Error('The server did not return an audio sample. Restart the server and refresh.');
          const blob = await response.blob();
          if (controller.signal.aborted || !audio.isConnected || !$('#speaker-dialog').open || speakerReview !== review) return;
          if (sampleUrl) URL.revokeObjectURL(sampleUrl);
          sampleUrl = URL.createObjectURL(blob);
          audio.src = sampleUrl;
        }
        if (audio.ended) audio.currentTime = 0;
        await audio.play();
      }
      catch (error) {
        if (error.name === 'AbortError' && (sampleController?.signal.aborted || !audio.isConnected || audio.hidden || !$('#speaker-dialog').open || speakerReview !== review)) return;
        sampleFailed = true;
        inspect.textContent = 'Retry voice sample';
        sampleStatus.className = 'error';
        sampleStatus.textContent = `Voice sample could not play: ${error.message} Use its audio controls to retry.`;
        throw error;
      }
    }));
    const next = node('button', '', 'Try another sample / still');
    next.className = 'speaker-next-sample';
    next.dataset.samples = representatives.length;
    next.type = 'button';
    next.disabled = busy || representatives.length < 2;
    next.addEventListener('click', () => {
      turn = (turn + 1) % representatives.length;
      audio.dispatchEvent(new Event('sample-reset'));
      updateCue();
      if (video && speakerReview.hasOriginal) loadSpeakerImage(representatives[turn], image, caption);
    });
    const label = node('label', '', 'Connect this speaker to an existing executive');
    label.append(select);
    card.append(inspect, audio, sampleStatus, next, label, node('p', 'hint', 'One selection assigns every matching turn in this recording.'));
    return card;
  });
  const unknown = speakerReview.segments.filter((segment, index) => !segment.speakerId && !speakerReview.assignments[index]).length;
  const timingIssues = speakerReview.segments.filter(segment => segment.speakerIssue).length;
  const notice = node('p', 'hint', groups.size
    ? `${groups.size} distinct speaker group(s) detected. ${unknown} uncertain or untracked turn(s) stay excluded unless corrected in Advanced.${timingIssues ? ` ${timingIssues} transcript entries have timing or analysis issues; see the warnings and Advanced.` : ''}`
    : speakerReview.segments.length ? 'No speakers were detected. Use Re-analyze speakers below to analyze the retained recording. If detection still fails, re-import to regenerate speaker-separated timestamps.'
    : 'No speech detected. There are no voice cards to match.');
  const warning = speakerReview.trackingError || (!state.media?.speakerTracking && !state.media?.voiceFingerprints?.enabled && speakerReview.segments.length
    ? 'Automatic speaker detection requires Gemini audio input. Configure AI_TRANSCRIPTION_MODE=gemini and a compatible Gemini endpoint, then restart the server and re-analyze this recording.'
    : '');
  const warnings = [...new Set([...(speakerReview.warnings || []), ...(warning ? [warning] : [])])];
  const errors = warnings.map(message => node('p', 'error', message));
  for (const error of errors) error.setAttribute('role', 'alert');
  $('#speaker-groups').replaceChildren(...errors, notice, ...cards);
}
function stopSpeakerSample() {
  for (const audio of document.querySelectorAll('.speaker-sample')) audio.dispatchEvent(new Event('sample-reset'));
  activeSpeakerSample = undefined;
}
async function speakerPreviewFrame(review, seconds) {
  const cache = speakerPreviewCache;
  const key = `${review.id}:${seconds}`;
  if (!cache.has(key)) {
    const pending = speakerFrameTasks.then(async () => {
      if (speakerReview !== review || !$('#speaker-dialog').open) return null;
      const response = await fetch(`/api/documents/${encodeURIComponent(review.id)}/frame?seconds=${seconds}`);
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || `Frame extraction failed (${response.status}).`);
      }
      const blob = await response.blob();
      if (speakerPreviewCache !== cache) return null;
      return URL.createObjectURL(blob);
    });
    cache.set(key, pending);
    // Keep later frame requests running after an error; each caller displays its own failure.
    speakerFrameTasks = pending.then(() => undefined, () => undefined);
  }
  return cache.get(key);
}
async function loadSpeakerImage(index, image, caption) {
  const review = speakerReview;
  const segment = review.segments[index];
  const request = String(index);
  image.dataset.turn = request;
  image.hidden = true;
  caption.textContent = `Loading still during voice sample at ${segment.start.toFixed(2)}s...`;
  try {
    const seconds = segment.speakerVisual?.seconds ?? segment.start + Math.min(1, (segment.end - segment.start) / 2);
    const url = await speakerPreviewFrame(review, seconds);
    if (!url || speakerReview !== review || image.dataset.turn !== request) return;
    image.src = url;
    image.hidden = false;
    caption.textContent = `Still at ${seconds.toFixed(2)}s. ${segment.speakerVisual ? 'Selected from the AI speaker analysis; verify the visible person by listening.' : 'Scene context only; the visible person may not be speaking.'}`;
    caption.className = 'hint';
  } catch (error) {
    if (image.dataset.turn !== request) return;
    caption.textContent = `Video still unavailable: ${error.message} You can still identify this voice by listening.`;
    caption.className = 'error';
  }
}
async function showSpeakerMoment(index, play = false) {
  const review = speakerReview;
  const segment = review.segments[index];
  const player = $('#speaker-player video');
  if (!player) return;
  player.currentTime = segment.start;
  speakerPlaybackEnd = play ? Math.min(segment.end, segment.start + 12) : undefined;
  if (play) {
    stopSpeakerSample();
    try { await player.play(); }
    catch (error) {
      if (error.name === 'AbortError' && (!$('#speaker-dialog').open || speakerReview !== review)) return;
      throw error;
    }
  }
  if (!/\.(mp4|mov|webm|mkv)$/i.test(review.originalFilename)) return;
  const requested = { review, index };
  speakerFrameWanted = requested;
  if (speakerFrameLoading) return;
  speakerFrameLoading = true;
  $('#speaker-frame').hidden = true;
  $('#speaker-frame-status').textContent = `Loading frame at ${segment.start.toFixed(2)}s…`;
  try {
    const url = await speakerPreviewFrame(review, segment.start);
    if (!url) return;
    if (speakerFrameWanted !== requested || speakerReview !== review || !$('#speaker-dialog').open) return;
    $('#speaker-frame-image').src = url;
    $('#speaker-frame-caption').textContent = `Turn ${index + 1}, ${segment.start.toFixed(2)}s — visual aid only; the visible person may not be speaking.`;
    $('#speaker-frame').hidden = false;
  } finally {
    speakerFrameLoading = false;
    $('#speaker-frame-status').textContent = '';
    if (speakerFrameWanted && speakerFrameWanted !== requested &&
        speakerFrameWanted.review === speakerReview && $('#speaker-dialog').open) {
      await showSpeakerMoment(speakerFrameWanted.index);
    }
  }
}
function updateSpeakerCount() {
  const assigned = speakerReview.assignments.filter(Boolean);
  $('#speaker-count').textContent = `${assigned.length}/${speakerReview.segments.length} segments assigned to ${new Set(assigned).size} executive(s). Speech assigned to the uploader's own executive enriches their digital twin; other assigned speech stays private to the uploader, and AI-extracted general knowledge becomes public.`;
  $('#speaker-publish').disabled = busy || !assigned.length;
  updateVoiceMemory();
}
function updateVoiceMemory() {
  $('#speaker-voice-memory-status').textContent = `${savedVoiceProfiles.length} saved voice profile(s), shared by all users.` +
    (savedVoiceProfiles.length ? ` ${savedVoiceProfiles.map(item => item.name).join(', ')}.` : '') +
    (!state.media?.voiceFingerprints?.enabled ? ' Voice fingerprinting is disabled; new uploads cannot recognize saved voices.'
      : speakerReview.hasVoiceFingerprints ? ' Fingerprint data is available for this recording.' : ' This recording has no voice fingerprints.');
}
async function refreshVoiceMemory() {
  savedVoiceProfiles = await api(`voice-profiles?${new URLSearchParams({ profileId })}`);
  updateVoiceMemory();
}
async function openSpeakerReview(id) {
  speakerReview = await api(`documents/${encodeURIComponent(id)}/speakers`);
  savedSpeakerAssignments = [...speakerReview.assignments];
  $('#speaker-expected-speakers').value = speakerReview.expectedSpeakers || '';
  $('#speaker-regroup-status').textContent = '';
  await refreshVoiceMemory();
  $('#speaker-title').textContent = `Identify speakers: ${speakerReview.title}`;
  $('#speaker-player').replaceChildren();
  $('#speaker-frame').hidden = true;
  $('#speaker-propagate').checked = true;
  $('#speaker-corrections').open = false;
  $('#speaker-playback').open = false;
  $('#speaker-tracking-tools').open = Boolean(speakerReview.trackingError) || !speakerReview.segments.some(segment => segment.speakerId);
  const playable = speakerReview.hasOriginal && /\.(mp4|mov|webm|mkv|mp3|wav|m4a|ogg|flac|aac)$/i.test(speakerReview.originalFilename);
  if (playable) {
    const player = node('video');
    player.controls = true;
    player.preload = 'metadata';
    player.src = `/api/documents/${encodeURIComponent(id)}/original`;
    player.addEventListener('timeupdate', () => {
      if (speakerPlaybackEnd !== undefined && player.currentTime >= speakerPlaybackEnd) {
        player.pause();
        speakerPlaybackEnd = undefined;
      }
    });
    $('#speaker-player').append(player);
  } else {
    $('#speaker-player').append(node('p', 'hint', 'No playable original recording available here. Use your local recording to verify times. Extracted meeting analyses can still be assigned.'));
  }
  $('#speaker-segments').replaceChildren(...speakerReview.segments.map((segment, index) => {
    const row = node('section', 'speaker-segment');
    const selected = node('input');
    selected.type = 'checkbox';
    selected.className = 'speaker-selected';
    selected.dataset.index = index;
    selected.setAttribute('aria-label', `Select segment ${index + 1}`);
    const seek = node('button', 'speaker-seek', `${segment.start.toFixed(2)}s - ${segment.end.toFixed(2)}s`);
    seek.type = 'button';
    seek.disabled = busy || !playable;
    seek.addEventListener('click', run(async () => {
      await showSpeakerMoment(index, true);
    }));
    const assignment = node('select', 'speaker-assignment');
    assignment.disabled = busy;
    assignment.dataset.index = index;
    assignment.setAttribute('aria-label', `Speaker for segment ${index + 1}`);
    assignment.addEventListener('change', () => {
      const executive = assignment.value || null;
      if (segment.speakerId && $('#speaker-propagate').checked) {
        speakerReview.segments.forEach((other, turn) => {
          if (other.speakerId === segment.speakerId) speakerReview.assignments[turn] = executive;
        });
      } else {
        speakerReview.assignments[index] = executive;
      }
      renderSpeakerOptions();
      updateSpeakerCount();
    });
    const track = segment.speakerId ? segment.speakerId.replace('speaker-', 'Speaker ') : 'Unknown / not tracked';
    const description = node('p', '', `${track}: ${segment.text}${segment.speakerIssue ? `\n${segment.speakerIssue}` : ''}`);
    const match = speakerReview.voiceDiagnostics?.[index];
    if (match) {
      const labels = { 'no-fingerprint': 'No usable voice fingerprint', 'no-references': 'No saved reference from another recording',
        'below-threshold': 'Below identity threshold', ambiguous: 'Competing voice too similar',
        matched: 'Saved voice match (unverified)', 'group-supported': 'Recording-supported voice match (unverified)' };
      const candidate = state.executives.find(executive => executive.id === match.candidateId)?.name;
      const scores = Number.isFinite(match.score)
        ? `; ${candidate || 'best candidate'}: ${match.score.toFixed(3)}, threshold: ${match.threshold.toFixed(3)}` +
          (match.competitorScore !== null ? `, competitor: ${match.competitorScore.toFixed(3)}` : '') +
          (Number.isFinite(match.groupScore) ? `, group support: ${match.groupScore.toFixed(3)}` : '') : '';
      description.append(node('span', 'hint', `\nVoice check: ${labels[match.status] || match.status}${scores}`));
    }
    row.append(selected, seek, description, assignment);
    return row;
  }));
  $('#speaker-dialog').showModal();
  renderSpeakerOptions();
  updateSpeakerCount();
  updateSpeakerTracking();
}
$('#speaker-regroup').addEventListener('click', run(async () => {
  if (busy) return;
  const id = speakerReview.id;
  const expectedSpeakers = $('#speaker-expected-speakers').value ? Number($('#speaker-expected-speakers').value) : null;
  if (expectedSpeakers !== null && (!Number.isInteger(expectedSpeakers) || expectedSpeakers < 1 || expectedSpeakers > 20)) throw new Error('Choose between 1 and 20 speakers, or leave the count empty.');
  setBusy(true);
  $('#speaker-regroup-status').textContent = 'Grouping voice fingerprints across the recording locally...';
  try {
    if (JSON.stringify(savedSpeakerAssignments) !== JSON.stringify(speakerReview.assignments)) {
      await api(`documents/${encodeURIComponent(id)}/speakers`, 'POST', {
        draft: true, assignments: speakerReview.assignments,
      });
    }
    await api(`documents/${encodeURIComponent(id)}/speaker-groups`, 'POST', { expectedSpeakers });
    $('#speaker-dialog').close();
    await openSpeakerReview(id);
    $('#speaker-regroup-status').textContent = 'Recording-wide groups saved. Existing assignments are preserved for review.';
  } finally { setBusy(false); }
}));
$('#speaker-detect').addEventListener('click', run(async () => {
  if (busy) return;
  const id = speakerReview.id;
  setBusy(true);
  $('#speaker-track-status').textContent = 'Analyzing voice characteristics and available video frames across the recording… Keep this page open. Existing assignments and published knowledge are preserved.';
  try {
    if (JSON.stringify(savedSpeakerAssignments) !== JSON.stringify(speakerReview.assignments)) {
      await api(`documents/${encodeURIComponent(id)}/speakers`, 'POST', {
        draft: true, assignments: speakerReview.assignments,
      });
    }
    await api(`documents/${encodeURIComponent(id)}/speaker-tracks`, 'POST', {
      expectedSpeakers: $('#speaker-expected-speakers').value ? Number($('#speaker-expected-speakers').value) : null,
    });
    $('#speaker-dialog').close();
    await openSpeakerReview(id);
  } finally { setBusy(false); }
}));
$('#speaker-select-all').addEventListener('click', () => {
  for (const box of document.querySelectorAll('.speaker-selected')) box.checked = true;
});
$('#speaker-clear-selection').addEventListener('click', () => {
  for (const box of document.querySelectorAll('.speaker-selected')) box.checked = false;
});
$('#speaker-apply').addEventListener('click', run(async () => {
  const selected = [...document.querySelectorAll('.speaker-selected:checked')];
  if (!selected.length) throw new Error('Select at least one transcript segment.');
  for (const box of selected) speakerReview.assignments[Number(box.dataset.index)] = $('#speaker-bulk').value || null;
  renderSpeakerOptions();
  updateSpeakerCount();
}));
$('#speaker-create').addEventListener('click', run(async () => {
  await api('executives', 'POST', {
    name: $('#speaker-new-name').value, role: $('#speaker-new-role').value,
  });
  state = await api('state');
  $('#speaker-new-name').value = '';
  $('#speaker-new-role').value = '';
  renderSpeakerOptions();
  renderExecutives();
}));
$('#speaker-form').addEventListener('submit', run(async () => {
  if (busy) return;
  setBusy(true);
  try {
    const result = await api(`documents/${encodeURIComponent(speakerReview.id)}/speakers`, 'POST', {
      assignments: speakerReview.assignments,
    });
    $('#speaker-dialog').close();
    $('#upload-result').textContent = `${result.assignedSegments} speech segments published to ${result.generated.length} executive(s). Unknown speech and visuals excluded. ${dreamingSummary(result)}${result.voiceProfileWarning ? ` ${result.voiceProfileWarning}` : ''}`;
    $('#upload-result').hidden = false;
    await refresh();
  } finally { setBusy(false); }
  if (speakerQueue.length) await openSpeakerReview(speakerQueue.shift());
}));
$('#speaker-save').addEventListener('click', run(async () => {
  if (busy) return;
  setBusy(true);
  try {
    const saved = await api(`documents/${encodeURIComponent(speakerReview.id)}/speakers`, 'POST', {
      draft: true, assignments: speakerReview.assignments,
    });
    savedSpeakerAssignments = [...speakerReview.assignments];
    speakerReview.assignmentsReviewed = true;
    speakerReview.hasVoiceFingerprints = (await api(`documents/${encodeURIComponent(speakerReview.id)}/speakers`)).hasVoiceFingerprints;
    await refreshVoiceMemory();
    if (saved.voiceProfileWarning) $('#speaker-voice-memory-status').textContent += ` ${saved.voiceProfileWarning}`;
  } finally { setBusy(false); }
  $('#speaker-count').textContent += ' Draft saved. You can close and reopen this review later.';
}));
$('#speaker-dialog').addEventListener('close', () => {
  stopSpeakerSample();
  const player = $('#speaker-player video');
  if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
  for (const pending of speakerPreviewCache.values()) pending.then(url => {
    if (url) URL.revokeObjectURL(url);
  }, () => undefined);
  speakerPreviewCache = new Map();
  speakerPlaybackEnd = undefined;
  speakerFrameWanted = undefined;
  $('#speaker-frame-image').removeAttribute('src');
});
function renderSelectedFiles(failed = false) {
  for (const url of attachmentPreviewUrls) URL.revokeObjectURL(url);
  attachmentPreviewUrls = [];
  $('#selected-files').replaceChildren(...selectedFiles.map(file => {
    const item = node('li', 'knowledge-attachment');
    if (isImageFile(file)) {
      const preview = node('img', 'knowledge-attachment-preview');
      const url = URL.createObjectURL(file);
      attachmentPreviewUrls.push(url);
      preview.src = url;
      preview.alt = file.name;
      item.append(preview);
    }
    item.append(node('span', '', `${file.name} (${(file.size / 1024).toFixed(1)} KB)${failed ? ' - not imported' : ''}`));
    const remove = node('button', 'tool-button');
    remove.type = 'button';
    remove.title = `Remove ${file.name}`;
    remove.setAttribute('aria-label', remove.title);
    remove.disabled = busy;
    remove.append(icon('X'));
    remove.addEventListener('click', run(() => selectFiles(selectedFiles.filter(candidate => candidate !== file))));
    item.append(remove);
    return item;
  }));
}
function selectFiles(files) {
  if (!state?.documents) throw new Error(restartMessage);
  const candidates = Array.from(files);
  const emailOnly = candidates.every(file => /\.(eml|msg|mbox)$/i.test(file.name));
  const batchLimit = emailOnly ? state.documents.emailFiles ?? state.documents.files : state.documents.files;
  if (candidates.length > batchLimit) {
    throw new Error(`Select at most ${batchLimit} ${emailOnly ? 'email files' : 'files'} per batch.`);
  }
  for (const file of candidates) {
    const extension = `.${file.name.split('.').pop().toLowerCase()}`;
    if (isMediaFile(file) && !state.media?.participantLabels) throw new Error(restartMessage);
    if (!isMediaFile(file) && !state.documents.extensions.includes(extension)) {
      throw new Error(`Unsupported file: ${file.name}. Use PNG, JPEG, WebP, or a supported document, email, text, video, or audio format. Convert DOC/PPT to DOCX/PPTX.`);
    }
    if (file.name.length > 200) throw new Error(`Filename exceeds 200 characters: ${file.name}`);
    const limit = isMediaFile(file) ? state.video.bytes : state.documents.bytes;
    if (!file.size || file.size > limit) {
      throw new Error(`${file.name}: file must contain data and be at most ${isMediaFile(file) ? '3 GB' : '25 MB'}.`);
    }
  }
  selectedFiles = candidates;
  renderParticipantEditors();
  $('#upload-status').textContent = '';
  $('#analysis-progress').hidden = true;
  $('#upload-details').replaceChildren();
  renderSelectedFiles();
  updateUploadState();
  if (selectedFiles.some(isMediaFile)) {
    $('#upload-status').textContent = state.video.enabled
      ? 'Recording selected: optionally identify participants below.'
      : state.configurationError || 'Recording analysis requires an API key and a transcription endpoint. Configure .env and restart the server.';
  } else if (selectedFiles.some(isImageFile)) {
    $('#upload-status').textContent = state.images?.enabled
      ? 'Pictures will be sent to the configured AI provider for text extraction and description.'
      : state.configurationError || 'Pictures require a configured AI provider and a vision-capable model. Configure the provider or remove the picture to save text only.';
  }
}
  function renderParticipantEditors() {
    for (const [file, editor] of participantEditors) {
      if (!selectedFiles.includes(file)) {
        editor.player.pause();
        editor.player.removeAttribute('src');
        editor.player.load();
        URL.revokeObjectURL(editor.url);
        editor.section.remove();
        participantEditors.delete(file);
      }
    }
    for (const file of selectedFiles.filter(isMediaFile)) {
      if (participantEditors.has(file)) continue;
      const section = node('details', 'participant-editor');
      section.append(node('summary', '', `Optional preview / manual range labels: ${file.name}`),
        node('p', 'hint', 'You can skip this. With Gemini, voices are separated automatically during analysis and you match each voice card to an executive afterwards. These optional range labels only annotate the archived transcript or sampled scene; they do not replace voice grouping. Use seconds or HH:MM:SS.'));
      const player = node(isVideoFile(file) ? 'video' : 'audio');
      player.controls = true;
      player.preload = 'metadata';
      const url = URL.createObjectURL(file);
      player.src = url;
      const time = node('p', 'hint', 'Current time: 00:00:00');
      player.addEventListener('timeupdate', () => { time.textContent = `Current time: ${player.currentTime.toFixed(1)} seconds`; });
      player.addEventListener('error', () => { time.textContent = 'This browser cannot preview the codec. Use a local player to find timestamps; server decoding may still support this file.'; });
      const speech = node('textarea');
      speech.rows = 3;
      speech.maxLength = 4000;
      speech.placeholder = '00:00:00 | 00:00:10 | Alex Morgan\n00:00:10 | 00:00:20 | Jordan Lee';
      const speechLabel = node('label', '', 'Speaking turns: start | end | person (one turn per line)');
      speechLabel.append(speech);
      section.append(player, time, speechLabel,
        node('p', 'hint', 'Leave unknown or simultaneous speakers unlabeled. A transcript segment crossing a label boundary is marked uncertain, not assigned to a person.'));
      let screen;
      if (isVideoFile(file)) {
        screen = node('textarea');
        screen.rows = 2;
        screen.maxLength = 4000;
        screen.placeholder = '00:00:00 | 00:00:20 | Alex Morgan | left tile, blue shirt';
        const screenLabel = node('label', '', 'On-screen people: start | end | person | location/description');
        screenLabel.append(screen);
        section.append(screenLabel, node('p', 'hint', 'Visual labels apply only at these times and locations. A visible person is not assumed to be speaking.'));
      }
      participantEditors.set(file, { section, player, url, speech, screen });
      $('#participant-editors').append(section);
    }
  }
  function participantLabels(file) {
    const editor = participantEditors.get(file);
    const seconds = value => {
      if (!/^(?:\d+:)?(?:\d+:)?\d+(?:\.\d+)?$/.test(value)) throw new Error(`${file.name}: use seconds or HH:MM:SS for participant times.`);
      const parts = value.split(':').map(Number);
      if (parts.length > 1 && parts.slice(1).some(part => part >= 60)) throw new Error(`${file.name}: minutes/seconds must be below 60.`);
      return parts.reduce((total, part) => total * 60 + part, 0);
    };
    const result = [];
    for (const [kind, field] of [['speech', editor.speech], ['screen', editor.screen]]) {
      for (const line of (field?.value || '').split('\n').filter(line => line.trim())) {
        const parts = line.split('|').map(part => part.trim());
        if (parts.length !== (kind === 'speech' ? 3 : 4)) throw new Error(`${file.name}: invalid participant line. Use the displayed start | end | person${kind === 'screen' ? ' | location' : ''} format.`);
        const [start, end, name, cue = ''] = parts;
        result.push({ kind, start: seconds(start), end: seconds(end), name, cue });
      }
    }
    const encoded = JSON.stringify(result);
    if (encoded.length > 6000 || encodeURIComponent(encoded).length > 12000) throw new Error(`${file.name}: participant labels are too large. Use fewer or shorter labels.`);
    return encoded;
  }
$('#file').addEventListener('change', run(() => {
  try {
    if ($('#file').files.length) selectFiles($('#file').files);
  } finally { updateUploadState(); }
}));
$('#clear-files').addEventListener('click', run(() => {
  selectFiles([]);
  $('#file').value = '';
  $('#document-content').focus();
}));
function pasteKnowledge(event) {
  if (busy) return;
  const clipboard = event.clipboardData;
  const files = Array.from(clipboard?.files || []);
  if (!files.length) return;
  event.preventDefault();
  const attachments = files.map(file => {
    if (!file.type.startsWith('image/')) return file;
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.type];
    if (!extension) throw new Error('Paste a PNG, JPEG, or WebP picture.');
    return new File([file], `Pasted picture ${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`, { type: file.type });
  });
  selectFiles([...selectedFiles, ...attachments]);
  const text = clipboard.getData('text/plain');
  if (text) {
    const field = $('#document-content');
    if (field.value.length - (field.selectionEnd - field.selectionStart) + text.length > field.maxLength) throw new Error('Pasted text exceeds the 200,000-character limit.');
    field.setRangeText(text, field.selectionStart, field.selectionEnd, 'end');
  }
}
$('#document-content').addEventListener('paste', event => {
  if (event.clipboardData?.files.length) void run(pasteKnowledge)(event);
});
const uploadDialog = $('#executive-dialog');
const dropZone = $('#drop-zone');
function isFileDrag(event) {
  const transfer = event.dataTransfer;
  if (!transfer) return false;
  return transfer.files.length > 0 ||
    Array.from(transfer.types).includes('Files') ||
    Array.from(transfer.items).some(item => item.kind === 'file');
}
document.addEventListener('dragenter', event => {
  if (!uploadDialog.open || (!uploadDialog.contains(event.target) && !isFileDrag(event))) return;
  if (isFileDrag(event)) dropZone.classList.add('drag-over');
});
document.addEventListener('dragover', event => {
  if (!uploadDialog.open || (!uploadDialog.contains(event.target) && !isFileDrag(event))) return;
  event.preventDefault();
  if (isFileDrag(event)) {
    event.dataTransfer.dropEffect = 'copy';
    dropZone.classList.add('drag-over');
  }
});
document.addEventListener('dragleave', event => {
  if (uploadDialog.open && !uploadDialog.contains(event.relatedTarget)) dropZone.classList.remove('drag-over');
});
document.addEventListener('drop', event => {
  if (!uploadDialog.open || (!uploadDialog.contains(event.target) && !isFileDrag(event))) return;
  event.preventDefault();
  event.stopPropagation();
  dropZone.classList.remove('drag-over');
  clearError();
  if (busy) {
    $('#upload-status').textContent = 'Wait for the current import to finish before adding more files.';
    return;
  }
  const files = Array.from(event.dataTransfer.files);
  $('#upload-editor').hidden = false;
  if (!files.length) {
    const itemFiles = Array.from(event.dataTransfer.items)
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter(Boolean);
    files.push(...itemFiles);
  }
  if (!files.length) {
    $('#upload-status').textContent = 'The drop reached the app, but the browser did not provide a file. Use “Choose files” to select the .eml file instead.';
    return;
  }
  try {
    selectFiles([...selectedFiles, ...files]);
  } catch (error) {
    $('#upload-status').textContent = error.message;
  }
}, true);
$('#upload-form').addEventListener('submit', run(async () => {
  if (busy) return;
  const form = $('#upload-form');
  const input = { ...context(), ...Object.fromEntries(new FormData(form)), title: knowledgeTitle($('#document-content').value) };
  const files = [...selectedFiles];
  if (!files.length && !input.content.trim()) throw new Error('Paste text or add an attachment first.');
  const labels = new Map(files.filter(isMediaFile).map(file => [file, participantLabels(file)]));
  setBusy(true);
  $('#profile-save-status').hidden = true;
  $('#upload-result').hidden = true;
  $('#upload-details').replaceChildren();
  $('#analysis-progress').hidden = true;
  try {
    let message = 'Text added to the knowledge library.';
    const notices = [];
    if (files.length) {
      const failures = [];
      for (const [index, file] of files.entries()) {
        const video = isMediaFile(file);
        const image = isImageFile(file);
        $('#analysis-progress').hidden = !video;
        $('#analysis-progress-bar').removeAttribute('value');
        $('#analysis-progress-label').textContent = `${file.name}: uploading recording...`;
        $('#upload-status').textContent = `${index + 1}/${files.length}: ${file.name} - ${video ? 'uploading and analyzing recording; this may take several minutes' : image ? 'extracting image text and description with AI' : 'extracting document text and Dreaming'}... Keep this page open.`;
        const detail = node('li', '', `${file.name}: processing...`);
        $('#upload-details').append(detail);
        try {
          const query = new URLSearchParams({
            executiveId: input.executiveId, profileId: input.profileId,
            title: file.name, filename: file.name,
            ...(video ? { reviewSpeakers: 'true', progress: 'true', expectedSpeakers: $('#voice-speaker-count').value } : {}),
          });
          const response = await fetch(`/api/${video ? 'media' : 'files'}?${query}`, {
            method: 'POST', headers: {
              'Content-Type': 'application/octet-stream',
              ...(video ? { 'X-Participants': encodeURIComponent(labels.get(file)) } : {}),
            }, body: file,
          });
          const result = await readImportResponse(response, progress => {
            const percent = Math.floor(progress.percent);
            $('#analysis-progress-bar').value = percent;
            $('#analysis-progress-label').textContent = `${file.name}: ${percent}% - ${progress.message}`;
          });
          if (video) {
            $('#analysis-progress-bar').value = 100;
            $('#analysis-progress-label').textContent = `${file.name}: 100% - Analysis saved`;
          }
          if (result.needsSpeakerReview) speakerQueue.push(result.id);
          const summary = video
            ? `${result.frames} sampled frame(s), ${result.hasAudio ? 'timestamped speech' : 'no audio track'}`
            : `${result.characters.toLocaleString()} extracted characters`;
          const warnings = result.warnings?.length ? ` Notice: ${result.warnings.join(' ')}` : '';
          detail.textContent = `${file.name}: ${result.needsSpeakerReview ? 'analyzed; awaiting speaker review before RAG indexing' : 'imported'} (${summary}). ${dreamingSummary(result)}${warnings}`;
          if (result.dreaming?.some(item => ['completed', 'queued'].includes(item.status))) notices.push(dreamingSummary(result));
          if (warnings) notices.push(`${file.name}:${warnings}`);
        } catch (error) {
          if (video) $('#analysis-progress-label').textContent = `${file.name}: analysis failed - ${error.message}`;
          detail.textContent = `${file.name}: FAILED - ${error.message}`;
          detail.className = 'import-error';
          failures.push(file);
        }
      }
      message = `${files.length - failures.length} of ${files.length} files saved.`;
      if (files.some(isMediaFile)) message += ' Recordings await speaker review before RAG indexing. Use Identify speakers in the library to reopen a review.';
      if (failures.length) {
        selectedFiles = failures;
        renderParticipantEditors();
        renderSelectedFiles(true);
        $('#upload-result').textContent = message;
        $('#upload-result').hidden = false;
        await refresh();
        throw new Error(`${failures.length} file(s) failed. See the per-file errors below. Retry imports only the failed files; successful files will not be duplicated.`);
      }
      selectedFiles = [];
      renderParticipantEditors();
      renderSelectedFiles();
      updateUploadState();
      $('#upload-result').textContent = message;
      $('#upload-result').hidden = false;
    }
    if (input.content.trim()) {
      $('#upload-status').textContent = 'Saving text...';
      const result = await api('documents', 'POST', input);
      notices.push(dreamingSummary(result));
      if (files.length) message += ' Pasted text was also added as a separate source.';
    }
    form.reset();
    selectedFiles = [];
    renderParticipantEditors();
    renderSelectedFiles();
    $('#upload-editor').hidden = true;
    knowledgeCategory = 'all';
    $('#knowledge-search').value = '';
    $('#upload-result').textContent = [message, ...notices].join('\n');
    $('#upload-result').hidden = false;
    await refresh();
  } finally {
    $('#upload-status').textContent = '';
    setBusy(false);
  }
  if (speakerQueue.length) await openSpeakerReview(speakerQueue.shift());
}));
$('#chat-form').addEventListener('submit', run(async () => {
  const question = $('#question').value.trim();
  if (!question || busy) return;
  setBusy(true);
  try {
    if (!conversationId) {
      const chat = await api('conversations', 'POST', { ...context(), projectId });
      conversationId = chat.id;
      saveWorkspace();
    }
    const live = showStreamingExchange(question);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...context(), question, stream: true }),
      });
      await readEventStream(response, { delta: event => live.append(event.text) }, 'Chat',
        'The answer was interrupted before it finished. Please ask again.');
    } catch (error) {
      await refresh().catch(() => {});
      throw error;
    } finally { live.done(); }
    $('#question').value = '';
    await refresh();
  } finally { setBusy(false); }
}));
// Shows the question and a growing answer until the saved exchange (with sources) is re-rendered.
function showStreamingExchange(question) {
  const messages = $('#messages');
  messages.querySelector('.empty')?.remove();
  const asked = node('article', 'message user');
  asked.append(node('div', 'message-label', 'YOU'), node('div', 'message-text', question));
  const card = node('article', 'message assistant streaming');
  const text = node('div', 'message-text');
  card.append(node('div', 'message-label', 'AI REPRESENTATION · WRITING…'), text);
  messages.setAttribute('aria-busy', 'true');
  messages.append(asked, card);
  messages.scrollTop = messages.scrollHeight;
  return {
    append(piece) {
      const following = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
      text.textContent += piece;
      if (following) messages.scrollTop = messages.scrollHeight;
    },
    done() {
      card.classList.remove('streaming');
      messages.removeAttribute('aria-busy');
    },
  };
}
$('#question').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (!busy) $('#chat-form').requestSubmit();
  }
});
setBusy(true);
run(async () => {
  await loadState();
  setBusy(false);
  renderDreamingIndicator();
  if (state.dreaming?.status) {
    await pollDreaming();
  }
})();
