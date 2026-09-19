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
  replyingTo: null, // Feature 5: {id, author, content} of message being replied to
  userTypingStatus: {}, // Feature 6: Who's typing
  recentMentions: [], // Feature 7: @mentions tracking
  memberStatuses: {}, // username -> "online" | "idle" | "dnd" | "offline" (server-synced)
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
  showLoginBtn.classList.toggle("hidden", isLogin);
  showRegisterBtn.classList.toggle("hidden", !isLogin);
  $("authSwitchLabel").textContent = isLogin ? "Need an account?" : "Already have an account?";
  authTitle.textContent = isLogin ? "Welcome back!" : "Create an account";
  authSubtitle.textContent = isLogin
    ? "We're so excited to see you again!"
    : "";
  authSubmitBtn.textContent = isLogin ? "Log In" : "Continue";
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
  const isSelf = name === state.username;
  const status = isSelf ? state.userStatus : (state.memberStatuses[name] || "online");

  const li = document.createElement("li");
  li.className = "member-row" + (isActive ? " active" : "") + (status === "offline" ? " offline" : "");
  li.innerHTML = `
    <span class="member-avatar-wrap">
      <span class="member-avatar${profile.avatar_url ? " has-image" : ""}"${avatarStyle}>${profile.avatar_url ? "" : initial}</span>
      <span class="member-status status-${status}"></span>
    </span>
    <span class="member-name"${nameStyle}>${escapeHtml(name)}</span>
    ${role !== "member" ? `<span class="member-role-badge role-${role}">${role}</span>` : ""}
    ${isSelf ? "" : `<button class="member-context-btn" title="More" type="button">⋯</button>`}
  `;
  li.addEventListener("click", () => onSelect(name));

  const ctxBtn = li.querySelector(".member-context-btn");
  if (ctxBtn) {
    ctxBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openMemberContextMenu(name);
    });
  }
  return li;
}

function openMemberContextMenu(name) {
  const isBlocked = isUserBlocked(name);
  const isMod = state.role === "admin" || state.role === "mod";
  const content = `<div class="menu-list">
    ${menuRow("💬", "Message", `closeModal(); openDmComposer('${name}')`)}
    ${menuRow("📜", "DM History", `closeModal(); openDmHistory('${name}')`)}
    ${state.role === "admin" ? menuRow("👑", "Set Role", `closeModal(); openRoleSelector('${name}')`) : ""}
    <div class="menu-divider"></div>
    ${isBlocked
      ? menuRow("✅", "Unblock User", `closeModal(); unblockSelectedUser('${name}')`)
      : menuRow("🚫", "Block User", `closeModal(); blockSelectedUser('${name}')`, true)}
    ${isMod ? `<div class="menu-divider"></div>` : ""}
    ${isMod ? menuRow("⏱️", "Timeout User", `closeModal(); openTimeoutModal('${name}')`, true) : ""}
    ${isMod ? menuRow("👢", "Kick User", `closeModal(); kickUser('${name}')`, true) : ""}
  </div>`;
  showModal(name, content, []);
}

// FEATURE 13/14: Moderation — kick & timeout
window.kickUser = function(name) {
  showConfirmModal("Kick User", `Kick ${name} from the server? They can rejoin by reconnecting.`, `confirmKick('${name}')`);
};

window.confirmKick = function(name) {
  closeModal();
  send({ type: "moderate_kick", username: name.toLowerCase() });
  showSuccess(`Kicked ${name}`);
};

window.openTimeoutModal = function(name) {
  const durations = [
    { label: "1 minute", seconds: 60 },
    { label: "5 minutes", seconds: 300 },
    { label: "15 minutes", seconds: 900 },
    { label: "1 hour", seconds: 3600 },
  ];
  const content = `<div class="menu-list">${durations.map(d =>
    menuRow("⏱️", d.label, `applyTimeout('${name}', ${d.seconds})`)
  ).join("")}</div>`;
  showModal(`Timeout ${name}`, content, []);
};

window.applyTimeout = function(name, seconds) {
  closeModal();
  send({ type: "moderate_timeout", username: name.toLowerCase(), seconds });
  showSuccess(`${name} timed out`);
};

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

function setDisabled(id, value) {
  const el = $(id);
  if (el) el.disabled = value;
}

