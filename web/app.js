const state = {
  ws: null,
  username: "",
  role: "member",
  channel: "general",
  channels: [],
  users: [],
  selectedUser: "",
  authMode: "login",
  isAuthed: false,
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
      setAuthenticated(false);
      setAuthMode("login");
    });

    ws.addEventListener("close", () => {
      if (!opened) {
        connectAt(index + 1);
        return;
      }
      statusText.textContent = "Disconnected";
      setAuthenticated(false);
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

function renderUsers() {
  renderList(usersEl, state.users, state.selectedUser, (name) => {
    state.selectedUser = name;
    renderUsers();
  });
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

function addMessage(who, text, type = "normal") {
  const box = document.createElement("article");
  box.className = `msg ${type === "system" ? "system" : ""}`;

  const head = document.createElement("div");
  head.className = "who";
  head.textContent = who;

  const body = document.createElement("div");
  body.textContent = text;

  box.appendChild(head);
  box.appendChild(body);
  messagesEl.appendChild(box);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderHistory(history) {
  messagesEl.innerHTML = "";
  history.forEach((msg) => addMessage(msg.author || "?", msg.content || ""));
}

function handlePacket(packet) {
  switch (packet.type) {
    case "auth_ok":
      state.username = packet.username || state.username;
      state.role = packet.role || "member";
      roleBadge.textContent = state.role;
      selfUser.textContent = state.username;
      setAuthenticated(true);
      send({ type: "who" });
      addMessage("System", `Logged in as ${state.username}`, "system");
      break;
    case "auth_error":
      authStatus.textContent = packet.message || "Authentication failed";
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
      renderUsers();
      break;
    case "message":
      addMessage(packet.author || "?", packet.content || "");
      break;
    case "dm": {
      const peer = packet.sender === state.username ? packet.recipient : packet.sender;
      addMessage("DM", `with ${peer}: ${packet.content || ""}`, "system");
      break;
    }
    case "dm_history":
      addMessage("System", `DM history with ${packet.with || "?"}`, "system");
      (packet.history || []).forEach((m) => {
        const peer = m.sender === state.username ? m.recipient : m.sender;
        addMessage("DM", `with ${peer}: ${m.content || ""}`, "system");
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
      addMessage("System", `Username changed to ${state.username}`, "system");
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

$("newChannelBtn").addEventListener("click", () => {
  if (!state.isAuthed) return;
  const name = prompt("New channel name");
  if (!name) return;
  send({ type: "switch_channel", channel: name.trim().toLowerCase().replace(/\s+/g, "-") });
});

$("refreshUsersBtn").addEventListener("click", () => {
  send({ type: "who" });
});

$("dmBtn").addEventListener("click", () => {
  if (!state.selectedUser) {
    alert("Select a user first");
    return;
  }
  const text = prompt(`DM to ${state.selectedUser}`);
  if (!text) return;
  send({ type: "dm", to: state.selectedUser.toLowerCase(), content: text.trim() });
});

$("changeNameBtn").addEventListener("click", () => {
  if (!state.isAuthed) {
    return;
  }
  const nextName = prompt("Enter your new username", state.username);
  if (!nextName) {
    return;
  }
  const normalized = nextName.trim().toLowerCase();
  if (!normalized) {
    return;
  }
  send({ type: "change_username", new_username: normalized });
});

$("dmHistoryBtn").addEventListener("click", () => {
  if (!state.selectedUser) {
    alert("Select a user first");
    return;
  }
  send({ type: "dm_history", with: state.selectedUser.toLowerCase() });
});

$("promoteBtn").addEventListener("click", () => {
  if (state.role !== "admin") {
    alert("Only admins can set roles");
    return;
  }
  if (!state.selectedUser) {
    alert("Select a user first");
    return;
  }
  const role = prompt("Role: member | mod | admin", "member");
  if (!role) return;
  const normalized = role.trim().toLowerCase();
  if (!["member", "mod", "admin"].includes(normalized)) {
    alert("Invalid role");
    return;
  }
  send({ type: "promote", username: state.selectedUser.toLowerCase(), role: normalized });
});

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const username = $("usernameInput").value.trim().toLowerCase();
  const password = $("passwordInput").value;

  if (!username || !password) return;
  authStatus.textContent = "";
  send({ type: "auth", action: state.authMode, username, password });
});

showLoginBtn.addEventListener("click", () => setAuthMode("login"));
showRegisterBtn.addEventListener("click", () => setAuthMode("register"));

connectSocket();
