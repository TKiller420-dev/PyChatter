const state = {
  ws: null,
  username: "",
  rememberToken: "",
  attemptedTokenAuth: false,
  role: "member",
  roles: ["member"],
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
  dmView: "", // username of the DM conversation currently open, "" = viewing a channel
  dmPartners: [], // [{username, lastAt}] — people you've exchanged DMs with, most recent first
  dmUnread: {}, // username -> unread count
  customStatuses: {}, // username -> custom status message (server-synced, shown in member list)
  userTypingStatus: {}, // Feature 6: Who's typing
  recentMentions: [], // Feature 7: @mentions tracking
  memberStatuses: {}, // username -> "online" | "idle" | "dnd" | "offline" (server-synced)
  rtc: {
    pc: null,
    localStream: null,
    peer: "",
    callMode: "",
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    pendingIceCandidates: {},
    voicePeers: {},
    voicePendingIce: {},
  },
  pendingIncomingCall: null, // {from, mediaType, sdp} — an offer waiting on Accept/Decline
};

const $ = (id) => document.getElementById(id);

const channelsEl = $("channels");
const usersEl = $("users");
const messagesEl = $("messages");
const inputEl = $("messageInput");
const sendBtn = $("sendBtn");
const statusText = $("statusText");
const channelTitle = $("channelTitle");
const channelMeta = $("channelMeta");
const chatGlyph = $("chatGlyph");
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
const dmListEl = $("dmList");
const voiceRoomsListEl = $("voiceRoomsList");
const voiceRoomMetaEl = $("voiceRoomMeta");
const usersMetaEl = $("usersMeta");
const friendsMetaEl = $("friendsMeta");
const requestsMetaEl = $("requestsMeta");

function renderDmList(filter = "") {
  if (!dmListEl) return;
  dmListEl.innerHTML = "";
  const query = String(filter || "").trim().toLowerCase();
  const items = query
    ? Array.from(new Set([...state.users, ...state.friends])).filter((name) => name !== state.username && name.toLowerCase().includes(query)).map((name) => ({ username: name, unread: 0 }))
    : state.dmPartners.filter((partner) => (partner.username || partner) !== state.username);
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "dm-empty";
    empty.textContent = query ? "No people found" : "No conversations yet";
    dmListEl.appendChild(empty);
    return;
  }
  items.forEach((partner) => {
    const name = partner.username || partner;
    const profile = profileFor(name);
    const initial = escapeHtml((name || "?").slice(0, 1).toUpperCase());
    const avatarStyle = profile.avatar_url ? ` style="background-image:url('${escapeHtml(profile.avatar_url)}')"` : "";
    const unread = Number(partner.unread || state.dmUnread[name] || 0);
    const li = document.createElement("li");
    li.className = `dm-row${state.dmView === name ? " active" : ""}${unread ? " unread" : ""}`;
    li.innerHTML = `<span class="identity-avatar${profile.avatar_url ? " has-image" : ""}"${avatarStyle}>${profile.avatar_url ? "" : initial}</span>`
      + `<span class="dm-name">${escapeHtml(name)}</span>`
      + (unread ? `<span class="dm-unread-badge">${unread > 99 ? "99+" : unread}</span>` : "");
    li.addEventListener("click", () => openDmConversation(name));
    dmListEl.appendChild(li);
  });
}

function openDmConversation(name) {
  const peer = String(name || "").trim().toLowerCase();
  if (!peer || peer === state.username) return;
  state.dmView = peer;
  state.selectedUser = peer;
  state.selectedFriend = state.friends.includes(peer) ? peer : "";
  state.dmUnread[peer] = 0;
  appView.classList.add("dm-active");
  chatGlyph.textContent = "@";
  channelTitle.textContent = `@${peer}`;
  channelMeta.textContent = "Direct message";
  inputEl.placeholder = `Message @${peer}`;
  messagesEl.innerHTML = "";
  send({ type: "dm_history", with: peer });
  send({ type: "dm_mark_read", with: peer });
  renderDmList();
  syncActionButtons();
}

window.openDmConversation = openDmConversation;

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
  const candidates = [
    `${wsProtocol}://${location.hostname}:9011/ws`,
    `${wsProtocol}://${location.host}/ws`,
  ];

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
      dismissIncomingCall();
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

const ROLE_ORDER = ["owner", "god", "admin", "satan", "lead_developer", "developer", "mod", "member"];
const ROLE_LABELS = {
  owner: "Owner",
  god: "God",
  admin: "Admin",
  satan: "Satan",
  lead_developer: "Lead Developer",
  developer: "Developer",
  mod: "Mod",
  member: "Member",
};
const ROLE_GROUP_LABELS = {
  owner: "Owner",
  god: "God Mode",
  admin: "Admins",
  satan: "Infernal Affairs",
  lead_developer: "Lead Developers",
  developer: "Developers",
  mod: "Moderators",
  member: "Online",
};
const ROLE_MANAGER_ROLES = new Set(["owner", "god", "admin", "lead_developer"]);
const MODERATION_ROLES = new Set(["owner", "god", "admin", "satan", "lead_developer", "mod"]);
const MESSAGE_POWER_ROLES = new Set(["owner", "god", "admin", "satan", "lead_developer", "developer", "mod"]);

