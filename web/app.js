const state = {
  ws: null,
  username: "",
  rememberToken: "",
  attemptedTokenAuth: false,
  role: "member",
  channel: "general",
  channels: [],
  users: [],
  friends: [],
  incomingRequests: [],
  voiceRooms: [],
  voiceState: {},
  currentVoiceRoom: "",
  selectedFriend: "",
  selectedRequest: "",
  selectedVoiceRoom: "",
  selectedUser: "",
  profiles: {},
  authMode: "login",
  isAuthed: false,
  notifications: [],
  blockedUsers: [],
  bookmarkedMessages: new Set(),
  userSearch: "",
  reconnectAttempts: 0,
  maxReconnectAttempts: 10,
  userStatus: "online", // Feature 1: User presence status
  customStatus: "", // Feature 1b: Custom status message
  favorites: new Set(), // Feature 2: Favorite channels/users
  unreadCount: {}, // Feature 3: Unread message counts
  pinnedMessages: new Map(), // Feature 4: Pinned messages per channel
  messageThreads: new Map(), // Feature 5: Message threads/replies
  userTypingStatus: {}, // Feature 6: Who's typing
  recentMentions: [], // Feature 7: @mentions tracking
  rtc: {
    pc: null,
    localStream: null,
    peer: "",
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  },
};

const $ = (id) => document.getElementById(id);

const channelsEl = $("channels");
const usersEl = $("users");
const messagesEl = $("messages");
const inputEl = $("messageInput");
const sendBtn = $("sendBtn");
const statusText = $("statusText");
const roleBadge = $("roleBadge");
const channelTitle = $("channelTitle");
const channelMeta = $("channelMeta");
const authForm = $("authForm");
const authView = $("authView");
const appView = $("appView");
const authStatus = $("authStatus");
const authTitle = $("authTitle");
const authSubtitle = $("authSubtitle");
const authSubmitBtn = $("authSubmitBtn");
const showLoginBtn = $("showLoginBtn");
const showRegisterBtn = $("showRegisterBtn");
const selfUser = $("selfUser");
const selfAvatarEl = $("selfAvatar");
const rememberMe = $("rememberMe");
const callPanel = $("callPanel");
const callStatus = $("callStatus");
const localVideo = $("localVideo");
const remoteVideo = $("remoteVideo");
const friendsListEl = $("friendsList");
const friendRequestsListEl = $("friendRequestsList");
const voiceRoomsListEl = $("voiceRoomsList");
const voiceRoomMetaEl = $("voiceRoomMeta");
const usersMetaEl = $("usersMeta");
const friendsMetaEl = $("friendsMeta");
const requestsMetaEl = $("requestsMeta");

const REMEMBER_KEY = "pychatter.remember.v1";

function loadRemember() {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.username !== "string" || typeof parsed.token !== "string") return null;
    return {
      username: parsed.username.trim().toLowerCase(),
      token: parsed.token.trim(),
    };
  } catch {
    return null;
  }
}

function saveRemember(username, token) {
  const payload = {
    username: username.trim().toLowerCase(),
    token: token.trim(),
  };
  localStorage.setItem(REMEMBER_KEY, JSON.stringify(payload));
  state.rememberToken = payload.token;
}

function clearRemember() {
  localStorage.removeItem(REMEMBER_KEY);
  state.rememberToken = "";
}

function attemptTokenLogin() {
  const remembered = loadRemember();
  if (!remembered) return false;
  if (!remembered.token || !remembered.username) {
    clearRemember();
    return false;
  }
  state.attemptedTokenAuth = true;
  state.rememberToken = remembered.token;
  $("usernameInput").value = remembered.username;
  authStatus.textContent = "Signing in automatically...";
  send({ type: "auth", action: "token", token: remembered.token });
  return true;
}

function setAuthMode(mode) {
  state.authMode = mode;
  const isLogin = mode === "login";
  showLoginBtn.classList.toggle("active", isLogin);
  showRegisterBtn.classList.toggle("active", !isLogin);
  authTitle.textContent = isLogin ? "Welcome back" : "Create your account";
  authSubtitle.textContent = isLogin
    ? "Log in to continue chatting with your server."
    : "Register once, then jump into channels and DMs.";
  authSubmitBtn.textContent = isLogin ? "Sign In" : "Register";
  authStatus.textContent = "";
}

function setAuthenticated(isAuthed) {
  state.isAuthed = isAuthed;
  authView.classList.toggle("hidden", isAuthed);
  appView.classList.toggle("hidden", !isAuthed);
  if (!isAuthed) {
    state.selectedFriend = "";
    state.selectedRequest = "";
    state.selectedVoiceRoom = "";
    state.currentVoiceRoom = "";
  }
  syncActionButtons();
}

function connectSocket() {
  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  const candidates = [`${wsProtocol}://${location.host}/ws`, `${wsProtocol}://${location.hostname}:9011/ws`];

  const connectAt = (index) => {
    if (index >= candidates.length) {
      statusText.textContent = "WebSocket unavailable";
      setAuthenticated(false);
      return;
    }

    const ws = new WebSocket(candidates[index]);
    let opened = false;

    ws.addEventListener("open", () => {
      opened = true;
      state.ws = ws;
      statusText.textContent = "Connected";
      if (!attemptTokenLogin()) {
        setAuthenticated(false);
        setAuthMode("login");
      }
    });

    ws.addEventListener("close", () => {
      if (!opened) {
        connectAt(index + 1);
        return;
      }
      statusText.textContent = "Disconnected";
      endCall(false);
      setAuthenticated(false);
      syncActionButtons();
    });

    ws.addEventListener("message", (event) => {
      const packet = JSON.parse(event.data);
      handlePacket(packet);
    });
  };

  connectAt(0);
}

function send(packet) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify(packet));
}

function selectedTarget() {
  return state.selectedFriend || state.selectedUser || "";
}

function mergeProfiles(profiles) {
  if (!profiles || typeof profiles !== "object") return;
  Object.entries(profiles).forEach(([username, profile]) => {
    if (!username || !profile || typeof profile !== "object") return;
    state.profiles[String(username).toLowerCase()] = {
      avatar_url: String(profile.avatar_url || ""),
      name_color: String(profile.name_color || ""),
      role: String(profile.role || "member"),
    };
  });
}

function profileFor(username) {
  return state.profiles[String(username || "").toLowerCase()] || { avatar_url: "", name_color: "", role: "member" };
}

const ROLE_GROUP_ORDER = ["admin", "mod", "member"];
const ROLE_GROUP_LABELS = { admin: "Admins", mod: "Moderators", member: "Online" };

function applySelfAvatar() {
  if (!selfAvatarEl) return;
  const profile = profileFor(state.username);
  const initial = (state.username || "?").slice(0, 1).toUpperCase();
  if (profile.avatar_url) {
    selfAvatarEl.style.backgroundImage = `url(${profile.avatar_url})`;
    selfAvatarEl.style.backgroundSize = "cover";
    selfAvatarEl.style.backgroundPosition = "center";
    selfAvatarEl.textContent = "";
  } else {
    selfAvatarEl.style.backgroundImage = "";
    selfAvatarEl.textContent = initial;
  }
}

function ensureDefaultTarget() {
  if (selectedTarget()) return;
  const fromUsers = state.users.find((name) => name && name !== state.username);
  const fromFriends = state.friends.find((name) => name && name !== state.username);
  const fallback = fromUsers || fromFriends || "";
  if (!fallback) return;
  state.selectedUser = fallback;
  if (state.friends.includes(fallback)) {
    state.selectedFriend = fallback;
  }
}

function setCallStatus(text) {
  callStatus.textContent = text;
}

function getPeer() {
  return state.rtc.peer;
}

