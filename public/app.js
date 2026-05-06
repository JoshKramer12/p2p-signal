//p2p-send/app.js

document.addEventListener("DOMContentLoaded", () => {
  console.log("✅ app.js loaded");


  // ===== AUTH TOGGLE =====
const toggleBtns = document.querySelectorAll(".authToggleBtn");
const toggleIndicator = document.getElementById("authToggleIndicator");
const loginForm = document.getElementById("loginForm");
const signupForm = document.getElementById("signupForm");

toggleBtns.forEach(btn => {
  btn.onclick = () => {
    toggleBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    const isSignup = btn.dataset.mode === "signup";

    toggleIndicator.style.transform = isSignup
      ? "translateX(100%)"
      : "translateX(0)";

    loginForm.classList.toggle("hidden", isSignup);
    signupForm.classList.toggle("hidden", !isSignup);
  };
});


  // =====================
  // UI Elements
  // =====================
  const logEl = document.getElementById("log");
  const roomEl = document.getElementById("room");
  const joinBtn = document.getElementById("join");
  const offerBtn = document.getElementById("makeOffer");
  const sendBtn = document.getElementById("send");

  const packageToggle = document.getElementById("packageToggle");
  const savePhotosBtn = document.getElementById("savePhotosBtn");

  const photoInput = document.getElementById("filePhotos");
  const fileInput = document.getElementById("fileFiles");
  const folderInput = document.getElementById("folderInput");
  const choosePhotosBtn = document.getElementById("choosePhotos");
  const chooseFilesBtn = document.getElementById("chooseFiles");
  const chooseFolderBtn = document.getElementById("chooseFolder");
  const uploadMenuBtn = document.getElementById("uploadMenuBtn");
  const uploadMenu = document.getElementById("uploadMenu");
  const chatNoteInput = document.getElementById("chatNoteInput");
  const chatSearchToggle = document.getElementById("chatSearchToggle");
  const chatSearchBar = document.getElementById("chatSearchBar");
  const chatSearchInput = document.getElementById("chatSearchInput");
  const headerAvatar = document.getElementById("headerAvatar");
  const headerAvatarLetter = document.getElementById("headerAvatarLetter");
  const headerAvatarImg = document.getElementById("headerAvatarImg");

  const contactsSearchInput = document.querySelector(".search");

  const toSendUl = document.getElementById("toSend");

  // Auth + friends UI
  const authSection = document.getElementById("authSection");
  const authUserEl = document.getElementById("authUser");
  const authPassEl = document.getElementById("authPass");
  const signupBtn = document.getElementById("signupBtn");
  const loginBtn = document.getElementById("loginBtn");
  const authStateEl = document.getElementById("authState");
  const mobileBackBtn = document.getElementById("mobileBackBtn");

  const statTotalUsers = document.getElementById("statTotalUsers");
  const statOnlineUsers = document.getElementById("statOnlineUsers");
  const statStoredFiles = document.getElementById("statStoredFiles");
  const statStorageUsed = document.getElementById("statStorageUsed");
  const filesList = document.getElementById("filesList");
  const filesEmpty = document.getElementById("filesEmpty");
  const filesSelectAll = document.getElementById("filesSelectAll");
  const filesDeleteSelected = document.getElementById("filesDeleteSelected");
  const filesInfo = document.getElementById("filesInfo");

  const friendNameEl = document.getElementById("friendName");
  const addFriendBtn = document.getElementById("addFriendBtn");
  const friendSelectEl = document.getElementById("friendSelect");
  const friendsRequestBadge = document.getElementById("friendsRequestBadge");
  const friendSearchInput = document.getElementById("friendSearchInput");
  const friendSearchResults = document.getElementById("friendSearchResults");
  const friendSearchMsg = document.getElementById("friendSearchMsg");
  const pendingRequestsList = document.getElementById("pendingRequestsList");
  const pendingEmpty = document.getElementById("pendingEmpty");
  const friendsListFull = document.getElementById("friendsListFull");
  const friendsEmpty = document.getElementById("friendsEmpty");
  const friendsCountEl = document.getElementById("friendsCount");
  const authedAppEl = document.getElementById("authedApp");
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const messageStreamEl = document.getElementById("messageStream");

  const SESSION_KEY = "p2p_session";

  function setActivePage(page) {
    document.querySelectorAll(".iconBtn")
      .forEach(b => b.classList.toggle("active", b.dataset.page === page));

    document.querySelectorAll(".page").forEach(p => {
      p.classList.remove("active");
      p.classList.add("hidden");
    });

    const target = document.getElementById(`page-${page}`);
    if (target) {
      target.classList.remove("hidden");
      target.classList.add("active");
    }

    document.body.classList.toggle("page-friends", page === "friends");
    document.body.classList.toggle("page-account", page === "account");
    document.body.classList.toggle("page-logs", page === "logs");
    document.body.classList.toggle("page-chat", page === "chat");

    if (page !== "chat") {
      document.body.classList.remove("mobile-chat-active");
    }
    if (page !== "chat" && chatSearchBar) {
      chatSearchBar.classList.add("hidden");
      if (chatSearchInput) chatSearchInput.value = "";
      applyChatSearch("");
    }

    if (page === "friends") {
      renderPendingRequests();
      renderFriendsTab();
      renderFriendSearch();
    }

    if (page === "account") {
      hydrateAccountFields();
    }

    if (page === "logs") {
      requestStats();
    }

    if (page === "chat" && !selectedFriend()) {
      document.body.classList.remove("mobile-chat-active");
    }
  }

  document.querySelectorAll(".iconBtn").forEach(btn => {
    btn.onclick = () => setActivePage(btn.dataset.page);
  });

  function getSavedSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.username && parsed?.token) return parsed;
  } catch {}
  return null;
}

function currentUsername() {
  return getSavedSession()?.username || ACCOUNT_USERNAME || "";
}

function chatKey(friend) {
  const session = getSavedSession();
  if (!session?.username || !friend) return null;
  return `chat:${session.username}:${friend}`;
}

function loadChat(friend) {
  const key = chatKey(friend);
  if (!key) return [];
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch {
    return [];
  }
}

function saveChat(friend, messages) {
  const key = chatKey(friend);
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(messages));
}



function removeChatMessageByIntent(friend, intentId) {
  if (!friend || !intentId) return false;
  const messages = loadChat(friend);
  const filtered = messages.filter(m => m.intentId !== intentId);
  if (filtered.length !== messages.length) {
    saveChat(friend, filtered);
    return true;
  }
  return false;
}

function removeBubbleByIntent(intentId) {
  if (!intentId) return;
  document.querySelectorAll(`.msgRow[data-intent-id="${intentId}"]`).forEach(b => b.remove());
}
function appendChatMessage(friend, message) {
  const messages = loadChat(friend);
  messages.push(message);
  saveChat(friend, messages);
}

function metaKey(friend) {
  const session = getSavedSession();
  if (!session?.username || !friend) return null;
  return `chatmeta:${session.username}:${friend}`;
}

function loadChatMeta(friend) {
  const key = metaKey(friend);
  if (!key) return { unread: 0, lastActivity: 0 };
  try {
    return JSON.parse(localStorage.getItem(key)) || { unread: 0, lastActivity: 0 };
  } catch {
    return { unread: 0, lastActivity: 0 };
  }
}

function saveChatMeta(friend, meta) {
  const key = metaKey(friend);
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(meta));
}

function bumpActivity(friend) {
  const meta = loadChatMeta(friend);
  meta.lastActivity = Date.now();
  saveChatMeta(friend, meta);
}

function incrementUnread(friend) {
  const meta = loadChatMeta(friend);
  meta.unread += 1;
  meta.lastActivity = Date.now();
  saveChatMeta(friend, meta);
}

function clearUnread(friend) {
  const meta = loadChatMeta(friend);
  meta.unread = 0;
  saveChatMeta(friend, meta);
}




if (friendSelectEl) {
  friendSelectEl.onchange = () => {
    highlightActiveFriend(friendSelectEl.value);
  };
}



  // Toggle Login vs App View
  function setAuthedUi(isLoggedIn) {
  if (authSection) {
    authSection.style.display = isLoggedIn ? "none" : "block";
    authSection.classList.toggle("hidden", isLoggedIn);
  }
  if (authedAppEl) {
    authedAppEl.style.display = isLoggedIn ? "block" : "none";
    authedAppEl.classList.toggle("hidden", !isLoggedIn);
  }
  if (!isLoggedIn) {
    document.body.classList.remove("page-friends");
  }
}

  // Initial State (optimistic auth)