function syncActionButtons() {
  const hasTarget = !!selectedTarget();
  const inCall = !!state.rtc.pc;
  const micCamReady = !!state.rtc.localStream;
  setDisabled("voiceCallBtn", !state.isAuthed || !hasTarget);
  setDisabled("videoCallBtn", !state.isAuthed || !hasTarget);
  setDisabled("hangupBtn", !state.isAuthed || !inCall);
  setDisabled("toggleMicBtn", !state.isAuthed || !micCamReady);
  setDisabled("toggleCamBtn", !state.isAuthed || !micCamReady);
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

// Discord-subset markdown. Runs on already-escaped text, so it's safe to
// inject the handful of tags below — no user-controlled HTML can slip in.
function renderMarkdown(escaped) {
  // Code blocks first so ** / * / ~~ inside them aren't touched.
  const blocks = [];
  let text = escaped.replace(/```([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre class="msg-codeblock"><code>${code.trim()}</code></pre>`);
    return `■${blocks.length - 1}■`;
  });

  text = text.replace(/`([^`\n]+)`/g, '<code class="msg-inline-code">$1</code>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(?:^|(?<=\s))_([^_\n]+)_(?=\s|$)/g, "<em>$1</em>");
  text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  text = text.replace(/■(\d+)■/g, (_, i) => blocks[Number(i)]);
  return text;
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

function buildMsgToolbar(msgId, author, content) {
  const bar = document.createElement("div");
  bar.className = "msg-toolbar";

  const reactBtn = document.createElement("button");
  reactBtn.textContent = "😊";
  reactBtn.title = "React";
  reactBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleEmojiPicker(msgId, reactBtn); });
  bar.appendChild(reactBtn);

  const replyBtn = document.createElement("button");
  replyBtn.textContent = "↩️";
  replyBtn.title = "Reply";
  replyBtn.addEventListener("click", (e) => { e.stopPropagation(); startReply(msgId, author, content); });
  bar.appendChild(replyBtn);

  const bookmarkBtn = document.createElement("button");
  bookmarkBtn.textContent = state.bookmarkedMessages.has(String(msgId)) ? "🔖" : "📑";
  bookmarkBtn.title = "Bookmark message";
  bookmarkBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    bookmarkLatestMessage(msgId);
    bookmarkBtn.textContent = state.bookmarkedMessages.has(String(msgId)) ? "🔖" : "📑";
  });
  bar.appendChild(bookmarkBtn);

  if (state.role === "admin" || state.role === "mod") {
    const pinBtn = document.createElement("button");
    const isPinned = getPinnedMessages().includes(msgId);
    pinBtn.textContent = isPinned ? "📌" : "📍";
    pinBtn.title = isPinned ? "Unpin message" : "Pin message";
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (getPinnedMessages().includes(msgId)) {
        unpinMessage(msgId);
        showInfo("Message unpinned");
      } else {
        pinMessage(msgId);
        showSuccess("Message pinned");
      }
      pinBtn.textContent = getPinnedMessages().includes(msgId) ? "📌" : "📍";
    });
    bar.appendChild(pinBtn);
  }

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

// Discord groups consecutive messages from the same author sent within a
// short window: one avatar+name header, subsequent lines just show the
// text with the timestamp revealed on hover.
const GROUP_WINDOW_SECONDS = 7 * 60;
let _lastRenderedAuthor = "";
let _lastRenderedAt = 0;

function resetMessageGrouping() {
  _lastRenderedAuthor = "";
  _lastRenderedAt = 0;
}

function shouldGroupWith(author, createdAt) {
  if (!author || !createdAt) return false;
  if (author !== _lastRenderedAuthor) return false;
  return createdAt - _lastRenderedAt < GROUP_WINDOW_SECONDS;
}

function buildMessageEl(opts) {
  const isSystem = opts.type === "system";
  const isDeleted = !!opts.deleted;
  const author = opts.author || "";
  const createdAt = opts.created_at || 0;

  const grouped = !isSystem && !opts.reply_preview && shouldGroupWith(author, createdAt);
  if (!isSystem) {
    _lastRenderedAuthor = author;
    _lastRenderedAt = createdAt || _lastRenderedAt;
  } else {
    resetMessageGrouping();
  }

  const box = document.createElement("article");
  box.className = "msg"
    + (isSystem ? " system" : "")
    + (isDeleted ? " msg-deleted" : "")
    + (grouped ? " msg-grouped" : "");
  if (opts.id) {
    box.id = `msg-${opts.id}`;
    box.dataset.msgId = opts.id;
    box.dataset.msgAuthor = author;
  }

  const ts = createdAt
    ? new Date(createdAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  const profile = profileFor(author);
  const authorColor = opts.author_name_color || profile.name_color || "";
  const authorStyle = authorColor ? ` style="color:${escapeHtml(authorColor)}"` : "";
  const initial = escapeHtml((author || "?").slice(0, 1).toUpperCase());
  const avatarStyle = profile.avatar_url ? ` style="background-image:url('${escapeHtml(profile.avatar_url)}')"` : "";

  if (!isSystem) {
    const gutter = document.createElement("div");
    gutter.className = "msg-gutter";
    if (grouped) {
      gutter.innerHTML = `<span class="msg-hover-ts">${ts}</span>`;
    } else {
      gutter.innerHTML = `<span class="msg-avatar${profile.avatar_url ? " has-image" : ""}"${avatarStyle}>${profile.avatar_url ? "" : initial}</span>`;
    }
    box.appendChild(gutter);
  }

  const content = document.createElement("div");
  content.className = "msg-content";

  if (opts.reply_preview) {
    const quote = document.createElement("div");
    quote.className = "msg-reply-quote";
    const rp = opts.reply_preview;
    quote.innerHTML = `<span class="reply-icon">↩</span><span class="reply-author">${escapeHtml(rp.author || "?")}</span><span class="reply-text">${escapeHtml((rp.content || "").slice(0, 100))}</span>`;
    content.appendChild(quote);
  }

  if (!grouped) {
    const head = document.createElement("div");
    head.className = "who";
    head.innerHTML = `<span class="msg-author"${authorStyle}>${escapeHtml(author)}</span>${ts ? ` <span class="msg-ts">${ts}</span>` : ""}`;
    content.appendChild(head);
  }

  const body = document.createElement("div");
  body.className = "msg-body";
  body.dataset.raw = opts.content || "";
  if (isDeleted) {
    body.innerHTML = "<em>[deleted]</em>";
  } else {
    body.innerHTML = renderMarkdown(highlightMentions(escapeHtml(opts.content || "")));
    if (opts.edited_at) {
      const mark = document.createElement("span");
      mark.className = "edited-mark";
      mark.textContent = " (edited)";
      body.appendChild(mark);
    }
  }
  content.appendChild(body);

  if (!isSystem && opts.id) {
    if (!isDeleted) content.appendChild(buildMsgToolbar(opts.id, opts.author, opts.content || ""));
    content.appendChild(buildReactRow(opts.id, opts.reactions || {}));
  }

  box.appendChild(content);
  return box;
}

function addMessage(who, text, type = "normal") {
  const box = buildMessageEl({ author: who, content: text, type });
  messagesEl.appendChild(box);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderHistory(history) {
  messagesEl.innerHTML = "";
  resetMessageGrouping();
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
      reply_preview: msg.reply_preview || null,
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
  if (!names.length) { el.innerHTML = ""; return; }
  const label = names.length === 1
    ? `<strong>${escapeHtml(names[0])}</strong> is typing`
    : names.length === 2
      ? `<strong>${escapeHtml(names[0])}</strong> and <strong>${escapeHtml(names[1])}</strong> are typing`
      : `Several people are typing`;
  el.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>${label}`;
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
      Object.assign(state.memberStatuses, packet.statuses || {});
      if (packet.my_status) {
        state.userStatus = packet.my_status;
        updateStatusBadge();
      }
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
      markAsRead(state.channel);
      renderChannelList();
      renderHistory(packet.history || []);
      state.pinnedMessages.set(state.channel, packet.pinned || []);
      updatePinnedButton();
      renderPoll(state.channel, packet.poll || null);
      break;
    case "channel_activity":
      if (packet.channel && packet.channel !== state.channel) {
        incrementUnread(packet.channel);
        renderChannelList();
      }
      break;
    case "pinned_update":
      state.pinnedMessages.set(packet.channel, packet.pinned || []);
      if (packet.channel === state.channel) updatePinnedButton();
      break;
    case "search_results":
      handleSearchResults(packet);
      break;
    case "mention":
      trackMention(packet.by);
      showToast(`${packet.by} mentioned you in #${packet.channel}`, "info");
      showNotification(`${packet.by} mentioned you`, { body: packet.content || "" });
      break;
    case "poll_update":
      renderPoll(packet.channel, packet.poll);
      break;
    case "user_list":
      state.users = packet.users || [];
      mergeProfiles(packet.profiles || {});
      Object.assign(state.memberStatuses, packet.statuses || {});
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
        reply_preview: packet.reply_preview || null,
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
          body.innerHTML = renderMarkdown(highlightMentions(escapeHtml(packet.content || "")));
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
  const packet = { type: "message", content };
  if (state.replyingTo) packet.reply_to = state.replyingTo.id;
  send(packet);
  inputEl.value = "";
  cancelReply();
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

