const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  conversations: [],
  selectedId: null,
  conversation: null,
  messages: [],
  events: [],
  snapshots: [],
  langfuse: null,
  eventSource: null,
  liveDraft: null,
  followLiveOutput: true,
  activeTab: "details",
};

const terminalStatuses = new Set(["stopped", "timed_out", "completed", "failed"]);
let conversationRefreshTimer = null;
let langfuseRefreshTimer = null;
let programmaticMessageScroll = false;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail || body);
    } catch (_) { /* response was not JSON */ }
    throw new Error(detail);
  }
  return response.json();
}

function shortId(id) { return id ? id.slice(0, 8) : "—"; }
function compact(text, max = 74) { return text.length > max ? `${text.slice(0, max)}…` : text; }
function fmtDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
function fmtDuration(ms) {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
function fmtNumber(value) { return value == null ? "—" : new Intl.NumberFormat("ru-RU").format(value); }
function statusLabel(status) { return String(status || "unknown").replaceAll("_", " "); }

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

async function checkHealth() {
  try {
    const health = await api("/health/ready");
    $("#database-status").className = `status-square ${health.database}`;
    $("#langfuse-status").className = `status-square ${health.langfuse}`;
  } catch (_) {
    $("#database-status").className = "status-square unknown";
    $("#langfuse-status").className = "status-square unknown";
  }
}

async function loadConversations({ selectFirst = false } = {}) {
  const filter = $("#status-filter").value;
  const query = new URLSearchParams({ limit: "200" });
  if (filter) query.set("status", filter);
  const page = await api(`/v1/conversations?${query}`);
  state.conversations = page.items;
  renderConversationList();
  if (selectFirst && !state.selectedId && page.items.length) selectConversation(page.items[0].id);
}

function scheduleConversationRefresh() {
  if (conversationRefreshTimer) return;
  conversationRefreshTimer = setTimeout(() => {
    conversationRefreshTimer = null;
    loadConversations().catch(() => {});
  }, 1000);
}

function scheduleLangfuseRefresh() {
  if (langfuseRefreshTimer) return;
  langfuseRefreshTimer = setTimeout(() => {
    langfuseRefreshTimer = null;
    if (state.selectedId) loadLangfuse(state.selectedId);
  }, 1500);
}

function renderConversationList() {
  const list = $("#conversation-list");
  const search = $("#conversation-search").value.trim().toLowerCase();
  const items = state.conversations.filter((item) => !search || item.task_prompt.toLowerCase().includes(search) || item.id.includes(search));
  list.replaceChildren();
  if (!items.length) {
    list.append(node("div", "empty-list", "No conversations found."));
    return;
  }
  for (const item of items) {
    const card = node("article", `conversation-card${item.id === state.selectedId ? " active" : ""}`);
    card.dataset.id = item.id;
    const top = node("div", "conversation-card-top");
    top.append(node("span", `status-pill ${item.status}`, statusLabel(item.status)), node("span", "message-meta", `${item.turn_count} turns`));
    card.append(top, node("div", "conversation-card-title", item.task_prompt));
    const meta = node("div", "conversation-card-meta");
    meta.append(node("span", "", shortId(item.id)), node("span", "", fmtDate(item.updated_at)));
    card.append(meta);
    card.addEventListener("click", () => selectConversation(item.id));
    list.append(card);
  }
}

async function fetchAllMessages(id) {
  const messages = [];
  let after = 0;
  while (true) {
    const page = await api(`/v1/conversations/${id}/messages?after_sequence=${after}&limit=1000`);
    messages.push(...page.items);
    if (!page.next_after_sequence) return messages;
    after = page.next_after_sequence;
  }
}

async function selectConversation(id) {
  if (state.selectedId === id && state.conversation) return;
  closeEventSource();
  state.selectedId = id;
  state.liveDraft = null;
  renderConversationList();
  setStreamState("connecting", "connecting");
  try {
    const [conversation, messages, events, snapshots] = await Promise.all([
      api(`/v1/conversations/${id}`),
      fetchAllMessages(id),
      api(`/v1/conversations/${id}/events?limit=5000`),
      api(`/v1/conversations/${id}/context-snapshots`),
    ]);
    if (state.selectedId !== id) return;
    state.conversation = conversation;
    state.messages = messages;
    state.events = events;
    state.snapshots = snapshots;
    state.langfuse = null;
    renderAll();
    connectEventSource(id);
    loadLangfuse(id);
  } catch (error) {
    showToast(`Cannot load conversation: ${error.message}`);
    setStreamState("offline", "error");
  }
}

function renderAll() {
  $("#empty-state").classList.add("hidden");
  $("#conversation-view").classList.remove("hidden");
  renderHeader();
  renderStats();
  renderMessages();
  renderInspector();
  renderConversationList();
}

function renderHeader() {
  const convo = state.conversation;
  if (!convo) return;
  $("#conversation-title").textContent = compact(convo.task_prompt, 92);
  $("#conversation-meta").textContent = `${shortId(convo.id)} · ${statusLabel(convo.status)} · next ${convo.next_speaker}`;
  $("#task-prompt").textContent = convo.task_prompt;
  const stop = $("#stop-conversation");
  stop.classList.toggle("hidden", terminalStatuses.has(convo.status));
  const link = $("#langfuse-link");
  link.classList.toggle("hidden", !convo.langfuse_url);
  if (convo.langfuse_url) link.href = convo.langfuse_url;
}

function renderStats() {
  const totalTokens = state.messages.reduce((sum, item) => sum + (item.prompt_tokens || 0) + (item.completion_tokens || 0), 0);
  const avgLatency = state.messages.length ? Math.round(state.messages.reduce((sum, item) => sum + item.latency_ms, 0) / state.messages.length) : null;
  const streamed = state.messages.filter((item) => item.streamed).length;
  const stats = [
    ["Turns", state.messages.length],
    ["Total tokens", fmtNumber(totalTokens)],
    ["Avg latency", fmtDuration(avgLatency)],
    ["Streamed", `${streamed}/${state.messages.length}`],
  ];
  const row = $("#stats-row"); row.replaceChildren();
  for (const [label, value] of stats) {
    const card = node("div", "stat"); card.append(node("span", "", label), node("strong", "", String(value))); row.append(card);
  }
}

function messageElement(message, live = false) {
  const article = node("article", `message ${message.speaker}${live ? " live" : ""}`);
  article.dataset.sequence = message.sequence;
  article.append(node("div", "avatar", message.speaker === "agent_a" ? "A" : "B"));
  const body = node("div", "message-body");
  const head = node("div", "message-head");
  head.append(node("span", "message-name", message.speaker === "agent_a" ? "Agent A" : "Agent B"), node("span", "message-meta", `#${message.sequence} · ${message.model || "generating"}`));
  const content = node("div", "message-content");
  if (live || !globalThis.AgentRelayMarkdown) {
    content.textContent = message.content || "";
  } else {
    content.innerHTML = globalThis.AgentRelayMarkdown.render(message.content || "");
  }
  body.append(head, content);
  if (!live) {
    const metrics = node("div", "message-metrics");
    metrics.append(
      node("span", "", fmtDuration(message.latency_ms)),
      node("span", "", `TTFT ${fmtDuration(message.first_token_ms)}`),
      node("span", "", `${fmtNumber(message.prompt_tokens)} in`),
      node("span", "", `${fmtNumber(message.completion_tokens)} out`),
      node("span", "", message.streamed ? "stream" : "response"),
      node("span", "", `${message.attempts} attempt${message.attempts === 1 ? "" : "s"}`),
    );
    body.append(metrics);
  }
  article.append(body);
  return article;
}

function messageListIsAtBottom() {
  const container = $("#message-stream");
  return container.scrollHeight - container.scrollTop - container.clientHeight <= 2;
}

function scrollMessagesToBottom() {
  const container = $("#message-stream");
  state.followLiveOutput = true;
  programmaticMessageScroll = true;
  container.scrollTop = container.scrollHeight;
  requestAnimationFrame(() => { programmaticMessageScroll = false; });
}

function renderTypingState() {
  const banner = $("#typing-banner");
  banner.classList.toggle("hidden", !state.liveDraft || Boolean(state.liveDraft.content));
  if (state.liveDraft) $("#typing-label").textContent = `${state.liveDraft.speaker === "agent_a" ? "Agent A" : "Agent B"} is thinking`;
}

function renderMessages({ scrollToBottom = true } = {}) {
  const container = $("#message-stream");
  const shouldScroll = scrollToBottom || state.followLiveOutput;
  container.replaceChildren(...state.messages.map((message) => messageElement(message)));
  if (state.liveDraft) container.append(messageElement({ ...state.liveDraft, model: state.liveDraft.model || "generating" }, true));
  renderTypingState();
  if (shouldScroll) scrollMessagesToBottom();
}

function beginLiveMessage(data) {
  if (data.sequence <= Math.max(0, ...state.messages.map((item) => item.sequence))) return false;
  if (state.liveDraft?.sequence === data.sequence) return true;
  const container = $("#message-stream");
  const shouldScroll = state.followLiveOutput;
  container.querySelector(".message.live")?.remove();
  state.liveDraft = { sequence: data.sequence, speaker: data.speaker, model: data.model, content: "" };
  container.append(messageElement({ ...state.liveDraft, model: state.liveDraft.model || "generating" }, true));
  renderTypingState();
  if (shouldScroll) scrollMessagesToBottom();
  return true;
}

function updateLiveMessage(data, { reset = false } = {}) {
  if (!state.liveDraft || state.liveDraft.sequence !== data.sequence) {
    if (!beginLiveMessage(data)) return;
  }
  const shouldScroll = state.followLiveOutput;
  state.liveDraft.content = reset ? "" : state.liveDraft.content + (data.content || "");
  const live = $("#message-stream .message.live");
  if (live) live.querySelector(".message-content").textContent = state.liveDraft.content;
  renderTypingState();
  if (shouldScroll) scrollMessagesToBottom();
}

function removeLiveMessage() {
  state.liveDraft = null;
  $("#message-stream .message.live")?.remove();
  renderTypingState();
}

function renderInspector() {
  renderDetails(); renderContext(); renderEvents(); renderLangfuse();
}

function addKv(parent, key, value) {
  const row = node("div", "kv"); row.append(node("span", "", key), node("strong", "", value == null ? "—" : String(value))); parent.append(row);
}

function renderDetails() {
  const panel = $("#tab-details"); panel.replaceChildren();
  const convo = state.conversation; if (!convo) return;
  const status = node("div", "inspect-section"); status.append(node("h3", "", "Run"));
  addKv(status, "Status", statusLabel(convo.status)); addKv(status, "ID", convo.id); addKv(status, "Created", fmtDate(convo.created_at)); addKv(status, "Deadline", fmtDate(convo.deadline_at)); addKv(status, "Turns", convo.turn_count); addKv(status, "Context", fmtNumber(convo.context_size)); addKv(status, "Compression", `${Math.round(convo.compression_threshold * 100)}%`);
  panel.append(status);
  for (const [key, label] of [["agent_a", "Agent A"], ["agent_b", "Agent B"]]) {
    const config = convo.config[key]; const section = node("div", "inspect-section"); section.append(node("h3", "", label));
    addKv(section, "Model", config.model); addKv(section, "Endpoint", config.base_url); addKv(section, "Streaming", config.stream); addKv(section, "Max tokens", config.parameters.max_tokens); addKv(section, "Temperature", config.parameters.temperature); addKv(section, "Context", fmtNumber(config.context_size || convo.context_size)); addKv(section, "Compression", `${Math.round((config.compression_threshold || convo.compression_threshold) * 100)}%`); addKv(section, "Recent", config.retain_recent_messages || convo.retain_recent_messages);
    const prompt = node("div", "prompt-block"); prompt.append(node("b", "", "System prompt"), node("p", "", config.system_prompt)); section.append(prompt); panel.append(section);
  }
  if (convo.error) { const error = node("div", "inline-error", convo.error); panel.prepend(error); }
}

function renderContext() {
  const panel = $("#tab-context"); panel.replaceChildren();
  if (!state.snapshots.length) { panel.append(node("div", "placeholder-copy", "The context has not been compressed yet.")); return; }
  for (const snapshot of [...state.snapshots].reverse()) {
    const block = node("div", "summary-block");
    block.append(node("b", "", `Summary v${snapshot.version} · through #${snapshot.through_sequence}`), node("p", "", snapshot.summary));
    const meta = node("div", "message-metrics"); meta.append(node("span", "", `source #${snapshot.source_from_sequence}–${snapshot.source_to_sequence}`), node("span", "", `${fmtNumber(snapshot.estimated_input_tokens)} → ${fmtNumber(snapshot.estimated_output_tokens)} est. tokens`), node("span", "", fmtDate(snapshot.created_at))); block.append(meta); panel.append(block);
  }
}

function renderEvents() {
  const panel = $("#tab-events"); panel.replaceChildren();
  if (!state.events.length) { panel.append(node("div", "placeholder-copy", "No durable events yet.")); return; }
  for (const event of [...state.events].reverse()) {
    const card = node("div", "event-card"); const header = node("header"); header.append(node("strong", "", event.event_type), node("time", "", fmtDate(event.created_at))); card.append(header, node("pre", "", JSON.stringify(event.payload, null, 2))); panel.append(card);
  }
}

function renderLangfuse() {
  const panel = $("#tab-langfuse"); panel.replaceChildren();
  if (!state.conversation) return;
  if (!state.langfuse) { panel.append(node("div", "placeholder-copy", "Loading observations from Langfuse…")); return; }
  if (state.langfuse.url) { const section = node("div", "inspect-section"); const link = node("a", "inline-link", `Open trace ${shortId(state.langfuse.trace_id)} ↗`); link.href = state.langfuse.url; link.target = "_blank"; link.rel = "noreferrer"; section.append(link); panel.append(section); }
  if (state.langfuse.error) panel.append(node("div", "inline-error", `Langfuse: ${state.langfuse.error}`));
  if (!state.langfuse.observations.length) { panel.append(node("div", "placeholder-copy", "No observations are queryable yet. Active traces can take a moment to flush.")); return; }
  for (const observation of state.langfuse.observations) {
    const type = String(observation.type || observation.observation_type || "span").toLowerCase();
    const card = node("div", `observation-card ${type}`); const header = node("header"); header.append(node("strong", "", observation.name || type), node("time", "", type)); card.append(header);
    const summary = { model: observation.model, startTime: observation.startTime || observation.start_time, endTime: observation.endTime || observation.end_time, usage: observation.usageDetails || observation.usage_details, level: observation.level, status: observation.statusMessage || observation.status_message };
    card.append(node("pre", "", JSON.stringify(summary, null, 2))); panel.append(card);
  }
}

async function loadLangfuse(id) {
  try { state.langfuse = await api(`/v1/conversations/${id}/langfuse?limit=200`); }
  catch (error) { state.langfuse = { enabled: false, observations: [], error: error.message }; }
  if (state.selectedId === id) renderLangfuse();
}

function upsertMessage(message) {
  const index = state.messages.findIndex((item) => item.sequence === message.sequence);
  if (index >= 0) state.messages[index] = message; else state.messages.push(message);
  state.messages.sort((a, b) => a.sequence - b.sequence);
}

function setStreamState(mode, label) {
  const element = $("#stream-state"); element.className = `stream-state ${mode}`; element.lastChild.textContent = ` ${label}`;
}

function closeEventSource() {
  if (state.eventSource) state.eventSource.close(); state.eventSource = null;
}

function connectEventSource(id) {
  closeEventSource();
  const source = new EventSource(`/v1/conversations/${id}/stream`); state.eventSource = source;
  source.onopen = () => setStreamState("live", "live");
  source.onerror = () => setStreamState("connecting", "reconnecting");

  source.addEventListener("ready", async (event) => {
    const data = JSON.parse(event.data); if (state.selectedId !== id) return;
    state.conversation = data.conversation; renderHeader();
    const currentLastSequence = Math.max(0, ...state.messages.map((item) => item.sequence));
    if (data.last_sequence > currentLastSequence) {
      try { state.messages = await fetchAllMessages(id); renderStats(); renderMessages(); } catch (_) { /* next reconciliation will recover */ }
    }
  });

  source.addEventListener("turn_started", (event) => beginLiveMessage(JSON.parse(event.data)));
  source.addEventListener("turn_stream_started", (event) => {
    updateLiveMessage(JSON.parse(event.data), { reset: true });
  });
  source.addEventListener("turn_delta", (event) => {
    updateLiveMessage(JSON.parse(event.data));
  });
  source.addEventListener("turn_completed", async (event) => {
    const data = JSON.parse(event.data);
    const container = $("#message-stream");
    const shouldScroll = state.followLiveOutput;
    if (data.message) {
      upsertMessage(data.message);
      const existing = container.querySelector(`[data-sequence="${data.message.sequence}"]`);
      const completed = messageElement(data.message);
      if (existing) existing.replaceWith(completed); else container.append(completed);
    } else {
      const previousScrollTop = container.scrollTop;
      try { state.messages = await fetchAllMessages(id); renderMessages({ scrollToBottom: shouldScroll }); } catch (_) {}
      if (!shouldScroll) container.scrollTop = previousScrollTop;
    }
    state.liveDraft = null;
    container.querySelector(".message.live")?.remove();
    renderTypingState();
    if (state.conversation) { state.conversation.turn_count = state.messages.length; state.conversation.next_speaker = data.next_speaker || state.conversation.next_speaker; }
    renderHeader(); renderStats(); if (shouldScroll) scrollMessagesToBottom(); scheduleConversationRefresh(); scheduleLangfuseRefresh();
  });
  source.addEventListener("context_compressed", async () => { try { state.snapshots = await api(`/v1/conversations/${id}/context-snapshots`); renderContext(); } catch (_) {} });

  const statusEvents = ["conversation_queued", "conversation_started", "conversation_stopped", "conversation_timed_out", "conversation_completed", "conversation_failed", "conversation_status"];
  for (const eventName of statusEvents) source.addEventListener(eventName, async (event) => {
    const data = JSON.parse(event.data); if (state.conversation && data.status) state.conversation.status = data.status;
    if (eventName === "conversation_started" && state.conversation) state.conversation.status = "running";
    if (eventName.startsWith("conversation_") && !["conversation_started", "conversation_queued", "conversation_status"].includes(eventName) && state.conversation) state.conversation.status = eventName.replace("conversation_", "");
    if (data.error && state.conversation) state.conversation.error = data.error;
    renderHeader(); renderDetails(); scheduleConversationRefresh();
    if (state.conversation && terminalStatuses.has(state.conversation.status)) { source.close(); setStreamState("offline", state.conversation.status); removeLiveMessage(); scheduleLangfuseRefresh(); }
  });
}

async function stopConversation() {
  if (!state.selectedId) return;
  const button = $("#stop-conversation"); button.disabled = true;
  try { const result = await api(`/v1/conversations/${state.selectedId}/end`, { method: "POST", body: "{}" }); if (state.conversation) state.conversation.status = result.status; renderHeader(); showToast("Conversation stopped"); }
  catch (error) { showToast(`Stop failed: ${error.message}`); }
  finally { button.disabled = false; }
}

function openDialog() { $("#form-error").classList.add("hidden"); $("#start-dialog").showModal(); }
function closeDialog() { $("#start-dialog").close(); }

function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const random = globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint32Array(2)).join("-")
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `web-${random}`;
}