function getConnection() {
  return state.rtc.pc;
}

async function loadRtcConfig() {
  try {
    const res = await fetch("/_rtc_config", { cache: "no-store" });
    if (!res.ok) return;
    const payload = await res.json();
    if (Array.isArray(payload.iceServers) && payload.iceServers.length) {
      state.rtc.iceServers = payload.iceServers;
    }
  } catch {
    // Keep default STUN-only fallback.
  }
}

async function ensureLocalMedia(mode = "video") {
  if (state.rtc.localStream) return state.rtc.localStream;
  const wantsVideo = mode !== "voice";
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantsVideo });
  state.rtc.localStream = stream;
  localVideo.srcObject = stream;
  return stream;
}

async function createPeerConnection(peerUser, mode = "video") {
  const pc = new RTCPeerConnection({
    iceServers: state.rtc.iceServers,
  });
  state.rtc.pc = pc;
  state.rtc.peer = peerUser;

  pc.onicecandidate = (event) => {
    if (!event.candidate || !getPeer()) return;
    send({
      type: "rtc_signal",
      to: getPeer(),
      signalType: "ice",
      candidate: event.candidate,
    });
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      remoteVideo.srcObject = stream;
    }
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "connected") {
      setCallStatus(`In call with ${getPeer()}`);
    } else if (["failed", "closed", "disconnected"].includes(st)) {
      endCall(false);
      setCallStatus("Call ended");
    }
  };

  const stream = await ensureLocalMedia(mode);
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  callPanel.classList.remove("hidden");
  return pc;
}

async function startCall(mode = "video") {
  const targetName = selectedTarget();
  if (!targetName) {
    showError("Select a friend or user first");
    return;
  }
  const target = targetName.toLowerCase();
  if (target === state.username) {
    showError("You cannot call yourself.");
    return;
  }
  if (getConnection()) {
    endCall(true);
  }

  try {
    setCallStatus(`Calling ${target}...`);
    const pc = await createPeerConnection(target, mode);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({
      type: "rtc_signal",
      to: target,
      signalType: "offer",
      mediaType: mode,
      sdp: pc.localDescription,
    });
  } catch (err) {
    let hint = String(err || "unknown error");
    if (err && typeof err === "object" && "name" in err) {
      const name = String(err.name || "");
      if (name === "NotAllowedError") {
        hint = "Mic/camera permission was denied. Allow browser permissions and try again.";
      } else if (name === "NotFoundError") {
        hint = "No microphone/camera device found.";
      } else if (name === "NotReadableError") {
        hint = "Mic/camera is busy in another app.";
      }
    }
    if (!window.isSecureContext) {
      hint = "Voice/video requires HTTPS (or localhost). Open the app over HTTPS and retry.";
    }
    setCallStatus("Call failed to start");
    endCall(false);
    addMessage("System", `Could not start call: ${hint}`, "system");
  }
}

async function handleRtcSignal(packet) {
  const from = (packet.from || "").toLowerCase();
  const signalType = packet.signalType;
  if (!from || !signalType) return;

  try {
    if (signalType === "offer") {
      if (getConnection()) {
        endCall(true);
      }
      setCallStatus(`Incoming call from ${from}...`);
      const mode = packet.mediaType === "voice" ? "voice" : "video";
      const pc = await createPeerConnection(from, mode);
      await pc.setRemoteDescription(new RTCSessionDescription(packet.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({
        type: "rtc_signal",
        to: from,
        signalType: "answer",
        sdp: pc.localDescription,
      });
      setCallStatus(`In call with ${from}`);
      return;
    }

    if (!getConnection() || getPeer() !== from) {
      return;
    }

    if (signalType === "answer" && packet.sdp) {
      await getConnection().setRemoteDescription(new RTCSessionDescription(packet.sdp));
      setCallStatus(`In call with ${from}`);
    } else if (signalType === "ice" && packet.candidate) {
      await getConnection().addIceCandidate(new RTCIceCandidate(packet.candidate));
    } else if (signalType === "hangup") {
      endCall(false);
      setCallStatus(`${from} ended the call`);
    }
  } catch (err) {
    addMessage("System", `Call signaling error: ${err}`, "system");
  }
}

function endCall(sendHangup) {
  const peer = getPeer();
  if (sendHangup && peer) {
    send({ type: "rtc_signal", to: peer, signalType: "hangup" });
  }

  if (state.rtc.pc) {
    try {
      state.rtc.pc.onicecandidate = null;
      state.rtc.pc.ontrack = null;
      state.rtc.pc.close();
    } catch {
      // ignore close errors
    }
  }
  state.rtc.pc = null;
  state.rtc.peer = "";

  if (state.rtc.localStream) {
    state.rtc.localStream.getTracks().forEach((t) => t.stop());
    state.rtc.localStream = null;
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  callPanel.classList.add("hidden");
  syncActionButtons();
}

function toggleLocalTrack(kind) {
  if (!state.rtc.localStream) return;
  const tracks = kind === "audio" ? state.rtc.localStream.getAudioTracks() : state.rtc.localStream.getVideoTracks();
  tracks.forEach((t) => {
    t.enabled = !t.enabled;
  });
  const enabled = tracks.some((t) => t.enabled);
  setCallStatus(`${kind === "audio" ? "Microphone" : "Camera"} ${enabled ? "on" : "off"}`);
}

function renderUsers() {
  if (usersMetaEl) {
    usersMetaEl.textContent = `${state.users.length} online`;
  }

  const groups = { admin: [], mod: [], member: [] };
  state.users.forEach((name) => {
    const role = profileFor(name).role || "member";
    (groups[role] || groups.member).push(name);
  });

  usersEl.innerHTML = "";
  const onSelect = (name) => {
    state.selectedUser = name;
    if (state.friends.includes(name)) {
      state.selectedFriend = name;
      renderFriends();
    }
    renderUsers();
    syncActionButtons();
  };

  ROLE_GROUP_ORDER.forEach((role) => {
    const members = groups[role].sort((a, b) => a.localeCompare(b));
    if (members.length === 0) return;

    const heading = document.createElement("li");
    heading.className = "member-category";
    heading.textContent = `${ROLE_GROUP_LABELS[role]} — ${members.length}`;
    usersEl.appendChild(heading);

    members.forEach((name) => {
      usersEl.appendChild(buildMemberRow(name, role, name === state.selectedUser, onSelect));
    });
  });
}

function buildMemberRow(name, role, isActive, onSelect) {
  const profile = profileFor(name);
  const initial = escapeHtml((name || "?").slice(0, 1).toUpperCase());
  const avatarStyle = profile.avatar_url ? ` style="background-image:url('${escapeHtml(profile.avatar_url)}')"` : "";
  const nameStyle = profile.name_color ? ` style="color:${escapeHtml(profile.name_color)}"` : "";

  const li = document.createElement("li");
  li.className = "member-row" + (isActive ? " active" : "");
  li.innerHTML = `
    <span class="member-avatar-wrap">
      <span class="member-avatar${profile.avatar_url ? " has-image" : ""}"${avatarStyle}>${profile.avatar_url ? "" : initial}</span>
      <span class="member-status status-online"></span>
    </span>
    <span class="member-name"${nameStyle}>${escapeHtml(name)}</span>
    ${role !== "member" ? `<span class="member-role-badge role-${role}">${role}</span>` : ""}
  `;
  li.addEventListener("click", () => onSelect(name));
  return li;
}

function renderList(container, items, activeValue, onClick) {
  container.innerHTML = "";
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    if (item === activeValue) li.classList.add("active");
    li.addEventListener("click", () => onClick(item));
    container.appendChild(li);
  });
}

function renderFriends() {
  if (friendsMetaEl) {
    friendsMetaEl.textContent = `Friends - ${state.friends.length}`;
  }
  renderIdentityList(friendsListEl, state.friends, state.selectedFriend, (name) => {
    state.selectedFriend = name;
    state.selectedUser = name;
    renderFriends();
    renderUsers();
    syncActionButtons();
  }, { presence: true });
}

function renderFriendRequests() {
  if (requestsMetaEl) {
    requestsMetaEl.textContent = `Incoming Requests - ${state.incomingRequests.length}`;
  }
  renderIdentityList(friendRequestsListEl, state.incomingRequests, state.selectedRequest, (name) => {
    state.selectedRequest = name;
    renderFriendRequests();
  }, { presence: false });
}

function renderIdentityList(container, items, activeValue, onClick, opts = {}) {
  container.innerHTML = "";
  const showPresence = !!opts.presence;
  items.forEach((item) => {
    const profile = profileFor(item);
    const initial = escapeHtml((item || "?").slice(0, 1).toUpperCase());
    const avatarStyle = profile.avatar_url ? ` style="background-image:url('${escapeHtml(profile.avatar_url)}')"` : "";
    const nameStyle = profile.name_color ? ` style="color:${escapeHtml(profile.name_color)}"` : "";
    const li = document.createElement("li");
    li.classList.add("identity-row");
    li.innerHTML = `<span class="identity-avatar${profile.avatar_url ? " has-image" : ""}"${avatarStyle}>${profile.avatar_url ? "" : initial}</span>`
      + `<span class="identity-name"${nameStyle}>${escapeHtml(item)}</span>`
      + (showPresence ? `<span class="identity-presence online"></span>` : "");
    if (item === activeValue) li.classList.add("active");
    li.addEventListener("click", () => onClick(item));
    container.appendChild(li);
  });
}

function roomLabel(room) {
  const users = state.voiceState[room] || [];
  return `${room} (${users.length})`;
}

function renderVoiceRooms() {
  voiceRoomsListEl.innerHTML = "";
  state.voiceRooms.forEach((room) => {
    const li = document.createElement("li");
    li.textContent = roomLabel(room);
    if (room === state.selectedVoiceRoom) li.classList.add("active");
    li.addEventListener("click", () => {
      state.selectedVoiceRoom = room;
      if (state.isAuthed && state.currentVoiceRoom !== room) {
        send({ type: "voice_join", room: room.toLowerCase() });
      }
      renderVoiceRooms();
    });
    voiceRoomsListEl.appendChild(li);
  });
  $("leaveVoiceRoomBtn").classList.toggle("hidden", !state.currentVoiceRoom);
  if (state.currentVoiceRoom) {
    const users = (state.voiceState[state.currentVoiceRoom] || []).join(", ");
    voiceRoomMetaEl.textContent = `In #${state.currentVoiceRoom}${users ? ` with ${users}` : ""}`;
  } else {
    voiceRoomMetaEl.textContent = "Not in a room";
  }
}

function syncActionButtons() {
  const hasTarget = !!selectedTarget();
  const inCall = !!state.rtc.pc;
  const micCamReady = !!state.rtc.localStream;
  $("dmBtn").disabled = !state.isAuthed || !hasTarget;
  $("voiceCallBtn").disabled = !state.isAuthed || !hasTarget;
  $("videoCallBtn").disabled = !state.isAuthed || !hasTarget;
  $("dmHistoryBtn").disabled = !state.isAuthed || !hasTarget;
  $("hangupBtn").disabled = !state.isAuthed || !inCall;
  $("toggleMicBtn").disabled = !state.isAuthed || !micCamReady;
  $("toggleCamBtn").disabled = !state.isAuthed || !micCamReady;
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const d = document.createElement("div");
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

const ALLOWED_EMOJI = ["👍", "👎", "❤️", "😂", "😮", "😢", "🔥", "🎉"];

function highlightMentions(escaped) {
  return escaped.replace(/@([\w-]+)/g, (_, name) => {
    const cls = name === state.username ? "mention mention-self" : "mention";
    return `<span class="${cls}">@${escapeHtml(name)}</span>`;
  });
}

function buildReactRow(msgId, reactions) {
  const row = document.createElement("div");
  row.className = "react-row";
  Object.entries(reactions || {}).forEach(([emoji, users]) => {
    const btn = document.createElement("button");
    btn.className = "react-btn" + (users.includes(state.username) ? " reacted" : "");
    btn.innerHTML = `${escapeHtml(emoji)} <span>${users.length}</span>`;
    btn.title = users.join(", ");
    btn.addEventListener("click", () => send({ type: "react", id: msgId, emoji }));
    row.appendChild(btn);
  });
  const addBtn = document.createElement("button");
  addBtn.className = "react-add-btn";
  addBtn.textContent = "＋";
  addBtn.title = "Add reaction";
  addBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleEmojiPicker(msgId, addBtn); });
  row.appendChild(addBtn);
  return row;
}