function normalizeRole(role) {
  return String(role || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeRoles(roles) {
  const raw = Array.isArray(roles)
    ? roles
    : String(roles || "").split(/[,|]/);
  const cleaned = new Set(raw.map(normalizeRole).filter((role) => ROLE_ORDER.includes(role)));
  if (cleaned.size === 0) cleaned.add("member");
  if (cleaned.size > 1) cleaned.delete("member");
  return ROLE_ORDER.filter((role) => cleaned.has(role));
}

function primaryRole(roles) {
  return normalizeRoles(roles)[0] || "member";
}

function hasAnyRole(roles, allowed) {
  return normalizeRoles(roles).some((role) => allowed.has(role));
}

function canManageRoles() {
  return hasAnyRole(state.roles, ROLE_MANAGER_ROLES);
}

function canModerate() {
  return hasAnyRole(state.roles, MODERATION_ROLES);
}

function canManageMessages() {
  return hasAnyRole(state.roles, MESSAGE_POWER_ROLES);
}

function selectUserTarget(name) {
  if (!name) return;
  state.selectedUser = name;
  state.selectedFriend = state.friends.includes(name) ? name : "";
  renderFriends();
  renderUsers();
  syncActionButtons();
}

function mergeProfiles(profiles) {
  if (!profiles || typeof profiles !== "object") return;
  Object.entries(profiles).forEach(([username, profile]) => {
    if (!username || !profile || typeof profile !== "object") return;
    state.profiles[String(username).toLowerCase()] = {
      avatar_url: String(profile.avatar_url || ""),
      name_color: String(profile.name_color || ""),
      role: String(profile.role || profile.primary_role || "member"),
      roles: normalizeRoles(profile.roles || profile.role || profile.primary_role),
      primary_role: primaryRole(profile.roles || profile.role || profile.primary_role),
    };
  });
}

function profileFor(username) {
  return state.profiles[String(username || "").toLowerCase()] || {
    avatar_url: "",
    name_color: "",
    role: "member",
    roles: ["member"],
    primary_role: "member",
  };
}

const ROLE_GROUP_ORDER = ROLE_ORDER;

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

function describeIceCandidate(candidate) {
  const raw = typeof candidate === "string" ? candidate : (candidate?.candidate || "");
  const type = raw.match(/\btyp\s+(\w+)/)?.[1] || "?";
  const protocol = raw.match(/\b(udp|tcp)\b/i)?.[1]?.toLowerCase() || "?";
  return `type=${type} protocol=${protocol}`;
}

function queueRemoteIce(from, candidate) {
  const peer = String(from || "").toLowerCase();
  if (!peer || !candidate) return;
  if (!state.rtc.pendingIceCandidates[peer]) {
    state.rtc.pendingIceCandidates[peer] = [];
  }
  state.rtc.pendingIceCandidates[peer].push(candidate);
  logCall(`queued remote ICE from ${peer}: ${describeIceCandidate(candidate)}`);
}

async function flushRemoteIce(peer) {
  const pc = getConnection();
  const from = String(peer || "").toLowerCase();
  if (!pc || !from) return;
  const queued = state.rtc.pendingIceCandidates[from] || [];
  delete state.rtc.pendingIceCandidates[from];
  for (const candidate of queued) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
      logCall(`added queued remote ICE from ${from}: ${describeIceCandidate(candidate)}`);
    } catch (err) {
      logCall(`failed queued remote ICE from ${from}: ${err}`);
    }
  }
}

function getVoicePeer(peer) {
  return state.rtc.voicePeers[String(peer || "").toLowerCase()] || null;
}

function queueVoiceIce(from, candidate) {
  const peer = String(from || "").toLowerCase();
  if (!peer || !candidate) return;
  if (!state.rtc.voicePendingIce[peer]) state.rtc.voicePendingIce[peer] = [];
  state.rtc.voicePendingIce[peer].push(candidate);
  logCall(`queued voice-room ICE from ${peer}: ${describeIceCandidate(candidate)}`);
}

async function flushVoiceIce(peer) {
  const name = String(peer || "").toLowerCase();
  const entry = getVoicePeer(name);
  if (!entry) return;
  const queued = state.rtc.voicePendingIce[name] || [];
  delete state.rtc.voicePendingIce[name];
  for (const candidate of queued) {
    try {
      await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
      logCall(`added queued voice-room ICE from ${name}: ${describeIceCandidate(candidate)}`);
    } catch (err) {
      logCall(`failed queued voice-room ICE from ${name}: ${err}`);
    }
  }
}

function attachVoiceAudio(peer, stream) {
  const id = `voice-audio-${peer}`;
  let audio = document.getElementById(id);
  if (!audio) {
    audio = document.createElement("audio");
    audio.id = id;
    audio.autoplay = true;
    audio.playsInline = true;
    audio.dataset.voicePeer = peer;
    audio.className = "voice-room-audio";
    callPanel.appendChild(audio);
  }
  audio.srcObject = stream;
  playMediaElement(audio);
}

async function createVoiceRoomPeer(peer, initiator = false) {
  const name = String(peer || "").toLowerCase();
  if (!name || name === state.username) return null;
  const existing = getVoicePeer(name);
  if (existing) return existing.pc;

  const room = state.currentVoiceRoom;
  const pc = new RTCPeerConnection({ iceServers: state.rtc.iceServers });
  state.rtc.voicePeers[name] = { pc, room };

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      logCall(`voice room ICE gathering complete for ${name}`);
      return;
    }
    logCall(`voice room local ICE for ${name}: ${describeIceCandidate(event.candidate)}`);
    send({
      type: "rtc_signal",
      to: name,
      signalType: "ice",
      candidate: event.candidate,
      context: "voice_room",
      room,
    });
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    logCall(`voice room ontrack from ${name}: ${event.track.kind} muted=${event.track.muted}`);
    event.track.onunmute = () => logCall(`voice room ${name} ${event.track.kind} UNMUTED`);
    event.track.onmute = () => logCall(`voice room ${name} ${event.track.kind} MUTED`);
    if (stream) attachVoiceAudio(name, stream);
  };

  pc.onconnectionstatechange = () => {
    logCall(`voice room ${name} connectionState -> ${pc.connectionState}`);
    if (pc.connectionState === "connected") {
      setCallStatus(`In voice #${state.currentVoiceRoom}`);
      logActiveCandidatePair(pc);
    } else if (["failed", "closed"].includes(pc.connectionState)) {
      logCandidatePairSummary(pc);
      closeVoiceRoomPeer(name);
    }
  };

  pc.oniceconnectionstatechange = () => {
    logCall(`voice room ${name} iceConnectionState -> ${pc.iceConnectionState}`);
  };

  const stream = await ensureLocalMedia("voice");
  stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
  callPanel.classList.remove("hidden");
  setCallStatus(`In voice #${room}`);
  syncActionButtons();

  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({
      type: "rtc_signal",
      to: name,
      signalType: "offer",
      sdp: pc.localDescription,
      mediaType: "voice",
      context: "voice_room",
      room,
    });
  }

  return pc;
}

function closeVoiceRoomPeer(peer) {
  const name = String(peer || "").toLowerCase();
  const entry = getVoicePeer(name);
  if (entry) {
    try {
      entry.pc.onicecandidate = null;
      entry.pc.ontrack = null;
      entry.pc.close();
    } catch {
      // ignore close errors
    }
  }
  delete state.rtc.voicePeers[name];
  delete state.rtc.voicePendingIce[name];
  document.getElementById(`voice-audio-${name}`)?.remove();
  syncActionButtons();
}

function closeVoiceRoomPeers(sendHangup = false) {
  Object.keys(state.rtc.voicePeers).forEach((peer) => {
    if (sendHangup) {
      send({ type: "rtc_signal", to: peer, signalType: "hangup", context: "voice_room", room: state.currentVoiceRoom });
    }
    closeVoiceRoomPeer(peer);
  });
  state.rtc.voicePendingIce = {};
  if (!getConnection() && state.rtc.localStream) {
    state.rtc.localStream.getTracks().forEach((t) => t.stop());
    state.rtc.localStream = null;
    localVideo.srcObject = null;
  }
  syncActionButtons();
}