async function startConversation(event) {
  event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form));
  const submit = $("#submit-conversation"); const errorBox = $("#form-error"); submit.disabled = true; submit.textContent = "Starting…"; errorBox.classList.add("hidden");
  const agent = (prefix) => ({
    system_prompt: values[`${prefix}_system_prompt`],
    model: values[`${prefix}_model`],
    base_url: values[`${prefix}_base_url`],
    api_key_env: null,
    stream: values[`${prefix}_stream`],
    request_timeout_seconds: Number(values[`${prefix}_request_timeout`]),
    max_retries: Number(values[`${prefix}_max_retries`]),
    context_size: Number(values[`${prefix}_context_size`]),
    compression_threshold: Number(values[`${prefix}_compression_threshold`]),
    retain_recent_messages: Number(values[`${prefix}_retain_recent_messages`]),
    extra_body: values[`${prefix}_disable_thinking`] ? { chat_template_kwargs: { enable_thinking: false } } : {},
    parameters: {
      temperature: Number(values[`${prefix}_temperature`]),
      max_tokens: Number(values[`${prefix}_max_tokens`]),
      top_p: Number(values[`${prefix}_top_p`]),
      frequency_penalty: Number(values[`${prefix}_frequency_penalty`]),
      presence_penalty: Number(values[`${prefix}_presence_penalty`]),
      seed: values[`${prefix}_seed`] === "" ? null : Number(values[`${prefix}_seed`]),
    },
  });
  const agentA = agent("agent_a"); const agentB = agent("agent_b");
  const body = {
    task_prompt: values.task_prompt,
    agent_a: agentA,
    agent_b: agentB,
    context_size: Math.min(agentA.context_size, agentB.context_size),
    compression_threshold: Math.min(agentA.compression_threshold, agentB.compression_threshold),
    retain_recent_messages: Math.min(agentA.retain_recent_messages, agentB.retain_recent_messages),
    timeout_seconds: Number(values.timeout_seconds),
  };
  try {
    const created = await api("/v1/conversations", { method: "POST", headers: { "Idempotency-Key": newIdempotencyKey() }, body: JSON.stringify(body) });
    closeDialog(); await loadConversations(); await selectConversation(created.conversation_id); showToast("Conversation started");
  } catch (error) { errorBox.textContent = error.message; errorBox.classList.remove("hidden"); }
  finally { submit.disabled = false; submit.textContent = "Start conversation"; }
}