function toggleEmojiPicker(msgId, anchor) {
  document.querySelectorAll(".emoji-picker").forEach((p) => p.remove());
  const picker = document.createElement("div");
  picker.className = "emoji-picker";
  ALLOWED_EMOJI.forEach((emo) => {
    const btn = document.createElement("button");
    btn.textContent = emo;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      send({ type: "react", id: msgId, emoji: emo });
      picker.remove();
    });
    picker.appendChild(btn);
  });
  anchor.after(picker);
  setTimeout(() => document.addEventListener("click", () => picker.remove(), { once: true }), 0);
}

function buildMsgToolbar(msgId, author) {
  const bar = document.createElement("div");
  bar.className = "msg-toolbar";

  const reactBtn = document.createElement("button");
  reactBtn.textContent = "😊";
  reactBtn.title = "React";
  reactBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleEmojiPicker(msgId, reactBtn); });
  bar.appendChild(reactBtn);

  if (author === state.username) {
    const editBtn = document.createElement("button");
    editBtn.textContent = "✏️";
    editBtn.title = "Edit message";
    editBtn.addEventListener("click", () => {
      const box = document.getElementById(`msg-${msgId}`);
      const bodyEl = box?.querySelector(".msg-body");
      if (!bodyEl) return;
      const orig = bodyEl.dataset.raw || bodyEl.textContent;
      showEditMessageModal(msgId, orig);
    });
    bar.appendChild(editBtn);
  }

  if (author === state.username || state.role === "admin" || state.role === "mod") {
    const delBtn = document.createElement("button");
    delBtn.textContent = "🗑️";
    delBtn.title = "Delete message";
    delBtn.addEventListener("click", () => {
      showConfirmModal("Delete Message", "Are you sure you want to delete this message?", `handleDeleteMessage(${msgId})`);
    });
    bar.appendChild(delBtn);
  }
  return bar;
}

function showEditMessageModal(msgId, orig) {
  const content = `
    <div class="form-group">
      <label class="form-label">Edit your message</label>
      <input type="text" id="editMsgInput" class="form-input" value="${escapeHtml(orig)}" autofocus>
    </div>
  `;
  const buttons = [
    { label: "Cancel", type: "secondary", onclick: "closeModal()" },
    { label: "Save", type: "primary", onclick: `submitEditMessage(${msgId})` },
  ];
  showModal("✏️ Edit Message", content, buttons);
  setTimeout(() => {
    const input = $("editMsgInput");
    if (input) {
      input.focus();
      input.select();
      input.addEventListener("keypress", (e) => {
        if (e.key === "Enter") submitEditMessage(msgId);
      });
    }
  }, 100);
}

window.submitEditMessage = function(msgId) {
  const input = $("editMsgInput");
  const newText = input?.value?.trim();
  closeModal();
  if (!newText) return;
  send({ type: "edit_message", id: msgId, content: newText });
};