window.openDmComposer = function(targetName) {
  targetName = targetName || selectedTarget();
  if (!targetName) {
    showError("Select a user first");
    return;
  }
  state.selectedUser = targetName;
  state.selectedFriend = state.friends.includes(targetName) ? targetName : state.selectedFriend;
  showPromptModal(`💬 Message ${targetName}`, "Type your message:", "handleSendDM");
};

window.handleSendDM = function(text) {
  const targetName = selectedTarget();
  send({ type: "dm", to: targetName.toLowerCase(), content: text.trim() });
  showSuccess(`Message sent to ${targetName}`);
};

window.openChangeUsername = function() {
  if (!state.isAuthed) return;
  showPromptModal("✏️ Change Username", "Enter new username:", "handleChangeUsername");
};

window.handleChangeUsername = function(nextName) {
  const normalized = nextName.trim().toLowerCase();
  if (!normalized) {
    showError("Username cannot be empty");
    return;
  }
  send({ type: "change_username", new_username: normalized });
  showSuccess(`Changing username to ${nextName}`);
};

window.openDmHistory = function(targetName) {
  targetName = targetName || selectedTarget();
  if (!targetName) {
    showError("Select a user first");
    return;
  }
  state.selectedUser = targetName;
  send({ type: "dm_history", with: targetName.toLowerCase() });
};