async function syncVoiceRoomConnections() {
  const room = state.currentVoiceRoom;
  if (!room || !state.username) {
    closeVoiceRoomPeers(false);
    return;
  }
  const members = (state.voiceState[room] || []).filter((name) => name && name !== state.username);
  const wanted = new Set(members);
  Object.keys(state.rtc.voicePeers).forEach((peer) => {
    if (!wanted.has(peer)) closeVoiceRoomPeer(peer);
  });
  for (const peer of members) {
    const initiator = state.username.localeCompare(peer) < 0;
    if (!getVoicePeer(peer) && initiator) {
      try {
        await createVoiceRoomPeer(peer, true);
      } catch (err) {
        logCall(`voice room failed to connect ${peer}: ${err}`);
      }
    }
  }
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
  playMediaElement(localVideo);
  return stream;
}

// The `autoplay` HTML attribute alone isn't reliable here: pc.ontrack fires
// whenever ICE/DTLS negotiation finishes, which is an async network event
// that happens well after the click that started the call — often outside
// the browser's "recent user gesture" window autoplay policies require for
// media with audio. Without an explicit .play() call (and handling when it
// gets rejected), the call can reach "connected" with real tracks flowing
// and still be completely silent on both ends, because the <video> element
// itself never actually started playing.
const _blockedMediaElements = new Set();

function playMediaElement(el) {
  const attempt = el.play();
  if (attempt && typeof attempt.catch === "function") {
    attempt
      .then(() => {
        _blockedMediaElements.delete(el);
        updateEnableAudioBanner();
      })
      .catch((err) => {
        console.warn("Autoplay blocked for", el.id, err);
        _blockedMediaElements.add(el);
        updateEnableAudioBanner();
      });
  }
}

function updateEnableAudioBanner() {
  const btn = $("enableAudioBtn");
  if (!btn) return;
  btn.classList.toggle("hidden", _blockedMediaElements.size === 0);
}

$("enableAudioBtn")?.addEventListener("click", () => {
  // A real click on a real button, directly in the handler — this is
  // exactly the kind of user gesture browsers require, unlike the
  // .ontrack callback that first hit the block (that one fires on its
  // own timer from network negotiation, not from anything the user did).
  _blockedMediaElements.forEach((el) => playMediaElement(el));
});

// Mirrors console.log to an on-page panel too — mobile browsers don't have
// easily-accessible dev tools, so this is the only practical way to see
// call diagnostics on a phone. Kept as plain text so it's trivially
// selectable/copyable, plus an explicit Copy button using the clipboard
// API where available.
function logCall(msg) {
  console.log(msg);
  const el = $("callDebugLog");
  if (!el) return;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  el.textContent += `[${time}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
  if (/failed|disconnected|timeout|blocked|error/i.test(msg)) {
    $("callDebugPanel")?.classList.remove("hidden");
  }
}

$("toggleCallDebugBtn")?.addEventListener("click", () => {
  $("callDebugPanel")?.classList.toggle("hidden");
});

$("copyCallDebugBtn")?.addEventListener("click", () => {
  const text = $("callDebugLog")?.textContent || "";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => showSuccess("Copied to clipboard"),
      () => showError("Couldn't copy — select the text manually")
    );
  } else {
    showError("Clipboard not available — select the text manually");
  }
});

$("clearCallDebugBtn")?.addEventListener("click", () => {
  const el = $("callDebugLog");
  if (el) el.textContent = "";
});

async function createPeerConnection(peerUser, mode = "video") {
  const pc = new RTCPeerConnection({
    iceServers: state.rtc.iceServers,
  });
  state.rtc.pc = pc;
  state.rtc.peer = peerUser;
  state.rtc.callMode = mode === "voice" ? "voice" : "video";

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      logCall("local ICE gathering complete");
      return;
    }
    logCall(`local ICE candidate: ${describeIceCandidate(event.candidate)}`);
    if (!getPeer()) return;
    send({
      type: "rtc_signal",
      to: getPeer(),
      signalType: "ice",
      candidate: event.candidate,
    });
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    const track = event.track;
    logCall(
      `ontrack fired: kind=${track.kind} readyState=${track.readyState} muted=${track.muted} streamTracks=${stream ? stream.getTracks().length : 0}`
    );
    // A track can be "muted" at the WebRTC level even once the connection
    // overall says "connected" — that means no RTP packets have actually
    // arrived for THIS track yet. mute/unmute firing later tells us
    // whether real audio data ever showed up, independent of browser
    // autoplay policy (which blocks playback of a track that HAS data;
    // this is about whether there's any data at all).
    track.onunmute = () => logCall(`remote ${track.kind} track UNMUTED (real media is arriving)`);
    track.onmute = () => logCall(`remote ${track.kind} track MUTED (no media arriving right now)`);
    if (stream) {
      remoteVideo.srcObject = stream;
      playMediaElement(remoteVideo);
    }
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    logCall(`connectionState -> ${st}`);
    if (st === "connected") {
      clearCallDisconnectTimer();
      stopRinging();
      setCallStatus(`In call with ${getPeer()}`);
      logActiveCandidatePair(pc);
      startCallDiagnostics(pc);
    } else if (st === "disconnected") {
      setCallStatus("Reconnecting call...");
      scheduleCallDisconnectEnd(pc);
    } else if (["failed", "closed"].includes(st)) {
      clearCallDisconnectTimer();
      if (st === "failed") logCandidatePairSummary(pc);
      endCall(false);
      setCallStatus("Call ended");
    }
  };

  pc.oniceconnectionstatechange = () => {
    logCall(`iceConnectionState -> ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      clearCallDisconnectTimer();
    } else if (pc.iceConnectionState === "disconnected") {
      setCallStatus("Reconnecting call...");
      scheduleCallDisconnectEnd(pc);
    } else if (pc.iceConnectionState === "failed") {
      clearCallDisconnectTimer();
      logCandidatePairSummary(pc);
      endCall(false);
      setCallStatus("Call ended");
    }
  };

  pc.onicegatheringstatechange = () => {
    logCall(`iceGatheringState -> ${pc.iceGatheringState}`);
  };

  const stream = await ensureLocalMedia(mode);
  logCall(
    `local media ready: ${stream.getTracks().map((t) => `${t.kind}(enabled=${t.enabled},readyState=${t.readyState})`).join(", ")}`
  );
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  callPanel.classList.remove("hidden");
  syncActionButtons();
  return pc;
}

// Identifies whether the call actually ended up relaying through TURN
// (candidate type "relay") vs a direct peer-to-peer path ("host"/"srflx").
// If this never logs "relay" despite TURN being configured, or logs
// nothing useful, that's a strong signal the TURN server itself isn't
// being reached/selected — different problem from autoplay blocking.
async function logActiveCandidatePair(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((report) => {
      if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
        pair = report;
      }
    });
    if (!pair) {
      logCall("no succeeded candidate-pair found in stats");
      return;
    }
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    logCall(
      `active path: local=${local?.candidateType || "?"} remote=${remote?.candidateType || "?"} protocol=${local?.protocol || "?"}`
    );
  } catch (err) {
    logCall(`getStats() failed: ${err}`);
  }
}