window.handleDeleteMessage = function(msgId) {
  closeModal();
  send({ type: "delete_message", id: msgId });
  showSuccess("Message deleted");
};

function buildMessageEl(opts) {
  const isSystem = opts.type === "system";
  const isDeleted = !!opts.deleted;

  const box = document.createElement("article");
  box.className = "msg" + (isSystem ? " system" : "") + (isDeleted ? " msg-deleted" : "");
  if (opts.id) {
    box.id = `msg-${opts.id}`;
    box.dataset.msgId = opts.id;
    box.dataset.msgAuthor = opts.author || "";
  }

  const head = document.createElement("div");
  head.className = "who";
  const ts = opts.created_at
    ? new Date(opts.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  const author = opts.author || "";
  const profile = profileFor(author);
  const authorColor = opts.author_name_color || profile.name_color || "";
  const authorStyle = authorColor ? ` style="color:${escapeHtml(authorColor)}"` : "";
  head.innerHTML = `<span class="msg-author"${authorStyle}>${escapeHtml(author)}</span>${ts ? ` <span class="msg-ts">${ts}</span>` : ""}`;

  const body = document.createElement("div");
  body.className = "msg-body";
  body.dataset.raw = opts.content || "";
  if (isDeleted) {
    body.innerHTML = "<em>[deleted]</em>";
  } else {
    body.innerHTML = highlightMentions(escapeHtml(opts.content || ""));
    if (opts.edited_at) {
      const mark = document.createElement("span");
      mark.className = "edited-mark";
      mark.textContent = " (edited)";
      body.appendChild(mark);
    }
  }

  box.appendChild(head);
  box.appendChild(body);

  if (!isSystem && opts.id) {
    if (!isDeleted) box.appendChild(buildMsgToolbar(opts.id, opts.author));
    box.appendChild(buildReactRow(opts.id, opts.reactions || {}));
  }
  return box;
}

function addMessage(who, text, type = "normal") {
  const box = buildMessageEl({ author: who, content: text, type });
  messagesEl.appendChild(box);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderHistory(history) {
  messagesEl.innerHTML = "";
  history.forEach((msg) => {
    messagesEl.appendChild(buildMessageEl({
      id: msg.id,
      author: msg.author || "?",
      author_name_color: msg.author_name_color || "",
      content: msg.content || "",
      reactions: msg.reactions || {},
      edited_at: msg.edited_at,
      deleted: msg.deleted,
      created_at: msg.created_at,
    }));
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ─── Typing indicator ─────────────────────────────────────────────────────────
const typingTimers = {};

function showTyping(username) {
  if (typingTimers[username]) clearTimeout(typingTimers[username]);
  typingTimers[username] = setTimeout(() => {
    delete typingTimers[username];
    updateTypingBanner();
  }, 3000);
  updateTypingBanner();
}

function updateTypingBanner() {
  const el = document.getElementById("typingIndicator");
  if (!el) return;
  const names = Object.keys(typingTimers).filter((u) => u !== state.username);
  if (!names.length) { el.textContent = ""; return; }
  el.textContent = names.length === 1
    ? `${names[0]} is typing…`
    : `${names.join(", ")} are typing…`;
}

function handlePacket(packet) {
  switch (packet.type) {
    case "auth_ok":
      state.username = packet.username || state.username;
      state.role = packet.role || "member";
      mergeProfiles({
        [state.username]: {
          avatar_url: packet.avatar_url || "",
          name_color: packet.name_color || "",
        },
      });
      state.attemptedTokenAuth = false;
      if (packet.remember_token) {
        saveRemember(state.username, packet.remember_token);
      } else if (!rememberMe.checked) {
        clearRemember();
      }
      roleBadge.textContent = state.role;
      selfUser.textContent = state.username;
      applySelfAvatar();
      setAuthenticated(true);
      send({ type: "who" });
      send({ type: "social_sync" });
      addMessage("System", `Logged in as ${state.username}`, "system");
      break;
    case "auth_error":
      if (state.attemptedTokenAuth) {
        clearRemember();
        state.attemptedTokenAuth = false;
        setAuthenticated(false);
        setAuthMode("login");
      }
      authStatus.textContent = packet.message || "Authentication failed";
      break;
    case "logged_out":
      endCall(false);
      setAuthenticated(false);
      setAuthMode("login");
      authStatus.textContent = "Signed out.";
      syncActionButtons();
      break;
    case "rtc_signal":
      handleRtcSignal(packet);
      break;
    case "social_state":
      state.friends = packet.friends || [];
      state.incomingRequests = packet.incoming_requests || [];
      state.voiceRooms = packet.voice_rooms || [];
      state.voiceState = packet.voice_state || {};
      state.currentVoiceRoom = packet.voice_room || "";
      mergeProfiles(packet.profiles || {});
      if (state.selectedFriend && !state.friends.includes(state.selectedFriend)) state.selectedFriend = "";
      if (state.selectedRequest && !state.incomingRequests.includes(state.selectedRequest)) state.selectedRequest = "";
      if (state.selectedVoiceRoom && !state.voiceRooms.includes(state.selectedVoiceRoom)) state.selectedVoiceRoom = "";
      if (state.selectedUser && !state.users.includes(state.selectedUser) && !state.friends.includes(state.selectedUser)) {
        state.selectedUser = "";
      }
      ensureDefaultTarget();
      renderFriends();
      renderFriendRequests();
      renderVoiceRooms();
      renderUsers();
      applySelfAvatar();
      syncActionButtons();
      break;
    case "action_error":
      addMessage("System", packet.message || "Action failed", "system");
      break;
    case "welcome":
    case "channel_switched":
      state.channel = packet.channel || "general";
      state.channels = packet.channels || ["general"];
      channelTitle.textContent = `#${state.channel}`;
      channelMeta.textContent = `${state.channels.length} channels available`;
      inputEl.placeholder = `Message #${state.channel}`;
      renderList(channelsEl, state.channels, state.channel, (name) => {
        send({ type: "switch_channel", channel: name });
      });
      renderHistory(packet.history || []);
      break;
    case "user_list":
      state.users = packet.users || [];
      mergeProfiles(packet.profiles || {});
      if (state.selectedUser && !state.users.includes(state.selectedUser) && !state.friends.includes(state.selectedUser)) {
        state.selectedUser = "";
      }
      ensureDefaultTarget();
      renderUsers();
      renderFriends();
      applySelfAvatar();
      syncActionButtons();
      break;
    case "message": {
      if (packet.author) {
        mergeProfiles({
          [packet.author]: {
            avatar_url: packet.author_avatar_url || "",
            name_color: packet.author_name_color || "",
          },
        });
      }
      const box = buildMessageEl({
        id: packet.id,
        author: packet.author || "?",
        author_name_color: packet.author_name_color || "",
        content: packet.content || "",
        created_at: packet.created_at,
        reactions: {},
      });
      messagesEl.appendChild(box);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      // Clear typing indicator for this author
      if (typingTimers[packet.author]) {
        clearTimeout(typingTimers[packet.author]);
        delete typingTimers[packet.author];
        updateTypingBanner();
      }
      break;
    }
    case "edited_message": {
      const box = document.getElementById(`msg-${packet.id}`);
      if (box) {
        const body = box.querySelector(".msg-body");
        if (body) {
          body.dataset.raw = packet.content || "";
          body.innerHTML = highlightMentions(escapeHtml(packet.content || ""));
          if (!body.querySelector(".edited-mark")) {
            const mark = document.createElement("span");
            mark.className = "edited-mark";
            mark.textContent = " (edited)";
            body.appendChild(mark);
          }
        }
      }
      break;
    }
    case "deleted_message": {
      const box = document.getElementById(`msg-${packet.id}`);
      if (box) {
        box.classList.add("msg-deleted");
        const body = box.querySelector(".msg-body");
        if (body) body.innerHTML = "<em>[deleted]</em>";
        box.querySelector(".msg-toolbar")?.remove();
      }
      break;
    }
    case "reaction_update": {
      const box = document.getElementById(`msg-${packet.id}`);
      if (box) {
        const oldRow = box.querySelector(".react-row");
        const newRow = buildReactRow(packet.id, packet.reactions || {});
        if (oldRow) box.replaceChild(newRow, oldRow);
        else box.appendChild(newRow);
      }
      break;
    }
    case "typing":
      if (packet.username !== state.username && packet.channel === state.channel) {
        showTyping(packet.username);
      }
      break;
    case "dm": {
      const peer = packet.sender === state.username ? packet.recipient : packet.sender;
      addMessage(`DM ↔ ${peer}`, packet.content || "", "system");
      break;
    }
    case "dm_history":
      addMessage("System", `── DM history with ${packet.with || "?"} ──`, "system");
      (packet.history || []).forEach((m) => {
        const peer = m.sender === state.username ? m.recipient : m.sender;
        addMessage(`DM ↔ ${peer}`, m.content || "", "system");
      });
      break;
    case "role_update":
      state.role = packet.role || state.role;
      roleBadge.textContent = state.role;
      addMessage("System", `Role updated to ${state.role}`, "system");
      break;
    case "username_changed":
      state.username = packet.username || state.username;
      selfUser.textContent = state.username;
      applySelfAvatar();
      addMessage("System", `Username changed to ${state.username}`, "system");
      break;
    case "profile_updated":
      mergeProfiles({
        [packet.username || state.username]: {
          avatar_url: packet.avatar_url || "",
          name_color: packet.name_color || "",
        },
      });
      applySelfAvatar();
      renderUsers();
      renderFriends();
      addMessage("System", "Profile updated.", "system");
      break;
    case "system":
      addMessage("System", packet.message || "", "system");
      break;
    default:
      break;
  }
}

sendBtn.addEventListener("click", () => {
  if (!state.isAuthed) return;
  const content = inputEl.value.trim();
  if (!content) return;
  send({ type: "message", content });
  inputEl.value = "";
});

inputEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    sendBtn.click();
  }
});

// Typing indicator — send at most once every 2 seconds
let _typingThrottle = null;
inputEl.addEventListener("input", () => {
  if (!state.isAuthed || _typingThrottle) return;
  send({ type: "typing" });
  _typingThrottle = setTimeout(() => { _typingThrottle = null; }, 2000);
});

$("newChannelBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  showPromptModal("📝 New Channel", "Enter channel name:", "handleNewChannel");
});

window.handleNewChannel = function(name) {
  send({ type: "switch_channel", channel: name.trim().toLowerCase().replace(/\s+/g, "-") });
  showSuccess(`Creating #${name}`);
};

$("refreshUsersBtn").addEventListener("click", () => {
  send({ type: "who" });
});

$("socialSyncBtn").addEventListener("click", () => {
  send({ type: "social_sync" });
});

$("addFriendBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  showPromptModal("👥 Add Friend", "Enter username:", "handleAddFriend");
});