const savedSession = getSavedSession();
if (savedSession) {
  setAuthedUi(true);          // 👈 show app immediately
  setAuthState("Restoring session...");
} else {
  setAuthedUi(false);
  setAuthState("Please log in.");
}


  let friends = [];
  let pendingIncoming = [];
  let pendingOutgoing = [];
  let pendingDeclined = [];
  let deletedFriends = [];

  function avatarColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) {
      hash = (hash << 5) - hash + name.charCodeAt(i);
      hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 50%)`;
  }

  function updateFriendRequestBadge() {
    if (!friendsRequestBadge) return;
    const count = pendingIncoming.length;
    friendsRequestBadge.classList.toggle("hidden", count === 0);
    friendsRequestBadge.textContent = count > 9 ? "9+" : String(count || "");
  }

  function isDeletedFriend(username) {
    return deletedFriends.includes(username);
  }

  function renderPendingRequests() {
    if (!pendingRequestsList) return;
    pendingRequestsList.innerHTML = "";

    const incoming = [...pendingIncoming].sort((a, b) => a.localeCompare(b));
    const outgoing = [...pendingOutgoing].sort((a, b) => a.localeCompare(b));
    const declined = [...pendingDeclined].sort((a, b) => a.localeCompare(b));

    const total = incoming.length + outgoing.length + declined.length;
    if (pendingEmpty) pendingEmpty.style.display = total ? "none" : "block";

    incoming.forEach(name => {
      const row = document.createElement("div");
      row.className = "friendRow";
      row.innerHTML = `
        <div class="friendMeta">
          <div class="friendAvatar" style="background:${avatarColor(name)}">${name[0]?.toUpperCase() || "?"}</div>
          <div class="friendName">${name}</div>
        </div>
        <div class="friendActions">
          <button class="btnAccept">Accept</button>
          <button class="btnDeny">Deny</button>
        </div>
      `;

      const [acceptBtn, denyBtn] = row.querySelectorAll("button");
      acceptBtn.onclick = () => {
        if (!requireWsOpen()) return alert("Not connected to server");
        accountWs.send(JSON.stringify({ type: "friend_request_accept", username: name }));
      };
      denyBtn.onclick = () => {
        if (!requireWsOpen()) return alert("Not connected to server");
        accountWs.send(JSON.stringify({ type: "friend_request_deny", username: name }));
      };

      pendingRequestsList.appendChild(row);
    });

    outgoing.forEach(name => {
      const row = document.createElement("div");
      row.className = "friendRow";
      row.innerHTML = `
        <div class="friendMeta">
          <div class="friendAvatar" style="background:${avatarColor(name)}">${name[0]?.toUpperCase() || "?"}</div>
          <div class="friendName">${name} <span style="color:#6b7280;font-weight:600;">(pending)</span></div>
        </div>
        <div class="friendActions">
          <div class="emptyText">Pending acceptance</div>
        </div>
      `;
      pendingRequestsList.appendChild(row);
    });

    declined.forEach(name => {
      const row = document.createElement("div");
      row.className = "friendRow";
      row.innerHTML = `
        <div class="friendMeta">
          <div class="friendAvatar" style="background:${avatarColor(name)}">${name[0]?.toUpperCase() || "?"}</div>
          <div class="friendName">${name} <span style="color:#6b7280;font-weight:600;">(declined)</span></div>
        </div>
        <div class="friendActions">
          <button class="btnDeny">✕</button>
        </div>
      `;
      row.querySelector("button").onclick = () => {
        if (!requireWsOpen()) return alert("Not connected to server");
        accountWs.send(JSON.stringify({ type: "friend_request_clear_declined", username: name }));
      };
      pendingRequestsList.appendChild(row);
    });
  }

  function renderFriendsTab() {
    if (!friendsListFull) return;
    friendsListFull.innerHTML = "";

    const me = currentUsername();
    const others = friends.filter(f => f && f !== me).sort((a, b) => a.localeCompare(b));
    const list = me ? [me, ...others] : others;

    if (friendsCountEl) friendsCountEl.textContent = String(list.length);
    if (friendsEmpty) friendsEmpty.style.display = list.length ? "none" : "block";

    list.forEach(name => {
      const isMe = name === me;
      const label = isMe ? `${name} (me)` : name;
      const deleted = !isMe && isDeletedFriend(name);
      const row = document.createElement("div");
      row.className = "friendRow";
      row.innerHTML = `
        <div class="friendMeta">
          <div class="friendAvatar" style="background:${avatarColor(name)}">${name[0]?.toUpperCase() || "?"}</div>
          <div>
            <div class="friendName">${label}</div>
            ${deleted ? `<div class="emptyText">This user deleted their account</div>` : ""}
          </div>
        </div>
        <div class="friendActions">
          ${deleted ? `<button class="btnDeny">✕</button>` : `<button class="btnGhost" disabled>Remove</button>`}
        </div>
      `;
      if (deleted) {
        row.querySelector("button")?.addEventListener("click", () => {
          if (!requireWsOpen()) return alert("Not connected to server");
          accountWs.send(JSON.stringify({ type: "remove_friend", username: name }));
        });
      }
      friendsListFull.appendChild(row);
    });
  }

  function renderFriendSearch() {
    if (!friendSearchResults || !friendSearchInput) return;
    friendSearchResults.innerHTML = "";

    if (friendSearchMsg) friendSearchMsg.textContent = "";
    const q = friendSearchInput.value.trim();
    if (!q) {
      const hint = document.createElement("div");
      hint.className = "emptyText";
      hint.textContent = "Search by username";
      friendSearchResults.appendChild(hint);
      return;
    }

    const me = currentUsername();
    const isSelf = q === me;
    const isFriend = friends.includes(q);
    const hasIncoming = pendingIncoming.includes(q);
    const hasOutgoing = pendingOutgoing.includes(q);

    const row = document.createElement("div");
    row.className = "friendRow";
    const label = isSelf ? `${q} (me)` : q;
    row.innerHTML = `
      <div class="friendMeta">
        <div class="friendAvatar" style="background:${avatarColor(q)}">${q[0]?.toUpperCase() || "?"}</div>
        <div class="friendName">${label}</div>
      </div>
      <div class="friendActions"></div>
    `;

    const actions = row.querySelector(".friendActions");

    if (isSelf) {
      const label = document.createElement("div");
      label.className = "emptyText";
      label.textContent = "This is you";
      actions.appendChild(label);
    } else if (isFriend) {
      const label = document.createElement("div");
      label.className = "emptyText";
      label.textContent = "Already friends";
      actions.appendChild(label);
    } else if (hasIncoming) {
      const label = document.createElement("div");
      label.className = "emptyText";
      label.textContent = "Request received";
      actions.appendChild(label);
    } else if (hasOutgoing) {
      const label = document.createElement("div");
      label.className = "emptyText";
      label.textContent = "Request sent";
      actions.appendChild(label);
    } else {
      const btn = document.createElement("button");
      btn.className = "btnRequest";
      btn.textContent = "Send friend request";
      btn.onclick = () => {
        if (!requireWsOpen()) return alert("Not connected to server");
        accountWs.send(JSON.stringify({ type: "friend_request_send", username: q }));
      };
      actions.appendChild(btn);
    }

    friendSearchResults.appendChild(row);
  }

  function setFriendsList(list) {
    const previousSelected = selectedFriend();
    const prev = new Set(friends);
    friends = Array.isArray(list) ? list : [];

    const me = currentUsername();
    if (me && !friends.includes(me)) {
      friends.unshift(me);
    }

    const newlyAdded = friends.filter(f => f && f !== me && !prev.has(f));
    newlyAdded.forEach(name => bumpActivity(name));

    const nextSelected = renderFriends(previousSelected);
    if (nextSelected !== previousSelected) {
      highlightActiveFriend(nextSelected || "");
    } else {
      applyActiveContact();
    }
    renderFriendsTab();
    renderFriendSearch();
  }

  function renderFriends(preferredSelection = "") {
    if (!friendSelectEl) return "";
    const currentSelection = String(preferredSelection || friendSelectEl.value || "").trim();
    friendSelectEl.innerHTML = "";

    const me = currentUsername();
    const others = friends.filter(f => f && f !== me);

    if (me) {
      const opt = document.createElement("option");
      opt.value = me;
      opt.textContent = `${me} (me)`;
      friendSelectEl.appendChild(opt);
    }

    if (!others.length) {
      if (me) friendSelectEl.value = me;
      renderFriendSidebar(me ? [me] : []);
      return me || "";
    }

    const sorted = [...others].sort((a, b) => {
      const ma = loadChatMeta(a).lastActivity || 0;
      const mb = loadChatMeta(b).lastActivity || 0;
      return mb - ma;
    });

    for (const f of sorted) {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = f;
      friendSelectEl.appendChild(opt);
    }

    const availableValues = new Set(Array.from(friendSelectEl.options).map((opt) => String(opt.value || "").trim()));
    const fallback = sorted[0] || me || "";
    const nextSelection = (currentSelection && availableValues.has(currentSelection))
      ? currentSelection
      : fallback;
    if (nextSelection) {
      friendSelectEl.value = nextSelection;
    }

    renderFriendSidebar(me ? [me, ...sorted] : sorted);
    return nextSelection || "";
  }

  function applyActiveContact() {
  const active = selectedFriend();
  if (!active) return;

  document.querySelectorAll("#friendList .contactItem").forEach(item => {
    const name = item.dataset.username || item.querySelector(".contactName")?.textContent;
    item.classList.toggle("active", name === active);
  });
}

  function renderFriendSidebar(listOverride = friends) {
  const list = document.getElementById("friendList");
  if (!list) return;

  const query = (contactsSearchInput?.value || "").trim().toLowerCase();
  const filtered = query
    ? listOverride.filter(u => (u || "").toLowerCase().includes(query))
    : listOverride;

  list.innerHTML = "";

  if (!filtered.length) {
    const empty = document.createElement("li");
    empty.className = "contactItem";
    empty.innerHTML = `<div class="contactLeft"><div class="contactText"><div class="contactName">No matches</div></div></div>`;
    list.appendChild(empty);
    return;
  }

  const me = currentUsername();
  filtered.forEach((username) => {
    const li = document.createElement("li");
    li.className = "contactItem";
    li.dataset.username = username;

    li.onclick = () => {
      friendSelectEl.value = username;
      highlightActiveFriend(username);
    };

    const meta = loadChatMeta(username);
    const isMe = username === me;
    const label = isMe ? `${username} (me)` : username;

    const deleted = !isMe && isDeletedFriend(username);

    li.innerHTML = `
      <div class="contactLeft">
        <div class="avatar">
          <span class="avatarLetter">${username[0]}</span>
        </div>
        <div class="contactText">
          <div class="contactName">${label}</div>
          ${deleted ? `<div class="contactSub">This user deleted their account</div>` : ""}
        </div>
      </div>

      ${
        deleted
          ? `<button class="removeContactBtn" title="Remove">✕</button>`
          : (!isMe && meta.unread > 0
              ? `<div class="unreadBadge">${meta.unread}</div>`
              : "")
      }
    `;

    const removeBtn = li.querySelector(".removeContactBtn");
    if (removeBtn) {
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        if (!requireWsOpen()) return alert("Not connected to server");
        accountWs.send(JSON.stringify({ type: "remove_friend", username }));
      };
    }

    list.appendChild(li);
  });
  applyActiveContact();

  }

function highlightActiveFriend(username) {
  const items = document.querySelectorAll("#friendList .contactItem");
  items.forEach((item) => {
    const name = item.dataset.username || item.querySelector(".contactName")?.textContent;
    item.classList.toggle("active", name === username);
  });

  // Update main header
  const header = document.getElementById("activeUser");
  const nameEl = document.getElementById("activeName");

  if (!username) {
    if (header) header.style.display = "none";
    if (nameEl) nameEl.textContent = "";
    if (headerAvatarLetter) headerAvatarLetter.textContent = "";
    if (headerAvatarImg) headerAvatarImg.style.display = "none";
    return;
  }

  clearUnread(username);
const me = currentUsername();
const listForSidebar = friends.filter(f => f && f !== me);
const sorted = listForSidebar.sort((a, b) => {
  const ma = loadChatMeta(a).lastActivity || 0;
  const mb = loadChatMeta(b).lastActivity || 0;
  return mb - ma;
});
renderFriendSidebar(me ? [me, ...sorted] : sorted);




  const isMe = username === currentUsername();
  if (header) header.style.display = "flex";
  if (nameEl) nameEl.textContent = isMe ? `${username} (me)` : username;
  const statusEl = document.getElementById("activeStatus");
  if (statusEl) statusEl.textContent = isMe ? "Your files" : "Active now";

  if (headerAvatarLetter) {
    headerAvatarLetter.textContent = username[0]?.toUpperCase() || "";
  }
  if (headerAvatarImg) {
    headerAvatarImg.style.display = "none";
  }
  if (isMe) {
    const profile = loadProfile(username);
    const imgUrl = profile.avatarDataUrl || "";
    if (imgUrl && headerAvatarImg) {
      headerAvatarImg.src = imgUrl;
      headerAvatarImg.style.display = "block";
      if (headerAvatarLetter) headerAvatarLetter.textContent = "";
    }
  }

  if (isMobile() && document.body.classList.contains("page-chat")) {
    document.body.classList.add("mobile-chat-active");
  }

  // Load chat history
const stream = document.getElementById("messageStream");
if (stream) {
  stream.innerHTML = "";
lastRenderedDate = null;


  const history = loadChat(username);
  history.forEach(msg => {
  addMessageBubble({
    file: { name: msg.fileName, size: msg.fileSize },
    direction: msg.direction,
    intentId: msg.intentId || null,
    pending: false,
    timestamp: msg.timestamp,
    read: msg.read,
    note: msg.note || ""
  });
});


}

const history = loadChat(username);
if (username !== currentUsername()) {
  history.forEach(msg => {
    if (msg.direction === "sent") {
      msg.read = true;
    }
  });
  saveChat(username, history);
}

  renderPendingTransfersForFriend(username);
  updateSavePhotosButton();
  updateSendButtonState();
  if (chatSearchInput && !chatSearchBar?.classList.contains("hidden")) {
    applyChatSearch(chatSearchInput.value);
  }
}



  function selectedFriend() {
    return friendSelectEl?.value || "";
  }

function setAuthState(text) {
  if (authStateEl) authStateEl.textContent = text || "";
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const base = Math.min(30_000, 1000 * Math.pow(2, reconnectAttempts));
  const delay = base + Math.floor(Math.random() * 500);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectAccountSocket();
  }, delay);
}

function isMobile() {
  return window.matchMedia("(max-width: 720px)").matches;
}

  function requestStats() {
    if (!requireWsOpen()) return;
    accountWs.send(JSON.stringify({ type: "stats" }));
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    const kb = 1024;
    const mb = kb * 1024;
    const gb = mb * 1024;

    if (bytes >= gb) return (bytes / gb).toFixed(2) + " GB";
    if (bytes >= mb) return (bytes / mb).toFixed(2) + " MB";
    if (bytes >= kb) return (bytes / kb).toFixed(1) + " KB";
    return bytes + " B";
  }

  let filesCache = [];
  const selectedFiles = new Set();


  function renderFilesList(items = []) {
    if (!filesList) return;
    filesList.innerHTML = "";
    const list = Array.isArray(items) ? items : [];
    filesCache = list;
    if (filesEmpty) filesEmpty.style.display = list.length ? "none" : "block";

    if (filesSelectAll) {
      filesSelectAll.checked = list.length > 0 && selectedFiles.size === list.length;
    }
    if (filesDeleteSelected) {
      filesDeleteSelected.disabled = selectedFiles.size === 0;
    }

    list.forEach((item) => {
      const row = document.createElement("div");
      row.className = "fileRow";
      row.dataset.storedFile = item.storedFile || "";
      row.dataset.intentId = item.intentId || "";

      const checked = item.storedFile && selectedFiles.has(item.storedFile);

      row.innerHTML = `
        <input class="fileCheckbox" type="checkbox" ${checked ? "checked" : ""} />
        <div class="fileMeta">
          <div class="fileName">${item.name || "(unknown)"}</div>
          <div class="fileSize">${formatSize(item.size || 0)}</div>
        </div>
        <button class="fileDeleteBtn">Delete</button>
      `;

      const checkbox = row.querySelector(".fileCheckbox");
      checkbox?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!item.storedFile) return;
        if (checkbox.checked) selectedFiles.add(item.storedFile);
        else selectedFiles.delete(item.storedFile);
        renderFilesList(filesCache);
      });

      row.addEventListener("click", () => {
        document.querySelectorAll(".fileRow").forEach(r => r.classList.remove("selected"));
        row.classList.add("selected");
        if (filesInfo) {
          const info = [
            `Name: ${item.name || "(unknown)"}`,
            `Size: ${formatSize(item.size || 0)}`,
            `From: ${item.from || "—"}`,
            `To: ${item.to || "—"}`,
            `Sent: ${item.createdAt ? new Date(item.createdAt).toLocaleString() : "—"}`,
            `Stored File: ${item.storedFile || "—"}`,
            `Intent ID: ${item.intentId || "—"}`
          ].join("\n");
          filesInfo.textContent = info;
        }
      });

      row.querySelector(".fileDeleteBtn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm("Delete this file from the server and remove from chats?")) return;
        if (!requireWsOpen()) return alert("Not connected to server");
        accountWs.send(JSON.stringify({ type: "delete_file", storedFile: item.storedFile }));
      });

      filesList.appendChild(row);
    });
  }


  function profileKey(username) {
    return `profile:${username}`;
  }

  function loadProfile(username) {
    if (!username) return {};
    try {
      return JSON.parse(localStorage.getItem(profileKey(username)) || "{}") || {};
    } catch {
      return {};
    }
  }

  function saveProfile(username, data) {
    if (!username) return;
    localStorage.setItem(profileKey(username), JSON.stringify(data || {}));
  }

function applyAvatar(username) {
    const profile = loadProfile(username);
    const imgUrl = profile.avatarDataUrl || "";

    const profileImg = document.getElementById("profileAvatarImg");
    const profileLetter = document.getElementById("profileAvatarLetter");
    if (profileImg) {
      profileImg.src = imgUrl;
      profileImg.style.display = imgUrl ? "block" : "none";
    }
    if (profileLetter) profileLetter.textContent = imgUrl ? "" : (username?.[0]?.toUpperCase() || "");

    // Only apply avatar to "me" contact and active header (not all contacts)
    const me = currentUsername();
    document.querySelectorAll("#friendList .contactItem").forEach((item) => {
      if (item.dataset.username !== me) return;
      const avatar = item.querySelector(".avatar");
      const letter = item.querySelector(".avatarLetter");
      if (!avatar) return;
      if (imgUrl) {
        avatar.style.backgroundImage = `url(${imgUrl})`;
        avatar.style.backgroundSize = "cover";
        avatar.style.backgroundPosition = "center";
        if (letter) letter.style.opacity = "0";
      } else {
        avatar.style.backgroundImage = "";
        if (letter) letter.style.opacity = "1";
      }
    });

    if (selectedFriend() === me) {
      if (headerAvatarImg) {
        headerAvatarImg.src = imgUrl;
        headerAvatarImg.style.display = imgUrl ? "block" : "none";
      }
      if (headerAvatarLetter) {
        headerAvatarLetter.textContent = imgUrl ? "" : (username?.[0]?.toUpperCase() || "");
      }
    }
  }

  function hydrateAccountFields() {
    const username = currentUsername();
    if (!username) return;

    const profile = loadProfile(username);

    const firstEl = document.getElementById("accountFirstName");
    const lastEl = document.getElementById("accountLastName");
    const userEl = document.getElementById("accountUsername");
    const emailEl = document.getElementById("accountEmail");
    const phoneEl = document.getElementById("accountPhone");

    if (firstEl) firstEl.value = profile.firstName || "";
    if (lastEl) lastEl.value = profile.lastName || "";
    if (userEl) userEl.value = `@${username}`;
    if (emailEl) emailEl.value = profile.email || "";
    if (phoneEl) phoneEl.value = profile.phone || "";

    applyAvatar(username);
  }

  // =====================
  // Transfer Progress UI
  // =====================
  const sendStatusEl = document.getElementById("sendStatus");
  const sendProgressEl = document.getElementById("sendProgress");
  const recvStatusEl = document.getElementById("recvStatus");
  const recvProgressEl = document.getElementById("recvProgress");

  const sendUi = {
    active: false,
    totalFiles: 0,
    currentIndex: 0,
    totalBytes: 0,
    completedBytes: 0,
  };

  const recvUi = {
    active: false,
    totalFiles: 0,
    currentIndex: 0,
    totalBytes: 0,
    receivedBytes: 0,
  };

  function setSendUI(text, percent) {
    if (sendStatusEl) sendStatusEl.textContent = text || "";
    if (sendProgressEl) sendProgressEl.value = Number.isFinite(percent) ? percent : 0;
  }

  function setRecvUI(text, percent) {
    if (recvStatusEl) recvStatusEl.textContent = text || "";
    if (recvProgressEl) recvProgressEl.value = Number.isFinite(percent) ? percent : 0;
  }

  function resetSendUI() {
    sendUi.active = false;
    sendUi.totalFiles = 0;
    sendUi.currentIndex = 0;
    sendUi.totalBytes = 0;
    sendUi.completedBytes = 0;
    setSendUI("", 0);
  }

  function resetRecvUI() {
    recvUi.active = false;
    recvUi.totalFiles = 0;
    recvUi.currentIndex = 0;
    recvUi.totalBytes = 0;
    recvUi.receivedBytes = 0;
    setRecvUI("", 0);
  }

  function updateSendProgress(currentFileName, currentFileSentBytes, currentFileTotalBytes) {
    const overallSent = sendUi.completedBytes + currentFileSentBytes;
    const overallPct = sendUi.totalBytes > 0 ? (overallSent / sendUi.totalBytes) * 100 : 0;

    const text = sendUi.totalFiles > 0
      ? `Sending ${sendUi.currentIndex}/${sendUi.totalFiles}: ${currentFileName}`
      : `Sending: ${currentFileName}`;

    setSendUI(text, Math.max(0, Math.min(100, overallPct)));
  }

  function updateRecvProgress(currentFileName, receivedBytes, totalBytes) {
    const pct = totalBytes > 0 ? (receivedBytes / totalBytes) * 100 : 0;
    const text = recvUi.totalFiles > 0
      ? `Receiving ${recvUi.currentIndex}/${recvUi.totalFiles}: ${currentFileName}`
      : `Receiving: ${currentFileName}`;

    setRecvUI(text, Math.max(0, Math.min(100, pct)));
  }

  const log = (msg) => {
    console.log(msg);
    if (!logEl) return;
    const time = new Date().toLocaleTimeString();
    logEl.textContent = `[${time}] ${msg}\n` + logEl.textContent;
  };

  // =====================
  // Selected files (To Send)
  // =====================
  let toSendFiles = [];
  let folderPackageMode = false;
  let folderPackageName = "";

  function sameFile(a, b) {
    return (
      a && b &&
      a.name === b.name &&
      a.size === b.size &&
      a.lastModified === b.lastModified
    );
  }

  function guessMime(fileName) {
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    if (ext === "pdf") return "application/pdf";
    if (ext === "png") return "image/png";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "gif") return "image/gif";
    if (ext === "txt") return "text/plain";
    if (ext === "json") return "application/json";
    if (ext === "zip") return "application/zip";
    return "application/octet-stream";
  }
  function isImageName(fileName) {
    return /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(fileName || "");
  }

  function safeZipName(name, used) {
    const base = String(name || "file").replace(/[\/]/g, "_");
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    if (count === 0) return base;
    const dot = base.lastIndexOf(".");
    if (dot === -1) return `${base} (${count + 1})`;
    return `${base.slice(0, dot)} (${count + 1})${base.slice(dot)}`;
  }

  function fileLabel(file) {
    return file?._sendName || file?.webkitRelativePath || file?.name || "";
  }

  function renderToSend() {
    if (!toSendUl) return;
    toSendUl.innerHTML = "";
    
    // Toggle "empty" message
    const emptyMsg = document.getElementById("toSendEmpty");
    if(emptyMsg) emptyMsg.style.display = toSendFiles.length ? "none" : "block";

    toSendFiles.forEach((file) => {
      const li = document.createElement("li");
      const label = document.createElement("div");
      label.className = "fileLabel";
      label.textContent = `${file.name} (${(file.size/1024).toFixed(1)} KB)`;

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "🗑️";
      deleteBtn.style.background = "#ffdddd";
      deleteBtn.style.color = "red";
      deleteBtn.onclick = () => {
        toSendFiles = toSendFiles.filter((f) => !sameFile(f, file));
        renderToSend();
        updateSendButtonState();
        log(`🗑️ Removed from queue: ${file.name}`);
      };

      li.appendChild(label);
      li.appendChild(deleteBtn);
      toSendUl.appendChild(li);
    });
  }


  function renderSelectedFilesTray() {
  const tray = document.getElementById("selectedFilesTray");
  if (!tray) return;

  tray.innerHTML = "";

  if (packageToggle?.checked && toSendFiles.length > 1) {
    const packageChip = document.createElement("div");
    packageChip.className = "selectedFile";
    packageChip.innerHTML = `<span>Package (${toSendFiles.length} files)</span>`;
    tray.appendChild(packageChip);
  }

  if (!toSendFiles.length) {
    tray.classList.add("hidden");
    document.body.classList.remove("hasMessages");
    return;
  }

  tray.classList.remove("hidden");
  document.body.classList.add("hasMessages");

  toSendFiles.forEach((file) => {
    const chip = document.createElement("div");
    chip.className = "selectedFile";

    chip.innerHTML = `
      <span>${file.name}</span>
      <button title="Remove">✕</button>
    `;

    chip.querySelector("button").onclick = () => {
      toSendFiles = toSendFiles.filter(f => !sameFile(f, file));
      renderToSend();
      renderSelectedFilesTray();
      updateSendButtonState();
    };

    tray.appendChild(chip);
  });
}


function formatDateLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";

  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function relativeTime(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);

  if (diff < 10) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  const s = Math.ceil(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r}s left`;
  return `${m}m ${r}s left`;
}