async function logCandidatePairSummary(pc) {
  try {
    const stats = await pc.getStats();
    const rows = [];
    stats.forEach((report) => {
      if (report.type !== "candidate-pair") return;
      const local = stats.get(report.localCandidateId);
      const remote = stats.get(report.remoteCandidateId);
      rows.push({
        state: report.state,
        requestsSent: report.requestsSent || 0,
        responsesReceived: report.responsesReceived || 0,
        bytesSent: report.bytesSent || 0,
        bytesReceived: report.bytesReceived || 0,
        local: local?.candidateType || "?",
        remote: remote?.candidateType || "?",
        protocol: local?.protocol || "?",
      });
    });
    rows
      .sort((a, b) => (b.responsesReceived - a.responsesReceived) || (b.requestsSent - a.requestsSent))
      .slice(0, 6)
      .forEach((row) => {
        logCall(
          `pair ${row.state}: local=${row.local} remote=${row.remote} protocol=${row.protocol} requests=${row.requestsSent} responses=${row.responsesReceived} bytes=${row.bytesSent}/${row.bytesReceived}`
        );
      });
    if (!rows.length) logCall("no candidate-pair stats available");
  } catch (err) {
    logCall(`candidate pair summary failed: ${err}`);
  }
}

let _callDiagnosticsTimer = null;
let _callDisconnectTimer = null;

function clearCallDisconnectTimer() {
  if (_callDisconnectTimer) {
    clearTimeout(_callDisconnectTimer);
    _callDisconnectTimer = null;
  }
}

function scheduleCallDisconnectEnd(pc) {
  clearCallDisconnectTimer();
  _callDisconnectTimer = setTimeout(() => {
    if (pc !== getConnection()) return;
    if (pc.connectionState === "disconnected" || pc.iceConnectionState === "disconnected") {
      logCall("call disconnected timeout elapsed; ending call");
      endCall(false);
      setCallStatus("Call ended");
    }
  }, 15000);
}

function startCallDiagnostics(pc) {
  clearInterval(_callDiagnosticsTimer);
  _callDiagnosticsTimer = setInterval(async () => {
    if (pc.connectionState !== "connected") {
      clearInterval(_callDiagnosticsTimer);
      return;
    }
    try {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio") {
          logCall(
            `inbound audio: packetsReceived=${report.packetsReceived} bytesReceived=${report.bytesReceived} packetsLost=${report.packetsLost} jitter=${report.jitter?.toFixed?.(3)}`
          );
        }
        if (report.type === "outbound-rtp" && report.kind === "audio") {
          logCall(`outbound audio: packetsSent=${report.packetsSent} bytesSent=${report.bytesSent}`);
        }
      });
    } catch {
      // stats collection failing isn't itself the bug we're chasing
    }
  }, 3000);
}

// ─── Ring tones ────────────────────────────────────────────────────────────
// Synthesized with the Web Audio API rather than shipping audio files —
// no asset to host, and it gives precise control over the on/off cadence
// that makes a ringback tone read as "ringback" and a ringtone read as
// "ringtone" (the timing pattern is what your ear actually recognizes,
// not the exact waveform).
let _ringAudioCtx = null;
let _ringTimer = null;

function _getRingAudioCtx() {
  if (!_ringAudioCtx || _ringAudioCtx.state === "closed") {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    _ringAudioCtx = new Ctx();
  }
  if (_ringAudioCtx.state === "suspended") {
    _ringAudioCtx.resume().catch(() => {});
  }
  return _ringAudioCtx;
}

function _playToneBurst(ctx, freqs, startAt, durationSec) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(0.12, startAt + 0.02);
  gain.gain.setValueAtTime(0.12, startAt + durationSec - 0.03);
  gain.gain.linearRampToValueAtTime(0, startAt + durationSec);
  gain.connect(ctx.destination);
  freqs.forEach((freq) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(startAt);
    osc.stop(startAt + durationSec);
  });
}

function _startRingLoop(freqs, onSec, offSec) {
  _stopRingLoop();
  const ctx = _getRingAudioCtx();
  const cycle = () => {
    const now = ctx.currentTime;
    _playToneBurst(ctx, freqs, now, onSec);
  };
  cycle();
  _ringTimer = setInterval(cycle, (onSec + offSec) * 1000);
}

function _stopRingLoop() {
  if (_ringTimer) {
    clearInterval(_ringTimer);
    _ringTimer = null;
  }
}

// US-style ringback (what the caller hears): two tones, 2s on / 4s off.
function startRingback() {
  _startRingLoop([440, 480], 2, 4);
}

// US-style ringtone (what the callee hears): two short bursts then a pause.
function startRingtone() {
  _stopRingLoop();
  const ctx = _getRingAudioCtx();
  const cycle = () => {
    const now = ctx.currentTime;
    _playToneBurst(ctx, [440, 480], now, 0.4);
    _playToneBurst(ctx, [440, 480], now + 0.6, 0.4);
  };
  cycle();
  _ringTimer = setInterval(cycle, 2000);
}

function stopRinging() {
  _stopRingLoop();
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
    startRingback();
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

  if (packet.context === "voice_room") {
    await handleVoiceRoomSignal(packet, from, signalType);
    return;
  }

  try {
    if (signalType === "offer") {
      // Already in a real, connected call, OR already ringing for a
      // different incoming call that hasn't been answered yet — either
      // way, this is what a phone does when you're busy: auto-reject the
      // new one rather than silently dropping/overwriting what's already
      // happening. Without the pendingIncomingCall check, a second caller
      // would silently replace the first in state.pendingIncomingCall and
      // the first caller's ringback would just play forever, since nobody
      // ever sent them a reject/hangup.
      if (getConnection() || (state.pendingIncomingCall && state.pendingIncomingCall.from !== from)) {
        send({ type: "rtc_signal", to: from, signalType: "reject", reason: "busy" });
        return;
      }
      if (state.pendingIncomingCall && state.pendingIncomingCall.from === from) {
        // Same caller re-sent an offer (e.g. their own retry) — ignore,
        // we're already ringing for them.
        return;
      }
      showIncomingCall(from, packet.mediaType === "voice" ? "voice" : "video", packet.sdp);
      return;
    }

    if (signalType === "hangup" && state.pendingIncomingCall && state.pendingIncomingCall.from === from) {
      // Caller cancelled before we answered — stop ringing, dismiss the prompt.
      dismissIncomingCall();
      return;
    }

    if ((!getConnection() || getPeer() !== from) && signalType === "ice" && packet.candidate) {
      queueRemoteIce(from, packet.candidate);
      return;
    }

    if (!getConnection() || getPeer() !== from) {
      return;
    }

    if (signalType === "answer" && packet.sdp) {
      stopRinging();
      await getConnection().setRemoteDescription(new RTCSessionDescription(packet.sdp));
      await flushRemoteIce(from);
      setCallStatus(`In call with ${from}`);
    } else if (signalType === "ice" && packet.candidate) {
      const pc = getConnection();
      if (!pc || getPeer() !== from || !pc.remoteDescription) {
        queueRemoteIce(from, packet.candidate);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(packet.candidate));
        logCall(`added remote ICE from ${from}: ${describeIceCandidate(packet.candidate)}`);
      } catch (err) {
        logCall(`failed remote ICE from ${from}: ${err}`);
      }
    } else if (signalType === "hangup") {
      endCall(false);
      setCallStatus(`${from} ended the call`);
    } else if (signalType === "reject") {
      endCall(false);
      const msg = packet.reason === "busy" ? `${from} is on another call` : `${from} declined the call`;
      setCallStatus(msg);
      showInfo(msg);
    }
  } catch (err) {
    addMessage("System", `Call signaling error: ${err}`, "system");
  }
}