window.handleAddFriend = function(target) {
  send({ type: "friend_request", to: target.trim().toLowerCase() });
  showSuccess(`Friend request sent to ${target}`);
};

$("acceptFriendBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  if (!state.selectedRequest) {
    showError("Select a friend request first.");
    return;
  }
  send({ type: "friend_accept", from: state.selectedRequest.toLowerCase() });
});

$("removeFriendBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  if (!state.selectedFriend) {
    showError("Select a friend first.");
    return;
  }
  showConfirmModal("Remove Friend", `Remove ${state.selectedFriend} from friends?`, `handleRemoveFriend()`);
});

window.handleRemoveFriend = function() {
  closeModal();
  send({ type: "friend_remove", user: state.selectedFriend.toLowerCase() });
  showSuccess(`Removed ${state.selectedFriend} from friends`);
};

$("createVoiceRoomBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  showPromptModal("🎙️ Create Voice Room", "Enter room name:", "handleCreateVoiceRoom");
});

window.handleCreateVoiceRoom = function(room) {
  send({ type: "voice_room_create", room: room.trim().toLowerCase().replace(/\s+/g, "-") });
  showSuccess(`Creating voice room: ${room}`);
};

$("leaveVoiceRoomBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  send({ type: "voice_leave" });
});

$("dmBtn").addEventListener("click", () => {
  const targetName = selectedTarget();
  if (!targetName) {
    showError("Select a user first");
    return;
  }
  showPromptModal(`💬 Message ${targetName}`, "Type your message:", "handleSendDM");
});

window.handleSendDM = function(text) {
  const targetName = selectedTarget();
  send({ type: "dm", to: targetName.toLowerCase(), content: text.trim() });
  showSuccess(`Message sent to ${targetName}`);
};

$("changeNameBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  showPromptModal("✏️ Change Username", "Enter new username:", "handleChangeUsername");
});

window.handleChangeUsername = function(nextName) {
  const normalized = nextName.trim().toLowerCase();
  if (!normalized) {
    showError("Username cannot be empty");
    return;
  }
  send({ type: "change_username", new_username: normalized });
  showSuccess(`Changing username to ${nextName}`);
};

$("dmHistoryBtn").addEventListener("click", () => {
  const targetName = selectedTarget();
  if (!targetName) {
    showError("Select a user first");
    return;
  }
  send({ type: "dm_history", with: targetName.toLowerCase() });
});

$("promoteBtn").addEventListener("click", () => {
  if (state.role !== "admin") {
    showError("Only admins can set roles");
    return;
  }
  if (!state.selectedUser) {
    showError("Select a user first");
    return;
  }
  const target = state.selectedUser;
  const content = `<p style="color: var(--text); margin-bottom: 16px;">Select a role for <strong>${target}</strong>:</p>`;
  const buttons = [
    { label: "Member", type: "secondary", onclick: `applyRole('member')` },
    { label: "Moderator", type: "secondary", onclick: `applyRole('mod')` },
    { label: "Admin", type: "danger", onclick: `applyRole('admin')` },
  ];
  showModal("👑 Set Role", content, buttons);
});

window.applyRole = function(normalized) {
  closeModal();
  send({ type: "promote", username: state.selectedUser.toLowerCase(), role: normalized });
  showSuccess(`${state.selectedUser} is now ${normalized}`);
};

$("voiceCallBtn").addEventListener("click", async () => {
  if (!state.isAuthed) return;
  ensureDefaultTarget();
  if (!navigator.mediaDevices || !window.RTCPeerConnection) {
    showError("Your browser does not support WebRTC voice/video.");
    return;
  }
  if (!window.isSecureContext) {
    showError("Voice calls require HTTPS (or localhost). Open this site over HTTPS.");
    return;
  }
  await startCall("voice");
  syncActionButtons();
});

$("videoCallBtn").addEventListener("click", async () => {
  if (!state.isAuthed) return;
  ensureDefaultTarget();
  if (!navigator.mediaDevices || !window.RTCPeerConnection) {
    showError("Your browser does not support WebRTC voice/video.");
    return;
  }
  if (!window.isSecureContext) {
    showError("Video calls require HTTPS (or localhost). Open this site over HTTPS.");
    return;
  }
  await startCall("video");
  syncActionButtons();
});

$("hangupBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  endCall(true);
  setCallStatus("Call ended");
  syncActionButtons();
});

$("toggleMicBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  toggleLocalTrack("audio");
  syncActionButtons();
});

$("toggleCamBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  toggleLocalTrack("video");
  syncActionButtons();
});