function supportsFileSystemAccess() {
  return "showSaveFilePicker" in window;
}

async function createStreamWriter(name, size) {
  if (!supportsFileSystemAccess()) return null;
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: name || "file",
      types: []
    });
    const writable = await handle.createWritable();
    return writable;
  } catch {
    return null;
  }
}
function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (bytes >= gb) return `${(bytes / gb).toFixed(1)} GB`;
  if (bytes >= mb) return `${(bytes / mb).toFixed(1)} MB`;
  if (bytes >= kb) return `${(bytes / kb).toFixed(1)} KB`;
  return `${bytes} B`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

function fileTypeMeta(fileName = "") {
  const ext = String(fileName).split(".").pop().toLowerCase();
  const imageExt = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic"]);
  const videoExt = new Set(["mp4", "mov", "avi", "mkv", "webm", "m4v"]);
  const audioExt = new Set(["mp3", "wav", "aac", "flac", "ogg", "m4a"]);
  const archiveExt = new Set(["zip", "rar", "7z", "tar", "gz"]);
  const excelExt = new Set(["xls", "xlsx", "csv"]);
  const pptExt = new Set(["ppt", "pptx", "key"]);
  const codeExt = new Set(["js", "ts", "py", "java", "c", "cpp", "cs", "rb", "php", "go", "swift", "kt"]);
  const markupExt = new Set(["json", "xml", "html", "css", "md", "yml", "yaml"]);
  const dbExt = new Set(["sql", "sqlite", "db"]);

  if (ext === "pdf") return { className: "icon-pdf", svg: iconSvg("pdf") };
  if (archiveExt.has(ext)) return { className: "icon-archive", svg: iconSvg("archive") };
  if (excelExt.has(ext)) return { className: "icon-excel", svg: iconSvg("excel") };
  if (pptExt.has(ext)) return { className: "icon-ppt", svg: iconSvg("ppt") };
  if (imageExt.has(ext)) return { className: "icon-image", svg: iconSvg("image") };
  if (videoExt.has(ext)) return { className: "icon-video", svg: iconSvg("video") };
  if (ext === "doc" || ext === "docx") return { className: "icon-doc", svg: iconSvg("doc") };
  if (audioExt.has(ext)) return { className: "icon-audio", svg: iconSvg("audio") };
  if (codeExt.has(ext)) return { className: "icon-code", svg: iconSvg("code") };
  if (markupExt.has(ext)) return { className: "icon-markup", svg: iconSvg("markup") };
  if (dbExt.has(ext)) return { className: "icon-db", svg: iconSvg("db") };
  return { className: "icon-default", svg: iconSvg("default") };
}