async function handleVoiceRoomSignal(packet, from, signalType) {
  const room = String(packet.room || "").toLowerCase();
  if (!state.currentVoiceRoom || room !== state.currentVoiceRoom) return;

  if (signalType === "hangup") {
    closeVoiceRoomPeer(from);
    return;
  }

  if (signalType === "ice" && packet.candidate) {
    const entry = getVoicePeer(from);
    if (!entry || !entry.pc.remoteDescription) {
      queueVoiceIce(from, packet.candidate);
      return;
    }
    try {
      await entry.pc.addIceCandidate(new RTCIceCandidate(packet.candidate));
      logCall(`added voice-room ICE from ${from}: ${describeIceCandidate(packet.candidate)}`);
    } catch (err) {
      logCall(`failed voice-room ICE from ${from}: ${err}`);
    }
    return;
  }

  if (signalType === "offer" && packet.sdp) {
    const pc = await createVoiceRoomPeer(from, false);
    await pc.setRemoteDescription(new RTCSessionDescription(packet.sdp));
    await flushVoiceIce(from);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({
      type: "rtc_signal",
      to: from,
      signalType: "answer",
      sdp: pc.localDescription,
      mediaType: "voice",
      context: "voice_room",
      room,
    });
    return;
  }

  if (signalType === "answer" && packet.sdp) {
    const entry = getVoicePeer(from);
    if (!entry) return;
    await entry.pc.setRemoteDescription(new RTCSessionDescription(packet.sdp));
    await flushVoiceIce(from);
  }
}

// Real incoming-call consent step: ring, show who's calling and how
// (voice/video), and do nothing to the connection or the user's mic/camera
// until they actually click Accept.
function showIncomingCall(from, mode, sdp) {
  state.pendingIncomingCall = { from, mediaType: mode, sdp };
  startRingtone();
  const label = mode === "voice" ? "Voice call" : "Video call";
  const content = `
    <div style="text-align:center; padding: 8px 0;">
      <div class="msg-avatar" style="width:64px; height:64px; margin:0 auto 12px; font-size:24px;">${escapeHtml((from || "?").slice(0, 1).toUpperCase())}</div>
      <div style="font-size:18px; font-weight:700; color:var(--title); margin-bottom:4px;">${escapeHtml(from)}</div>
      <div style="color:var(--senary);">${label} · Incoming</div>
    </div>
  `;
  showModal("Incoming Call", content, [
    { label: "Decline", type: "danger", onclick: "declineIncomingCall()" },
    { label: "Accept", type: "primary", onclick: "acceptIncomingCall()" },
  ]);
}

function dismissIncomingCall() {
  stopRinging();
  if (state.pendingIncomingCall?.from) {
    delete state.rtc.pendingIceCandidates[state.pendingIncomingCall.from];
  }
  state.pendingIncomingCall = null;
  closeModal();
}

window.acceptIncomingCall = async function() {
  const pending = state.pendingIncomingCall;
  closeModal();
  stopRinging();
  state.pendingIncomingCall = null;
  if (!pending) return;

  try {
    const pc = await createPeerConnection(pending.from, pending.mediaType);
    await pc.setRemoteDescription(new RTCSessionDescription(pending.sdp));
    await flushRemoteIce(pending.from);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({
      type: "rtc_signal",
      to: pending.from,
      signalType: "answer",
      sdp: pc.localDescription,
    });
    setCallStatus(`In call with ${pending.from}`);
    syncActionButtons();
  } catch (err) {
    let hint = String(err || "unknown error");
    if (err && typeof err === "object" && "name" in err) {
      const name = String(err.name || "");
      if (name === "NotAllowedError") hint = "Mic/camera permission was denied.";
      else if (name === "NotFoundError") hint = "No microphone/camera device found.";
      else if (name === "NotReadableError") hint = "Mic/camera is busy in another app.";
    }
    endCall(false);
    send({ type: "rtc_signal", to: pending.from, signalType: "reject" });
    addMessage("System", `Could not accept call: ${hint}`, "system");
  }
};

window.declineIncomingCall = function() {
  const pending = state.pendingIncomingCall;
  dismissIncomingCall();
  if (pending) {
    send({ type: "rtc_signal", to: pending.from, signalType: "reject" });
  }
};

function endCall(sendHangup) {
  stopRinging();
  clearInterval(_callDiagnosticsTimer);
  clearCallDisconnectTimer();
  _blockedMediaElements.clear();
  updateEnableAudioBanner();
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
  state.rtc.callMode = "";
  state.rtc.pendingIceCandidates = {};

  if (state.rtc.localStream && Object.keys(state.rtc.voicePeers).length === 0) {
    state.rtc.localStream.getTracks().forEach((t) => t.stop());
    state.rtc.localStream = null;
  }
  localVideo.srcObject = null;
  if (Object.keys(state.rtc.voicePeers).length === 0) {
    remoteVideo.srcObject = null;
  }
  if (Object.keys(state.rtc.voicePeers).length === 0) {
    callPanel.classList.add("hidden");
  } else {
    setCallStatus(`In voice #${state.currentVoiceRoom}`);
  }
  syncActionButtons();
}