window.openRoleSelector = function(targetName) {
  targetName = targetName || state.selectedUser;
  if (state.role !== "admin") {
    showError("Only admins can set roles");
    return;
  }
  if (!targetName) {
    showError("Select a user first");
    return;
  }
  state.selectedUser = targetName;
  const content = `<p style="color: var(--text); margin-bottom: 4px;">Select a role for <strong>${escapeHtml(targetName)}</strong>:</p>`;
  const buttons = [
    { label: "Member", type: "secondary", onclick: `applyRole('member')` },
    { label: "Moderator", type: "secondary", onclick: `applyRole('mod')` },
    { label: "Admin", type: "danger", onclick: `applyRole('admin')` },
  ];
  showModal("Set Role", content, buttons);
};

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

window.blockSelectedUser = function(targetName) {
  if (!state.isAuthed) return;
  const target = targetName || selectedTarget();
  if (!target) {
    showError("Select a user first");
    return;
  }
  blockUserWithServer(target);
};

window.unblockSelectedUser = function(targetName) {
  if (!state.isAuthed) return;
  if (targetName) {
    unblockUserWithServer(targetName);
    return;
  }
  showPromptModal("✅ Unblock User", "Enter username to unblock:", "handleUnblockUser");
};

window.handleUnblockUser = function(username) {
  unblockUserWithServer(username);
};