$("blockUserBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  const target = selectedTarget();
  if (!target) {
    showError("Select a user first");
    return;
  }
  blockUserWithServer(target);
  showNotification("User Blocked", { body: `${target} is now blocked` });
});

$("unblockUserBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  showPromptModal("✅ Unblock User", "Enter username to unblock:", "handleUnblockUser");
});

window.handleUnblockUser = function(username) {
  unblockUserWithServer(username);
};

// New Feature Event Listeners
$("statusBtn").addEventListener("click", () => {
  const statuses = ["online", "away", "dnd", "offline"];
  const current = statuses.indexOf(state.userStatus);
  const next = statuses[(current + 1) % statuses.length];
  setUserStatus(next);
  showSuccess(`Status changed to ${next}`);
});

$("searchUsersGlobalBtn").addEventListener("click", () => {
  showPromptModal("🔍 Search Users & Channels", "What would you like to search?", "performSearch");
});

window.performSearch = function(query) {
  const results = performGlobalSearch(query);
  if (results.users.length === 0 && results.channels.length === 0) {
    showError("No results found");
    return;
  }
  addMessage("System", `Search Results for "${query}"`, "system");
  if (results.users.length > 0) {
    addMessage("System", `👥 Users: ${results.users.join(", ")}`, "system");
  }
  if (results.channels.length > 0) {
    addMessage("System", `💬 Channels: ${results.channels.join(", ")}`, "system");
  }
  showSuccess(`Found ${results.users.length + results.channels.length} results`);
};

$("favoritesBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  if (state.favorites.size === 0) {
    showInfo("No favorites yet. Star channels to add them.");
    return;
  }
  const favList = Array.from(state.favorites).map(f => `⭐ ${f}`).join("<br>");
  const content = `<div style="color: var(--text); line-height: 1.8;">${favList}</div>`;
  showModal("⭐ Your Favorites", content, [
    { label: "Close", type: "primary", onclick: "closeModal()" }
  ]);
});

$("unreadBtn").addEventListener("click", () => {
  const unread = Object.entries(state.unreadCount)
    .filter(([_, count]) => count > 0)
    .map(([ch, count]) => `#${ch} <span style="color: var(--brand);">(${count})</span>`);

  if (unread.length === 0) {
    showSuccess("All caught up! No unread messages.");
    return;
  }
  const content = `<div style="color: var(--text); line-height: 1.8;">${unread.join("<br>")}</div>`;
  showModal("🔔 Unread Messages", content, [
    { label: "Close", type: "primary", onclick: "closeModal()" }
  ]);
});

$("quickMenuBtn").addEventListener("click", () => {
  const content = `
    <div style="color: var(--text); display: grid; gap: 12px;">
      <button class="btn-modal primary" style="width: 100%;" onclick="showPromptModal('Set Custom Status', 'Enter your status message', 'setCustomStatusFromModal')">Set Status Message</button>
      <button class="btn-modal primary" style="width: 100%;" onclick="showAccountInfo()">View Account Info</button>
      <button class="btn-modal primary" style="width: 100%;" onclick="showStatusSelector()">Change Status</button>
    </div>
  `;
  showModal("⚙️ Quick Menu", content, [
    { label: "Close", type: "secondary", onclick: "closeModal()" }
  ]);
});

window.setCustomStatusFromModal = function(msg) {
  setCustomStatus(msg);
  showSuccess("Custom status updated");
};

window.showAccountInfo = function() {
  const info = `
    <div style="color: var(--text); line-height: 2;">
      <strong>Username:</strong> ${state.username}<br>
      <strong>Role:</strong> <span style="color: var(--brand);">${state.role}</span><br>
      <strong>Status:</strong> ${state.userStatus}<br>
      <strong>Channels:</strong> ${state.channels.length}<br>
      <strong>Friends:</strong> ${state.friends.length}
    </div>
  `;
  showModal("👤 Account Info", info, [
    { label: "Close", type: "primary", onclick: "closeModal()" }
  ]);
};

window.showStatusSelector = function() {
  const statuses = ["online", "away", "dnd", "offline"];
  const buttons = statuses.map(s => ({
    label: s.toUpperCase(),
    type: state.userStatus === s ? "primary" : "secondary",
    onclick: `setUserStatus('${s}'); closeModal();`
  }));
  showModal("Change Status", `<p style="color: var(--text);">Select your new status:</p>`, buttons);
};

// Channel Search
const channelSearch = $("channelSearch");
if (channelSearch) {
  channelSearch.addEventListener("input", (e) => {
    if (e.target.value) {
      filterChannelList(e.target.value);
    } else {
      renderChannels();
    }
  });
}

// Message Search
const messageSearch = $("messageSearch");
if (messageSearch) {
  messageSearch.addEventListener("input", (e) => {
    const query = e.target.value.toLowerCase();
    if (!query) {
      document.querySelectorAll(".msg").forEach(m => m.style.opacity = "1");
      return;
    }
    document.querySelectorAll(".msg").forEach(m => {
      const content = m.textContent.toLowerCase();
      m.style.opacity = content.includes(query) ? "1" : "0.3";
    });
  });
}

$("bookmarkBtn").addEventListener("click", () => {
  const selected = messagesEl.querySelector(".msg");
  if (!selected) {
    showError("No messages to bookmark");
    return;
  }
  const msgId = selected.dataset.msgId;
  if (msgId && !state.bookmarkedMessages.has(msgId)) {
    bookmarkMessage(msgId);
    showError("Message bookmarked!");
  }
});

$("viewBookmarksBtn").addEventListener("click", () => {
  if (state.bookmarkedMessages.size === 0) {
    showError("No bookmarked messages");
    return;
  }
  addMessage("System", `── Bookmarked Messages (${state.bookmarkedMessages.size}) ──`, "system");
});

$("setNameColorBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  showPromptModal("🎨 Set Name Color", "Enter color name or hex code (e.g., red, #7289da):", "handleSetNameColor");
});

window.handleSetNameColor = function(color) {
  send({ type: "set_profile", name_color: color });
  showSuccess("Name color updated");
};

$("setProfilePicBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  showPromptModal("🖼️ Set Avatar", "Enter avatar image URL:", "handleSetAvatar");
});

window.handleSetAvatar = function(url) {
  send({ type: "set_profile", avatar_url: url });
  showSuccess("Avatar updated");
};

$("settingsBtn").addEventListener("click", () => {
  showError(`⚙️ Settings\n\n- Username: ${state.username}\n- Role: ${state.role}\n- Blocked Users: ${state.blockedUsers.length}\n- Bookmarks: ${state.bookmarkedMessages.size}`);
});

$("logoutBtn").addEventListener("click", () => {
  endCall(false);
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    clearRemember();
    setAuthenticated(false);
    setAuthMode("login");
    return;
  }
  send({ type: "logout", remember_token: state.rememberToken });
  clearRemember();
});

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const username = $("usernameInput").value.trim().toLowerCase();
  const password = $("passwordInput").value;

  if (!username || !password) return;
  state.attemptedTokenAuth = false;
  authStatus.textContent = "";
  send({ type: "auth", action: state.authMode, username, password, remember: rememberMe.checked });
});

showLoginBtn.addEventListener("click", () => setAuthMode("login"));
showRegisterBtn.addEventListener("click", () => setAuthMode("register"));

{
  const remembered = loadRemember();
  if (remembered?.username) {
    $("usernameInput").value = remembered.username;
    rememberMe.checked = true;
  }
}

// ─── 10 New Functional Features ──────────────────────────────────────────────