function iconSvg(type) {
  switch (type) {
    case "pdf":
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="2"/><path d="M14 3v6h6" stroke="currentColor" stroke-width="2"/><path d="M8 14h8M8 17h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    case "archive":
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 7h16v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7Z" stroke="currentColor" stroke-width="2"/><path d="M3 7l1-3h16l1 3" stroke="currentColor" stroke-width="2"/><path d="M9 11h6v3H9z" stroke="currentColor" stroke-width="2"/></svg>`;
    case "excel":
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M6 4h8l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="2"/><path d="M14 4v4h4" stroke="currentColor" stroke-width="2"/><path d="M8 12l2 3 2-3 2 3 2-3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    case "ppt":
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 5h16v10H4z" stroke="currentColor" stroke-width="2"/><path d="M8 19h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 15v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    case "image":
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="2"/><path d="M7 14l3-3 4 4 3-2 3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    case "video":
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="4" y="6" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2"/><path d="M16 10l4-2v8l-4-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case "doc":
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="2"/><path d="M14 3v6h6" stroke="currentColor" stroke-width="2"/><path d="M8 14h8M8 17h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    case "audio":
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M9 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" stroke="currentColor" stroke-width="2"/><path d="M15 16a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" stroke="currentColor" stroke-width="2"/><path d="M9 14V6l8-2v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    case "code":
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M9 8l-4 4 4 4M15 8l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case "markup":
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 7h16v10H4z" stroke="currentColor" stroke-width="2"/><path d="M8 10l-2 2 2 2M16 10l2 2-2 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    case "db":
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><ellipse cx="12" cy="6" rx="7" ry="3" stroke="currentColor" stroke-width="2"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" stroke="currentColor" stroke-width="2"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" stroke="currentColor" stroke-width="2"/></svg>`;
    default:
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="2"/><path d="M14 3v6h6" stroke="currentColor" stroke-width="2"/></svg>`;
  }
}

function applyChatSearch(query) {
  const q = (query || "").trim().toLowerCase();
  const rows = document.querySelectorAll(".msgRow");
  const seps = document.querySelectorAll(".dateSeparator");
  if (!q) {
    rows.forEach(r => r.style.display = "");
    seps.forEach(s => s.style.display = "");
    return;
  }
  seps.forEach(s => s.style.display = "none");
  rows.forEach(r => {
    const name = (r.dataset.fileName || "").toLowerCase();
    const note = (r.dataset.note || "").toLowerCase();
    const match = name.includes(q) || note.includes(q);
    r.style.display = match ? "" : "none";
  });
}

const uploadStats = new Map();


const pendingTransfers = new Map();

function upsertPendingTransfer(intentId, data = {}) {
  if (!intentId) return;
  const prev = pendingTransfers.get(intentId) || {};
  const createdAt = prev.createdAt || data.createdAt || Date.now();
  pendingTransfers.set(intentId, {
    ...prev,
    ...data,
    intentId,
    createdAt,
    updatedAt: Date.now()
  });
}

function removePendingTransfer(intentId) {
  if (!intentId) return;
  pendingTransfers.delete(intentId);
  removePendingTransfer(intentId);
}


function markPendingFailed(intentId, message = "Failed") {
  const bubble = intentId ? getPendingBubbleByIntent(intentId) : document.querySelector(".msgRow.pending");
  if (!bubble) return;
  bubble.classList.remove("pending");
  const wrap = bubble.querySelector(".messageProgressWrap");
  if (wrap) wrap.classList.remove("hidden");
  const etaEl = bubble.querySelector(".progressEta");
  if (etaEl) etaEl.textContent = message;
  removePendingTransfer(intentId);
}