// New Feature Event Listeners
$("statusBtn").addEventListener("click", () => {
  showStatusSelector();
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

function menuRow(icon, label, onclick, danger = false) {
  return `<button class="menu-row${danger ? " danger" : ""}" onclick="${onclick}"><span class="menu-row-icon">${icon}</span><span>${label}</span></button>`;
}

$("quickMenuBtn").addEventListener("click", () => {
  const content = `
    <div class="menu-list">
      ${menuRow("🟢", "Change Status", "showStatusSelector()")}
      ${menuRow("💬", "Set Custom Status", "openCustomStatusModal()")}
      ${menuRow("✏️", "Change Username", "openChangeUsername()")}
      ${menuRow("🖼️", "Set Avatar", "openSetAvatar()")}
      ${menuRow("🎨", "Set Name Color", "openSetNameColor()")}
      ${menuRow("🔖", "View Bookmarks", "openBookmarksList()")}
      ${menuRow("👤", "Account Info", "showAccountInfo()")}
      <div class="menu-divider"></div>
      ${menuRow("🚪", "Log Out", "doLogout()", true)}
    </div>
  `;
  showModal("Account", content, []);
});

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
  showModal("Account Info", info, [
    { label: "Close", type: "primary", onclick: "closeModal()" }
  ]);
};

const DISCORD_STATUSES = [
  { key: "online", label: "Online" },
  { key: "idle", label: "Idle" },
  { key: "dnd", label: "Do Not Disturb" },
  { key: "offline", label: "Invisible" },
];

window.showStatusSelector = function() {
  const content = `<div class="menu-list">${DISCORD_STATUSES.map(s => `
    <button class="menu-row" onclick="setUserStatus('${s.key}'); closeModal();">
      <span class="status-swatch status-${s.key}"></span>
      <span>${s.label}</span>
      ${state.userStatus === s.key ? '<span style="margin-left:auto; color:var(--brand-2);">✓</span>' : ""}
    </button>
  `).join("")}</div>`;
  showModal("Change Status", content, []);
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

// Message Search — live filter of loaded messages, Enter triggers a full
// server-side search across the channel's entire history (not just what's loaded).
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

  messageSearch.addEventListener("keypress", (e) => {
    if (e.key !== "Enter") return;
    const query = e.target.value.trim();
    if (!query) return;
    send({ type: "search_messages", channel: state.channel, query });
  });
}

// FEATURE 12: Channel Polls (server-authoritative)
function renderPoll(channel, poll) {
  if (channel !== state.channel) return;
  const container = $("pollContainer");
  if (!container) return;

  if (!poll) {
    container.innerHTML = "";
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");
  const total = poll.counts.reduce((a, b) => a + b, 0) || 1;
  const rows = poll.options.map((opt, i) => {
    const pct = Math.round((poll.counts[i] / total) * 100);
    return `
      <button class="poll-option" onclick="voteInPoll('${poll.id}', ${i})">
        <span class="poll-option-bar" style="width:${pct}%"></span>
        <span class="poll-option-label">${escapeHtml(opt)}</span>
        <span class="poll-option-count">${poll.counts[i]} · ${pct}%</span>
      </button>
    `;
  }).join("");

  container.innerHTML = `
    <div class="poll-card">
      <div class="poll-question">📊 ${escapeHtml(poll.question)}</div>
      <div class="poll-options">${rows}</div>
      <div class="poll-meta">Started by ${escapeHtml(poll.created_by)}</div>
    </div>
  `;
}

window.voteInPoll = function(pollId, optionIndex) {
  send({ type: "poll_vote", poll_id: pollId, option: optionIndex });
};

window.openCreatePoll = function() {
  const content = `
    <div class="form-group">
      <label class="form-label">Question</label>
      <input type="text" id="pollQuestion" class="form-input" placeholder="What's the question?" autofocus>
    </div>
    <div class="form-group">
      <label class="form-label">Options (one per line, 2-6)</label>
      <textarea id="pollOptions" class="form-input" rows="4" placeholder="Option A\nOption B\nOption C"></textarea>
    </div>
  `;
  showModal("📊 New Poll", content, [
    { label: "Cancel", type: "secondary", onclick: "closeModal()" },
    { label: "Create Poll", type: "primary", onclick: "submitCreatePoll()" },
  ]);
};

window.submitCreatePoll = function() {
  const question = $("pollQuestion")?.value?.trim();
  const options = ($("pollOptions")?.value || "")
    .split("\n")
    .map((o) => o.trim())
    .filter(Boolean)
    .slice(0, 6);
  closeModal();
  if (!question || options.length < 2) {
    showError("A poll needs a question and at least 2 options");
    return;
  }
  send({ type: "poll_create", question, options });
};

// FEATURE 11: Server-backed full-history message search
window.handleSearchResults = function(packet) {
  const results = packet.results || [];
  if (results.length === 0) {
    showInfo(`No messages found for "${packet.query}"`);
    return;
  }
  const rows = results.map((m) => `
    <div style="padding:8px 0; border-bottom:1px solid #25282c;">
      <strong>${escapeHtml(m.author)}</strong>
      <span style="color:var(--senary); font-size:12px;"> ${new Date(m.created_at * 1000).toLocaleString()}</span>
      <br>${escapeHtml(m.content)}
    </div>
  `).join("");
  showModal(`🔎 "${packet.query}" in #${packet.channel}`, rows, [
    { label: "Close", type: "primary", onclick: "closeModal()" },
  ]);
};

window.bookmarkLatestMessage = function(msgId) {
  if (!msgId) {
    const selected = messagesEl.querySelector(".msg:last-child");
    msgId = selected?.dataset?.msgId;
  }
  if (!msgId) {
    showError("No messages to bookmark");
    return;
  }
  if (state.bookmarkedMessages.has(msgId)) {
    unbookmarkMessage(msgId);
    showInfo("Bookmark removed");
  } else {
    bookmarkMessage(msgId);
    showSuccess("Message bookmarked!");
  }
};

window.openBookmarksList = function() {
  if (state.bookmarkedMessages.size === 0) {
    showInfo("No bookmarked messages yet");
    return;
  }
  const rows = Array.from(state.bookmarkedMessages).map((id) => {
    const box = document.getElementById(`msg-${id}`);
    const author = box?.dataset?.msgAuthor || "?";
    const text = box?.querySelector(".msg-body")?.textContent || "(message not loaded)";
    return `<div style="padding:8px 0; border-bottom:1px solid #25282c;"><strong>${escapeHtml(author)}</strong><br><span style="color:var(--senary);">${escapeHtml(text)}</span></div>`;
  }).join("");
  showModal("🔖 Bookmarked Messages", rows, [
    { label: "Close", type: "primary", onclick: "closeModal()" },
  ]);
};

window.openSetNameColor = function() {
  if (!state.isAuthed) return;
  showPromptModal("🎨 Set Name Color", "Enter color name or hex code (e.g., red, #7289da):", "handleSetNameColor");
};

window.handleSetNameColor = function(color) {
  send({ type: "set_profile", name_color: color });
  showSuccess("Name color updated");
};

window.openSetAvatar = function() {
  if (!state.isAuthed) return;
  const content = `
    <div id="avatarDropZone" class="avatar-drop-zone">
      <div id="avatarDropPreview" class="avatar-drop-preview">🖼️</div>
      <div class="avatar-drop-text">
        <strong>Drag & drop an image</strong><br>
        or click to browse
      </div>
      <input type="file" id="avatarFileInput" accept="image/*" style="display:none;">
    </div>
    <div class="form-group" style="margin-top:14px;">
      <label class="form-label">Or paste an image URL</label>
      <input type="text" id="avatarUrlInput" class="form-input" placeholder="https://...">
    </div>
  `;
  showModal("🖼️ Set Avatar", content, [
    { label: "Cancel", type: "secondary", onclick: "closeModal()" },
    { label: "Save", type: "primary", onclick: "submitAvatarFromModal()" },
  ]);
  setTimeout(initAvatarDropZone, 50);
};

let _pendingAvatarDataUrl = "";

function initAvatarDropZone() {
  const zone = $("avatarDropZone");
  const fileInput = $("avatarFileInput");
  const preview = $("avatarDropPreview");
  if (!zone || !fileInput) return;

  _pendingAvatarDataUrl = "";

  zone.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) {
      processAvatarFile(fileInput.files[0], preview);
    }
  });

  ["dragenter", "dragover"].forEach((evt) => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add("dragging");
    });
  });

  ["dragleave", "dragend"].forEach((evt) => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove("dragging");
    });
  });

  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("dragging");
    const file = e.dataTransfer?.files?.[0];
    if (file) processAvatarFile(file, preview);
  });
}