// FEATURE 1: User Presence & Status System (Server-synced)
function setUserStatus(newStatus) {
  const validStatuses = ["online", "away", "dnd", "offline"];
  if (validStatuses.includes(newStatus)) {
    state.userStatus = newStatus;
    updateStatusBadge();
    localStorage.setItem("pychatter.status", newStatus);
    send({ type: "set_status", status: newStatus });
    addMessage("System", `Status changed to ${newStatus}`, "system");
  }
}

function setCustomStatus(message) {
  state.customStatus = message;
  localStorage.setItem("pychatter.customStatus", message);
  send({ type: "set_custom_status", message });
}

function updateStatusBadge() {
  const badge = $("statusBadge");
  if (badge) {
    badge.className = `status-badge ${state.userStatus}`;
    badge.textContent = state.userStatus.charAt(0).toUpperCase() + state.userStatus.slice(1);
  }
}

// FEATURE 2: Favorite Channels/Users (Client-side localStorage)
function toggleFavorite(item) {
  if (state.favorites.has(item)) {
    state.favorites.delete(item);
  } else {
    state.favorites.add(item);
  }
  saveFavorites();
  renderChannels();
}

function saveFavorites() {
  localStorage.setItem("pychatter.favorites", JSON.stringify(Array.from(state.favorites)));
}

function loadFavorites() {
  try {
    const saved = localStorage.getItem("pychatter.favorites");
    if (saved) state.favorites = new Set(JSON.parse(saved));
  } catch {
    state.favorites = new Set();
  }
}

function isFavorite(item) {
  return state.favorites.has(item);
}

// FEATURE: Block User (Server-synced)
function blockUserWithServer(username) {
  const normalized = username.toLowerCase();
  if (!state.blockedUsers.includes(normalized)) {
    state.blockedUsers.push(normalized);
  }
  saveBlockedUsers();
  send({ type: "block_user", user: normalized });
  addMessage("System", `${username} has been blocked`, "system");
}

function unblockUserWithServer(username) {
  const normalized = username.toLowerCase();
  const idx = state.blockedUsers.indexOf(normalized);
  if (idx !== -1) {
    state.blockedUsers.splice(idx, 1);
  }
  saveBlockedUsers();
  send({ type: "unblock_user", user: normalized });
  addMessage("System", `${username} has been unblocked`, "system");
}

// FEATURE 3: Unread Messages Counter
function markAsRead(channel) {
  state.unreadCount[channel] = 0;
  updateUnreadBadges();
}

function incrementUnread(channel) {
  state.unreadCount[channel] = (state.unreadCount[channel] || 0) + 1;
  updateUnreadBadges();
}

function updateUnreadBadges() {
  const totalUnread = Object.values(state.unreadCount).reduce((a, b) => a + b, 0);
  const unreadBtn = $("unreadBtn");
  if (unreadBtn) {
    unreadBtn.textContent = totalUnread > 0 ? `🔔 ${totalUnread}` : "🔔";
  }
}

// FEATURE 4: Message Pinning (Server-synced)
function pinMessage(msgId, channel = state.channel) {
  if (!state.pinnedMessages.has(channel)) {
    state.pinnedMessages.set(channel, []);
  }
  const pins = state.pinnedMessages.get(channel);
  if (!pins.includes(msgId)) {
    pins.push(msgId);
    savePinnedMessages();
    send({ type: "pin_message", id: msgId, channel });
  }
}

function unpinMessage(msgId, channel = state.channel) {
  if (state.pinnedMessages.has(channel)) {
    const pins = state.pinnedMessages.get(channel);
    const idx = pins.indexOf(msgId);
    if (idx !== -1) {
      pins.splice(idx, 1);
      savePinnedMessages();
      send({ type: "unpin_message", id: msgId, channel });
    }
  }
}

function getPinnedMessages(channel = state.channel) {
  return state.pinnedMessages.get(channel) || [];
}

function savePinnedMessages() {
  const data = {};
  for (const [ch, msgs] of state.pinnedMessages) {
    data[ch] = msgs;
  }
  localStorage.setItem("pychatter.pinned", JSON.stringify(data));
}

function loadPinnedMessages() {
  try {
    const saved = localStorage.getItem("pychatter.pinned");
    if (saved) {
      const data = JSON.parse(saved);
      state.pinnedMessages = new Map(Object.entries(data));
    }
  } catch {
    state.pinnedMessages = new Map();
  }
}

// FEATURE 5: Message Threading/Replies (Client-side local threads)
function replyToMessage(msgId, text) {
  if (!state.messageThreads.has(msgId)) {
    state.messageThreads.set(msgId, []);
  }
  state.messageThreads.get(msgId).push({
    author: state.username,
    content: text,
    timestamp: Date.now(),
  });
  saveMessageThreads();
  addMessage("System", `Reply added to message thread`, "system");
}

function getThreadReplies(msgId) {
  return state.messageThreads.get(msgId) || [];
}

function saveMessageThreads() {
  const data = {};
  for (const [msgId, threads] of state.messageThreads) {
    data[msgId] = threads;
  }
  localStorage.setItem("pychatter.threads", JSON.stringify(data));
}

function loadMessageThreads() {
  try {
    const saved = localStorage.getItem("pychatter.threads");
    if (saved) {
      const data = JSON.parse(saved);
      state.messageThreads = new Map(Object.entries(data));
    }
  } catch {
    state.messageThreads = new Map();
  }
}

// FEATURE 6: Rich Text Formatting
function formatBold(text) {
  return `**${text}**`;
}

function formatItalic(text) {
  return `*${text}*`;
}

function formatCode(text) {
  return `` `${text}` ``;
}

function formatCodeBlock(text) {
  return `\`\`\`\n${text}\n\`\`\``;
}

function formatMessage(text, format = "bold") {
  switch (format) {
    case "bold": return formatBold(text);
    case "italic": return formatItalic(text);
    case "code": return formatCode(text);
    case "code-block": return formatCodeBlock(text);
    default: return text;
  }
}

// FEATURE 7: Global User Search
function searchUsers(query) {
  const term = query.toLowerCase();
  return state.users.filter(u => u.toLowerCase().includes(term));
}

function searchChannels(query) {
  const term = query.toLowerCase();
  return state.channels.filter(c => c.toLowerCase().includes(term));
}

function performGlobalSearch(query) {
  const users = searchUsers(query);
  const channels = searchChannels(query);
  return { users, channels };
}

// FEATURE 8: @Mentions Tracking
function trackMention(username) {
  if (!state.recentMentions.includes(username)) {
    state.recentMentions.unshift(username);
    if (state.recentMentions.length > 20) state.recentMentions.pop();
  }
  saveMentionHistory();
}

function saveMentionHistory() {
  localStorage.setItem("pychatter.mentions", JSON.stringify(state.recentMentions));
}

function loadMentionHistory() {
  try {
    const saved = localStorage.getItem("pychatter.mentions");
    if (saved) state.recentMentions = JSON.parse(saved);
  } catch {
    state.recentMentions = [];
  }
}

// FEATURE 9: Channel Search/Filter
function filterChannelList(search) {
  const filtered = searchChannels(search);
  renderList($("channels"), filtered, state.channel, (name) => {
    send({ type: "switch_channel", channel: name });
  });
}

// FEATURE 10: Enhanced Typing Notifications
function showTypingUsers() {
  const typing = Object.keys(state.userTypingStatus).filter(u => u !== state.username);
  if (typing.length === 0) return "";
  if (typing.length === 1) return `${typing[0]} is typing...`;
  return `${typing.join(", ")} are typing...`;
}

// ─── Modern Modal System ────────────────────────────────────────────────────
function showModal(title, content, buttons = []) {
  const overlay = $("modalOverlay");
  const titleEl = $("modalTitle");
  const bodyEl = $("modalBody");
  const footerEl = $("modalFooter");

  titleEl.textContent = title;
  bodyEl.innerHTML = content;
  footerEl.innerHTML = buttons
    .map(btn => `<button class="btn-modal ${btn.type || 'secondary'}" onclick="${btn.onclick}">${btn.label}</button>`)
    .join("");

  overlay.classList.add("active");
}