function initTabs() {
  for (const button of $$(".inspector-tabs button")) button.addEventListener("click", () => {
    state.activeTab = button.dataset.tab; $$(".inspector-tabs button").forEach((item) => item.classList.toggle("active", item === button)); $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${state.activeTab}`));
    if (state.activeTab === "langfuse" && state.selectedId) loadLangfuse(state.selectedId);
  });
}

async function init() {
  $("#new-conversation").addEventListener("click", openDialog); $("#empty-new").addEventListener("click", openDialog); $("#close-dialog").addEventListener("click", closeDialog); $("#cancel-dialog").addEventListener("click", closeDialog); $("#start-form").addEventListener("submit", startConversation); $("#stop-conversation").addEventListener("click", stopConversation);
  $("#start-form").addEventListener("invalid", (event) => {
    const details = event.target.closest("details"); if (details) details.open = true;
    const errorBox = $("#form-error"); errorBox.textContent = "Check the highlighted field."; errorBox.classList.remove("hidden");
  }, true);
  const messageStream = $("#message-stream");
  messageStream.addEventListener("wheel", (event) => {
    if (event.deltaY < 0) state.followLiveOutput = false;
  }, { passive: true });
  messageStream.addEventListener("touchstart", () => { state.followLiveOutput = false; }, { passive: true });
  messageStream.addEventListener("keydown", (event) => {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) state.followLiveOutput = false;
  });
  messageStream.addEventListener("scroll", () => {
    if (!programmaticMessageScroll) state.followLiveOutput = messageListIsAtBottom();
  }, { passive: true });
  $("#conversation-search").addEventListener("input", renderConversationList); $("#status-filter").addEventListener("change", () => loadConversations()); initTabs();
  await checkHealth(); try { await loadConversations({ selectFirst: true }); } catch (error) { showToast(error.message); }
  setInterval(checkHealth, 30000); setInterval(() => loadConversations().catch(() => {}), 10000);
}

window.addEventListener("beforeunload", closeEventSource);
init();