function processAvatarFile(file, preview) {
  if (!file.type.startsWith("image/")) {
    showError("Please choose an image file");
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    showError("Image too large (max 8MB)");
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // Downscale to a reasonable avatar size so the data URL stays small
      const maxSize = 256;
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      _pendingAvatarDataUrl = canvas.toDataURL("image/jpeg", 0.85);
      if (preview) {
        preview.style.backgroundImage = `url(${_pendingAvatarDataUrl})`;
        preview.style.backgroundSize = "cover";
        preview.style.backgroundPosition = "center";
        preview.textContent = "";
      }
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

window.submitAvatarFromModal = function() {
  const urlInput = $("avatarUrlInput")?.value?.trim();
  const avatarUrl = _pendingAvatarDataUrl || urlInput;
  if (!avatarUrl) {
    showError("Choose an image or paste a URL first");
    return;
  }
  closeModal();
  send({ type: "set_profile", avatar_url: avatarUrl });
  showSuccess("Avatar updated");
};

window.doLogout = function() {
  closeModal();
  endCall(false);
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    clearRemember();
    setAuthenticated(false);
    setAuthMode("login");
    return;
  }
  send({ type: "logout", remember_token: state.rememberToken });
  clearRemember();
};

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
  if (newStatus === "away") newStatus = "idle"; // legacy alias
  const validStatuses = ["online", "idle", "dnd", "offline"];
  if (validStatuses.includes(newStatus)) {
    state.userStatus = newStatus;
    updateStatusBadge();
    localStorage.setItem("pychatter.status", newStatus);
    send({ type: "set_status", status: newStatus });
    showSuccess(`Status set to ${DISCORD_STATUSES.find(s => s.key === newStatus)?.label || newStatus}`);
  }
}

let _customStatusClearTimer = null;