function getPendingTransfersForFriend(friend) {
  if (!friend) return [];
  return Array.from(pendingTransfers.values())
    .filter(p => p.friend === friend)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function renderPendingTransfersForFriend(friend) {
  const pending = getPendingTransfersForFriend(friend);
  if (!pending.length) return;

  pending.forEach(p => {
    addMessageBubble({
      file: { name: p.fileName || "file", size: p.fileSize || 0 },
      direction: p.direction || (friend === currentUsername() ? "self" : "received"),
      intentId: p.intentId || null,
      pending: true,
      timestamp: p.createdAt || Date.now(),
      note: p.note || ""
    });

    const sent = Number.isFinite(p.sentBytes) ? p.sentBytes : 0;
    const total = Number.isFinite(p.totalBytes) ? p.totalBytes : (p.fileSize || 0);
    if (p.intentId) updateBubbleProgress(p.intentId, sent, total || 0);
  });
}

function getPendingBubbleByIntent(intentId) {
  return document.querySelector(`.msgRow.pending[data-intent-id="${intentId}"]`);
}

function getPendingBubbleByFile(fileName) {
  const bubbles = Array.from(document.querySelectorAll(".msgRow.pending"));
  return bubbles.find(b => b.dataset.fileName === fileName);
}

function ensurePendingBubble({ intentId, fileName, fileSize, direction, note = "", friend = "" }) {
  let bubble = intentId ? getPendingBubbleByIntent(intentId) : null;
  if (!bubble && fileName) bubble = getPendingBubbleByFile(fileName);
  if (!bubble) {
    addMessageBubble({
      file: { name: fileName, size: fileSize || 0 },
      direction,
      intentId: intentId || null,
      pending: true,
      note
    });
    bubble = intentId ? getPendingBubbleByIntent(intentId) : getPendingBubbleByFile(fileName);
  }
  if (bubble && intentId) bubble.dataset.intentId = intentId;
  if (bubble && fileName) bubble.dataset.fileName = fileName;
  if (bubble) bubble.dataset.note = note || "";
  if (bubble) {
    const noteEl = bubble.querySelector(".msgNote");
    if (note) {
      if (noteEl) {
        noteEl.textContent = note;
      } else {
        const content = bubble.querySelector(".msgContent");
        if (content) {
          const div = document.createElement("div");
          div.className = "msgNote";
          div.textContent = note;
          content.appendChild(div);
        }
      }
    } else if (noteEl) {
      noteEl.remove();
    }
  }
  if (bubble && direction) {
    bubble.classList.remove("sent", "received", "self");
    bubble.classList.add(direction);
  }
  setPendingWaiting(bubble);
  if (intentId) {
    upsertPendingTransfer(intentId, {
      friend,
      fileName,
      fileSize: fileSize || 0,
      direction,
      note
    });
  }
  return bubble;
}



function setPendingWaiting(bubble, message = "Waiting for server") {
  if (!bubble) return;
  const wrap = bubble.querySelector(".messageProgressWrap");
  if (wrap) wrap.classList.remove("hidden");
  const etaEl = bubble.querySelector(".progressEta");
  if (etaEl) {
    etaEl.textContent = message;
    etaEl.classList.add("waiting");
  }
  const pctEl = bubble.querySelector(".progressPct");
  if (pctEl) pctEl.textContent = "0%";
}
function updateBubbleProgress(intentId, sentBytes, totalBytes) {
  if (!intentId) return;
  upsertPendingTransfer(intentId, { sentBytes, totalBytes });

  const bubble = getPendingBubbleByIntent(intentId);
  if (!bubble) return;

  const wrap = bubble.querySelector(".messageProgressWrap");
  const bar = bubble.querySelector(".messageProgressBar span");
  const pctEl = bubble.querySelector(".progressPct");
  const etaEl = bubble.querySelector(".progressEta");

  const pct = totalBytes > 0 ? Math.min(100, Math.max(0, (sentBytes / totalBytes) * 100)) : 0;
  if (bar) bar.style.width = `${pct.toFixed(1)}%`;
  if (pctEl) pctEl.textContent = `${pct.toFixed(1)}%`;

  if (wrap) wrap.classList.remove("hidden");

  const now = performance.now();
  const stat = uploadStats.get(intentId) || {
    startTs: now,
    lastTs: now,
    lastBytes: sentBytes,
    rate: 0
  };

  const elapsed = Math.max(0.001, (now - stat.startTs) / 1000);
  const avgRate = sentBytes > 0 ? sentBytes / elapsed : 0;
  const dt = Math.max(0.001, (now - stat.lastTs) / 1000);
  const db = sentBytes - stat.lastBytes;
  const instantRate = db > 0 ? db / dt : 0;
  const blended = avgRate && instantRate ? (avgRate * 0.7 + instantRate * 0.3) : (avgRate || instantRate || 0);
  stat.rate = stat.rate ? (stat.rate * 0.6 + blended * 0.4) : blended;
  stat.lastTs = now;
  stat.lastBytes = sentBytes;
  uploadStats.set(intentId, stat);

  const remaining = totalBytes - sentBytes;
  const eta = stat.rate > 0 ? remaining / stat.rate : Infinity;
  if (etaEl) etaEl.textContent = formatEta(eta);
}

function finalizePendingBubble(intentId) {
  if (!intentId) return;
  const bubble = document.querySelector(`.msgRow[data-intent-id="${intentId}"]`);
  if (!bubble) return;
  bubble.classList.remove("pending");
  const wrap = bubble.querySelector(".messageProgressWrap");
  if (wrap) wrap.classList.add("hidden");

  const actions = bubble.querySelector(".msgActions");
  if (actions && !actions.querySelector(".msgDownloadBtn")) {
    const btn = document.createElement("button");
    btn.className = "msgActionBtn msgDownloadBtn";
    btn.title = "Download";
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 20h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    btn.onclick = () => queueDownload(intentId, bubble.dataset.fileName || "", "auto");
    actions.prepend(btn);
  }

  removePendingTransfer(intentId);
}


function markPendingFailed(intentId, message = "Failed") {
  const bubble = intentId ? getPendingBubbleByIntent(intentId) : document.querySelector(".msgRow.pending");
  if (!bubble) return;
  bubble.classList.remove("pending");
  const wrap = bubble.querySelector(".messageProgressWrap");
  if (wrap) wrap.classList.remove("hidden");
  const etaEl = bubble.querySelector(".progressEta");
  if (etaEl) etaEl.textContent = message;
  removePendingTransfer(intentId);
}

  let lastRenderedDate = null;

function addMessageBubble({
  file,
  direction,
  intentId = null,
  pending = false,
  timestamp = Date.now(),
  read = false,
  note = ""
}) {
  const stream = document.getElementById("messageStream");
  if (!stream || !file) return;

  // ---- DATE SEPARATOR ----
  const dateLabel = formatDateLabel(timestamp);
  if (dateLabel !== lastRenderedDate) {
    const sep = document.createElement("div");
    sep.className = "dateSeparator";
    sep.textContent = dateLabel;
    stream.appendChild(sep);
    lastRenderedDate = dateLabel;
  }

  // ---- MESSAGE ----
  const div = document.createElement("div");
  const displayName = fileLabel?.(file) || file.name || "File";
  div.className = `msgRow ${direction} ${pending ? "pending" : ""}`;
  div.dataset.timestamp = timestamp;
  div.dataset.fileName = displayName || "";
  div.dataset.note = note || "";
  if (intentId) div.dataset.intentId = intentId;

  const showDownload = intentId && !pending;
  const activeFriend = selectedFriend();
  const senderLabel = direction === "received"
    ? (activeFriend || "Sender")
    : "You";

  const meta = fileTypeMeta(displayName || "");
  const safeName = escapeHtml(displayName || "File");
  const safeNote = escapeHtml(note || "");

  div.innerHTML = `
    <div class="msgMetaTop">${senderLabel}</div>
    <div class="msgBubble">
      <div class="msgIcon ${meta.className}">${meta.svg}</div>
      <div class="msgContent">
        <div class="msgName">${safeName}</div>
        <div class="msgSize">${formatFileSize(file.size || 0)}</div>
        ${safeNote ? `<div class="msgNote">${safeNote}</div>` : ""}
        <div class="messageProgressWrap ${pending ? "" : "hidden"}">
          <div class="messageProgressBar"><span></span></div>
          <div class="messageProgressText"><span class="progressPct">0%</span> • <span class="progressEta">--</span></div>
        </div>
      </div>
      <div class="msgActions">
        ${showDownload ? `<button class="msgActionBtn msgDownloadBtn" title="Download">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M12 3v12m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M4 20h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>` : ""}
        <button class="msgActionBtn msgMoreBtn" title="More">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="5" r="2" fill="currentColor"/>
            <circle cx="12" cy="12" r="2" fill="currentColor"/>
            <circle cx="12" cy="19" r="2" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="messageTime">${relativeTime(timestamp)}</div>
  `;


if (intentId) {
  div.querySelector(".msgDownloadBtn")?.addEventListener("click", () => {
    queueDownload(intentId, displayName, "auto");
  });
}

div.querySelector(".msgMoreBtn")?.addEventListener("click", () => {
  if (!intentId) return;
  const deleteForEveryone = confirm("Delete for everyone? Click OK for everyone, Cancel for just you.");
  if (deleteForEveryone) {
    if (!requireWsOpen()) return alert("Not connected to server");
    accountWs.send(JSON.stringify({ type: "delete_message_everyone", intentId }));
  } else {
    removeBubbleByIntent(intentId);
    const friend = selectedFriend();
    if (friend) removeChatMessageByIntent(friend, intentId);
  }
});


  stream.appendChild(div);
  stream.scrollTop = stream.scrollHeight;
  if (chatSearchInput && !chatSearchBar?.classList.contains("hidden")) {
    applyChatSearch(chatSearchInput.value);
  }
}




  function updateSendButtonLabel() {
    if (!sendBtn) return;
    if ((packageToggle?.checked && toSendFiles.length > 1) || folderPackageMode) {
      sendBtn.title = "Send Folder";
    } else {
      sendBtn.title = "Send";
    }
  }

  function updateSendButtonState() {
    const canSend = toSendFiles.length > 0;
    const blocked = isDeletedFriend(selectedFriend());
    if (sendBtn) {
      sendBtn.disabled = !canSend || blocked;
      sendBtn.style.opacity = (!canSend || blocked) ? "0.5" : "1";
    }
    updateSendButtonLabel();
  }

  // =====================
  // Inbox
  // =====================
  const inbox = [];
  const downloadQueue = [];
  let activeDownloadTask = null;

  function queueDownload(intentId, name, mode = "auto") {
    if (!intentId) return Promise.reject(new Error("Missing intentId"));
    return new Promise((resolve, reject) => {
      downloadQueue.push({ intentId, name, mode, resolve, reject });
      startNextDownload();
    });
  }

  function startNextDownload() {
    if (activeDownloadTask || !downloadQueue.length) return;
    if (!requireWsOpen()) {
      const task = downloadQueue.shift();
      task?.reject?.(new Error("Not connected to server"));
      return;
    }
    activeDownloadTask = downloadQueue.shift();
    accountWs.send(JSON.stringify({
      type: "download_ws_request",
      intentId: activeDownloadTask.intentId
    }));
  }

  function getPhotoIntentsForFriend(friend) {
    if (!friend) return [];
    return inbox.filter(i => i.from === friend && i.stored && isImageName(i.fileName));
  }

  function updateSavePhotosButton() {
    if (!savePhotosBtn) return;
    const friend = selectedFriend();
    const photos = getPhotoIntentsForFriend(friend);
    const hasPhotos = photos.length > 0;

    savePhotosBtn.classList.toggle("hidden", !hasPhotos);
    savePhotosBtn.disabled = !hasPhotos;
    savePhotosBtn.textContent = hasPhotos
      ? (photos.length === 1 ? "Save photo" : `Save ${photos.length} photos`)
      : "Save all photos";
  }

  async function saveAllPhotosForFriend() {
    const friend = selectedFriend();
    const intents = getPhotoIntentsForFriend(friend);
    if (!intents.length) return;

    if (!requireWsOpen()) {
      alert("Not connected to server");
      return;
    }

    savePhotosBtn.disabled = true;
    const originalLabel = savePhotosBtn.textContent;

    try {
      const files = [];
      let idx = 0;

      for (const intent of intents) {
        idx += 1;
        savePhotosBtn.textContent = `Downloading ${idx}/${intents.length}...`;

        const blob = await queueDownload(intent.id, intent.fileName, "collect");
        files.push(new File([blob], intent.fileName, {
          type: guessMime(intent.fileName),
          lastModified: Date.now()
        }));
      }

      if (navigator.canShare && navigator.canShare({ files })) {
        await navigator.share({ files, title: "Photos" });
      } else {
        if (!window.JSZip) {
          alert("Zip library missing.");
          return;
        }
        savePhotosBtn.textContent = "Packaging photos...";
        const zip = new JSZip();
        const used = new Map();
        files.forEach(f => zip.file(safeZipName(f.name, used), f));

        const zipBlob = await zip.generateAsync({ type: "blob" });
        const name = `photos_${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;

        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch (err) {
      alert(err?.message || "Failed to save photos");
    } finally {
      savePhotosBtn.disabled = false;
      savePhotosBtn.textContent = originalLabel || "Save all photos";
    }
  }
  let activeDownload = null;
  let downloadChunks = [];
  let downloadWriter = null;
  let downloadWriteChain = Promise.resolve();
  let isDownloading = false;

  // =====================
  // Account Signaling
  // =====================
  let accountWs = null;
  window.accountWs = null;

  let ACCOUNT_USERNAME = "";
  let IS_AUTHED = false;

  function getRuntimeSignalWsUrl() {
    try {
      const runtimeWs = String(window.__MERM_RUNTIME_CONFIG__?.signalWsUrl || "").trim();
      if (runtimeWs) return runtimeWs;
    } catch {}
    return "";
  }

  const ACCOUNT_SIGNALING_SERVER = getRuntimeSignalWsUrl();


const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

const rtcPeers = new Map(); // intentId -> { pc, dc, role, to, from }
const rtcAnswerResolvers = new Map(); // intentId -> resolve(answer)
const rtcOpenResolvers = new Map(); // intentId -> resolve()
const rtcReceiveState = new Map(); // intentId -> { name,size,received,chunks,writer,writeChain }

function rtcCleanup(intentId) {
  const state = rtcPeers.get(intentId);
  try { state?.dc?.close(); } catch {}
  try { state?.pc?.close(); } catch {}
  rtcPeers.delete(intentId);
  rtcAnswerResolvers.delete(intentId);
  rtcOpenResolvers.delete(intentId);
}

  async function waitForRtcAnswer(intentId, timeoutMs = 12000) {
  const p = new Promise((resolve) => {
    rtcAnswerResolvers.set(intentId, resolve);
  });
  return withTimeout(p, timeoutMs, "webrtc_answer");
}

async function waitForRtcOpen(intentId, timeoutMs = 12000) {
  const p = new Promise((resolve) => {
    rtcOpenResolvers.set(intentId, resolve);
  });
  return withTimeout(p, timeoutMs, "webrtc_open");
}

function createPeerConnection(intentId, role, peerName) {
  const pc = new RTCPeerConnection(RTC_CONFIG);

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    if (!requireWsOpen()) return;
    accountWs.send(JSON.stringify({
      type: "webrtc_ice",
      to: peerName,
      intentId,
      candidate: ev.candidate
    }));
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === "failed" || state === "disconnected" || state === "closed") {
      rtcCleanup(intentId);
    }
  };

  const data = { pc, dc: null, role, to: peerName, from: peerName };
  rtcPeers.set(intentId, data);
  return pc;
}

async function sendFileViaWebRTC(file, intentId, to, onProgress) {
  if (!window.RTCPeerConnection) return false;

  const pc = createPeerConnection(intentId, "sender", to);
  const dc = pc.createDataChannel(`file-${intentId}`, { ordered: true });
  dc.binaryType = "arraybuffer";
  rtcPeers.get(intentId).dc = dc;

  dc.onopen = () => {
    const resolve = rtcOpenResolvers.get(intentId);
    if (resolve) {
      rtcOpenResolvers.delete(intentId);
      resolve(true);
    }
  };

  dc.onerror = () => {
    rtcCleanup(intentId);
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  accountWs.send(JSON.stringify({
    type: "webrtc_offer",
    to,
    intentId,
    sdp: pc.localDescription
  }));

  const answer = await waitForRtcAnswer(intentId);
  if (!answer) {
    rtcCleanup(intentId);
    return false;
  }
  await pc.setRemoteDescription(answer);

  await waitForRtcOpen(intentId);

  // Send metadata
  dc.send(JSON.stringify({
    type: "meta",
    intentId,
    name: file.name,
    size: file.size
  }));

  const chunkSize = 256 * 1024;
  const bufferLimit = 8 * 1024 * 1024;
  let offset = 0;

  while (offset < file.size) {
    const slice = file.slice(offset, offset + chunkSize);
    const buf = await slice.arrayBuffer();

    while (dc.bufferedAmount > bufferLimit) {
      await new Promise(r => setTimeout(r, 10));
    }

    dc.send(buf);
    offset += chunkSize;
    if (typeof onProgress === "function") {
      onProgress(Math.min(offset, file.size), file.size);
    }
  }

  dc.send(JSON.stringify({ type: "done", intentId }));

  rtcCleanup(intentId);
  return true;
}

async function startRtcReceiver(intentId, from, offer) {
  const pc = createPeerConnection(intentId, "receiver", from);

  pc.ondatachannel = (ev) => {
    const dc = ev.channel;
    dc.binaryType = "arraybuffer";
    rtcPeers.get(intentId).dc = dc;

    dc.onmessage = async (msg) => {
      if (typeof msg.data === "string") {
        let data;
        try { data = JSON.parse(msg.data); } catch { return; }

        if (data.type === "meta") {
          const name = String(data.name || "file");
          const size = Number(data.size || 0);
          const state = {
            name,
            size,
            received: 0,
            chunks: [],
            writer: null,
            writeChain: Promise.resolve()
          };

          // create pending bubble
          ensurePendingBubble({
            intentId,
            fileName: name,
            fileSize: size,
            direction: "received",
            note: ""
          });

          rtcReceiveState.set(intentId, state);
          return;
        }

        if (data.type === "done") {
          const state = rtcReceiveState.get(intentId);
          if (!state) return;

          if (state.writer) {
            await state.writeChain;
            await state.writer.close();
          } else {
            const blob = new Blob(state.chunks, { type: guessMime(state.name) });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = state.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }

          finalizePendingBubble(intentId);
          appendChatMessage(from, {
            id: crypto.randomUUID(),
            direction: "received",
            fileName: state.name,
            fileSize: state.size,
            timestamp: Date.now(),
            intentId
          });
          bumpActivity(from);
          renderFriends();

          // remove server intent to avoid duplicates
          if (requireWsOpen()) {
            accountWs.send(JSON.stringify({ type: "delete_intent", intentId }));
          }

          rtcReceiveState.delete(intentId);
          rtcCleanup(intentId);
          return;
        }
      }

      // binary chunk
      const state = rtcReceiveState.get(intentId);
      if (!state) return;

      const chunk = msg.data instanceof ArrayBuffer ? new Uint8Array(msg.data) : msg.data;
      if (state.writer) {
        state.writeChain = state.writeChain.then(() => state.writer.write(chunk));
      } else {
        state.chunks.push(chunk);
      }
      state.received += chunk.byteLength || chunk.size || 0;
      updateBubbleProgress(intentId, state.received, state.size);
    };
  };

  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  accountWs.send(JSON.stringify({
    type: "webrtc_answer",
    to: from,
    intentId,
    sdp: pc.localDescription
  }));
}

  let pendingUploadIntentId = null;
  let awaitingIntentOk = false;
  let awaitingUploadOk = false;
  let isUploading = false;
  let isSending = false;

  const intentOkQueue = [];
  const uploadOkResolvers = new Map();

  function renderInbox() {
    const ul = document.getElementById("inbox");
    if (!ul) return;
    ul.innerHTML = "";
    
    // Toggle "empty" message
    const emptyMsg = document.getElementById("inboxEmpty");
    if(emptyMsg) emptyMsg.style.display = inbox.length ? "none" : "block";

    inbox.forEach((item) => {
      const li = document.createElement("li");

      const downloadBtn = document.createElement("button");
      const deleteBtn = document.createElement("button");

      if (item.stored && item.storedFile) {
        downloadBtn.textContent = `⬇️ ${item.fileName}`;
        downloadBtn.onclick = () => {
          queueDownload(item.id, item.fileName, "auto");
        };
      } else {
        downloadBtn.textContent = `⏳ ${item.fileName} (waiting)`;
        downloadBtn.disabled = true;
        downloadBtn.style.opacity = "0.6";
    
    updateSavePhotosButton();
  }

      deleteBtn.textContent = "🗑️";
      deleteBtn.onclick = () => {
        accountWs.send(JSON.stringify({
            type: "delete_intent",
            intentId: item.id,
        }));
      };

      li.appendChild(downloadBtn);
      li.appendChild(deleteBtn);
      ul.appendChild(li);
    });

    updateSavePhotosButton();
  }

  function connectAccountSocket() {
    if (accountWs && (accountWs.readyState === WebSocket.OPEN || accountWs.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (!ACCOUNT_SIGNALING_SERVER) {
      log("Signal server is not configured");
      setAuthState("Server config unavailable.");
      return;
    }
    accountWs = new WebSocket(ACCOUNT_SIGNALING_SERVER);
    accountWs.binaryType = "arraybuffer";
    window.accountWs = accountWs;

    accountWs.onopen = () => {
  log("✅ Connected to Server");
  reconnectAttempts = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const saved = getSavedSession();
  if (saved) {
    accountWs.send(JSON.stringify({
      type: "auth_resume",
      username: saved.username,
      sessionToken: saved.token,
    }));
    return;
  }
};



    accountWs.onerror = () => {
      log("❌ Connection Error");
    };

    accountWs.onclose = () => {
  const saved = getSavedSession();
  if (saved) {
    setAuthState("Disconnected. Reconnecting…");
    scheduleReconnect();
  } else {
    IS_AUTHED = false;
    setAuthedUi(false);
    setAuthState("Disconnected.");
  }
};




    accountWs.onmessage = async (ev) => {
      // 1) Binary Download Data
      if (isDownloading && activeDownload && (ev.data instanceof Blob || ev.data instanceof ArrayBuffer)) {
        const chunkBlob = ev.data instanceof Blob ? ev.data : new Blob([ev.data]);
        if (downloadWriter) {
          const buf = await chunkBlob.arrayBuffer();
          downloadWriteChain = downloadWriteChain.then(() => downloadWriter.write(new Uint8Array(buf)));
        } else {
          downloadChunks.push(chunkBlob);
        }
        const chunkSize = chunkBlob.size;
        recvUi.receivedBytes += chunkSize;
        updateRecvProgress(activeDownload.name, recvUi.receivedBytes, recvUi.totalBytes);
        return;
      }

      // 2) JSON Control Messages
      if (typeof ev.data !== "string") {
        return;
      }

      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }

      if (msg.type === "delete_ok") {
        const idx = inbox.findIndex((i) => i.id === msg.intentId);
        if (idx !== -1) {
          inbox.splice(idx, 1);
          renderInbox();
        }
        removePendingTransfer(msg.intentId);
        updateSavePhotosButton();
        return;
      }

      if (msg.type === "login_ok") {
        IS_AUTHED = true;
        setAuthState("");
        setAuthedUi(true);

        if (msg.sessionToken) {
          localStorage.setItem(SESSION_KEY, JSON.stringify({
            username: msg.username,
            token: msg.sessionToken,
          }));
        }

        accountWs.send(JSON.stringify({ type: "friends_list" }));
        hydrateAccountFields();
        if (document.body.classList.contains("page-logs")) requestStats();
        return;
      }


      if (msg.type === "signup_ok") {
        const username = document.getElementById("signupUser")?.value?.trim();
        const password = document.getElementById("signupPass")?.value;

        if (!username || !password) {
          setAuthState("Account created. Please log in.");
          return;
        }

        setAuthState("Account created. Logging you in…");

        accountWs.send(JSON.stringify({
          type: "auth_login",
          username,
          password,
          client: "web"
        }));

        return;
      }


      if (msg.type === "account_deleted") {
        localStorage.removeItem(SESSION_KEY);
        alert("Your account has been deleted.");
        location.reload();
        return;
      }


      if (msg.type === "inbox") {
        inbox.length = 0;
        inbox.push(...msg.items);
        renderInbox();
        updateSavePhotosButton();

        const active = selectedFriend();
        if (active) {
          msg.items
            .filter(i => i.from === active && !i.stored)
            .forEach(i => {
              const isSelf = i.from === currentUsername();
              ensurePendingBubble({
                intentId: i.id,
                fileName: i.fileName,
                fileSize: i.fileSize || 0,
                direction: isSelf ? "self" : "received",
                note: i.note || ""
              });
            });
        }

        return;
      }

   if (msg.type === "incoming_file") {
  inbox.push(msg.intent);
  removePendingTransfer(msg.intent.id);
  renderInbox();
  updateSavePhotosButton();

  const from = msg.intent.from;

  // ✅ Always save the message to the correct chat history FIRST
  appendChatMessage(from, {
    id: msg.intent.id,
    direction: "received",
    fileName: msg.intent.fileName,
    fileSize: msg.intent.fileSize || 0,
    intentId: msg.intent.id,
    timestamp: Date.now(),
    note: msg.intent.note || ""
  });

  // ✅ Only render into the UI if the user is currently viewing THAT friend's chat
  if (selectedFriend() === from) {
    const isSelf = from === currentUsername();
    const existing = getPendingBubbleByIntent(msg.intent.id);
    if (existing) {
      existing.dataset.fileName = msg.intent.fileName || "";
      existing.dataset.note = msg.intent.note || "";
      const noteEl = existing.querySelector(".msgNote");
      if (msg.intent.note) {
        if (noteEl) {
          noteEl.textContent = msg.intent.note;
        } else {
          const content = existing.querySelector(".msgContent");
          if (content) {
            const div = document.createElement("div");
            div.className = "msgNote";
            div.textContent = msg.intent.note;
            content.appendChild(div);
          }
        }
      } else if (noteEl) {
        noteEl.remove();
      }
      finalizePendingBubble(msg.intent.id);
    } else {
      addMessageBubble({
        file: {
          name: msg.intent.fileName,
          size: msg.intent.fileSize || 0
        },
        direction: isSelf ? "self" : "received",
        intentId: msg.intent.id,
        note: msg.intent.note || ""
      });
      if (isSelf) {
        finalizePendingBubble(msg.intent.id);
      }
    }

    bumpActivity(from);
  } else {
    if (from !== currentUsername()) incrementUnread(from);
  }

  const me = currentUsername();
  const others = friends.filter(f => f && f !== me);
  const sorted = [...others].sort((a, b) => (loadChatMeta(b).lastActivity || 0) - (loadChatMeta(a).lastActivity || 0));
  renderFriendSidebar(me ? [me, ...sorted] : sorted);
  log(`📩 New file: ${msg.intent.fileName}`);
  return;
}




      if (msg.type === "friends_list") {
        deletedFriends = Array.isArray(msg.deletedFriends) ? msg.deletedFriends : [];
        setFriendsList(Array.isArray(msg.friends) ? msg.friends : []);
        return;
      }

      if (msg.type === "friend_requests") {
        pendingIncoming = Array.isArray(msg.incoming) ? msg.incoming : [];
        pendingOutgoing = Array.isArray(msg.outgoing) ? msg.outgoing : [];
        pendingDeclined = Array.isArray(msg.declined) ? msg.declined : [];
        updateFriendRequestBadge();
        renderPendingRequests();
        renderFriendSearch();
        return;
      }

      if (msg.type === "stats") {
        if (statTotalUsers) statTotalUsers.textContent = msg.totalUsers ?? "—";
        if (statOnlineUsers) statOnlineUsers.textContent = msg.onlineUsers ?? "—";
        if (statStoredFiles) statStoredFiles.textContent = msg.storedFiles ?? "—";
        if (statStorageUsed) statStorageUsed.textContent = formatSize(msg.storageBytes ?? 0);
        renderFilesList(msg.largestFiles || []);
        return;
      }

      if (msg.type === "incoming_intent") {
        const intent = msg.intent || {};
        if (intent.id && !inbox.find(i => i.id === intent.id)) {
          inbox.push(intent);
          renderInbox();
        }

        const isSelf = intent.from === currentUsername();
        if (selectedFriend() === intent.from) {
          ensurePendingBubble({
            intentId: intent.id,
            fileName: intent.fileName,
            fileSize: intent.fileSize || 0,
            direction: isSelf ? "self" : "received",
            note: intent.note || ""
          });
        } else {
          if (!isSelf) incrementUnread(intent.from);
        }

        updateFriendRequestBadge();
        return;
      }



if (msg.type === "webrtc_offer") {
  try {
    await startRtcReceiver(msg.intentId, msg.from, msg.sdp);
  } catch (err) {
    log("❌ WebRTC offer failed: " + (err?.message || err));
  }
  return;
}

if (msg.type === "webrtc_answer") {
  const resolve = rtcAnswerResolvers.get(msg.intentId);
  if (resolve) {
    rtcAnswerResolvers.delete(msg.intentId);
    resolve(msg.sdp);
  }
  return;
}

if (msg.type === "webrtc_ice") {
  const state = rtcPeers.get(msg.intentId);
  if (state?.pc && msg.candidate) {
    try { await state.pc.addIceCandidate(msg.candidate); } catch {}
  }
  return;
}

if (msg.type === "webrtc_unavailable") {
  const resolve = rtcAnswerResolvers.get(msg.intentId);
  if (resolve) {
    rtcAnswerResolvers.delete(msg.intentId);
    resolve(null);
  }
  return;
}

if (msg.type === "webrtc_cancel") {
  rtcCleanup(msg.intentId);
  return;
}


if (msg.type === "intent_deleted") {
  const intentId = msg.intentId;
  const from = msg.from;
  const to = msg.to;
  if (intentId) {
    removeBubbleByIntent(intentId);
    if (from) removeChatMessageByIntent(from, intentId);
    if (to) removeChatMessageByIntent(to, intentId);
  }
  if (msg.storedFile) {
    filesCache = filesCache.filter(f => f.storedFile !== msg.storedFile);
    renderFilesList(filesCache);
  }
  return;
}
      if (msg.type === "incoming_progress") {
        if (msg.intentId && msg.bytesSent != null && msg.bytesExpected != null) {
          updateBubbleProgress(msg.intentId, msg.bytesSent, msg.bytesExpected);
        }
        return;
      }

      if (msg.type === "download_ws_begin") {
        log(`📥 Starting download: ${msg.name}`);
        activeDownload = { intentId: msg.intentId, name: msg.name, size: msg.size };
        downloadChunks = [];
        downloadWriter = await createStreamWriter(msg.name, msg.size);
        downloadWriteChain = Promise.resolve();
        isDownloading = true;

        recvUi.active = true;
        recvUi.totalFiles = 1;
        recvUi.currentIndex = 1;
        recvUi.totalBytes = msg.size;
        recvUi.receivedBytes = 0;
        updateRecvProgress(msg.name, 0, msg.size);
        return;
      }

      if (msg.type === "download_ws_end") {
        if (downloadWriter) {
          await downloadWriteChain;
          await downloadWriter.close();
        }

        if (activeDownloadTask) {
          if (downloadWriter) {
            activeDownloadTask.resolve(true);
          } else {
            const blob = new Blob(downloadChunks, { type: guessMime(activeDownload.name) });
            activeDownloadTask.resolve(blob);
          }
        }

        if (!activeDownloadTask || activeDownloadTask.mode === "auto") {
          if (!downloadWriter) {
            const blob = new Blob(downloadChunks, { type: guessMime(activeDownload.name) });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = activeDownload.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }
        }

        activeDownload = null;
        downloadChunks = [];
        downloadWriter = null;
        isDownloading = false;

        if (activeDownloadTask) {
          activeDownloadTask = null;
          startNextDownload();
        }

        updateRecvProgress("Complete", recvUi.totalBytes, recvUi.totalBytes);
        setTimeout(() => resetRecvUI(), 1500);
        log("✅ Download complete");
        return;
      }

      if (msg.type === "intent_ok") {
        pendingUploadIntentId = msg.intentId;
        awaitingIntentOk = false;
        const pendingBubble = getPendingBubbleByIntent(pendingUploadIntentId);
        if (pendingBubble) setPendingWaiting(pendingBubble, "Preparing upload");
        const nextResolve = intentOkQueue.shift();
        if (nextResolve) nextResolve(pendingUploadIntentId);
        updateSendButtonState();
        return;
      }

      if (msg.type === "upload_ok") {
        awaitingUploadOk = false;
        if (msg.intentId && uploadOkResolvers.has(msg.intentId)) {
          const resolve = uploadOkResolvers.get(msg.intentId);
          uploadOkResolvers.delete(msg.intentId);
          resolve();
          return;
        }
        if (uploadOkResolvers.has("any")) {
          const resolve = uploadOkResolvers.get("any");
          uploadOkResolvers.delete("any");
          resolve();
          return;
        }
        return;
      }

      if (msg.type === "upload_done") {
        pendingUploadIntentId = null;
        awaitingIntentOk = false;
        awaitingUploadOk = false;
        isUploading = false;
        isSending = false;
        updateSendButtonState();
        return;
      }


      if (msg.message === "Session expired" || msg.message === "Not logged in") {
          localStorage.removeItem(SESSION_KEY);
          setAuthedUi(false);
          setAuthState("Please log in.");
          return;
        }

      if (msg.type === "error") {
        log("❌ Error: " + (msg.message || ev.data));
        setAuthState(msg.message || "Error");

        if (friendSearchMsg && msg.message) {
          if (msg.message === "User not found") {
            friendSearchMsg.textContent = "This username doesn't exist.";
          } else {
            friendSearchMsg.textContent = msg.message;
          }
        }
        
        // Reset states if error occurred
        awaitingIntentOk = false;
        awaitingUploadOk = false;
        isUploading = false;
        isSending = false;
        updateSendButtonState();
        return;
      }
    };
  }

  function requireWsOpen() {
    return accountWs && accountWs.readyState === WebSocket.OPEN;
  }

  if (signupBtn) {
  signupBtn.onclick = () => {
    const firstName = document.getElementById("signupFirst")?.value.trim();
  const lastName = document.getElementById("signupLast")?.value.trim();
  const email = document.getElementById("signupEmail")?.value.trim();
  const username = document.getElementById("signupUser")?.value.trim();
  const password = document.getElementById("signupPass")?.value;

  const name = [firstName, lastName].filter(Boolean).join(" ").trim();

  if (!firstName || !lastName || !email || !username || !password) {
    setAuthState("Please fill out all fields.");
    return;
  }


  // ✅ EMAIL FORMAT VALIDATION
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    setAuthState("Please enter a valid email address (example@domain.com).");
    return;
  }

  if (!requireWsOpen()) {
    setAuthState("Not connected to server.");
    return;
  }

  setAuthState("Creating account...");

  accountWs.send(JSON.stringify({
    type: "auth_signup",
    name,
    email,
    username,
    password,
    client: "web"
  }));
};

}



  if (loginBtn) {
    loginBtn.onclick = () => {
      const u = (authUserEl?.value || "").trim();
      const p = (authPassEl?.value || "");
      if (!u || !p) return alert("Enter username + password");
      if (!requireWsOpen()) return alert("Not connected to server");

      ACCOUNT_USERNAME = u;
      accountWs.send(JSON.stringify({ type: "auth_login", username: u, password: p, client: "web" }));
      setAuthState("Logging in...");
    };
  }

  function sendFriendRequest(username) {
    if (!IS_AUTHED) return alert("Log in first");
    if (!username) return alert("Enter a username");
    if (!requireWsOpen()) return alert("Not connected to server");
    accountWs.send(JSON.stringify({ type: "friend_request_send", username }));
  }

  if (friendSearchInput) {
    friendSearchInput.oninput = () => renderFriendSearch();
    friendSearchInput.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      const q = friendSearchInput.value.trim();
      if (!q) return;
      sendFriendRequest(q);
    };
  }

  // Top-left "Add friend" icon button now opens Friends tab
  const openAddFriendBtn = document.getElementById("openAddFriendBtn");
  if (openAddFriendBtn) {
    openAddFriendBtn.onclick = () => {
      if (!IS_AUTHED) return alert("Log in first");
      setActivePage("friends");
      if (friendSearchInput) friendSearchInput.focus();
      renderFriendSearch();
    };
  }

// =====================
// 🗑️ DELETE ACCOUNT (UI)
// =====================
const deleteAccountBtn = document.getElementById("deleteAccountBtn");


  if (deleteAccountBtn) {
  deleteAccountBtn.onclick = () => {
    if (!confirm("This will permanently delete your account. Continue?")) return;

    if (!requireWsOpen()) {
      alert("Not connected to server");
      return;
    }

    accountWs.send(JSON.stringify({
      type: "delete_account"
    }));
  };
}



  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      ),
    ]);
  }

  function waitForIntentOk(timeoutMs = 15000) {
    const p = new Promise((resolve) => {
      intentOkQueue.push(resolve);
    });
    return withTimeout(p, timeoutMs, "intent_ok");
  }



function abortSendFlow(reason) {
  try {
    if (reason) log(`❌ ${reason}`);
  } catch {}

  // Resolve any pending intent/upload waits so queues unwind
  while (intentOkQueue.length) {
    const resolve = intentOkQueue.shift();
    try { resolve(null); } catch {}
  }
  for (const [key, resolve] of uploadOkResolvers.entries()) {
    try { resolve(false); } catch {}
  }
  uploadOkResolvers.clear();

  awaitingIntentOk = false;
  awaitingUploadOk = false;
  isUploading = false;
  isSending = false;

  if (pendingUploadIntentId) {
    removePendingTransfer(pendingUploadIntentId);
    pendingUploadIntentId = null;
  }

  resetSendUI();
  updateSendButtonState();
}
  function waitForUploadOk(intentId, timeoutMs = 20000) {
    const p = new Promise((resolve) => {
      uploadOkResolvers.set(intentId, resolve);
      uploadOkResolvers.set("any", resolve);
    });
    return withTimeout(p, timeoutMs, "upload_ok");
  }

  async function uploadFilesViaServer(intentId, files, onProgress) {
    if (!accountWs || accountWs.readyState !== WebSocket.OPEN) {
      log("❌ Not connected");
      return;
    }
    if (isUploading) return;

    isUploading = true;

    try {
      for (const file of files) {
        awaitingUploadOk = true;
        const uploadOkPromise = waitForUploadOk(intentId);

        accountWs.send(JSON.stringify({
            type: "upload_begin",
            intentId,
            name: fileLabel(file) || file.name,
            size: file.size,
        }));

        const uploadOk = await uploadOkPromise;
        if (uploadOk === false) throw new Error("Upload canceled");

        const chunkSize = 8 * 1024 * 1024; // 8 MB chunks for better throughput
        const bufferLimit = 128 * 1024 * 1024;
        let offset = 0;

        while (offset < file.size) {
  const slice = file.slice(offset, offset + chunkSize);
  const buf = await slice.arrayBuffer();

  // If ws buffer is huge, yield until it drains a bit (prevents freezing)
  while (accountWs.bufferedAmount > bufferLimit) {
    await new Promise(r => setTimeout(r, 15));
  }

  accountWs.send(buf); // keep as ArrayBuffer (binary)
  offset += chunkSize;

  if (typeof onProgress === "function") {
    onProgress(Math.min(offset, file.size), file.size);
  }
}



        accountWs.send(JSON.stringify({ type: "upload_end", intentId }));
        log("📤 Uploaded: " + file.name);
      }
    } catch (err) {
      log("❌ Upload failed: " + (err?.message || err));
      awaitingUploadOk = false;
      throw err;
    } finally {
      isUploading = false;
      awaitingUploadOk = false;
    }
  }

  // Connect immediately
  connectAccountSocket();

  // =====================
  // File pickers
  // =====================
  if (choosePhotosBtn && photoInput) {
    choosePhotosBtn.onclick = () => photoInput.click();
  }
  if (chooseFilesBtn && fileInput) {
    chooseFilesBtn.onclick = () => fileInput.click();
  }
  if (chooseFolderBtn && folderInput) {
    chooseFolderBtn.onclick = () => folderInput.click();
  }

  if (photoInput) {
    photoInput.onchange = () => {
      toSendFiles = Array.from(photoInput.files || []);
      folderPackageMode = false;
      folderPackageName = "";
      if (fileInput) fileInput.value = "";
      if (folderInput) folderInput.value = "";
      renderToSend();
renderSelectedFilesTray();
updateSendButtonState();


toSendFiles.forEach(file => {
  addMessageBubble({ file, direction: "sent", pending: true });
});

    };
  }

  if (fileInput) {
    fileInput.onchange = () => {
      toSendFiles = Array.from(fileInput.files || []);
      folderPackageMode = false;
      folderPackageName = "";
      if (photoInput) photoInput.value = "";
      if (folderInput) folderInput.value = "";
      renderToSend();
renderSelectedFilesTray();
updateSendButtonState();


toSendFiles.forEach(file => {
  addMessageBubble({ file, direction: "sent", pending: true });
});

    };
  }

  if (folderInput) {
    folderInput.onchange = () => {
      toSendFiles = Array.from(folderInput.files || []).map(f => {
        // attach relative path for display + sending
        if (f.webkitRelativePath) {
          f._sendName = f.webkitRelativePath;
        }
        return f;
      });
      folderPackageMode = toSendFiles.length > 0;
      folderPackageName = toSendFiles[0]?.webkitRelativePath?.split("/")?.[0] || "folder";
      if (photoInput) photoInput.value = "";
      if (fileInput) fileInput.value = "";
      renderToSend();
renderSelectedFilesTray();
updateSendButtonState();


toSendFiles.forEach(file => {
  addMessageBubble({ file, direction: "sent", pending: true });
});

    };
  }

  if (messageStreamEl) {
    messageStreamEl.addEventListener("click", (e) => {
      const target = e.target;
      const btn = target?.closest?.(".msgDownloadBtn");
      if (!btn) return;
      const row = btn.closest(".msgRow");
      const intentId = row?.dataset?.intentId;
      const name = row?.dataset?.fileName || "file";
      if (!intentId) return;
      queueDownload(intentId, name, "auto");
    });
  }

  function setUploadMenuOpen(open) {
    if (!uploadMenu) return;
    uploadMenu.classList.toggle("hidden", !open);
  }

  if (uploadMenuBtn && uploadMenu) {
    uploadMenuBtn.onclick = (e) => {
      e.stopPropagation();
      setUploadMenuOpen(uploadMenu.classList.contains("hidden"));
    };
  }

  document.addEventListener("click", (e) => {
    if (!uploadMenu || uploadMenu.classList.contains("hidden")) return;
    if (uploadMenu.contains(e.target) || uploadMenuBtn?.contains(e.target)) return;
    setUploadMenuOpen(false);
  });

  if (choosePhotosBtn) {
    choosePhotosBtn.onclick = () => {
      if (photoInput) photoInput.click();
      setUploadMenuOpen(false);
    };
  }
  if (chooseFilesBtn) {
    chooseFilesBtn.onclick = () => {
      if (fileInput) fileInput.click();
      setUploadMenuOpen(false);
    };
  }
  if (chooseFolderBtn) {
    chooseFolderBtn.onclick = () => {
      if (folderInput) folderInput.click();
      setUploadMenuOpen(false);
    };
  }

  if (chatSearchToggle) {
    chatSearchToggle.onclick = () => {
      if (!chatSearchBar) return;
      const isHidden = chatSearchBar.classList.contains("hidden");
      chatSearchBar.classList.toggle("hidden", !isHidden);
      if (isHidden) {
        chatSearchInput?.focus();
      } else {
        if (chatSearchInput) chatSearchInput.value = "";
        applyChatSearch("");
      }
    };
  }
  if (chatSearchInput) {
    chatSearchInput.oninput = () => applyChatSearch(chatSearchInput.value);
  }

  if (packageToggle) {
    packageToggle.onchange = () => {
      renderSelectedFilesTray();
      updateSendButtonState();
    };
  }

  if (contactsSearchInput) {
    contactsSearchInput.oninput = () => {
      const me = currentUsername();
      const others = friends.filter(f => f && f !== me);
      const sorted = [...others].sort((a, b) => (loadChatMeta(b).lastActivity || 0) - (loadChatMeta(a).lastActivity || 0));
      renderFriendSidebar(me ? [me, ...sorted] : sorted);
    };
  }

  if (savePhotosBtn) {
    savePhotosBtn.onclick = () => saveAllPhotosForFriend();
  }

  const profileImageInput = document.getElementById("profileImageInput");
  const profileImageBtn = document.getElementById("profileImageBtn");
  const profileImageRemoveBtn = document.getElementById("profileImageRemoveBtn");
  const accountSaveBtn = document.getElementById("accountSaveBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  if (profileImageBtn && profileImageInput) {
    profileImageBtn.onclick = () => profileImageInput.click();
  }

  if (profileImageInput) {
    profileImageInput.onchange = () => {
      const file = profileImageInput.files?.[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        alert("Max image size is 5MB.");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const username = currentUsername();
        const profile = loadProfile(username);
        profile.avatarDataUrl = String(reader.result || "");
        saveProfile(username, profile);
        applyAvatar(username);
      };
      reader.readAsDataURL(file);
    };
  }

  if (profileImageRemoveBtn) {
    profileImageRemoveBtn.onclick = () => {
      const username = currentUsername();
      const profile = loadProfile(username);
      delete profile.avatarDataUrl;
      saveProfile(username, profile);
      applyAvatar(username);
    };
  }

  if (accountSaveBtn) {
    accountSaveBtn.onclick = () => {
      const username = currentUsername();
      const profile = loadProfile(username);
      const firstEl = document.getElementById("accountFirstName");
      const lastEl = document.getElementById("accountLastName");
      const emailEl = document.getElementById("accountEmail");
      const phoneEl = document.getElementById("accountPhone");

      profile.firstName = firstEl?.value?.trim() || "";
      profile.lastName = lastEl?.value?.trim() || "";
      profile.email = emailEl?.value?.trim() || "";
      profile.phone = phoneEl?.value?.trim() || "";

      saveProfile(username, profile);
      alert("Saved.");
    };
  }


if (filesSelectAll) {
  filesSelectAll.onchange = () => {
    selectedFiles.clear();
    if (filesSelectAll.checked) {
      filesCache.forEach(f => f.storedFile && selectedFiles.add(f.storedFile));
    }
    renderFilesList(filesCache);
  };
}

if (filesDeleteSelected) {
  filesDeleteSelected.onclick = () => {
    if (!selectedFiles.size) return;
    if (!confirm(`Delete ${selectedFiles.size} files from server and remove from chats?`)) return;
    if (!requireWsOpen()) return alert("Not connected to server");
    accountWs.send(JSON.stringify({ type: "delete_files", storedFiles: Array.from(selectedFiles) }));
    selectedFiles.clear();
  };
}
  if (logoutBtn) {
    logoutBtn.onclick = () => {
      localStorage.removeItem("p2p_session");
      location.reload();
    };
  }

  window.addEventListener("online", () => {
    const saved = getSavedSession();
    if (saved) connectAccountSocket();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      const saved = getSavedSession();
      if (saved) connectAccountSocket();
    }
  });

  if (mobileBackBtn) {
    mobileBackBtn.onclick = () => {
      document.body.classList.remove("mobile-chat-active");
    };
  }

  // =====================
  // Sending Logic (Restored)
  // =====================
  const sendQueue = [];
  let processingQueue = false;
  const fileNotes = new WeakMap();

  async function processSendQueue() {
  if (processingQueue) return;
  processingQueue = true;

  try {
    while (sendQueue.length) {
      const file = sendQueue.shift();
      if (!file) continue;

      let currentIntentId = null;
      let success = false;
      const targetFriend = file._sendTarget || selectedFriend();

      sendUi.currentIndex += 1;
      updateSendProgress(file.name, 0, file.size || 0);

      isSending = true;
      if (sendBtn) sendBtn.disabled = true;

      try {
        awaitingIntentOk = false;
        awaitingUploadOk = false;

        const to = targetFriend;
        if (!to) {
          alert("Pick a friend to send to");
          throw new Error("No recipient");
        }

        if (!requireWsOpen()) {
          throw new Error("Server not connected");
        }

        const noteText = fileNotes.get(file) || "";

        accountWs.send(JSON.stringify({
          type: "send_intent",
          to,
          fileName: fileLabel(file) || file.name,
          fileSize: file.size,
          note: noteText
        }));

        log(`➡️ Sending intent for ${file.name}`);

        const intentId = await waitForIntentOk();
        if (!intentId) throw new Error("Intent not acknowledged");
        currentIntentId = intentId;
        // Let UI breathe before the upload loop starts
        await new Promise(r => setTimeout(r, 0));

        const isSelfChat = to === currentUsername();
        const pendingBubble = ensurePendingBubble({
          intentId,
          fileName: fileLabel(file) || file.name,
          fileSize: file.size,
          direction: isSelfChat ? "self" : "sent",
          note: noteText,
          friend: to
        });
        if (pendingBubble) pendingBubble.dataset.intentId = intentId;

        let lastUiUpdate = 0;

        await uploadFilesViaServer(intentId, [file], (sent, total) => {
          const now = performance.now();
          if (now - lastUiUpdate > 50) {
            updateSendProgress(file.name, sent, total);
            updateBubbleProgress(intentId, sent, total);
            lastUiUpdate = now;
          }
        });

        success = true;
        log(`✅ Send success: ${file.name}`);

      } catch (err) {
        log("❌ Send failed: " + (err?.message || err));
        awaitingIntentOk = false;
        awaitingUploadOk = false;
        isUploading = false;

      } finally {
        // 🔒 FINALIZE ONE FILE (ONLY ONCE)
        isSending = false;

        sendUi.completedBytes += file.size || 0;
        updateSendProgress(file.name, file.size || 0, file.size || 0);

        if (success) {
          // finalize pending bubble
          if (currentIntentId) {
            finalizePendingBubble(currentIntentId);
          } else if (pendingUploadIntentId) {
            finalizePendingBubble(pendingUploadIntentId);
          } else {
            const pendingBubble = document.querySelector(".msgRow.pending");
            if (pendingBubble) pendingBubble.classList.remove("pending");
          }

          // ✅ PERSIST CHAT HISTORY (CORRECT LOCATION)
          const savedIntentId = currentIntentId || pendingUploadIntentId || null;
          appendChatMessage(targetFriend, {
            id: crypto.randomUUID(),
            direction: targetFriend === currentUsername() ? "self" : "sent",
            fileName: file.name,
            fileSize: file.size,
            timestamp: Date.now(),
            note: fileNotes.get(file) || "",
            intentId: savedIntentId
          });

          bumpActivity(targetFriend);
          renderFriends();
        } else {
          markPendingFailed(currentIntentId || pendingUploadIntentId, "Failed");
        }


        // cleanup UI state
        toSendFiles = toSendFiles.filter((f) => !sameFile(f, file));
        renderToSend();
        renderSelectedFilesTray();

        if (toSendFiles.length === 0) {
          if (photoInput) photoInput.value = "";
          if (fileInput) fileInput.value = "";
        }

        updateSendButtonState();
      }
    }
  } finally {
    processingQueue = false;
    isSending = false;

    if (sendUi.active) {
      setSendUI("Sending complete", 100);
      setTimeout(() => resetSendUI(), 900);
    }

    updateSendButtonState();
  }
}


  if (sendBtn) {
    sendBtn.onclick = async () => {
      if (!toSendFiles.length) {
        alert("Choose files first");
        return;
      }

      if (!selectedFriend()) {
        alert("Please select a friend first.");
        return;
      }

      if (selectedFriend() === currentUsername()) {
        alert("You cannot send files to yourself.");
        return;
      }

      if (isDeletedFriend(selectedFriend())) {
        alert("This user deleted their account.");
        return;
      }

      const noteText = (chatNoteInput?.value || "").trim();

      sendQueue.length = 0;

      let batch = [...toSendFiles];

      const shouldPackage = (packageToggle?.checked && toSendFiles.length > 1) || folderPackageMode;
      if (shouldPackage) {
        if (!window.JSZip) {
          alert("Zip library missing.");
          return;
        }

        sendBtn.disabled = true;
        setSendUI(`Packaging ${toSendFiles.length} files...`, 0);

        const zip = new JSZip();
        const used = new Map();
        toSendFiles.forEach(file => {
          const label = fileLabel(file) || file.name;
          zip.file(label, file);
        });

        const zipBlob = await zip.generateAsync(
          { type: "blob" },
          (meta) => {
            const pct = Math.round(meta.percent || 0);
            setSendUI(`Packaging ${pct}%`, pct);
          }
        );

        const base = folderPackageMode ? folderPackageName : "package";
        const packageName = `${base}_${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
        const zipFile = new File([zipBlob], packageName, {
          type: "application/zip",
          lastModified: Date.now()
        });

        document.querySelectorAll(".msgRow.pending").forEach(b => b.remove());
        addMessageBubble({
          file: { name: zipFile.name, size: zipFile.size },
          direction: "sent",
          pending: true,
          note: noteText
        });

        batch = [zipFile];
        toSendFiles = [zipFile];
        folderPackageMode = false;
        folderPackageName = "";

        fileNotes.set(zipFile, noteText);
      }

      sendUi.active = true;
      sendUi.totalFiles = batch.length;
      sendUi.currentIndex = 0;
      sendUi.totalBytes = batch.reduce((sum, f) => sum + (f.size || 0), 0);
      sendUi.completedBytes = 0;
      setSendUI(`Sending file 1 of ${sendUi.totalFiles}`, 0);

      const targetFriend = selectedFriend();
      for (const file of batch) {
        fileNotes.set(file, noteText);
        file._sendTarget = targetFriend;
        sendQueue.push(file);
      }

      processSendQueue();

      if (chatNoteInput) chatNoteInput.value = "";
    };
  }

  // Initial UI state
  renderToSend();
  updateSendButtonState();

  setInterval(() => {
  document.querySelectorAll(".msgRow").forEach(bubble => {
    const ts = Number(bubble.dataset.timestamp);
    if (!ts) return;
    const label = bubble.querySelector(".messageTime");
    if (label) {
      label.textContent = relativeTime(ts);
    }
  });
}, 60_000); // every minute
});