function closeModal() {
  const overlay = $("modalOverlay");
  overlay.classList.remove("active");
}

function showPromptModal(title, label = "Enter value", onSubmit) {
  const content = `
    <div class="form-group">
      <label class="form-label">${label}</label>
      <input type="text" id="promptInput" class="form-input" placeholder="Type here..." autofocus>
    </div>
  `;

  const buttons = [
    { label: "Cancel", type: "secondary", onclick: "closeModal()" },
    {
      label: "Submit",
      type: "primary",
      onclick: `submitPrompt('${onSubmit}')`
    },
  ];

  showModal(title, content, buttons);

  // Allow Enter key to submit
  setTimeout(() => {
    const input = $("promptInput");
    if (input) {
      input.addEventListener("keypress", (e) => {
        if (e.key === "Enter") submitPrompt(onSubmit);
      });
    }
  }, 100);
}

function submitPrompt(funcName) {
  const input = $("promptInput");
  const value = input?.value?.trim();
  closeModal();
  if (value && window[funcName]) {
    window[funcName](value);
  }
}

function showConfirmModal(title, message, onConfirm) {
  const buttons = [
    { label: "Cancel", type: "secondary", onclick: "closeModal()" },
    { label: "Confirm", type: "danger", onclick: onConfirm },
  ];

  showModal(title, `<p style="color: var(--text); margin: 0;">${message}</p>`, buttons);
}

// ─── Toast Notifications ────────────────────────────────────────────────────
function showToast(message, type = "info") {
  const container = $("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = "toastSlideIn 0.3s ease reverse";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function showSuccess(message) {
  showToast(message, "success");
}

function showError(message) {
  showToast(message, "error");
}

function showInfo(message) {
  showToast(message, "info");
}

// ─── Notification System ─────────────────────────────────────────────────────
function showNotification(title, options = {}) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, options);
  }
}

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

// ─── Enhanced Error Handling ─────────────────────────────────────────────────
function handleConnectionError(error) {
  console.error("Connection error:", error);
  if (state.reconnectAttempts < state.maxReconnectAttempts) {
    const delay = Math.min(1000 * Math.pow(1.5, state.reconnectAttempts), 30000);
    state.reconnectAttempts++;
    setTimeout(() => connectSocket(), delay);
  } else {
    statusText.textContent = "Connection failed - please refresh";
  }
}

// ─── Bookmark Management ─────────────────────────────────────────────────────
function bookmarkMessage(msgId) {
  state.bookmarkedMessages.add(msgId);
  const el = document.getElementById(`msg-${msgId}`);
  if (el) {
    el.classList.add("bookmarked");
    const mark = document.createElement("span");
    mark.className = "bookmark-mark";
    mark.textContent = "🔖";
    el.insertBefore(mark, el.firstChild);
  }
  saveBookmarks();
}

function unbookmarkMessage(msgId) {
  state.bookmarkedMessages.delete(msgId);
  const el = document.getElementById(`msg-${msgId}`);
  if (el) {
    el.classList.remove("bookmarked");
    el.querySelector(".bookmark-mark")?.remove();
  }
  saveBookmarks();
}

function saveBookmarks() {
  localStorage.setItem("pychatter.bookmarks", JSON.stringify(Array.from(state.bookmarkedMessages)));
}

function loadBookmarks() {
  try {
    const saved = localStorage.getItem("pychatter.bookmarks");
    if (saved) state.bookmarkedMessages = new Set(JSON.parse(saved));
  } catch {
    state.bookmarkedMessages = new Set();
  }
}

// ─── Block System ───────────────────────────────────────────────────────────
function blockUser(username) {
  const normalized = username.toLowerCase();
  if (!state.blockedUsers.includes(normalized)) {
    state.blockedUsers.push(normalized);
  }
  saveBlockedUsers();
  addMessage("System", `${username} has been blocked`, "system");
}

function unblockUser(username) {
  const normalized = username.toLowerCase();
  state.blockedUsers = state.blockedUsers.filter(u => u !== normalized);
  saveBlockedUsers();
  addMessage("System", `${username} has been unblocked`, "system");
}

function saveBlockedUsers() {
  localStorage.setItem("pychatter.blocked", JSON.stringify(state.blockedUsers));
}

function loadBlockedUsers() {
  try {
    const saved = localStorage.getItem("pychatter.blocked");
    if (saved) state.blockedUsers = JSON.parse(saved);
  } catch {
    state.blockedUsers = [];
  }
}

function isUserBlocked(username) {
  return state.blockedUsers.includes(username.toLowerCase());
}

// ─── User Search ────────────────────────────────────────────────────────────
function filterUsers(searchTerm) {
  if (!searchTerm) return state.users;
  return state.users.filter(u => u.toLowerCase().includes(searchTerm.toLowerCase()));
}

function filterFriends(searchTerm) {
  if (!searchTerm) return state.friends;
  return state.friends.filter(u => u.toLowerCase().includes(searchTerm.toLowerCase()));
}

// ─── Enhanced Settings ───────────────────────────────────────────────────────
function loadSettings() {
  try {
    const saved = localStorage.getItem("pychatter.settings");
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  localStorage.setItem("pychatter.settings", JSON.stringify(settings));
}

// ─── Auto-reconnection ───────────────────────────────────────────────────────
const originalConnectSocket = connectSocket;
connectSocket = function() {
  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  const candidates = [`${wsProtocol}://${location.host}/ws`, `${wsProtocol}://${location.hostname}:9011/ws`];

  const connectAt = (index) => {
    if (index >= candidates.length) {
      statusText.textContent = "WebSocket unavailable";
      setAuthenticated(false);
      handleConnectionError(new Error("No WebSocket candidates available"));
      return;
    }

    const ws = new WebSocket(candidates[index]);
    let opened = false;
    let timeout;

    timeout = setTimeout(() => {
      if (!opened) ws.close();
    }, 5000);

    ws.addEventListener("open", () => {
      opened = true;
      clearTimeout(timeout);
      state.ws = ws;
      state.reconnectAttempts = 0;
      statusText.textContent = "Connected";
      if (!attemptTokenLogin()) {
        setAuthenticated(false);
        setAuthMode("login");
      }
    });

    ws.addEventListener("close", () => {
      if (!opened) {
        connectAt(index + 1);
        return;
      }
      statusText.textContent = "Disconnected";
      endCall(false);
      setAuthenticated(false);
      syncActionButtons();
      handleConnectionError(new Error("WebSocket closed"));
    });

    ws.addEventListener("error", (event) => {
      handleConnectionError(event);
    });

    ws.addEventListener("message", (event) => {
      try {
        const packet = JSON.parse(event.data);
        handlePacket(packet);
      } catch (err) {
        console.error("Failed to parse packet:", err);
      }
    });
  };

  connectAt(0);
};

// ─── Initialize ──────────────────────────────────────────────────────────────
// Load all persisted data
loadBookmarks();
loadBlockedUsers();
loadFavorites();
loadMentionHistory();
loadPinnedMessages();
loadMessageThreads();
requestNotificationPermission();

// Load user preferences
try {
  const savedStatus = localStorage.getItem("pychatter.status");
  if (savedStatus) state.userStatus = savedStatus;
  const savedCustomStatus = localStorage.getItem("pychatter.customStatus");
  if (savedCustomStatus) state.customStatus = savedCustomStatus;
} catch {
  // Use defaults
}

updateStatusBadge();
connectSocket();
loadRtcConfig();
syncActionButtons();