function setCustomStatus(message, clearAfterMs = null) {
  state.customStatus = message;
  localStorage.setItem("pychatter.customStatus", message);
  send({ type: "set_custom_status", message });
  updateStatusBadge();

  if (_customStatusClearTimer) {
    clearTimeout(_customStatusClearTimer);
    _customStatusClearTimer = null;
  }
  if (clearAfterMs) {
    _customStatusClearTimer = setTimeout(() => setCustomStatus(""), clearAfterMs);
  }
}

// Discord's own suggested custom statuses
const CUSTOM_STATUS_SUGGESTIONS = [
  { emoji: "💡", text: "Working on something" },
  { emoji: "🎯", text: "Focusing" },
  { emoji: "📅", text: "In a meeting" },
  { emoji: "🌙", text: "Sleeping" },
  { emoji: "🍕", text: "Eating" },
  { emoji: "🏖️", text: "Vacationing" },
];

const CUSTOM_STATUS_EMOJI = ["😀", "🎮", "🎵", "📚", "💻", "☕", "🔥", "💤", "🚀", "❤️", "😴", "🤒"];

window.openCustomStatusModal = function() {
  const [savedEmoji, ...rest] = (state.customStatus || "").split(" ");
  const isEmoji = /\p{Emoji}/u.test(savedEmoji || "");
  const currentEmoji = isEmoji ? savedEmoji : "😀";
  const currentText = isEmoji ? rest.join(" ") : (state.customStatus || "");

  const content = `
    <div class="custom-status-row">
      <button class="emoji-trigger" id="statusEmojiTrigger" type="button">${currentEmoji}</button>
      <input type="text" id="customStatusText" class="form-input" placeholder="What's happening?" value="${escapeHtml(currentText)}" maxlength="100">
    </div>
    <div class="emoji-grid" id="statusEmojiGrid">
      ${CUSTOM_STATUS_EMOJI.map(e => `<button class="emoji-grid-btn" onclick="document.getElementById('statusEmojiTrigger').textContent='${e}'">${e}</button>`).join("")}
    </div>
    <div class="form-group">
      <label class="form-label">Suggestions</label>
      <div class="menu-list">
        ${CUSTOM_STATUS_SUGGESTIONS.map(s => `
          <button class="menu-row" onclick="document.getElementById('statusEmojiTrigger').textContent='${s.emoji}'; document.getElementById('customStatusText').value='${s.text}';">
            <span class="menu-row-icon">${s.emoji}</span><span>${s.text}</span>
          </button>
        `).join("")}
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Clear after</label>
      <select id="customStatusClear" class="form-input">
        <option value="0">Don't clear</option>
        <option value="1800000">30 minutes</option>
        <option value="3600000">1 hour</option>
        <option value="14400000">4 hours</option>
        <option value="86400000">Today</option>
      </select>
    </div>
  `;
  showModal("Set a custom status", content, [
    { label: "Clear Status", type: "secondary", onclick: "clearCustomStatus()" },
    { label: "Save", type: "primary", onclick: "submitCustomStatus()" },
  ]);
};

window.submitCustomStatus = function() {
  const emoji = $("statusEmojiTrigger")?.textContent || "";
  const text = $("customStatusText")?.value?.trim() || "";
  const clearAfter = parseInt($("customStatusClear")?.value || "0", 10);
  closeModal();
  if (!text) {
    showError("Enter a status message");
    return;
  }
  setCustomStatus(`${emoji} ${text}`, clearAfter || null);
  showSuccess("Status updated");
};

window.clearCustomStatus = function() {
  closeModal();
  setCustomStatus("");
  showInfo("Custom status cleared");
};