function toggleLocalTrack(kind) {
  if (!state.rtc.localStream) return;
  const tracks = kind === "audio" ? state.rtc.localStream.getAudioTracks() : state.rtc.localStream.getVideoTracks();
  if (kind === "video" && tracks.length === 0) {
    showInfo("Camera is not active in this voice call.");
    return;
  }
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

  const groups = Object.fromEntries(ROLE_GROUP_ORDER.map((role) => [role, []]));
  state.users.forEach((name) => {
    const role = profileFor(name).primary_role || primaryRole(profileFor(name).roles);
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
    ${normalizeRoles(profile.roles || role).filter(r => r !== "member").map(r => `<span class="member-role-badge role-${r}">${ROLE_LABELS[r] || r}</span>`).join("")}
    ${isSelf ? "" : `<button class="member-context-btn" title="More" type="button">⋯</button>`}
  `;
  li.addEventListener("click", () => onSelect(name));

  const ctxBtn = li.querySelector(".member-context-btn");
  if (ctxBtn) {
    ctxBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openMemberContextMenu(name, ctxBtn);
    });
  }
  return li;
}

function openMemberContextMenu(name, anchorEl) {
  if (name === state.username) {
    openSelfMenu(anchorEl || _lastClickPos);
    return;
  }

  const isBlocked = isUserBlocked(name);
  const isMod = canModerate();
  const content = `
    <div class="popout-menu-title">${escapeHtml(name)}</div>
    ${menuRow("💬", "Message", `closePopoutMenu(); openDmComposer('${name}')`)}
    ${menuRow("📜", "DM History", `closePopoutMenu(); openDmHistory('${name}')`)}
    ${canManageRoles() ? menuRow("👑", "Set Roles", `closePopoutMenu(); openRoleSelector('${name}')`) : ""}
    <div class="menu-divider"></div>
    ${isBlocked
      ? menuRow("✅", "Unblock User", `closePopoutMenu(); unblockSelectedUser('${name}')`)
      : menuRow("🚫", "Block User", `closePopoutMenu(); blockSelectedUser('${name}')`, true)}
    ${isMod ? `<div class="menu-divider"></div>` : ""}
    ${isMod ? menuRow("⏱️", "Timeout User", `closePopoutMenu(); openTimeoutModal('${name}')`, true) : ""}
    ${isMod ? menuRow("👢", "Kick User", `closePopoutMenu(); kickUser('${name}')`, true) : ""}
  `;
  showPopoutMenu(anchorEl || _lastClickPos, content, { alignRight: true });
}

function openAuthorContextMenu(name, anchorEl) {
  if (!name) return;
  selectUserTarget(name);
  openMemberContextMenu(name, anchorEl);
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
  const content = `
    <div class="popout-menu-title">Timeout ${escapeHtml(name)}</div>
    ${durations.map(d => menuRow("⏱️", d.label, `applyTimeout('${name}', ${d.seconds})`)).join("")}
  `;
  showPopoutMenu(_lastClickPos, content);
};

window.applyTimeout = function(name, seconds) {
  closePopoutMenu();
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
  const inDirectCall = !!state.rtc.pc;
  const inVoiceRoomCall = Object.keys(state.rtc.voicePeers).length > 0 || !!state.currentVoiceRoom;
  const inCall = inDirectCall || inVoiceRoomCall;
  const micCamReady = !!state.rtc.localStream;
  const hasVideoTrack = !!state.rtc.localStream?.getVideoTracks?.().length;
  setDisabled("voiceCallBtn", !state.isAuthed || !hasTarget);
  setDisabled("videoCallBtn", !state.isAuthed || !hasTarget);
  setDisabled("hangupBtn", !state.isAuthed || !inCall);
  setDisabled("toggleMicBtn", !state.isAuthed || !micCamReady);
  setDisabled("toggleCamBtn", !state.isAuthed || !micCamReady || !hasVideoTrack);
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

  if (canManageMessages()) {
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

  if (author === state.username || canManageMessages()) {
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
    + (opts.satanic ? " msg-satanic" : "")
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
      gutter.innerHTML = `<button class="msg-avatar${profile.avatar_url ? " has-image" : ""}"${avatarStyle} type="button" title="Open ${escapeHtml(author)} actions">${profile.avatar_url ? "" : initial}</button>`;
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
    head.innerHTML = `<button class="msg-author" type="button"${authorStyle}>${escapeHtml(author)}</button>${ts ? ` <span class="msg-ts">${ts}</span>` : ""}`;
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
  if (!isSystem) {
    box.querySelectorAll(".msg-author, .msg-avatar").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        openAuthorContextMenu(author, el);
      });
    });
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
  resetMessageGrouping();
  history.forEach((msg) => {
    messagesEl.appendChild(buildMessageEl({
      id: msg.id,
      author: msg.author || "?",
      author_name_color: msg.author_name_color || "",
      satanic: !!msg.satanic,
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
      state.roles = normalizeRoles(packet.roles || packet.role || "member");
      state.role = primaryRole(state.roles);
      mergeProfiles({
        [state.username]: {
          avatar_url: packet.avatar_url || "",
          name_color: packet.name_color || "",
          role: packet.role || state.role,
          roles: state.roles,
          primary_role: state.role,
        },
      });
      state.attemptedTokenAuth = false;
      if (packet.remember_token) {
        saveRemember(state.username, packet.remember_token);
      } else if (!rememberMe.checked) {
        clearRemember();
      }
      selfUser.textContent = state.username;
      applySelfAvatar();
      setAuthenticated(true);
      send({ type: "who" });
      send({ type: "social_sync" });
      send({ type: "user_state_sync" });
      send({ type: "mention_history" });
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
      state.dmPartners = packet.dm_partners || [];
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
      renderDmList();
      renderUsers();
      applySelfAvatar();
      syncActionButtons();
      syncVoiceRoomConnections();
      break;
    case "user_state":
      state.userStatus = packet.status || state.userStatus;
      state.customStatus = packet.custom_status || "";
      state.blockedUsers = packet.blocked_users || [];
      state.favorites = new Set(packet.favorites || []);
      state.unreadCount = packet.unread_counts || {};
      state.bookmarkedMessages = new Set((packet.bookmarks || []).map((item) => Number(item.msg_id)));
      updateStatusBadge();
      updateUnreadBadges();
      renderChannelList();
      break;
    case "channel_state":
      state.favorites = new Set(packet.favorites || []);
      renderChannelList();
      break;
    case "unread_state":
      state.unreadCount = packet.unread_counts || {};
      updateUnreadBadges();
      renderChannelList();
      break;
    case "bookmark_state":
      state.bookmarkedMessages = new Set((packet.bookmarks || []).map((item) => Number(item.msg_id)));
      break;
    case "mention_history":
      state.recentMentions = (packet.mentions || []).map((item) => item.mentioned_by).filter(Boolean);
      saveMentionHistory();
      break;
    case "action_error":
      // If we're mid call-setup (ringback playing, or a peer connection
      // that hasn't reached "connected" yet — e.g. the callee turned out
      // to be offline, or some other server-side rejection of the offer),
      // this error is almost certainly about that call attempt. Without
      // this, the caller's ringback tone and their own already-requested
      // mic/camera would just run forever with no way to know the call
      // never had a chance of connecting.
      if (_ringTimer || (getConnection() && getConnection().connectionState !== "connected")) {
        endCall(false);
        setCallStatus(packet.message || "Call failed");
      }
      addMessage("System", packet.message || "Action failed", "system");
      break;
    case "welcome":
    case "channel_switched":
      state.dmView = "";
      appView.classList.remove("dm-active");
      chatGlyph.textContent = "#";
      if (packet.roles || packet.role) {
        state.roles = normalizeRoles(packet.roles || packet.role);
        state.role = primaryRole(state.roles);
      }
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
      renderDmList();
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
        satanic: !!packet.satanic,
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
      if (state.dmView === peer) {
        messagesEl.appendChild(buildMessageEl({
          id: packet.id,
          author: packet.sender,
          author_name_color: packet.author_name_color || "",
          satanic: !!packet.satanic,
          content: packet.content || "",
          created_at: packet.created_at,
        }));
        messagesEl.scrollTop = messagesEl.scrollHeight;
        send({ type: "dm_mark_read", with: peer });
      } else {
        state.dmUnread[peer] = (state.dmUnread[peer] || 0) + 1;
        renderDmList();
        showToast(`${peer} sent you a direct message`, "info");
        showNotification(`${peer} sent you a message`, { body: packet.content || "" });
      }
      break;
    }
    case "dm_history":
      if (state.dmView !== String(packet.with || "").toLowerCase()) break;
      messagesEl.innerHTML = "";
      resetMessageGrouping();
      (packet.history || []).forEach((m) => messagesEl.appendChild(buildMessageEl({
        id: m.id,
        author: m.sender,
        author_name_color: m.author_name_color || "",
        satanic: !!m.satanic,
        content: m.content || "",
        created_at: m.created_at,
      })));
      messagesEl.scrollTop = messagesEl.scrollHeight;
      break;
    case "role_update":
      state.roles = normalizeRoles(packet.roles || packet.role || state.roles);
      state.role = primaryRole(state.roles);
      mergeProfiles({ [state.username]: { ...profileFor(state.username), role: state.roles.join(","), roles: state.roles, primary_role: state.role } });
      addMessage("System", `Roles updated: ${state.roles.map((role) => ROLE_LABELS[role] || role).join(", ")}`, "system");
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
  const packet = state.dmView
    ? { type: "dm", to: state.dmView, content }
    : { type: "message", content };
  if (state.dmView) {
    inputEl.value = "";
    send(packet);
    return;
  }
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

function openNewChannelModal() {
  if (!state.isAuthed) return;
  showPromptModal("📝 New Channel", "Enter channel name:", "handleNewChannel");
}

$("newChannelBtn").addEventListener("click", openNewChannelModal);
$("serverRailAddBtn")?.addEventListener("click", openNewChannelModal);

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
  closeVoiceRoomPeers(true);
  send({ type: "voice_leave" });
});

window.openDmComposer = function(targetName) {
  targetName = targetName || selectedTarget();
  if (!targetName) {
    showError("Select a user first");
    return;
  }
  openDmConversation(targetName);
  inputEl.focus();
};

window.handleSendDM = function(text) {
  const targetName = selectedTarget();
  send({ type: "dm", to: targetName.toLowerCase(), content: text.trim() });
  showSuccess(`Message sent to ${targetName}`);
};

window.openDmByName = function(name) {
  const peer = String(name || "").trim().toLowerCase();
  if (!peer || peer === state.username) {
    showError("Enter another user's name.");
    return;
  }
  if (!state.users.includes(peer) && !state.friends.includes(peer)) {
    showError("That user is not available.");
    return;
  }
  openDmConversation(peer);
};

function toggleDmFinder() {
  const wrap = $("dmSearchWrap");
  const input = $("dmSearchInput");
  if (!wrap || !input) return;
  const opening = wrap.classList.contains("hidden");
  wrap.classList.toggle("hidden", !opening);
  if (opening) {
    input.value = "";
    renderDmList();
    input.focus();
  } else {
    renderDmList();
  }
}

$("newDmBtn")?.addEventListener("click", toggleDmFinder);
$("dmFinderBtn")?.addEventListener("click", toggleDmFinder);
$("dmSearchInput")?.addEventListener("input", (event) => renderDmList(event.target.value));

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
  if (!canManageRoles()) {
    showError("You need a role-management role");
    return;
  }
  if (!targetName) {
    showError("Select a user first");
    return;
  }
  state.selectedUser = targetName;
  const currentRoles = normalizeRoles(profileFor(targetName).roles || profileFor(targetName).role);
  const content = `
    <p style="color: var(--text); margin-bottom: 10px;">Toggle roles for <strong>${escapeHtml(targetName)}</strong>:</p>
    <div class="role-toggle-list">
      ${ROLE_ORDER.filter((role) => role !== "member").map((role) => {
        const enabled = currentRoles.includes(role);
        return `<button class="role-toggle ${enabled ? "active" : ""} role-${role}" onclick="applyRole('${role}', ${enabled ? "false" : "true"})">
          <span>${ROLE_LABELS[role]}</span><span>${enabled ? "Remove" : "Add"}</span>
        </button>`;
      }).join("")}
    </div>
  `;
  showModal("Set Roles", content, [
    { label: "Close", type: "secondary", onclick: "closeModal()" },
  ]);
};

window.applyRole = function(normalized, enabled = true) {
  closeModal();
  send({ type: "promote", username: state.selectedUser.toLowerCase(), role: normalized, enabled });
  showSuccess(`${enabled ? "Adding" : "Removing"} ${ROLE_LABELS[normalized] || normalized} for ${state.selectedUser}`);
};

$("memberListToggleBtn")?.addEventListener("click", () => {
  document.querySelector(".members-pane")?.classList.toggle("hidden");
});

$("topbarSearchBtn")?.addEventListener("click", () => {
  const input = $("messageSearch");
  if (!input) return;
  input.scrollIntoView({ block: "nearest" });
  input.focus();
});

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
  if (state.rtc.pc) {
    endCall(true);
    setCallStatus("Call ended");
  } else if (state.currentVoiceRoom || Object.keys(state.rtc.voicePeers).length > 0) {
    closeVoiceRoomPeers(true);
    if (state.currentVoiceRoom) send({ type: "voice_leave" });
    state.currentVoiceRoom = "";
    setCallStatus("Left voice channel");
    callPanel.classList.add("hidden");
  } else {
    setCallStatus("Call ended");
  }
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
const selfUserCard = $("selfUserCard");
if (selfUserCard) {
  selfUserCard.addEventListener("click", (e) => {
    e.stopPropagation();
    openSelfMenu(selfUserCard);
  });
  selfUserCard.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openSelfMenu(selfUserCard);
  });
}

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

function openSelfMenu(anchorEl) {
  const content = `
    ${menuRow("🟢", "Change Status", "closePopoutMenu(); showStatusSelector()")}
    ${menuRow("💬", "Set Custom Status", "closePopoutMenu(); openCustomStatusModal()")}
    ${menuRow("✏️", "Change Username", "closePopoutMenu(); openChangeUsername()")}
    ${menuRow("🖼️", "Set Avatar", "closePopoutMenu(); openSetAvatar()")}
    ${menuRow("🎨", "Set Name Color", "closePopoutMenu(); openSetNameColor()")}
    ${menuRow("🔖", "View Bookmarks", "closePopoutMenu(); openBookmarksList()")}
    ${menuRow("👤", "Account Info", "closePopoutMenu(); showAccountInfo()")}
    <div class="menu-divider"></div>
    ${menuRow("🚪", "Log Out", "doLogout()", true)}
  `;
  showPopoutMenu(anchorEl || $("quickMenuBtn") || _lastClickPos, content, { above: true, alignRight: true });
}

$("quickMenuBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  openSelfMenu($("quickMenuBtn"));
});

window.showAccountInfo = function() {
  const info = `
    <div style="color: var(--text); line-height: 2;">
      <strong>Username:</strong> ${state.username}<br>
      <strong>Roles:</strong> <span style="color: var(--brand);">${state.roles.map((role) => ROLE_LABELS[role] || role).join(", ")}</span><br>
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
  const content = `
    <div class="popout-menu-title">Change Status</div>
    ${DISCORD_STATUSES.map(s => `
      <button class="menu-row" onclick="setUserStatus('${s.key}'); closePopoutMenu();">
        <span class="status-swatch status-${s.key}"></span>
        <span>${s.label}</span>
        ${state.userStatus === s.key ? '<span style="margin-left:auto; color:var(--brand-2);">✓</span>' : ""}
      </button>
    `).join("")}
  `;
  showPopoutMenu(_lastClickPos, content);
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
    send({
      type: "search_messages",
      ...(state.dmView ? { with: state.dmView } : { channel: state.channel }),
      query,
    });
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
      <strong>${escapeHtml(m.author || m.sender || "?")}</strong>
      <span style="color:var(--senary); font-size:12px;"> ${new Date(m.created_at * 1000).toLocaleString()}</span>
      <br>${escapeHtml(m.content)}
    </div>
  `).join("");
  showModal(`🔎 "${packet.query}" ${packet.scope === "dm" ? `with @${packet.with}` : `in #${packet.channel}`}`, rows, [
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
  const label = DISCORD_STATUSES.find(s => s.key === state.userStatus)?.label || "Online";
  if (statusText) statusText.textContent = state.customStatus || label;
  const selfDot = $("selfStatusDot");
  if (selfDot) {
    selfDot.className = `status-swatch status-${state.userStatus}`;
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
  if (state.channels.includes(item)) {
    send({ type: "channel_favorite", channel: item, favorite: state.favorites.has(item) });
  }
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
  send({ type: "mark_read", channel });
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
    const unpinBtn = canManageMessages()
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
  send({ type: "mention_history" });
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

// Discord's real account-gear / member-⋯ menus are small floating popouts
// anchored next to the button that opened them, not centered dialogs.
let _popoutCloseHandler = null;
let _lastClickPos = { x: 0, y: 0 };
document.addEventListener("click", (e) => {
  _lastClickPos = { x: e.clientX, y: e.clientY };
}, true);

function showPopoutMenu(anchorElOrPoint, contentHtml, opts = {}) {
  const popout = $("popoutMenu");
  if (!popout || !anchorElOrPoint) return;

  popout.innerHTML = `<div class="menu-list">${contentHtml}</div>`;
  popout.classList.remove("hidden");

  // Accept either a real element (getBoundingClientRect) or a plain
  // {x, y} point — the latter is used when a nested popout opens from
  // inside an onclick string, where no element reference survives.
  const anchorEl = typeof anchorElOrPoint.getBoundingClientRect === "function" ? anchorElOrPoint : null;
  const rect = anchorEl
    ? anchorEl.getBoundingClientRect()
    : { top: anchorElOrPoint.y, bottom: anchorElOrPoint.y, left: anchorElOrPoint.x, right: anchorElOrPoint.x };
  // Measure after making visible so offsetWidth/Height are real.
  const popW = popout.offsetWidth || 220;
  const popH = popout.offsetHeight || 200;
  const margin = 8;

  let top;
  if (opts.above) {
    top = rect.top - popH - margin;
  } else {
    top = rect.bottom + margin;
    if (top + popH > window.innerHeight - margin) {
      top = rect.top - popH - margin; // flip above if it wouldn't fit below
    }
  }
  let left = opts.alignRight ? rect.right - popW : rect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - popW - margin));
  top = Math.max(margin, top);

  popout.style.top = `${top}px`;
  popout.style.left = `${left}px`;

  if (_popoutCloseHandler) {
    document.removeEventListener("click", _popoutCloseHandler, true);
  }
  _popoutCloseHandler = (e) => {
    const clickedAnchor = anchorEl && (e.target === anchorEl || anchorEl.contains(e.target));
    if (!popout.contains(e.target) && !clickedAnchor) {
      closePopoutMenu();
    }
  };
  setTimeout(() => document.addEventListener("click", _popoutCloseHandler, true), 0);
}

function closePopoutMenu() {
  const popout = $("popoutMenu");
  if (popout) popout.classList.add("hidden");
  if (_popoutCloseHandler) {
    document.removeEventListener("click", _popoutCloseHandler, true);
    _popoutCloseHandler = null;
  }
}
window.closePopoutMenu = closePopoutMenu;

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
  send({ type: "bookmark_message", id: msgId, channel: state.channel, bookmarked: true });
}

function unbookmarkMessage(msgId) {
  state.bookmarkedMessages.delete(msgId);
  const el = document.getElementById(`msg-${msgId}`);
  if (el) {
    el.classList.remove("bookmarked");
    el.querySelector(".bookmark-mark")?.remove();
  }
  saveBookmarks();
  send({ type: "bookmark_message", id: msgId, channel: state.channel, bookmarked: false });
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
  const candidates = [
    `${wsProtocol}://${location.hostname}:9011/ws`,
    `${wsProtocol}://${location.host}/ws`,
  ];

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
      clearTimeout(timeout);
      if (!opened) {
        connectAt(index + 1);
        return;
      }
      statusText.textContent = "Disconnected";
      dismissIncomingCall();
      endCall(false);
      setAuthenticated(false);
      syncActionButtons();
      handleConnectionError(new Error("WebSocket closed"));
    });

    ws.addEventListener("error", (event) => {
      if (opened) {
        handleConnectionError(event);
      }
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