function updateStatusBadge() {
  const badge = $("statusBadge");
  if (badge) {
    const label = DISCORD_STATUSES.find(s => s.key === state.userStatus)?.label || "Online";
    const customPart = state.customStatus ? ` — ${escapeHtml(state.customStatus)}` : "";
    badge.innerHTML = `<span class="status-swatch status-${state.userStatus}"></span>${label}${customPart}`;
  }
  const selfDot = $("selfStatusDot");
  if (selfDot) {
    selfDot.className = `status-swatch status-${state.userStatus}`;
  }
  const statusBtnDot = document.querySelector("#statusBtn .status-swatch");
  if (statusBtnDot) {
    statusBtnDot.className = `status-swatch status-${state.userStatus}`;
  }
  renderUsers(); // refresh own row's status dot in the member list
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

// FEATURE 4: Message Pinning — server is the source of truth; state.pinnedMessages
// is populated from "welcome"/"channel_switched"/"pinned_update" packets only.
function pinMessage(msgId, channel = state.channel) {
  send({ type: "pin_message", id: msgId, channel });
}

function unpinMessage(msgId, channel = state.channel) {
  send({ type: "unpin_message", id: msgId, channel });
}

function getPinnedMessages(channel = state.channel) {
  return state.pinnedMessages.get(channel) || [];
}

function updatePinnedButton() {
  const btn = $("pinnedMessagesBtn");
  if (!btn) return;
  const count = getPinnedMessages().length;
  btn.textContent = count > 0 ? `📌 ${count}` : "📌";
  btn.classList.toggle("has-pins", count > 0);
}

window.openPinnedMessages = function() {
  const pins = getPinnedMessages();
  if (pins.length === 0) {
    showInfo("No pinned messages in this channel");
    return;
  }
  const rows = pins.map((id) => {
    const box = document.getElementById(`msg-${id}`);
    const author = box?.dataset?.msgAuthor || "?";
    const text = box?.querySelector(".msg-body")?.textContent || "(not loaded — scroll up)";
    const unpinBtn = (state.role === "admin" || state.role === "mod")
      ? `<button class="btn-modal secondary" style="padding:4px 10px;font-size:12px;" onclick="unpinMessage(${id}); closeModal();">Unpin</button>`
      : "";
    return `<div style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:8px 0; border-bottom:1px solid #25282c;">
      <div><strong>${escapeHtml(author)}</strong><br><span style="color:var(--senary);">${escapeHtml(text)}</span></div>
      ${unpinBtn}
    </div>`;
  }).join("");
  showModal(`📌 Pinned in #${state.channel}`, rows, [
    { label: "Close", type: "primary", onclick: "closeModal()" },
  ]);
};

// FEATURE 5: Reply to message (server-backed — see reply_to on the "message"
// packet and store.get_reply_preview()). Clicking Reply on a message shows a
// banner above the composer; sending includes reply_to and the server
// resolves + persists the quoted preview.
function startReply(msgId, author, content) {
  state.replyingTo = { id: msgId, author, content };
  renderReplyBanner();
  inputEl.focus();
}

function cancelReply() {
  state.replyingTo = null;
  renderReplyBanner();
}

function renderReplyBanner() {
  const banner = $("replyBanner");
  if (!banner) return;
  if (!state.replyingTo) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    return;
  }
  const preview = (state.replyingTo.content || "").slice(0, 80);
  banner.classList.remove("hidden");
  banner.innerHTML = `
    <span class="reply-banner-text">Replying to <strong>${escapeHtml(state.replyingTo.author)}</strong> — ${escapeHtml(preview)}</span>
    <button type="button" class="reply-banner-cancel" onclick="cancelReply()">✕</button>
  `;
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

// Discord-style channel list: unread channels render bold/white with an
// unread-count pill, favorited channels get a star, click switches +
// marks that channel read.
function renderChannelList(filter = "") {
  const container = $("channels");
  if (!container) return;
  const items = filter ? searchChannels(filter) : state.channels;

  container.innerHTML = "";
  items.forEach((name) => {
    const unread = state.unreadCount[name] || 0;
    const isFavorite = state.favorites.has(name);
    const li = document.createElement("li");
    li.className = "channel-row" + (unread > 0 ? " unread" : "");
    if (name === state.channel) li.classList.add("active");
    li.innerHTML = `
      <span class="channel-row-name">${isFavorite ? "⭐ " : ""}${escapeHtml(name)}</span>
      <span class="channel-row-right">
        ${unread > 0 ? `<span class="channel-unread-badge">${unread > 99 ? "99+" : unread}</span>` : ""}
        <button class="channel-favorite-btn${isFavorite ? " active" : ""}" title="${isFavorite ? "Remove from favorites" : "Add to favorites"}" type="button">${isFavorite ? "★" : "☆"}</button>
      </span>
    `;
    li.addEventListener("click", () => {
      send({ type: "switch_channel", channel: name });
    });
    const favBtn = li.querySelector(".channel-favorite-btn");
    favBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavorite(name);
    });
    container.appendChild(li);
  });

  const countEl = $("channelCount");
  if (countEl) countEl.textContent = state.channels.length;
}

// Kept as an alias — favorites/search code was written against this name.
function renderChannels() {
  renderChannelList($("channelSearch")?.value || "");
}

// FEATURE 9: Channel Search/Filter
function filterChannelList(search) {
  renderChannelList(search);
}

// FEATURE 10: Enhanced Typing Notifications
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
