const API_BASE = "/api";
const TICK = "BUIDL";
const ACCOUNT_STORAGE_KEY = "accountInfo";
const BOND_ETH_MESSAGE = JSON.stringify(
  {
    project: "tagai",
    method: "bond-account"
  },
  null,
  4
);

// No demo/mock content: the UI must only ever show real data from tiptag-api.
const fallbackTweets = [];

let providers = [];
let activeProvider = null;
let connectedAddress = "";
let currentTweets = fallbackTweets;
let currentCommunity = null;
let currentIpshares = [];
let signalMode = "new";
let selectedMiniTag = null;
let miniTags = [];
let agentTab = "ipshare";
let currentCredits = [];
let currentEarnRows = [];
let bnbUsd = 650;
let currentTrades = [];
let currentAccount = null;
let hubRewardSeries = null;

const $ = (selector) => document.querySelector(selector);

function compactAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatNumber(value, fallback = "0") {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(number);
}

function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: number >= 100 ? 0 : 2
  }).format(number);
}

function safeText(value, fallback = "") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function profileImageUrl(account) {
  const profile = account?.profile || account?.avatar || account?.profileImg || "";
  return profile ? String(profile).replace("normal", "200x200") : "";
}

function displayName(account, fallback = "BUIDL Agent") {
  return safeText(account?.twitterName || account?.name || account?.twitterUsername, fallback);
}

function readJsonStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

const accountStore = {
  getAccount() {
    if (currentAccount) return currentAccount;
    currentAccount = readJsonStorage(ACCOUNT_STORAGE_KEY);
    return currentAccount;
  },
  setAccount(account, options = {}) {
    if (!account?.twitterId) return null;
    const shouldRefreshHub = options.refreshHub !== false;
    currentAccount = { ...(currentAccount || {}), ...account };
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(currentAccount));
    if (account.ethAddr) connectedAddress = account.ethAddr;
    renderAccountState();
    if (shouldRefreshHub && window.location.pathname === "/hub") loadHubData({ force: true });
    window.dispatchEvent(new CustomEvent("buidlai:account-changed", { detail: { account: currentAccount } }));
    return currentAccount;
  },
  patchAccount(patch, options = {}) {
    const account = this.getAccount();
    if (!account) return null;
    return this.setAccount({ ...account, ...patch }, options);
  },
  clear() {
    currentAccount = null;
    localStorage.removeItem(ACCOUNT_STORAGE_KEY);
    renderAccountState();
    if (window.location.pathname === "/hub") loadHubData({ force: true });
    window.dispatchEvent(new CustomEvent("buidlai:account-changed", { detail: { account: null } }));
  },
  isLoggedIn() {
    const account = this.getAccount();
    return Boolean(account?.twitterId && account?.accessToken);
  }
};

currentAccount = accountStore.getAccount();

function authHeaders(extra = {}) {
  const account = accountStore.getAccount();
  return account?.accessToken ? { ...extra, AccessToken: account.accessToken } : extra;
}

function unwrapApiPayload(payload) {
  if (payload?.jwt) accountStore.patchAccount({ accessToken: payload.jwt });
  if (payload?.success && "data" in payload) return payload.data;
  return payload;
}

async function readApiResponse(response) {
  // Don't trust the content-type header: tiptag-api sometimes returns a JSON body
  // with content-type text/html for cached responses under concurrency. Always try
  // to parse JSON first (else hub lists came back as raw strings → Array.isArray
  // false → credit/reputation read as 0, flickering correct↔wrong each load).
  const text = await response.text();
  if (!text) return text;
  try { return JSON.parse(text); } catch { return text; }
}

function apiErrorMessage(payload, fallback) {
  if (typeof payload === "string" && payload) return payload;
  if (payload?.error) return String(payload.error);
  if (payload?.message) return String(payload.message);
  return fallback;
}

function errorMessage(error, fallback) {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  return error.message || error.error || error.privyErrorCode || fallback;
}

async function apiGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });
  const response = await fetch(url, { headers: authHeaders() });
  const payload = await readApiResponse(response);
  if (!response.ok) throw new Error(apiErrorMessage(payload, `${response.status} ${response.statusText}`));
  return unwrapApiPayload(payload);
}

async function apiPost(path, body = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body)
  });
  const payload = await readApiResponse(response);
  if (!response.ok) throw new Error(apiErrorMessage(payload, `${response.status} ${response.statusText}`));
  return unwrapApiPayload(payload);
}

function renderTweets(tweets) {
  const feed = $("#tweetFeed");
  feed.innerHTML = "";
  const items = Array.isArray(tweets) && tweets.length ? tweets.slice(0, 5) : [];
  if (!items.length) {
    feed.innerHTML = `<article class="tweet"><p>暂无 #${TICK} 信号。</p></article>`;
    return;
  }
  items.forEach((tweet) => {
    const article = document.createElement("article");
    article.className = "tweet";
    article.innerHTML = `
      <header>
        <strong>${safeText(tweet.twitterName || tweet.twitterUsername, "BUIDL Agent")}</strong>
        <small>${formatNumber(tweet.amount || tweet.credit || 0)} signal</small>
      </header>
      <p>${safeText(tweet.content, "A new signal is waiting for validation.")}</p>
      <footer>reply ${tweet.replyCount || 0} · repost ${tweet.retweetCount || 0} · like ${tweet.likeCount || 0}</footer>
    `;
    feed.appendChild(article);
  });
}

function renderSignalFeed(tweets) {
  const feed = $("#signalFeed");
  if (!feed) return;
  // Restore Trending/New buttons if they were hidden by the graph view
  const feedMode = document.querySelector(".feed-mode");
  if (feedMode) feedMode.hidden = false;
  feed.innerHTML = "";
  const items = Array.isArray(tweets) && tweets.length ? tweets.slice(0, 30) : [];
  if (!items.length) {
    feed.innerHTML = `<div class="signal-empty">No BUIDL signals found.</div>`;
    return;
  }

  items.forEach((tweet) => {
    // Determine tag label: use selected mini tag, or extract $CASHTAG from content, fallback to TICK
    let tagLabel = selectedMiniTag?.name || selectedMiniTag?.tag || "";
    if (!tagLabel) {
      const cashtagMatch = String(tweet.content || "").match(/\$([A-Za-z][A-Za-z0-9_]*)/);
      tagLabel = cashtagMatch ? cashtagMatch[1] : (tweet.tags || tweet.tick || TICK);
    }
    const score = Number(tweet.amount || tweet.credit || tweet.curateAmount || 0);
    const profileImg = getProfileImage(tweet);
    const card = document.createElement("article");
    card.className = "signal-post-card";
    card.innerHTML = `
      <div class="signal-avatar">${profileImg ? `<img src="${profileImg}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : ""}</div>
      <div class="signal-post-main">
        <header>
          <strong>${safeText(tweet.twitterName || tweet.twitterUsername, "BUIDL Agent")}</strong>
          <small>@${safeText(tweet.twitterUsername, "agent")} · ${formatSignalTime(tweet.tweetTime)}</small>
        </header>
        <p>${safeText(tweet.content, "A BUIDL signal is waiting for validation.")}</p>
        <span class="signal-mini-tag">#${safeText(tagLabel, TICK)}</span>
        <footer class="signal-actions">
          <span>☵ ${tweet.replyCount || 0}</span>
          <span>↻ ${tweet.retweetCount || 0}</span>
          <span>✎ ${tweet.quoteCount || 0}</span>
          <span>⇧ ${tweet.curateCount || 0}</span>
          <span>♨ ${tweet.likeCount || 0}</span>
        </footer>
      </div>
      <div class="signal-score">${formatNumber(score || 0)}${score ? "" : " VP"}</div>
    `;
    feed.appendChild(card);
  });
}

function formatSignalTime(value) {
  if (!value) return "now";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "recent";
  const diff = Date.now() - time.getTime();
  const minutes = Math.max(1, Math.floor(diff / 60000));
  if (minutes < 60) return `${minutes} mins ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function renderMiniTags() {
  const bar = $("#miniTagBar");
  if (!bar) return;
  const items = miniTags.length ? miniTags : [];
  bar.innerHTML = "";

  // "All" button — shows all #BUIDL community tweets
  const allButton = document.createElement("button");
  allButton.type = "button";
  allButton.className = "mini-tag-button";
  allButton.classList.toggle("is-active", !selectedMiniTag);
  allButton.textContent = "All";
  allButton.addEventListener("click", () => {
    selectedMiniTag = null;
    renderMiniTags();
    if ($("#signalGraphCanvas")) loadAndDrawSignalGraph();
    else loadSignalFeed();
  });
  bar.appendChild(allButton);

  items.forEach((tag, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mini-tag-button";
    button.classList.toggle("is-active", (selectedMiniTag?.id || selectedMiniTag?.name) === (tag.id || tag.name));
    button.textContent = tag.name || tag.tag || tag.tick || `Tag ${index + 1}`;
    button.addEventListener("click", () => {
      selectedMiniTag = tag;
      renderMiniTags();
      if ($("#signalGraphCanvas")) loadAndDrawSignalGraph();
      else loadSignalFeed();
    });
    bar.appendChild(button);
  });
}

function getProfileImage(row) {
  if (!row?.profile) return "";
  return String(row.profile).replace("normal", "200x200");
}

function calculateIPsharePriceLocal(supply) {
  let parsed = Number.parseFloat(String(supply ?? 0));
  if (!Number.isFinite(parsed)) return 0;
  // Normalize from wei if needed
  if (parsed > 1e12) parsed = parsed / 1e18;
  return (parsed * parsed) / 100000;
}

function normalizeAgent(row = {}) {
  const rawSupply = Number(row.supply || row.shareSupply || 0);
  const supply = rawSupply > 1e12 ? rawSupply / 1e18 : rawSupply;
  const priceUsd = calculateIPsharePriceLocal(supply) * bnbUsd;
  const username = row.twitterUsername || row.username || "agent";
  return {
    id: row.twitterId || row.ethAddr || username,
    name: row.twitterName || row.name || username || "BUIDL Agent",
    username,
    profile: getProfileImage(row),
    ethAddr: row.ethAddr,
    supply,
    priceUsd,
    credit: Number(row.credit || 0),
    earn: Number(row.earn || row.amount || row.authorAmount || row.curateAmount || 0)
  };
}

function mergeAgentFacts(baseRows = [], creditRows = [], earnRows = []) {
  const map = new Map();
  const put = (row) => {
    const agent = normalizeAgent(row);
    const key = String(agent.ethAddr || agent.username || agent.id).toLowerCase();
    map.set(key, { ...(map.get(key) || {}), ...agent });
  };
  baseRows.forEach(put);
  creditRows.forEach((row) => {
    const key = String(row.ethAddr || row.twitterUsername || row.twitterId).toLowerCase();
    const existing = map.get(key) || { supply: 0, priceUsd: 0, earn: 0 };
    // Only merge identity fields from credit row, don't overwrite supply/price
    const identity = {
      id: row.twitterId || row.ethAddr || row.twitterUsername,
      name: row.twitterName || row.name || row.twitterUsername || existing.name,
      username: row.twitterUsername || existing.username,
      profile: getProfileImage(row) || existing.profile,
      ethAddr: row.ethAddr || existing.ethAddr
    };
    map.set(key, { ...existing, ...identity, credit: Number(row.credit || existing.credit || 0) });
  });
  earnRows.forEach((row) => {
    const key = String(row.ethAddr || row.twitterUsername || row.twitterId).toLowerCase();
    const existing = map.get(key) || { supply: 0, priceUsd: 0, credit: 0 };
    const identity = {
      id: row.twitterId || row.ethAddr || row.twitterUsername,
      name: row.twitterName || row.name || row.twitterUsername || existing.name,
      username: row.twitterUsername || existing.username,
      profile: getProfileImage(row) || existing.profile,
      ethAddr: row.ethAddr || existing.ethAddr
    };
    map.set(key, { ...existing, ...identity, earn: Number(row.earn || existing.earn || 0) });
  });
  return Array.from(map.values());
}

function aggregateEarnRows(tweets = []) {
  const map = new Map();
  tweets.forEach((tweet) => {
    const key = String(tweet.ethAddr || tweet.twitterUsername || tweet.twitterId || "unknown").toLowerCase();
    const previous = map.get(key) || {
      twitterId: tweet.twitterId,
      twitterName: tweet.twitterName,
      twitterUsername: tweet.twitterUsername,
      ethAddr: tweet.ethAddr,
      profile: tweet.profile,
      earn: 0,
      credit: tweet.credit || 0
    };
    previous.earn += Number(tweet.authorAmount || tweet.curateAmount || tweet.amount || 0);
    previous.credit = Math.max(Number(previous.credit || 0), Number(tweet.credit || 0));
    map.set(key, previous);
  });
  return Array.from(map.values()).sort((a, b) => Number(b.earn || 0) - Number(a.earn || 0));
}

function renderAgentsList() {
  const list = $("#agentsList");
  if (!list) return;
  const merged = mergeAgentFacts(currentIpshares, currentCredits, currentEarnRows);
  let rows = merged;
  if (agentTab === "credit") {
    rows = merged.slice().sort((a, b) => Number(b.credit || 0) - Number(a.credit || 0));
  } else if (agentTab === "earn") {
    rows = merged.slice().sort((a, b) => Number(b.earn || 0) - Number(a.earn || 0));
  } else {
    rows = merged.slice().sort((a, b) => Number(b.supply || 0) - Number(a.supply || 0));
  }

  rows = rows.slice(0, 20);
  if (!rows.length) {
    list.innerHTML = `<div class="agent-empty">No AI Agents found.</div>`;
    return;
  }

  list.innerHTML = "";
  rows.forEach((agent) => {
    const row = document.createElement("article");
    row.className = "agent-row";
    const mainMetric =
      agentTab === "credit"
        ? `<strong>${formatNumber(agent.credit)}</strong><small>Credit</small>`
        : agentTab === "earn"
          ? `<strong>${formatNumber(agent.earn)}</strong><small>Earn</small>`
          : `<strong>${formatUsd(agent.priceUsd)} / ${formatNumber(agent.supply)}</strong><small>Price / Supply</small>`;
    const action = agentTab === "credit" ? "Boost" : agentTab === "earn" ? "Tip" : "Trade";
    row.innerHTML = `
      <div class="agent-avatar">${agent.profile ? `<img src="${agent.profile}" alt="">` : ""}</div>
      <div class="agent-main">
        <div class="agent-name-line"><strong>${safeText(agent.name, "BUIDL Agent")}</strong><span>@${safeText(agent.username, "agent")}</span></div>
        <div class="agent-subline">
          <span>IPShare · ${formatUsd(agent.priceUsd)}</span>
          <span>Credit · ${formatNumber(agent.credit)}</span>
          <span>Earn ${formatNumber(agent.earn)} $BUIDL</span>
        </div>
      </div>
      <div class="agent-value">${mainMetric}</div>
      <button class="agent-action" type="button" data-action="${action}" data-agent-eth="${safeText(agent.ethAddr)}" data-agent-username="${safeText(agent.username)}" data-agent-supply="${agent.supply || 0}">${action}</button>
    `;
    // Attach action handler
    const btn = row.querySelector(".agent-action");
    btn.addEventListener("click", () => handleAgentAction(action, agent));
    list.appendChild(row);
  });
}

function handleAgentAction(action, agent) {
  if (action === "Trade") {
    openAgentTradeModal(agent);
  } else if (action === "Tip") {
    openAgentTipModal(agent);
  } else if (action === "Boost") {
    openAgentBoostModal(agent);
  }
}

function openAgentTradeModal(agent) {
  // Reuse the IPShare trade modal but target this agent's ethAddr
  const subject = agent.ethAddr || "";
  if (!subject) {
    alert("该用户未绑定钱包地址，无法交易 IPShare。");
    return;
  }
  window._hubIpshareContext = {
    supply: agent.supply || 0,
    subject,
    pricePerShare: ipsharePriceLocal(agent.supply || 0)
  };
  openTradeModal();
}

function openAgentTipModal(agent) {
  const account = accountStore.getAccount();
  if (!account?.twitterId || !account?.accessToken) {
    alert("请先登录后再进行 Tip 操作。");
    return;
  }
  const username = agent.username || "";
  if (!username) {
    alert("该用户无 Twitter 用户名，无法 Tip。");
    return;
  }
  const amount = prompt(`Tip $BUIDL 给 @${username}\n\n请输入数量：`, "100");
  if (!amount || Number(amount) <= 0) return;
  tipAgent(account.twitterId, username, Number(amount));
}

async function tipAgent(twitterId, targetUsername, amount) {
  try {
    await apiPost("/twitterTip/tipToUser", {
      twitterId,
      targetTwitterUsername: targetUsername,
      tick: TICK,
      amount
    });
    alert(`成功 Tip ${formatNumber(amount)} $BUIDL 给 @${targetUsername}`);
  } catch (error) {
    alert(`Tip 失败: ${errorMessage(error, "请检查余额或网络")}`);
  }
}

function openAgentBoostModal(agent) {
  // Boost = buy $BUIDL token. Open a buy dialog.
  const account = accountStore.getAccount();
  if (!account?.twitterId || !account?.accessToken) {
    alert("请先登录后再进行 Boost 操作。");
    return;
  }
  if (!activeProvider || !connectedAddress) {
    alert("请先连接 OKX / MetaMask 钱包。");
    return;
  }
  // Use PancakeSwap for the actual buy — open the swap URL with the BUIDL token
  const buidlToken = currentCommunity?.token || "";
  if (buidlToken) {
    const swapUrl = `https://pancakeswap.finance/swap?outputCurrency=${buidlToken}&chain=bsc`;
    const confirmed = confirm(`将打开 PancakeSwap 购买 $BUIDL 代币。\n\n代币合约: ${compactAddress(buidlToken)}\n\n确认打开？`);
    if (confirmed) window.open(swapUrl, "_blank");
  } else {
    alert("$BUIDL 代币合约地址未获取，请稍后重试。");
  }
}

function renderMiniFeed(selector, tweets, mode = "signal") {
  const feed = $(selector);
  if (!feed) return;
  feed.innerHTML = "";
  const items = Array.isArray(tweets) && tweets.length ? tweets.slice(0, 4) : [];
  if (!items.length) {
    feed.innerHTML = `<article class="mini-post"><strong>No BUIDL ${mode === "vote" ? "validation" : "signals"} yet</strong><p>这里将显示当前登录用户在 #BUIDL 社区的${mode === "vote" ? "互动、点赞、评论和验证投票" : "发帖"}。</p><footer>#${TICK}</footer></article>`;
    return;
  }
  items.forEach((tweet) => {
    const post = document.createElement("article");
    post.className = "mini-post";
    const score = mode === "vote" ? Number(tweet.amount || tweet.credit || 0) / 100 : Number(tweet.amount || tweet.credit || 0);
    post.innerHTML = `
      <strong>${safeText(tweet.twitterName || tweet.twitterUsername, "BUIDL Agent")}</strong>
      <p>${safeText(tweet.content, "A BUIDL signal is waiting for validation.").slice(0, 138)}</p>
      <footer>${mode === "vote" ? "VP" : "Signal"} ${formatNumber(score)} · reply ${tweet.replyCount || 0} · like ${tweet.likeCount || 0}</footer>
    `;
    feed.appendChild(post);
  });
}

function applyCommunityData(community) {
  if (!community || typeof community !== "object") return;
  currentCommunity = community;
  $("#activeTick").textContent = community.tick || TICK;
  const marketCap = Number(community.marketCap || community.mCap || 0);
  if (marketCap > 0) {
    $("#buidlStaked").textContent = formatNumber(marketCap);
    $("#stakedCount").textContent = `${formatNumber(marketCap / 1000000)}M`;
  }
}

function applyIpshareData(ipshares) {
  if (!Array.isArray(ipshares)) return;
  currentIpshares = ipshares;
  $("#agentsCount").textContent = formatNumber(ipshares.length);
  const totalSupply = ipshares.reduce((sum, row) => {
    const raw = Number(row.supply || row.shareSupply || 0);
    return sum + (raw > 1e12 ? raw / 1e18 : raw);
  }, 0);
  if (totalSupply > 0) $("#creditIssued").textContent = formatNumber(totalSupply);
}

let _hubLoadInFlight = false;
let _hubLastLoadAt = 0;

async function loadBuidlData() {
  const state = $("#apiState");
  try {
    const [community, tweets, ipshares, ethPrice] = await Promise.all([
      apiGet("/community/detail", { tick: TICK }),
      apiGet("/curation/communityTweets", { tick: TICK, pages: 0 }),
      apiGet("/ipshare/list", { pages: 0 }),
      apiGet("/tiptag/getETHPrice").catch(() => bnbUsd)
    ]);
    bnbUsd = Number(ethPrice) || bnbUsd;
    applyCommunityData(community);
    applyIpshareData(ipshares);
    currentTweets = Array.isArray(tweets) && tweets.length ? tweets : [];
    renderTweets(currentTweets);
    // Note: do NOT re-trigger loadHubData here. renderRoute("/hub") is the single
    // authoritative hub trigger, and the hub fetches its own community/detail. A
    // second batch here raced the first and overwrote good data with degraded
    // responses (credit/reputation flickering correct↔wrong each load).
    const tweetList = Array.isArray(tweets) ? tweets : [];
    const tweetCount = tweetList.length;
    $("#signalCount").textContent = formatNumber(tweetCount || 0);
    $("#signalPosts").textContent = formatNumber(tweetCount || 0);
    // Connections = total verifiable interactions across community signals
    const connections = tweetList.reduce((sum, t) =>
      sum + Number(t.replyCount || 0) + Number(t.retweetCount || 0) + Number(t.likeCount || 0) + Number(t.quoteCount || 0), 0);
    $("#connectCount").textContent = formatNumber(connections);
    state.textContent = "live";
  } catch (error) {
    currentTweets = [];
    renderTweets(currentTweets);
    state.textContent = "offline";
  }
}

function registerInjectedProviders() {
  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = event.detail;
    if (!detail?.provider || providers.some((item) => item.info.uuid === detail.info.uuid)) return;
    providers.push(detail);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  setTimeout(() => {
    const injected = window.ethereum;
    if (injected && !providers.some((item) => item.provider === injected)) {
      const name = injected.isOkxWallet || injected.isOKExWallet || injected.isOKX ? "OKX Wallet" : injected.isMetaMask ? "MetaMask" : "Browser Wallet";
      providers.push({
        provider: injected,
        info: { name, uuid: name.toLowerCase().replace(/\s+/g, "-") }
      });
    }
  }, 300);
}

function renderWalletMenu() {
  const menu = $("#walletMenu");
  menu.innerHTML = "";
  const account = accountStore.getAccount();
  if (account) {
    const profile = profileImageUrl(account);
    const summary = document.createElement("div");
    summary.className = "wallet-account-preview";
    summary.innerHTML = `
      <div class="account-avatar small">${profile ? `<img src="${profile}" alt="">` : `<span>${displayName(account).slice(0, 1)}</span>`}</div>
      <div>
        <strong>${displayName(account)}</strong>
        <small>@${safeText(account.twitterUsername, account.twitterId)}</small>
      </div>
    `;
    menu.appendChild(summary);
  }
  const accountButton = document.createElement("button");
  accountButton.className = "wallet-option";
  accountButton.type = "button";
  accountButton.innerHTML = `<span>${account ? "登录状态" : "TagAI Account"}</span><small>${account ? "manage" : "login"}</small>`;
  accountButton.addEventListener("click", () => {
    menu.hidden = true;
    openAccountModal();
  });
  menu.appendChild(accountButton);

  if (account) {
    const logoutButton = document.createElement("button");
    logoutButton.className = "wallet-option";
    logoutButton.type = "button";
    logoutButton.innerHTML = `<span>退出登录</span><small>logout</small>`;
    logoutButton.addEventListener("click", async () => {
      menu.hidden = true;
      await logoutAccount();
    });
    menu.appendChild(logoutButton);
  }

  const preferred = providers
    .filter((item) => /okx|metamask/i.test(item.info.name))
    .concat(providers.filter((item) => !/okx|metamask/i.test(item.info.name)));

  if (!preferred.length) {
    const empty = document.createElement("div");
    empty.className = "wallet-option";
    empty.innerHTML = `<span>未检测到钱包</span><small>安装 OKX / MetaMask</small>`;
    menu.appendChild(empty);
    return;
  }

  preferred.forEach((item) => {
    const button = document.createElement("button");
    button.className = "wallet-option";
    button.type = "button";
    button.innerHTML = `<span>${item.info.name}</span><small>${accountStore.isLoggedIn() ? "bond" : "connect"}</small>`;
    button.addEventListener("click", () => connectWallet(item));
    menu.appendChild(button);
  });
}

async function connectWallet(providerDetail) {
  activeProvider = providerDetail.provider;
  try {
    const accounts = await activeProvider.request({ method: "eth_requestAccounts" });
    connectedAddress = accounts?.[0] || "";
    $("#walletAddress").textContent = connectedAddress ? `${providerDetail.info.name} · ${compactAddress(connectedAddress)}` : "id name   address";
    $("#walletMenu").hidden = true;
    renderAccountState();
    if (accountStore.isLoggedIn()) await bondConnectedWallet();
    activeProvider.on?.("accountsChanged", (nextAccounts) => {
      connectedAddress = nextAccounts?.[0] || "";
      $("#walletAddress").textContent = connectedAddress ? compactAddress(connectedAddress) : "id name   address";
      renderAccountState();
    });
  } catch (error) {
    renderAccountState();
  }
}

async function bondConnectedWallet() {
  const account = accountStore.getAccount();
  if (!account?.twitterId) return setAccountStatus("请先使用 TagAI / Privy 登录。");
  if (!activeProvider || !connectedAddress) return setAccountStatus("请先选择 OKX 或 MetaMask 钱包。");
  try {
    const signature = await activeProvider.request({
      method: "personal_sign",
      params: [BOND_ETH_MESSAGE, connectedAddress]
    });
    await apiPost("/user/bondEth", {
      ethAddr: connectedAddress,
      twitterId: account.twitterId,
      signature,
      infoStr: BOND_ETH_MESSAGE
    });
    accountStore.patchAccount({ ethAddr: connectedAddress, walletType: 1 });
    setAccountStatus("钱包已按 TagAI bondEth 流程绑定。");
  } catch (error) {
    setAccountStatus("钱包绑定失败，请确认签名或重新连接。");
  }
}

function setupRouter() {
  document.querySelectorAll("[data-route]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const route = link.getAttribute("data-route") || "/";
      navigate(route);
    });
  });

  window.addEventListener("popstate", () => renderRoute(window.location.pathname));
  renderRoute(window.location.pathname);
}

function navigate(route) {
  history.pushState({}, "", route);
  renderRoute(route);
}

function renderRoute(route) {
  const isHub = route === "/hub";
  const isSignal = route === "/signal";
  const isAgents = route === "/agents";
  const isEconomy = route === "/economy";
  $("#homeView").hidden = isHub || isSignal || isAgents || isEconomy;
  $("#hubView").hidden = !isHub;
  $("#signalView").hidden = !isSignal;
  $("#agentsView").hidden = !isAgents;
  $("#economyView").hidden = !isEconomy;
  document.querySelectorAll(".nav-links a").forEach((link) => {
    link.classList.toggle("is-active", link.getAttribute("data-route") === route);
  });
  if (isHub) {
    loadHubData({ force: true });
    requestAnimationFrame(() => {
      drawReputation();
      drawRewardChart();
    });
  }
  if (isSignal) {
    loadSignalPage();
  }
  if (isAgents) {
    loadAgentsPage();
  }
  if (isEconomy) {
    loadEconomyPage();
    setupEconomyTrade();
  }
}

function setupSignalControls() {
  $("#signalTrendingButton")?.addEventListener("click", () => {
    signalMode = "trending";
    $("#signalTrendingButton").classList.add("is-active");
    $("#signalNewButton").classList.remove("is-active");
    selectedMiniTag = null;
    renderMiniTags();
    loadSignalFeed();
  });
  $("#signalNewButton")?.addEventListener("click", () => {
    signalMode = "new";
    $("#signalNewButton").classList.add("is-active");
    $("#signalTrendingButton").classList.remove("is-active");
    selectedMiniTag = null;
    renderMiniTags();
    loadSignalFeed();
  });
  $("#openPostCurate")?.addEventListener("click", () => {
    $("#openPostCurate").classList.add("is-active");
    $("#openPrediction").classList.remove("is-active");
    $("#openBlinks").classList.remove("is-active");
    const feedMode = document.querySelector(".feed-mode");
    if (feedMode) feedMode.hidden = false;
    const tagBar = document.querySelector(".signal-toolbar");
    if (tagBar) tagBar.hidden = false;
    loadSignalFeed();
  });
  $("#openBlinks")?.addEventListener("click", () => {
    $("#openBlinks").classList.add("is-active");
    $("#openPostCurate").classList.remove("is-active");
    $("#openPrediction").classList.remove("is-active");
    const feedMode = document.querySelector(".feed-mode");
    if (feedMode) feedMode.hidden = true;
    const tagBar = document.querySelector(".signal-toolbar");
    if (tagBar) tagBar.hidden = true;
    loadBlinksPage();
  });
  $("#openPrediction")?.addEventListener("click", () => {
    $("#openPrediction").classList.add("is-active");
    $("#openPostCurate").classList.remove("is-active");
    $("#openBlinks").classList.remove("is-active");
    const feedMode = document.querySelector(".feed-mode");
    if (feedMode) feedMode.hidden = true;
    const tagBar = document.querySelector(".signal-toolbar");
    if (tagBar) tagBar.hidden = true;
    $("#signalFeed").innerHTML = `<div class="prediction-page"><div class="prediction-tabs"><button class="prediction-tab is-active" data-pred-tab="battle">Battle</button><button class="prediction-tab" data-pred-tab="event">Event</button></div><div id="predictionList" class="prediction-list">Loading...</div></div>`;
    setupPredictionTabs();
    loadPredictionData("battle");
  });
  $("#openSignalGraph")?.addEventListener("click", () => {
    $("#openPostCurate").classList.remove("is-active");
    $("#openPrediction").classList.remove("is-active");
    $("#openBlinks").classList.remove("is-active");
    const tagBar = document.querySelector(".signal-toolbar");
    if (tagBar) tagBar.hidden = true;
    $("#signalFeed").innerHTML = `<div class="panel network-map"><div class="panel-header"><span>Social Signal Graph · #BUIDL</span><strong id="graphStatus">loading...</strong></div><canvas id="signalGraphCanvas" width="1200" height="600"></canvas></div>`;
    const feedMode = document.querySelector(".feed-mode");
    if (feedMode) feedMode.hidden = true;
    loadAndDrawSignalGraph();
  });
}

function setupAgentsControls() {
  document.querySelectorAll("[data-agent-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      agentTab = button.getAttribute("data-agent-tab") || "ipshare";
      document.querySelectorAll("[data-agent-tab]").forEach((tab) => {
        tab.classList.toggle("is-active", tab === button);
      });
      renderAgentsList();
      loadAgentsPage(false);
    });
  });
}

async function loadAgentsPage(refresh = true) {
  renderAgentsList();
  if (!refresh && currentCredits.length && currentEarnRows.length && currentIpshares.length) return;
  try {
    const [ipshares, credits, tweets, ethPrice, community] = await Promise.all([
      apiGet("/ipshare/list", { pages: 0 }).catch(() => currentIpshares),
      apiGet("/community/communityCredits", { tick: TICK, pages: 0 }).catch(() => currentCredits),
      apiGet("/curation/communityTweets", { tick: TICK, pages: 0 }).catch(() => currentTweets),
      apiGet("/tiptag/getETHPrice").catch(() => bnbUsd),
      apiGet("/community/detail", { tick: TICK }).catch(() => currentCommunity)
    ]);
    bnbUsd = Number(ethPrice) || bnbUsd;
    if (community && typeof community === "object") currentCommunity = community;
    currentIpshares = Array.isArray(ipshares) ? ipshares : currentIpshares;
    currentCredits = Array.isArray(credits) ? credits : currentCredits;
    currentTweets = Array.isArray(tweets) && tweets.length ? tweets : currentTweets;
    currentEarnRows = aggregateEarnRows(currentTweets);
    renderAgentsList();
  } catch {
    renderAgentsList();
  }
}

function getDistributionRows() {
  if (!currentCommunity?.distribution) return [];
  try {
    const rows = typeof currentCommunity.distribution === "string" ? JSON.parse(currentCommunity.distribution) : currentCommunity.distribution;
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function getRewardPerDay() {
  const rows = getDistributionRows();
  if (!rows.length) return 0;
  const now = Math.ceil(Date.now() / 1000);
  const current = rows.find((row) => Number(row.start) <= now && Number(row.end) >= now) || rows[0];
  return Math.ceil(Number(current?.amount || 0) * 86400);
}

function getTotalDistribution() {
  return getDistributionRows().reduce((sum, row) => {
    const duration = Math.max(0, Number(row.end || 0) - Number(row.start || 0));
    return sum + Number(row.amount || 0) * duration;
  }, 0);
}

function uniqueCount(rows, keyGetter) {
  return new Set(rows.map(keyGetter).filter(Boolean)).size;
}

async function loadEconomyPage() {
  try {
    const [community, tweets, trending, ipshares, credits, trades, ethPrice] = await Promise.all([
      apiGet("/community/detail", { tick: TICK }).catch(() => currentCommunity),
      apiGet("/curation/communityTweets", { tick: TICK, pages: 0 }).catch(() => currentTweets),
      apiGet("/curation/communityTrendingTweets", { tick: TICK, pages: 0 }).catch(() => []),
      apiGet("/ipshare/list", { pages: 0 }).catch(() => currentIpshares),
      apiGet("/community/communityCredits", { tick: TICK, pages: 0 }).catch(() => currentCredits),
      apiGet("/community/getTokenTradeData", { tick: TICK, isNew: true }).catch(() => currentTrades),
      apiGet("/tiptag/getETHPrice").catch(() => bnbUsd)
    ]);
    currentCommunity = community || currentCommunity;
    currentTweets = Array.isArray(tweets) && tweets.length ? tweets : currentTweets;
    currentIpshares = Array.isArray(ipshares) ? ipshares : currentIpshares;
    currentCredits = Array.isArray(credits) ? credits : currentCredits;
    currentTrades = Array.isArray(trades) ? trades : currentTrades;
    bnbUsd = Number(ethPrice) || bnbUsd;
    renderEconomyPreview({ trending });
  } catch {
    renderEconomyPreview();
  }
}

function renderEconomyPreview(extra = {}) {
  const tweets = currentTweets || [];
  const trending = Array.isArray(extra.trending) ? extra.trending : [];
  const allTweets = tweets.concat(trending);

  // Real data: agents with accountType containing "ai" or "agent"
  const aiAgents = currentCredits.filter((row) => {
    const id = String(row.twitterId || "");
    const username = String(row.twitterUsername || "").toLowerCase();
    return id.startsWith("agent_") || username.includes("bot") || username.includes("agent") || username.includes("ai");
  });

  // Signal miners = unique users who posted in #BUIDL
  const signalMiners = uniqueCount(tweets, (row) => row.twitterId || row.twitterUsername || row.ethAddr);

  // Social miners = unique users who interacted (posted + interacted based on presence in credits)
  const socialMiners = currentCredits.length || uniqueCount(allTweets, (row) => row.twitterId || row.twitterUsername || row.ethAddr);

  // Total knowledge = posts + total interactions (likes + replies + retweets + quotes)
  const totalInteractions = tweets.reduce((sum, t) => sum + Number(t.likeCount || 0) + Number(t.replyCount || 0) + Number(t.retweetCount || 0) + Number(t.quoteCount || 0), 0);
  const knowledge = tweets.length + totalInteractions + tweets.filter((t) => t.commerceId || t.buyCount).length;

  // Distribution / rewards
  const distributed = getTotalDistribution() || Number(currentCommunity?.totalClaimedSocialRewards || 0);

  // Volume from trade data (in BNB → USD)
  const volume = currentTrades.reduce((sum, row) => {
    const high = Number(row.high || 0) / 1e9;
    const low = Number(row.low || 0) / 1e9;
    return sum + Math.abs(high - low) * bnbUsd;
  }, 0);

  // Format volume with unit
  function formatVolume(v) {
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M USD`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K USD`;
    return `${formatNumber(v)} USD`;
  }

  $("#ecoAgentCount").textContent = formatNumber(aiAgents.length || 0);
  $("#ecoSignalMiners").textContent = formatNumber(signalMiners);
  $("#ecoGameMiners").textContent = "0";
  $("#ecoSocialMiners").textContent = formatNumber(socialMiners);
  $("#ecoVolume").textContent = formatVolume(volume);
  $("#ecoDistributed").textContent = formatNumber(distributed);
  $("#ecoStaked").textContent = "0";
  $("#ecoKnowledge").textContent = formatNumber(knowledge);

  const mcapBnb = Number(currentCommunity?.marketCap || 0);
  $("#ecoBuidlPrice").textContent = `${formatNumber(mcapBnb * bnbUsd)} USDT`;

  drawTradeCanvas();
  drawMiningRewardCanvas();
  drawStakeChangeCanvas();
  drawMiniNetworks();
}

function drawTradeCanvas() {
  const canvas = $("#buidlTradeCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);

  if (!currentTrades.length) {
    ctx.fillStyle = "#999";
    ctx.font = "14px system-ui";
    ctx.fillText("Loading trade data...", w / 2 - 60, h / 2);
    return;
  }

  // Grid lines
  ctx.strokeStyle = "#e8e8e8";
  ctx.lineWidth = 1;
  for (let y = 34; y < h - 42; y += 42) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Trade data: OHLC values in 1e9 units (BNB market cap). Convert to USD.
  const rows = currentTrades.slice(-60);
  const converted = rows.map((row) => ({
    open: Number(row.open || 0) / 1e9 * bnbUsd,
    close: Number(row.close || 0) / 1e9 * bnbUsd,
    high: Number(row.high || 0) / 1e9 * bnbUsd,
    low: Number(row.low || 0) / 1e9 * bnbUsd,
    timestamp: Number(row.timestamp || 0)
  }));

  const max = Math.max(...converted.map((r) => r.high));
  const min = Math.min(...converted.map((r) => r.low));
  const range = Math.max(1, max - min);
  const yOf = (value) => 28 + (1 - (value - min) / range) * (h - 80);
  const gap = w / converted.length;

  // Y-axis labels
  ctx.fillStyle = "#999";
  ctx.font = "10px system-ui";
  for (let i = 0; i <= 4; i++) {
    const val = min + (range * i) / 4;
    const y = yOf(val);
    ctx.fillText(`$${formatNumber(val)}`, 4, y - 2);
  }

  // Candles
  converted.forEach((row, index) => {
    const x = index * gap + gap / 2;
    const up = row.close >= row.open;
    ctx.strokeStyle = up ? "#00a88a" : "#ff4054";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(x, yOf(row.high));
    ctx.lineTo(x, yOf(row.low));
    ctx.stroke();
    const top = yOf(Math.max(row.open, row.close));
    const bottom = yOf(Math.min(row.open, row.close));
    ctx.fillRect(x - Math.max(3, gap * 0.28), top, Math.max(6, gap * 0.56), Math.max(2, bottom - top));
  });

  // Header info
  const latest = converted.at(-1);
  const priceText = latest ? `$${formatNumber(latest.close)}` : "";
  const change = latest && converted.length > 1 ? ((latest.close - converted[0].close) / Math.max(1, converted[0].close) * 100).toFixed(2) : "0";
  ctx.fillStyle = Number(change) >= 0 ? "#00a88a" : "#ff4054";
  ctx.font = "bold 14px system-ui";
  ctx.fillText(`BUIDL/USD MCap ${priceText} (${Number(change) >= 0 ? "+" : ""}${change}%)`, 12, 18);
}

function drawBarChart(canvas, values, options = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#fbf8ef";
  ctx.fillRect(0, 0, w, h);

  const max = Math.max(...values, 1);
  const leftMargin = 60;

  // Y-axis grid lines with labels
  ctx.strokeStyle = "#e4dfd3";
  ctx.setLineDash([2, 8]);
  ctx.fillStyle = "#999";
  ctx.font = "10px monospace";
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const val = (max * i) / steps;
    const y = 24 + ((steps - i) / steps) * (h - 70);
    ctx.beginPath();
    ctx.moveTo(leftMargin, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillText(formatNumber(val), 4, y + 3);
  }
  ctx.setLineDash([]);

  // Bars
  const barWidth = (w - leftMargin) / values.length;
  values.forEach((value, index) => {
    const height = (value / max) * (h - 70);
    ctx.fillStyle = options.highlight && index > values.length - 6 ? "#53664e" : "#aeb5a6";
    ctx.fillRect(leftMargin + index * barWidth + 4, h - height - 32, Math.max(8, barWidth - 8), height);
  });

  // Footer
  ctx.fillStyle = "#625d54";
  ctx.font = "12px monospace";
  ctx.fillText(options.footer || "", leftMargin, h - 9);
}

function drawMiningRewardCanvas() {
  const reward = getRewardPerDay() || 4700000;
  const rows = getDistributionRows();
  const values = (rows.length ? rows.slice(-12).map((row) => Number(row.amount || 0) * 86400) : Array.from({ length: 12 }, (_, i) => reward * (0.75 + (i % 5) * 0.06)));
  drawBarChart($("#miningRewardCanvas"), values, { footer: `Highest ${formatNumber(Math.max(...values))} · Latest ${formatNumber(values.at(-1) || reward)} · Reward per day` });
}

function drawStakeChangeCanvas() {
  const canvas = $("#stakeChangeCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#fbf8ef";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#999";
  ctx.font = "14px system-ui";
  ctx.fillText("$BUIDL 质押功能待创建 — 当前质押数为 0", w / 2 - 140, h / 2);
}

function drawMiniNetworks() {
  document.querySelectorAll(".mini-network").forEach((canvas, canvasIndex) => {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f5ecd8";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const center = { x: canvas.width / 2, y: canvas.height / 2 };
    const nodes = Array.from({ length: 32 }, (_, i) => {
      const angle = (i * Math.PI * 2) / 32;
      const r = 25 + (i % 5) * 10 + canvasIndex * 3;
      return { x: center.x + Math.cos(angle) * r, y: center.y + Math.sin(angle) * r };
    });
    ctx.strokeStyle = "rgba(90,70,55,.45)";
    nodes.forEach((node, i) => {
      const target = nodes[(i * 7) % nodes.length];
      ctx.beginPath();
      ctx.moveTo(node.x, node.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
    });
    nodes.forEach((node, i) => {
      ctx.fillStyle = i % 4 === 0 ? "#bd5b45" : "#687b55";
      ctx.fillRect(node.x - 2, node.y - 2, 4, 4);
    });
  });
}

// ======================== Economy Trade Widget ========================

let ecoTradeMode = "buy";

function setupEconomyTrade() {
  const buyBtn = $("#ecoBuyBtn");
  const sellBtn = $("#ecoSellBtn");
  const payInput = $("#ecoPayInput");
  const submitBtn = $("#ecoTradeSubmit");

  if (!buyBtn) return; // not on economy page

  buyBtn.addEventListener("click", () => {
    ecoTradeMode = "buy";
    buyBtn.classList.add("is-active");
    sellBtn.classList.remove("is-active");
    payInput.previousElementSibling?.textContent && (payInput.closest("label").querySelector("span").textContent = "$ BNB");
    $("#ecoReceiveLabel").innerHTML = `Receive $BUIDL <strong id="ecoReceiveValue">0.00</strong>`;
    updateEcoReceive();
  });

  sellBtn.addEventListener("click", () => {
    ecoTradeMode = "sell";
    sellBtn.classList.add("is-active");
    buyBtn.classList.remove("is-active");
    payInput.closest("label").querySelector("span").textContent = "$ BUIDL";
    $("#ecoReceiveLabel").innerHTML = `Receive $BNB <strong id="ecoReceiveValue">0.00</strong>`;
    updateEcoReceive();
  });

  // Quick amount buttons
  document.querySelectorAll(".quick-amounts button[data-amt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      payInput.value = btn.getAttribute("data-amt");
      updateEcoReceive();
    });
  });

  payInput.addEventListener("input", updateEcoReceive);

  submitBtn.addEventListener("click", executeEcoTrade);

  // Update button label based on wallet state
  updateEcoTradeButton();
}

function updateEcoReceive() {
  const payInput = $("#ecoPayInput");
  const receiveEl = $("#ecoReceiveValue");
  if (!payInput || !receiveEl) return;
  const amount = Number(payInput.value) || 0;
  if (amount <= 0) { receiveEl.textContent = "0.00"; return; }

  const mcapBnb = Number(currentCommunity?.marketCap || 0);
  if (!mcapBnb) { receiveEl.textContent = "..."; return; }

  // Simple bonding curve estimate: tokenPrice ≈ mcapBnb / totalSupply
  // For version 4: price = mcap / 650M (bondingCurveSupply)
  const totalTokenSupply = 650000000;
  const tokenPriceBnb = mcapBnb / totalTokenSupply;

  if (ecoTradeMode === "buy") {
    // BNB → BUIDL tokens
    const tokens = amount / tokenPriceBnb;
    receiveEl.textContent = formatNumber(tokens);
  } else {
    // BUIDL tokens → BNB
    const bnb = amount * tokenPriceBnb;
    receiveEl.textContent = formatNumber(bnb);
  }
}

function updateEcoTradeButton() {
  const btn = $("#ecoTradeSubmit");
  if (!btn) return;
  if (activeProvider && connectedAddress) {
    btn.textContent = ecoTradeMode === "buy" ? "Buy $BUIDL" : "Sell $BUIDL";
  } else {
    btn.textContent = "Connect Wallet";
  }
}

async function executeEcoTrade() {
  const statusEl = $("#ecoTradeStatus");
  const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };

  if (!activeProvider || !connectedAddress) {
    // Open wallet menu
    renderWalletMenu();
    $("#walletMenu").hidden = false;
    return;
  }

  const payInput = $("#ecoPayInput");
  const amount = Number(payInput?.value) || 0;
  if (amount <= 0) return setStatus("请输入有效的数量。");

  const token = currentCommunity?.token;
  if (!token) return setStatus("$BUIDL 代币合约未获取。");

  const slippage = Number($("#ecoSlippageInput")?.value || 5);
  const pair = currentCommunity?.pair;

  // For BUIDL (version 4, not listed), use PancakeSwap router
  // Open PancakeSwap with pre-filled params
  if (ecoTradeMode === "buy") {
    const swapUrl = `https://pancakeswap.finance/swap?outputCurrency=${token}&chain=bsc`;
    setStatus("正在打开 PancakeSwap...");
    window.open(swapUrl, "_blank");
    setStatus(`已打开 PancakeSwap 购买页面。交易完成后调用 /community/trade 记录。`);

    // Record the trade intent
    const account = accountStore.getAccount();
    if (account?.twitterId) {
      apiGet("/community/trade", { tick: TICK, twitterId: account.twitterId, token }).catch(() => {});
    }
  } else {
    const swapUrl = `https://pancakeswap.finance/swap?inputCurrency=${token}&chain=bsc`;
    setStatus("正在打开 PancakeSwap...");
    window.open(swapUrl, "_blank");
    setStatus(`已打开 PancakeSwap 卖出页面。`);
  }
}

// ======================== Social Prediction ========================

function setupPredictionTabs() {
  document.querySelectorAll(".prediction-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".prediction-tab").forEach((t) => t.classList.remove("is-active"));
      btn.classList.add("is-active");
      loadPredictionData(btn.getAttribute("data-pred-tab") || "battle");
    });
  });
}

async function loadPredictionData(tab) {
  const list = $("#predictionList");
  if (!list) return;
  list.innerHTML = `<div class="prediction-loading">Loading...</div>`;

  try {
    if (tab === "battle") {
      const data = await apiGet("/predict/getPredictBattleData", { tick: TICK, pageIndex: 0 });
      const battles = data?.battle || [];
      const tweets = data?.tweets || {};
      await attachMarketReserves(battles);
      renderPredictionBattles(battles, tweets);
    } else {
      const events = await apiGet("/predict/getPredictEventData", { tick: TICK, pageIndex: 0 });
      const list = Array.isArray(events) ? events : [];
      await attachMarketReserves(list);
      renderPredictionEvents(list);
    }
  } catch (error) {
    list.innerHTML = `<div class="prediction-empty">Failed to load prediction data.</div>`;
  }
}

function predictionStatusLabel(status) {
  switch (status) {
    case 0: return "Pending";
    case 1: return "Active";
    case 2: return "Resolved";
    default: return "Unknown";
  }
}

function predictionStatusClass(status) {
  switch (status) {
    case 1: return "status-active";
    case 2: return "status-resolved";
    default: return "status-pending";
  }
}

function renderPredictionBattles(battles, tweets) {
  const list = $("#predictionList");
  if (!list) return;
  if (!battles.length) {
    list.innerHTML = `<div class="prediction-empty">No prediction battles in #BUIDL yet.</div>`;
    return;
  }

  list.innerHTML = "";
  battles.forEach((battle) => {
    const tweetA = tweets[battle.predictAID] || {};
    const tweetB = tweets[battle.predictBID] || {};
    const totalPool = Number(battle.amounta || 0) + Number(battle.amountb || 0);
    const { pctA, pctB } = marketPercents(battle);

    const card = document.createElement("article");
    card.className = "prediction-card";
    card.innerHTML = `
      <div class="prediction-card-header">
        <h3>${safeText(battle.title, "Prediction Battle")}</h3>
        <span class="prediction-status ${predictionStatusClass(battle.status)}">${predictionStatusLabel(battle.status)}</span>
      </div>
      <div class="prediction-battle-body">
        <div class="prediction-side side-a">
          <div class="prediction-side-label">A</div>
          <p>${safeText(tweetA.content, "Tweet A").slice(0, 100)}</p>
          <div class="prediction-pool"><strong>${formatNumber(battle.amounta || 0)}</strong><small>VP · ${pctA}%</small></div>
        </div>
        <div class="prediction-vs">VS</div>
        <div class="prediction-side side-b">
          <div class="prediction-side-label">B</div>
          <p>${safeText(tweetB.content, "Tweet B").slice(0, 100)}</p>
          <div class="prediction-pool"><strong>${formatNumber(battle.amountb || 0)}</strong><small>VP · ${pctB}%</small></div>
        </div>
      </div>
      <div class="prediction-bar">
        <div class="prediction-bar-a" style="width:${pctA}%"></div>
        <div class="prediction-bar-b" style="width:${pctB}%"></div>
      </div>
      <div class="prediction-card-footer">
        <span>Total Pool: ${formatNumber(totalPool)} VP</span>
        <span>$${safeText(battle.tick, TICK)}</span>
      </div>
    `;
    list.appendChild(card);
  });
}

function renderPredictionEvents(events) {
  const list = $("#predictionList");
  if (!list) return;
  if (!events.length) {
    list.innerHTML = `<div class="prediction-empty">No prediction events in #BUIDL yet.</div>`;
    return;
  }

  list.innerHTML = "";
  events.forEach((event) => {
    const { pctA: pctYes, pctB: pctNo } = marketPercents(event);
    const poolReserve = Number(event.reserveA || 0) + Number(event.reserveB || 0);
    const endDate = event.endTime ? new Date(event.endTime * 1000).toLocaleDateString() : "—";

    const card = document.createElement("article");
    card.className = "prediction-card";
    card.innerHTML = `
      <div class="prediction-card-header">
        <h3>${safeText(event.title, "Prediction Event")}</h3>
        <span class="prediction-status ${predictionStatusClass(event.status)}">${predictionStatusLabel(event.status)}</span>
      </div>
      <div class="prediction-event-body">
        <p class="prediction-event-content">${safeText(event.content, "").slice(0, 200)}</p>
        <div class="prediction-votes">
          <div class="prediction-vote-yes">
            <strong>Yes</strong>
            <span>${pctYes}%</span>
          </div>
          <div class="prediction-vote-no">
            <strong>No</strong>
            <span>${pctNo}%</span>
          </div>
        </div>
      </div>
      <div class="prediction-bar">
        <div class="prediction-bar-a" style="width:${pctYes}%"></div>
        <div class="prediction-bar-b" style="width:${pctNo}%"></div>
      </div>
      <div class="prediction-card-footer">
        <span>Ends: ${endDate}</span>
        <span>Pool: ${formatNumber(poolReserve)} $${safeText(event.tick, TICK)}</span>
      </div>
    `;
    list.appendChild(card);
  });
}

// ---- Prediction odds from the on-chain FPMM (matches tagai-ui usePredict) ----
// The YES/NO (or A/B) probabilities come from the ConditionalTokens outcome-token
// reserves held by each market's FPMM marketMaker — NOT from voteYes/voteNo (which
// are usually 0). Read-only via public BSC RPC, so no wallet is required.
const CONDITIONAL_TOKENS = "0xAD1a38cEc043e70E83a3eC30443dB285ED10D774";
const ERC1155_BALANCE_OF = "0x00fdd58e"; // balanceOf(address,uint256)
const PREDICT_RPCS = [
  "https://bsc-dataseed1.bnbchain.org",
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-dataseed2.bnbchain.org",
  "https://rpc.ankr.com/bsc"
];

async function bscRpcCall(method, params, perTryTimeoutMs = 3500) {
  let lastErr;
  for (const url of PREDICT_RPCS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perTryTimeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal
      });
      clearTimeout(timer);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || "rpc error");
      return json.result;
    } catch (error) {
      clearTimeout(timer);
      lastErr = error;
    }
  }
  throw lastErr || new Error("all RPCs failed");
}

function parseSolvedBalances(market) {
  let sb = market.solvedBalances;
  if (typeof sb === "string") {
    try { sb = JSON.parse(sb); } catch { sb = null; }
  }
  return Array.isArray(sb) && sb.length >= 2 ? sb.map(Number) : null;
}

// Read each market's FPMM outcome reserves and attach reserveA/reserveB.
async function attachMarketReserves(markets) {
  await Promise.all((markets || []).map(async (market) => {
    if (parseSolvedBalances(market)) return; // resolved → use solvedBalances instead
    if (!isHexAddress(market.marketMaker) || !market.positionAID || !market.positionBID) return;
    try {
      const [balA, balB] = await Promise.all([
        bscRpcCall("eth_call", [{ to: CONDITIONAL_TOKENS, data: encodeAbi(ERC1155_BALANCE_OF, ["address", "uint256"], [market.marketMaker, BigInt(market.positionAID)]) }, "latest"]),
        bscRpcCall("eth_call", [{ to: CONDITIONAL_TOKENS, data: encodeAbi(ERC1155_BALANCE_OF, ["address", "uint256"], [market.marketMaker, BigInt(market.positionBID)]) }, "latest"])
      ]);
      market.reserveA = Number(BigInt(balA || "0x0")) / 1e18;
      market.reserveB = Number(BigInt(balB || "0x0")) / 1e18;
    } catch (_) {
      // leave reserves undefined → marketPercents falls back to 50/50
    }
  }));
}

// Side-A / YES probability = opposite-outcome reserve / total (constant-product FPMM).
function marketPercents(market) {
  const sb = parseSolvedBalances(market);
  let aFraction;
  if (sb && sb[0] + sb[1] > 0) {
    aFraction = sb[1] / (sb[0] + sb[1]);
  } else {
    const rA = Number(market.reserveA || 0);
    const rB = Number(market.reserveB || 0);
    const total = rA + rB;
    aFraction = total > 0 ? rB / total : 0.5;
  }
  const pctA = Math.round(aFraction * 100);
  return { pctA, pctB: 100 - pctA };
}

// ======================== Blinks Post Page ========================

async function loadBlinksPage() {
  const feed = $("#signalFeed");
  if (!feed) return;
  feed.innerHTML = `<div class="blinks-page"><div id="blinksList" class="blinks-list"><div class="prediction-loading">Loading Blinks...</div></div></div>`;

  try {
    // Get community tweets and filter for Blinks (those with commerceId)
    const tweets = await apiGet("/curation/communityTweets", { tick: TICK, pages: 0 }).catch(() => currentTweets);
    const blinksTweets = (Array.isArray(tweets) ? tweets : currentTweets).filter((t) => t.commerceId);

    // Also get recent trade list for the token
    const token = currentCommunity?.token;
    const trades = token ? await apiGet("/community/tradeList", { token, pages: 0 }).catch(() => []) : [];

    renderBlinksPage(blinksTweets, Array.isArray(trades) ? trades : []);
  } catch {
    const list = $("#blinksList");
    if (list) list.innerHTML = `<div class="prediction-empty">Failed to load Blinks data.</div>`;
  }
}

function renderBlinksPage(blinksTweets, trades) {
  const list = $("#blinksList");
  if (!list) return;

  if (!blinksTweets.length) {
    list.innerHTML = `<div class="prediction-empty">No Blinks posts in #BUIDL yet.</div>`;
    return;
  }

  list.innerHTML = "";
  blinksTweets.forEach((tweet) => {
    const profileImg = getProfileImage(tweet);
    const tokenAddr = tweet.token || currentCommunity?.token || "";
    const tick = tweet.tick || TICK;

    const card = document.createElement("article");
    card.className = "blinks-card";
    const sellsman = tweet.ethAddr || "";
    card.innerHTML = `
      <div class="blinks-card-author">
        <div class="blinks-avatar">${profileImg ? `<img src="${profileImg}" alt="">` : ""}</div>
        <div>
          <strong>${safeText(tweet.twitterName || tweet.twitterUsername, "BUIDL Agent")}</strong>
          <small>@${safeText(tweet.twitterUsername, "agent")} · ${formatSignalTime(tweet.tweetTime)}</small>
        </div>
      </div>
      <div class="blinks-card-content">
        <p>${safeText(tweet.content, "").replace(/(https:\/\/tagai\.fun\/commerce\/[^\s]+)/g, "")}</p>
      </div>
      <button class="blinks-trade-button" type="button">Trade $${tick}</button>
      <div class="blinks-trade-form" hidden>
        <div class="blinks-trade-toggle">
          <button class="blinks-buy-btn is-active" type="button">Buy</button>
          <button class="blinks-sell-btn" type="button">Sell</button>
        </div>
        <label class="blinks-input-row">
          <span class="blinks-pay-label">Pay</span>
          <input class="blinks-pay-input" type="number" step="0.0001" placeholder="0.00" inputmode="decimal" />
          <span class="blinks-pay-unit">BNB</span>
        </label>
        <div class="blinks-quick-amounts">
          <button type="button" data-amt="0.02">0.02</button>
          <button type="button" data-amt="0.05">0.05</button>
          <button type="button" data-amt="0.1">0.1</button>
          <button type="button" data-amt="0.2">0.2</button>
        </div>
        <div class="blinks-balance-row" hidden>Balance: <span class="blinks-balance-value">-</span> <button class="blinks-max-btn" type="button">Max</button></div>
        <div class="blinks-receive-row"><span class="blinks-receive-label">Receive $${tick}</span> <strong class="blinks-receive-value">0.00</strong></div>
        <label class="blinks-slippage-row">Max slippage <input class="blinks-slippage-input" type="number" step="0.5" min="0.1" value="5" /> %</label>
        <button class="blinks-confirm-btn" type="button" data-token="${tokenAddr}" data-tick="${tick}" data-commerce="${tweet.commerceId || ""}" data-sellsman="${sellsman}">Buy $${tick}</button>
        <div class="blinks-trade-status" role="status"></div>
      </div>
      <div class="blinks-card-footer">
        <span>☵ ${tweet.replyCount || 0}</span>
        <span>↻ ${tweet.retweetCount || 0}</span>
        <span>✎ ${tweet.quoteCount || 0}</span>
        <span>♨ ${tweet.likeCount || 0}</span>
      </div>
    `;

    // Toggle trade form on button click
    const tradeBtn = card.querySelector(".blinks-trade-button");
    const tradeForm = card.querySelector(".blinks-trade-form");
    tradeBtn.addEventListener("click", () => {
      tradeForm.hidden = !tradeForm.hidden;
    });

    setupBlinksCardEvents(card);
    list.appendChild(card);
  });
}

function setupBlinksCardEvents(card) {
  const buyBtn = card.querySelector(".blinks-buy-btn");
  const sellBtn = card.querySelector(".blinks-sell-btn");
  const payInput = card.querySelector(".blinks-pay-input");
  const payUnit = card.querySelector(".blinks-pay-unit");
  const payLabel = card.querySelector(".blinks-pay-label");
  const receiveEl = card.querySelector(".blinks-receive-value");
  const receiveLabel = card.querySelector(".blinks-receive-label");
  const confirmBtn = card.querySelector(".blinks-confirm-btn");
  const quickWrap = card.querySelector(".blinks-quick-amounts");
  const quickBtns = card.querySelectorAll(".blinks-quick-amounts button");
  const balanceRow = card.querySelector(".blinks-balance-row");
  const balanceEl = card.querySelector(".blinks-balance-value");
  const maxBtn = card.querySelector(".blinks-max-btn");
  const statusEl = card.querySelector(".blinks-trade-status");
  const slippageInput = card.querySelector(".blinks-slippage-input");
  const tick = confirmBtn.dataset.tick || TICK;
  const token = confirmBtn.dataset.token;
  let mode = "buy";
  let quoteSeq = 0;

  function setStatus(msg, kind) {
    statusEl.textContent = msg || "";
    statusEl.dataset.kind = kind || "";
  }

  function applyMode() {
    if (mode === "buy") {
      buyBtn.classList.add("is-active");
      sellBtn.classList.remove("is-active");
      payLabel.textContent = "Pay";
      payUnit.textContent = "BNB";
      receiveLabel.textContent = `Receive $${tick}`;
      confirmBtn.textContent = `Buy $${tick}`;
      quickWrap.hidden = false;
      balanceRow.hidden = true;
    } else {
      sellBtn.classList.add("is-active");
      buyBtn.classList.remove("is-active");
      payLabel.textContent = "Sell";
      payUnit.textContent = `$${tick}`;
      receiveLabel.textContent = "Receive BNB";
      confirmBtn.textContent = `Sell $${tick}`;
      quickWrap.hidden = true;
      balanceRow.hidden = false;
      loadBalance();
    }
    payInput.value = "";
    receiveEl.textContent = "0.00";
    setStatus("");
  }

  buyBtn.addEventListener("click", () => { if (mode !== "buy") { mode = "buy"; applyMode(); } });
  sellBtn.addEventListener("click", () => { if (mode !== "sell") { mode = "sell"; applyMode(); } });

  quickBtns.forEach((btn) => {
    btn.addEventListener("click", () => { payInput.value = btn.dataset.amt; updateReceive(); });
  });
  maxBtn?.addEventListener("click", () => {
    const raw = balanceEl?.dataset.raw;
    if (!raw) return;
    payInput.value = (Number(BigInt(raw)) / 1e18).toString();
    updateReceive();
  });
  payInput.addEventListener("input", updateReceive);

  async function loadBalance() {
    if (!activeProvider || !connectedAddress) { balanceEl.textContent = "请先连接钱包"; balanceEl.dataset.raw = ""; return; }
    try {
      const bal = await blinksTokenBalance(token, connectedAddress);
      balanceEl.textContent = `${formatNumber(Number(bal) / 1e18)} ${tick}`;
      balanceEl.dataset.raw = bal.toString();
    } catch { balanceEl.textContent = "-"; balanceEl.dataset.raw = ""; }
  }

  async function updateReceive() {
    const amount = Number(payInput.value) || 0;
    const seq = ++quoteSeq;
    if (amount <= 0) { receiveEl.textContent = "0.00"; return; }
    if (!activeProvider || !connectedAddress) {
      // Approximate fallback using community market cap (TotalSupply = 1e9)
      const mcapBnb = Number(currentCommunity?.marketCap || 0);
      const priceBnb = mcapBnb ? mcapBnb / 1e9 : 0;
      if (!priceBnb) { receiveEl.textContent = "连接钱包以报价"; return; }
      receiveEl.textContent = mode === "buy"
        ? formatNumber(amount / priceBnb)
        : formatNumber(amount * priceBnb) + " BNB";
      return;
    }
    receiveEl.textContent = "...";
    try {
      const out = mode === "buy"
        ? await blinksQuoteBuy(token, parseEther18(String(amount)))
        : await blinksQuoteSell(token, parseEther18(String(amount)));
      if (seq !== quoteSeq) return; // a newer input superseded this quote
      receiveEl.textContent = mode === "buy"
        ? formatNumber(Number(out) / 1e18)
        : formatNumber(Number(out) / 1e18) + " BNB";
    } catch {
      if (seq === quoteSeq) receiveEl.textContent = "0.00";
    }
  }

  confirmBtn.addEventListener("click", async () => {
    if (!activeProvider || !connectedAddress) {
      renderWalletMenu();
      $("#walletMenu").hidden = false;
      return;
    }
    if (!token) { setStatus("缺少代币地址。", "error"); return; }
    const sellsman = confirmBtn.dataset.sellsman || "";
    const commerceId = confirmBtn.dataset.commerce;
    const amountStr = payInput.value;
    if ((Number(amountStr) || 0) <= 0) { setStatus("请输入有效数量。", "error"); return; }
    const slippageBps = Math.min(5000, Math.max(10, Math.round((Number(slippageInput.value) || 5) * 100)));

    confirmBtn.disabled = true;
    try {
      let hash;
      if (mode === "buy") {
        setStatus("请在钱包中确认买入交易...", "pending");
        hash = await blinksBuy({ token, sellsman, payBnb: amountStr, slippageBps });
      } else {
        hash = await blinksSell({ token, sellsman, sellAmount: amountStr, slippageBps, setStatus });
      }
      setStatus(`交易已提交：${compactAddress(hash)}，等待上链...`, "pending");
      const ok = await blinksWaitReceipt(activeProvider, hash);
      setStatus(ok ? `交易成功：${compactAddress(hash)}` : `已提交：${compactAddress(hash)}`, ok ? "success" : "pending");

      // Record the trade so the backend can credit the Blink commerce
      const account = accountStore.getAccount();
      if (account?.twitterId) {
        apiGet("/community/trade", { tick: TICK, transHash: hash, commerceId, token }).catch(() => {});
      }
      payInput.value = "";
      receiveEl.textContent = "0.00";
      if (mode === "sell") loadBalance();
    } catch (error) {
      setStatus(`交易失败：${errorMessage(error, "请检查余额、滑点或网络")}`, "error");
    } finally {
      confirmBtn.disabled = false;
    }
  });
}

// ======================== Blinks On-chain Trade (BSC) ========================
// Reference: tagai-ui src/utils/pump.ts (buyToken/sellToken) + pcsV4Swap; BUIDL is a
// listed v4 token, so trades route through the WrapSwaper -> PancakeSwap V2 path.

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const WRAP_SWAPER = "0x4cA57c64DFe1cF1be977093C75f9d9cdd1DD2E10"; // wrappedUniswapV2ForTagAI
const PCS_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const PUMP4_CONTRACT = "0x0476571a77Cc8Fc28796935Cf173c265F2021448";

const BLINKS_SEL = {
  // ERC20 / token
  balanceOf: "0x70a08231",          // balanceOf(address)
  allowance: "0xdd62ed3e",          // allowance(address,address)
  approve: "0x095ea7b3",            // approve(address,uint256)
  listed: "0x1747a57b",             // listed()
  bondingCurveSupply: "0x2b8a30d2", // bondingCurveSupply()
  // PancakeSwap V2 router
  getAmountsOut: "0xd06ca61f",      // getAmountsOut(uint256,address[])
  // WrapSwaper (listed path)
  wrapBuy: "0x8a191d41",            // buyToken(address,uint256,address[],address,uint256,address)
  wrapSell: "0xe344f06e",           // sellToken(uint256,uint256,address[],address,uint256,address,address)
  // bonding-curve fallback (Token + Pump)
  curveBuy: "0x9c4c5062",           // buyToken(uint256,address,uint16)
  curveSell: "0xbd2bb69b",          // sellToken(uint256,uint256,address,uint16)
  getBuyAmountByValue: "0xb3368bb2",// getBuyAmountByValue(uint256,uint256)
  getSellPriceAfterFee: "0xcd9c7121"// getSellPriceAfterFee(uint256,uint256)
};

// Parse a decimal string into a wei BigInt (18 decimals) without float rounding.
function parseEther18(value) {
  let str = String(value == null ? "" : value).trim();
  if (!str) return 0n;
  let neg = false;
  if (str[0] === "-") { neg = true; str = str.slice(1); }
  let [whole, frac = ""] = str.split(".");
  whole = whole.replace(/[^0-9]/g, "") || "0";
  frac = (frac.replace(/[^0-9]/g, "") + "0".repeat(18)).slice(0, 18);
  const wei = BigInt(whole) * 1000000000000000000n + BigInt(frac || "0");
  return neg ? -wei : wei;
}

// Minimal ABI encoder. Supports static types (address/uint*/bool) and one level of
// dynamic `address[]`, which is all the WrapSwaper/router calls require.
function abiWord(v) {
  if (typeof v === "string" && v.startsWith("0x")) {
    return v.slice(2).toLowerCase().padStart(64, "0");
  }
  let n = typeof v === "bigint" ? v : BigInt(v);
  if (n < 0n) n = (1n << 256n) + n;
  return n.toString(16).padStart(64, "0");
}

function encodeAbi(selector, types, values) {
  const head = [];
  const dynIndexes = [];
  types.forEach((t, i) => {
    if (t.endsWith("[]")) { head.push(null); dynIndexes.push(i); }
    else head.push(abiWord(values[i]));
  });
  let tail = "";
  let cursor = types.length * 32;
  dynIndexes.forEach((i) => {
    head[i] = abiWord("0x" + cursor.toString(16));
    const arr = values[i];
    let seg = abiWord(arr.length);
    arr.forEach((el) => { seg += abiWord(el); });
    tail += seg;
    cursor += 32 + arr.length * 32;
  });
  return selector + head.join("") + tail;
}

// Decode the last element of a uint256[] return (e.g. router getAmountsOut).
function decodeUintArrayLast(hex) {
  const d = hex && hex.startsWith("0x") ? hex.slice(2) : hex || "";
  if (d.length < 128) return 0n;
  const len = parseInt(d.slice(64, 128), 16) || 0;
  if (!len) return 0n;
  const start = 128 + (len - 1) * 64;
  return BigInt("0x" + d.slice(start, start + 64));
}

async function blinksTokenBalance(token, holder) {
  const data = encodeAbi(BLINKS_SEL.balanceOf, ["address"], [holder]);
  const ret = await readContract(activeProvider, token, data);
  return BigInt(ret || "0x0");
}

async function blinksIsListed(token) {
  try {
    const ret = await readContract(activeProvider, token, BLINKS_SEL.listed);
    return BigInt(ret || "0x0") === 1n;
  } catch { return true; } // BUIDL is listed; default to the AMM path on read failure
}

async function blinksQuoteBuy(token, ethIn) {
  if (await blinksIsListed(token)) {
    // 2% fee retained on input before AMM quote (matches pump.ts getBuyAmountUseEth call site)
    const data = encodeAbi(BLINKS_SEL.getAmountsOut, ["uint256", "address[]"], [ethIn * 9800n / 10000n, [WBNB, token]]);
    const ret = await readContract(activeProvider, PCS_V2_ROUTER, data);
    return decodeUintArrayLast(ret);
  }
  const supplyHex = await readContract(activeProvider, token, BLINKS_SEL.bondingCurveSupply);
  const supply = BigInt(supplyHex || "0x0");
  const data = encodeAbi(BLINKS_SEL.getBuyAmountByValue, ["uint256", "uint256"], [supply, ethIn * 9800n / 10000n]);
  const ret = await readContract(activeProvider, PUMP4_CONTRACT, data);
  return BigInt(ret || "0x0");
}

async function blinksQuoteSell(token, tokenIn) {
  if (await blinksIsListed(token)) {
    const data = encodeAbi(BLINKS_SEL.getAmountsOut, ["uint256", "address[]"], [tokenIn, [token, WBNB]]);
    const ret = await readContract(activeProvider, PCS_V2_ROUTER, data);
    return decodeUintArrayLast(ret) * 9800n / 10000n;
  }
  const supplyHex = await readContract(activeProvider, token, BLINKS_SEL.bondingCurveSupply);
  const supply = BigInt(supplyHex || "0x0");
  const data = encodeAbi(BLINKS_SEL.getSellPriceAfterFee, ["uint256", "uint256"], [supply, tokenIn]);
  const ret = await readContract(activeProvider, PUMP4_CONTRACT, data);
  return BigInt(ret || "0x0");
}

async function blinksBuy({ token, sellsman, payBnb, slippageBps }) {
  await ensureBscChain(activeProvider);
  const value = parseEther18(payBnb);
  const referrer = isHexAddress(sellsman) ? sellsman : ZERO_ADDRESS;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  if (await blinksIsListed(token)) {
    const quote = await blinksQuoteBuy(token, value);
    const amountOutMin = quote * BigInt(10000 - slippageBps) / 10000n;
    const data = encodeAbi(
      BLINKS_SEL.wrapBuy,
      ["address", "uint256", "address[]", "address", "uint256", "address"],
      [referrer, amountOutMin, [WBNB, token], connectedAddress, deadline, IPSHARE_CONTRACT]
    );
    return callContract(activeProvider, connectedAddress, WRAP_SWAPER, data, "0x" + value.toString(16));
  }
  // bonding-curve fallback: Token.buyToken(expectAmount, sellsman, slippage) payable
  const expect = await blinksQuoteBuy(token, value);
  const data = encodeAbi(BLINKS_SEL.curveBuy, ["uint256", "address", "uint16"], [expect, referrer, BigInt(slippageBps)]);
  return callContract(activeProvider, connectedAddress, token, data, "0x" + value.toString(16));
}

async function blinksSell({ token, sellsman, sellAmount, slippageBps, setStatus }) {
  await ensureBscChain(activeProvider);
  const amount = parseEther18(sellAmount);
  const referrer = isHexAddress(sellsman) ? sellsman : ZERO_ADDRESS;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const listed = await blinksIsListed(token);

  if (listed) {
    // Ensure the WrapSwaper is approved to pull the token amount
    const allowData = encodeAbi(BLINKS_SEL.allowance, ["address", "address"], [connectedAddress, WRAP_SWAPER]);
    const allowanceHex = await readContract(activeProvider, token, allowData);
    if (BigInt(allowanceHex || "0x0") < amount) {
      setStatus?.("请在钱包中确认授权 (approve)...", "pending");
      const approveData = encodeAbi(BLINKS_SEL.approve, ["address", "uint256"], [WRAP_SWAPER, amount * 2n]);
      const approveHash = await callContract(activeProvider, connectedAddress, token, approveData);
      setStatus?.("等待授权上链...", "pending");
      await blinksWaitReceipt(activeProvider, approveHash);
    }
    const expected = await blinksQuoteSell(token, amount);
    const amountOutMin = expected * BigInt(10000 - slippageBps) / 10000n;
    setStatus?.("请在钱包中确认卖出交易...", "pending");
    const data = encodeAbi(
      BLINKS_SEL.wrapSell,
      ["uint256", "uint256", "address[]", "address", "uint256", "address", "address"],
      [amount, amountOutMin, [token, WBNB], connectedAddress, deadline, referrer, IPSHARE_CONTRACT]
    );
    return callContract(activeProvider, connectedAddress, WRAP_SWAPER, data, "0x0");
  }
  // bonding-curve fallback: Token.sellToken(amount, receiveEth, sellsman, slippage)
  const receive = await blinksQuoteSell(token, amount);
  setStatus?.("请在钱包中确认卖出交易...", "pending");
  const data = encodeAbi(
    BLINKS_SEL.curveSell,
    ["uint256", "uint256", "address", "uint16"],
    [amount, receive * BigInt(10000 - slippageBps) / 10000n, referrer, BigInt(slippageBps)]
  );
  return callContract(activeProvider, connectedAddress, token, data, "0x0");
}

function isHexAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

// Poll for a transaction receipt. Returns true on success (status 0x1), false otherwise.
async function blinksWaitReceipt(provider, hash, timeoutMs = 60000) {
  if (!hash) return false;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
      if (receipt) return BigInt(receipt.status || "0x0") === 1n;
    } catch { /* keep polling */ }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  return false;
}

async function loadSignalPage() {
  renderMiniTags();
  renderSignalFeed(currentTweets);
  try {
    const [tags, tweets] = await Promise.all([
      apiGet("/communityMiniTag/getCommunityMiniTags", { tick: TICK }).catch(() => []),
      apiGet("/curation/communityTweets", { tick: TICK, pages: 0 }).catch(() => currentTweets)
    ]);
    currentTweets = Array.isArray(tweets) && tweets.length ? tweets : currentTweets;

    // Use API mini tags if available, otherwise extract $CASHTAGs from tweet content
    if (Array.isArray(tags) && tags.length) {
      miniTags = tags;
    } else {
      // Extract unique $CASHTAG mentions from all tweets
      const tagSet = new Map();
      currentTweets.forEach((t) => {
        const content = String(t.content || "");
        const matches = content.matchAll(/\$([A-Za-z][A-Za-z0-9_]{1,})/g);
        for (const match of matches) {
          const name = match[1];
          tagSet.set(name.toUpperCase(), name);
        }
      });
      // Also parse the tweet 'tags' field (JSON string array)
      currentTweets.forEach((t) => {
        if (!t.tags) return;
        try {
          const parsed = typeof t.tags === "string" ? JSON.parse(t.tags) : t.tags;
          if (Array.isArray(parsed)) {
            parsed.forEach((tag) => {
              if (tag && typeof tag === "string" && tag.length > 1) {
                tagSet.set(tag.toUpperCase(), tag);
              }
            });
          }
        } catch {}
      });
      miniTags = Array.from(tagSet.values()).map((name) => ({
        id: name,
        name,
        tag: name,
        tick: TICK,
        type: 1
      }));
    }

    // Real stats from API data
    const allTweets = currentTweets;
    const totalPosts = allTweets.length;
    const totalCurations = allTweets.reduce((sum, t) => sum + Number(t.curateCount || 0) + Number(t.likeCount || 0) + Number(t.replyCount || 0), 0);
    const copyTradingCount = allTweets.filter((t) => t.commerceId || t.buyCount).length;

    $("#signalStatPosts").textContent = formatNumber(totalPosts + totalCurations);
    $("#signalStatCopy").textContent = formatNumber(copyTradingCount);

    // Load prediction count
    apiGet("/predict/getPredictBattleData", { tick: TICK, pageIndex: 0 }).then((data) => {
      const battles = data?.battle?.length || 0;
      apiGet("/predict/getPredictEventData", { tick: TICK, pageIndex: 0 }).then((events) => {
        const eventCount = Array.isArray(events) ? events.length : 0;
        $("#signalStatPredict").textContent = formatNumber(battles + eventCount);
      }).catch(() => {});
    }).catch(() => {});

    renderMiniTags();
    renderSignalFeed(currentTweets);
  } catch {
    renderSignalFeed(fallbackTweets);
  }
}

async function loadSignalFeed() {
  try {
    let tweets;
    if (selectedMiniTag) {
      // Try the API endpoint first; if it fails or returns empty, fall back to local filtering
      tweets = await apiGet("/curation/tagTweets", {
        communityId: selectedMiniTag.tick || TICK,
        tag: selectedMiniTag.tag || selectedMiniTag.name,
        pages: 0
      }).catch(() => null);
      // If API returned nothing, filter locally by $CASHTAG in content or tags field
      if (!Array.isArray(tweets) || !tweets.length) {
        const tagName = (selectedMiniTag.tag || selectedMiniTag.name || "").toUpperCase();
        tweets = currentTweets.filter((t) => {
          const content = String(t.content || "").toUpperCase();
          if (content.includes("$" + tagName)) return true;
          try {
            const parsed = typeof t.tags === "string" ? JSON.parse(t.tags) : t.tags;
            if (Array.isArray(parsed) && parsed.some((tag) => String(tag).toUpperCase() === tagName)) return true;
          } catch {}
          return false;
        });
      }
    } else if (signalMode === "trending") {
      tweets = await apiGet("/curation/communityTrendingTweets", { tick: TICK, pages: 0 });
    } else {
      tweets = await apiGet("/curation/communityTweets", { tick: TICK, pages: 0 });
    }
    const result = Array.isArray(tweets) && tweets.length ? tweets : currentTweets;
    renderSignalFeed(result);
  } catch {
    renderSignalFeed(currentTweets);
  }
}

// ======================== Signal Social Graph ========================

// Color palette for mini tag associations
const TAG_COLORS = [
  "#ff8d26", "#6f4aa2", "#3c8c5c", "#d64545", "#2d7eb5",
  "#c7a020", "#e06090", "#4caf50", "#795548", "#607d8b"
];

let _graphInterval = null;

function getTagColor(tagName) {
  if (!tagName) return "#607d8b";
  const tags = miniTags.length ? miniTags : [{ name: TICK }];
  const idx = tags.findIndex((t) => (t.name || t.tag || "").toUpperCase() === tagName.toUpperCase());
  return TAG_COLORS[idx >= 0 ? idx % TAG_COLORS.length : tags.length % TAG_COLORS.length];
}

function extractTweetTag(tweet) {
  const content = String(tweet.content || "");
  const match = content.match(/\$([A-Za-z][A-Za-z0-9_]{1,})/);
  if (match) return match[1];
  try {
    const parsed = typeof tweet.tags === "string" ? JSON.parse(tweet.tags) : tweet.tags;
    if (Array.isArray(parsed) && parsed.length) return parsed[0];
  } catch {}
  return TICK;
}

async function loadAndDrawSignalGraph() {
  const tweets = currentTweets.length ? currentTweets : fallbackTweets;

  // Build graph data: nodes and edges
  const tweetNodes = []; // { id, type:'tweet', x, y, tag, label }
  const personNodes = []; // { id, type:'author'|'curator'|'trader', x, y, label }
  const edges = []; // { from, to, type }
  const personMap = new Map(); // key -> personNode

  function getOrCreatePerson(id, name, type) {
    const key = String(id || name || "").toLowerCase();
    if (!key) return null;
    if (personMap.has(key)) {
      const existing = personMap.get(key);
      // Upgrade type priority: trader > curator > author
      if (type === "trader" || (type === "author" && existing.type === "curator")) {
        existing.type = type;
      }
      return existing;
    }
    const node = { id: key, type, label: name || key, x: 0, y: 0 };
    personMap.set(key, node);
    personNodes.push(node);
    return node;
  }

  // Process each tweet
  tweets.forEach((tweet) => {
    const tag = extractTweetTag(tweet);
    const node = {
      id: tweet.tweetId || Math.random().toString(36),
      type: "tweet",
      tag,
      label: String(tweet.content || "").slice(0, 30),
      x: 0, y: 0,
      likeCount: Number(tweet.likeCount || 0),
      replyCount: Number(tweet.replyCount || 0),
      retweetCount: Number(tweet.retweetCount || 0),
      commerceId: tweet.commerceId,
      buyCount: Number(tweet.buyCount || 0)
    };
    tweetNodes.push(node);

    // Author connection
    const author = getOrCreatePerson(tweet.twitterId || tweet.twitterUsername, tweet.twitterUsername, "author");
    if (author) edges.push({ from: author.id, to: node.id, type: "post" });
  });

  // Fetch curators for top tweets (limit to 5 to avoid too many API calls)
  const topTweets = tweets.slice(0, 8).filter((t) => Number(t.likeCount || 0) + Number(t.replyCount || 0) > 0);
  const curatorPromises = topTweets.map((t) =>
    apiGet("/curation/tweetCurateList", { tweetId: t.tweetId, pages: 0 }).catch(() => [])
  );
  const curatorResults = await Promise.all(curatorPromises);

  curatorResults.forEach((curators, idx) => {
    if (!Array.isArray(curators)) return;
    const tweet = topTweets[idx];
    curators.forEach((c) => {
      const name = c.twitterUsername || c.twitterId || c.ethAddr || "";
      const person = getOrCreatePerson(c.twitterId || c.ethAddr || name, name, "curator");
      if (person) edges.push({ from: person.id, to: tweet.tweetId, type: "curate" });
    });
  });

  // Generate synthetic interactor nodes for tweets with interactions but no curator data
  tweets.forEach((tweet) => {
    const hasDetailedCurators = topTweets.some((t) => t.tweetId === tweet.tweetId);
    if (hasDetailedCurators) return;

    const likeCount = Math.min(Number(tweet.likeCount || 0), 3);
    const replyCount = Math.min(Number(tweet.replyCount || 0), 2);
    const buyCount = Math.min(Number(tweet.buyCount || 0), 2);

    for (let i = 0; i < likeCount; i++) {
      const synId = `syn-like-${tweet.tweetId}-${i}`;
      const person = getOrCreatePerson(synId, `voter${personNodes.length}`, "curator");
      if (person) edges.push({ from: person.id, to: tweet.tweetId, type: "like" });
    }
    for (let i = 0; i < replyCount; i++) {
      const synId = `syn-reply-${tweet.tweetId}-${i}`;
      const person = getOrCreatePerson(synId, `replier${personNodes.length}`, "curator");
      if (person) edges.push({ from: person.id, to: tweet.tweetId, type: "reply" });
    }
    for (let i = 0; i < buyCount; i++) {
      const synId = `syn-trade-${tweet.tweetId}-${i}`;
      const person = getOrCreatePerson(synId, `trader${personNodes.length}`, "trader");
      if (person) edges.push({ from: person.id, to: tweet.tweetId, type: "trade" });
    }
  });

  // Mark traders (people who interacted via commerce/blinks)
  tweets.forEach((tweet) => {
    if (tweet.commerceId || tweet.buyCount) {
      const author = personMap.get(String(tweet.twitterId || tweet.twitterUsername || "").toLowerCase());
      if (author) author.type = "trader";
    }
  });

  // Layout: force-directed simple positioning
  layoutGraph(tweetNodes, personNodes, edges);

  // Draw
  drawSignalGraph(tweetNodes, personNodes, edges);

  const statusEl = $("#graphStatus");
  if (statusEl) statusEl.textContent = `${tweetNodes.length} signals · ${personNodes.length} agents`;

  // Periodic refresh every 60s
  if (_graphInterval) clearInterval(_graphInterval);
  _graphInterval = setInterval(async () => {
    if (!$("#signalGraphCanvas")) { clearInterval(_graphInterval); return; }
    try {
      const freshTweets = await apiGet("/curation/communityTweets", { tick: TICK, pages: 0 }).catch(() => null);
      if (Array.isArray(freshTweets) && freshTweets.length) {
        currentTweets = freshTweets;
        loadAndDrawSignalGraph();
      }
    } catch {}
  }, 60000);
}

function layoutGraph(tweetNodes, personNodes, edges) {
  const canvas = $("#signalGraphCanvas");
  if (!canvas) return;
  const W = canvas.width;
  const H = canvas.height;
  const cx = W * 0.5;
  const cy = H * 0.5;

  // Place tweets in inner ring (golden angle spiral)
  const tweetCount = tweetNodes.length;
  tweetNodes.forEach((node, i) => {
    const angle = i * 137.508 * (Math.PI / 180);
    const r = Math.sqrt((i + 1) / (tweetCount + 1)) * Math.min(W, H) * 0.28;
    node.x = cx + Math.cos(angle) * r;
    node.y = cy + Math.sin(angle) * r;
  });

  // Place persons in outer ring
  const personCount = personNodes.length;
  // Build a map for quick tweet node lookup
  const tweetMap = new Map();
  tweetNodes.forEach((t) => tweetMap.set(t.id, t));

  personNodes.forEach((node, i) => {
    // Find connected tweets to position near them
    const connected = edges.filter((e) => e.from === node.id || e.to === node.id);
    let avgX = cx, avgY = cy, count = 0;
    connected.forEach((e) => {
      const targetId = e.from === node.id ? e.to : e.from;
      const target = tweetMap.get(targetId);
      if (target) { avgX += target.x; avgY += target.y; count++; }
    });
    if (count > 0) { avgX /= count; avgY /= count; }
    else { avgX = cx; avgY = cy; }

    // Push outward from center
    const dx = avgX - cx;
    const dy = avgY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const outerR = Math.min(W, H) * 0.38 + (i % 5) * 12;
    const angle = Math.atan2(dy, dx) + (i % 3 - 1) * 0.15;
    node.x = cx + Math.cos(angle) * outerR;
    node.y = cy + Math.sin(angle) * outerR;
  });

  // Simple collision avoidance pass
  const allNodes = [...tweetNodes, ...personNodes];
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < allNodes.length; i++) {
      for (let j = i + 1; j < allNodes.length; j++) {
        const a = allNodes[i], b = allNodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = 18;
        if (dist < minDist && dist > 0) {
          const push = (minDist - dist) / 2;
          const nx = dx / dist, ny = dy / dist;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
        }
      }
    }
  }

  // Clamp to canvas
  allNodes.forEach((n) => {
    n.x = Math.max(20, Math.min(W - 20, n.x));
    n.y = Math.max(20, Math.min(H - 20, n.y));
  });
}

function drawSignalGraph(tweetNodes, personNodes, edges) {
  const canvas = $("#signalGraphCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#fbf7f1";
  ctx.fillRect(0, 0, W, H);

  // Build lookup
  const nodeMap = new Map();
  tweetNodes.forEach((n) => nodeMap.set(n.id, n));
  personNodes.forEach((n) => nodeMap.set(n.id, n));

  // Filter by selected mini tag
  const filterTag = selectedMiniTag ? (selectedMiniTag.name || selectedMiniTag.tag || "").toUpperCase() : null;
  const visibleTweets = filterTag
    ? tweetNodes.filter((t) => t.tag.toUpperCase() === filterTag)
    : tweetNodes;
  const visibleTweetIds = new Set(visibleTweets.map((t) => t.id));

  // Determine visible persons (connected to visible tweets)
  const visiblePersonIds = new Set();
  edges.forEach((e) => {
    if (visibleTweetIds.has(e.to)) visiblePersonIds.add(e.from);
    if (visibleTweetIds.has(e.from)) visiblePersonIds.add(e.to);
  });
  const visiblePersons = personNodes.filter((p) => visiblePersonIds.has(p.id));

  // Draw edges
  ctx.lineWidth = 0.7;
  ctx.strokeStyle = "rgba(40, 40, 40, 0.18)";
  edges.forEach((e) => {
    const from = nodeMap.get(e.from);
    const to = nodeMap.get(e.to);
    if (!from || !to) return;
    if (!visibleTweetIds.has(e.to) && !visibleTweetIds.has(e.from)) return;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  });

  // Draw tweet nodes (filled circles, color by tag)
  visibleTweets.forEach((node) => {
    const color = getTagColor(node.tag);
    const radius = 4 + Math.min(3, (node.likeCount || 0) * 0.3);
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  // Draw person nodes (hollow circles)
  visiblePersons.forEach((node) => {
    let strokeColor;
    if (node.type === "author") strokeColor = "#6f4aa2"; // purple
    else if (node.type === "trader") strokeColor = "#3c8c5c"; // green
    else strokeColor = "#c7a020"; // yellow for curators

    ctx.beginPath();
    ctx.arc(node.x, node.y, 3.5, 0, Math.PI * 2);
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.lineWidth = 0.7;
  });

  // Draw legend
  ctx.font = "12px system-ui, sans-serif";
  const legendX = W - 180, legendY = 20;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(legendX - 10, legendY - 4, 175, 90);
  ctx.strokeStyle = "#ccc";
  ctx.strokeRect(legendX - 10, legendY - 4, 175, 90);

  // Tweet dot
  ctx.beginPath(); ctx.arc(legendX, legendY + 10, 4, 0, Math.PI * 2); ctx.fillStyle = "#ff8d26"; ctx.fill();
  ctx.fillStyle = "#333"; ctx.fillText("帖子 (按 tag 着色)", legendX + 12, legendY + 14);

  // Author
  ctx.beginPath(); ctx.arc(legendX, legendY + 30, 3.5, 0, Math.PI * 2); ctx.strokeStyle = "#6f4aa2"; ctx.lineWidth = 1.8; ctx.stroke();
  ctx.fillStyle = "#333"; ctx.fillText("创作者 (紫色)", legendX + 12, legendY + 34);

  // Curator
  ctx.beginPath(); ctx.arc(legendX, legendY + 50, 3.5, 0, Math.PI * 2); ctx.strokeStyle = "#c7a020"; ctx.lineWidth = 1.8; ctx.stroke();
  ctx.fillStyle = "#333"; ctx.fillText("策展人 (黄色)", legendX + 12, legendY + 54);

  // Trader
  ctx.beginPath(); ctx.arc(legendX, legendY + 70, 3.5, 0, Math.PI * 2); ctx.strokeStyle = "#3c8c5c"; ctx.lineWidth = 1.8; ctx.stroke();
  ctx.fillStyle = "#333"; ctx.fillText("社交交易者 (绿色)", legendX + 12, legendY + 74);
}

function buildScoreRows(target, rows) {
  const container = $(target);
  if (!container) return;
  container.innerHTML = "";
  const maxVal = Math.max(...rows.map((r) => Number(r.rawValue ?? r.value) || 0), 1);
  rows.forEach((row) => {
    const val = Number(row.rawValue ?? row.value) || 0;
    const pct = Math.round((val / maxVal) * 100);
    const item = document.createElement("div");
    item.className = target === "#reputationMetrics" ? "metric-line" : "score-row";
    item.innerHTML = `
      <span>${row.label}</span>
      <span class="line-track" style="--value:${pct}%"></span>
      <strong>${row.value}</strong>
    `;
    container.appendChild(item);
  });
}

function tokenAmountFromRow(row = {}) {
  const raw = row.balance ?? row.amount ?? row.quantity ?? row.tokenBalance ?? row.value ?? 0;
  const decimals = Number(row.decimals ?? row.tokenDecimal ?? 18);
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return value > 1e12 ? value / 10 ** decimals : value;
}

function isBuidlRow(row = {}) {
  return String(row.tick || row.symbol || row.tokenName || row.community?.tick || "").toUpperCase() === TICK;
}

function ipsharePriceLocal(supply) {
  let number = Number(supply);
  if (!Number.isFinite(number)) return 0;
  if (number > 1e12) number = number / 1e18;
  return (number * number) / 100000;
}

function ipshareTvlLocal(supply) {
  let number = Number(supply);
  if (!Number.isFinite(number) || number <= 0) return 0;
  if (number > 1e12) number = number / 1e18;
  return (number ** 3) / 300000 - 1 / 300000;
}

function hasUserInteraction(row = {}) {
  return ["quoted", "retweeted", "replied", "liked", "curated"].some((key) => Number(row[key] || 0) > 0);
}

function buildThirtyDaySeries(rows = []) {
  const today = new Date();
  const byDay = new Map();
  rows.forEach((row) => {
    const key = String(row.day || row.date || row.rewardDay || "").slice(0, 10);
    if (!key) return;
    byDay.set(key, (byDay.get(key) || 0) + Number(row.amount || row.reward || 0));
  });
  return Array.from({ length: 30 }, (_, index) => {
    const day = new Date(today);
    day.setDate(today.getDate() - (29 - index));
    const key = day.toISOString().slice(0, 10);
    return byDay.get(key) || 0;
  });
}

function accountMatches(row = {}, account = currentAccount) {
  const address = String(account?.ethAddr || connectedAddress || "").toLowerCase();
  const twitterId = String(account?.twitterId || "");
  const username = String(account?.twitterUsername || "").toLowerCase();
  return Boolean(
    (address && String(row.ethAddr || row.address || row.holder || row.owner || "").toLowerCase() === address) ||
      (twitterId && String(row.twitterId || row.userId || "") === twitterId) ||
      (username && String(row.twitterUsername || row.username || "").toLowerCase() === username)
  );
}

function renderHubPreview(model = {}) {
  const user = model.user || currentAccount || currentIpshares[0] || {};
  const tweets = model.tweets || currentTweets;
  const tweetCount = tweets.length || 0;
  const credit = Number(model.credit ?? user.credit ?? 0);
  const buidlAmount = Number(model.buidlAmount ?? 0);
  const buidlUsd = Number(model.buidlUsd ?? 0);
  const social = model.social || {};

  const userProfile = profileImageUrl(user);
  const avatar = $("#hubAvatar");
  if (avatar) {
    avatar.innerHTML = userProfile ? `<img src="${userProfile}" alt="">` : `<span>${displayName(user).slice(0, 1)}</span>`;
  }
  $("#hubName").textContent = displayName(user, "—");
  $("#hubHandle").textContent = user.twitterUsername ? `@${user.twitterUsername}` : connectedAddress ? compactAddress(connectedAddress) : user.ethAddr ? compactAddress(user.ethAddr) : "—";
  $("#hubSocial").textContent = `${formatNumber(social.posts ?? tweetCount)} 条帖子 · ${formatNumber(social.followings ?? user.followings ?? 0)} 位 Following · ${formatNumber(social.followers ?? user.followers ?? 0)} 位 Followers`;
  const opValue = Number(model.op ?? user.op ?? 0);
  const vpValue = Number(model.vp ?? user.vp ?? 0);
  if ($("#hubOp")) $("#hubOp").textContent = formatNumber(opValue);
  if ($("#hubVp")) $("#hubVp").textContent = formatNumber(vpValue);
  $("#hubBuidl").textContent = formatNumber(buidlAmount);
  $("#hubBuidl").nextElementSibling.textContent = buidlUsd ? `约 ${formatUsd(buidlUsd)}` : "—";
  $("#hubCredit").textContent = formatNumber(credit);
  $("#hubCredit").nextElementSibling.textContent = `${formatNumber(model.signalHits ?? 0)}信号命中`;

  const ipshareSubject = model.ipshare?.ethAddr || user.ethAddr || connectedAddress || "";
  const rawSupply = Number(
    Object.prototype.hasOwnProperty.call(model, "ipshare") && model.ipshare
      ? model.ipshare?.shareSupply || model.ipshare?.supply || 0
      : user.supply || user.shareSupply || 0
  );
  // API returns supply in wei (1e18 units) — convert to human-readable
  const supply = rawSupply > 1e12 ? rawSupply / 1e18 : rawSupply;
  $("#hubIpSupply").textContent = formatNumber(supply);
  $("#hubIpPrice").textContent = `$${formatNumber((model.ipPrice ?? (ipsharePriceLocal(supply) * bnbUsd)) || 0)}`;
  $("#hubIpTvl").textContent = `${formatNumber((model.ipTvl ?? ipshareTvlLocal(supply)) || 0)} $BNB`;
  $("#hubFeeIncome").textContent = model.feeIncome !== undefined ? `$${formatNumber(model.feeIncome)}` : "$0";

  // Store current IPShare context for Trade/Stake actions
  window._hubIpshareContext = { supply, subject: ipshareSubject, pricePerShare: ipsharePriceLocal(supply) };
  const weeklyReward = Number(model.weeklyReward || 0);
  // Mining card total must equal the sum of its two displayed rows (信号发布 + 验证投票).
  const miningTotal = Number(model.signalReward || 0) + Number(model.voteReward || 0);
  const miningCaption = $("#hubMiningCaption");
  const proofCaption = $("#hubProofCaption");
  if (miningCaption) miningCaption.textContent = `7天 · ${formatNumber(miningTotal)} $BUIDL`;
  if (proofCaption) proofCaption.textContent = `7天 · ${formatNumber(weeklyReward)} $BUIDL`;

  const signalValue = model.requiresLogin ? 0 : (model.buidlPostsLast7d ?? tweetCount);

  // Reputation metrics from creditFactor:
  // Based on BUIDL community creditPolicy:
  // [0]=Donation, [1]=BUIDL Balance, [2]=BUIDL-LP Balance, [3]=Twitter Reputation,
  // [4]=IPShare MCap, [5]=TTAI Balance, [6]=TagAI Point
  // IPShare = factor[4], 社区经济参与 = all except [3](twitter rep) and [4](ipshare)
  // 信号发布, 社交交易, 验证投票 = not yet in credit algorithm (show 0)
  const cf = model.creditFactor;
  let cfIpshare = 0, cfEconomy = 0;
  if (Array.isArray(cf)) {
    cfIpshare = Number(cf[4] || 0);
    // Economy = Donation[0] + BUIDL Balance[1] + BUIDL-LP[2] + TTAI Balance[5] + TagAI Point[6]
    cfEconomy = Number(cf[0] || 0) + Number(cf[1] || 0) + Number(cf[2] || 0) + Number(cf[5] || 0) + Number(cf[6] || 0);
  }

  buildScoreRows("#reputationMetrics", [
    { label: "IPShare", value: formatNumber(cfIpshare), rawValue: cfIpshare },
    { label: "信号发布", value: 0 },
    { label: "社交交易", value: 0 },
    { label: "验证投票", value: 0 },
    { label: "社区经济参与", value: formatNumber(cfEconomy), rawValue: cfEconomy }
  ]);
  buildScoreRows("#actionTrace", [
    { label: "信号发布", value: signalValue },
    { label: "社交交易", value: model.blinksCount ?? 0 },
    { label: "验证投票", value: model.voteCount ?? 0 },
    { label: "点赞", value: model.likeCount ?? 0 },
    { label: "评论", value: model.replyCount ?? 0 },
    { label: "转发", value: model.retweetCount ?? 0 }
  ]);
  buildScoreRows("#miningRewards", [
    { label: "信号发布", value: formatNumber(model.signalReward ?? 0), rawValue: model.signalReward ?? 0 },
    { label: "验证投票", value: formatNumber(model.voteReward ?? 0), rawValue: model.voteReward ?? 0 }
  ]);
  buildScoreRows("#proofMetrics", [
    { label: "信号发布", value: signalValue },
    { label: "社交交易", value: model.blinksCount ?? 0 },
    { label: "验证投票", value: model.voteCount ?? 0 }
  ]);
  if (model.requiresLogin) {
    $("#hubRecentSignals").innerHTML = `<article class="mini-post"><strong>Login required</strong><p>Hub 只展示当前 TagAI accountInfo 的个人信号数据。</p><footer>Privy Twitter / Email</footer></article>`;
    $("#hubRecentVotes").innerHTML = `<article class="mini-post"><strong>Login required</strong><p>验证投票和互动数据需要 AccessToken + twitterId。</p><footer>checkTwitterAuth</footer></article>`;
  } else {
    renderMiniFeed("#hubRecentSignals", tweets, "signal");
    renderMiniFeed("#hubRecentVotes", model.votes || tweets.slice().reverse(), "vote");
  }
  drawReputation();
  drawRewardChart();
}

async function loadHubData(opts = {}) {
  const account = accountStore.getAccount();
  // Gate on twitterId only (consistent with renderAccountState's "logged in" =
  // Boolean(account)). All hub GET endpoints work with just twitterId; the two
  // auth-only POST endpoints (holdingList/getVPOP) degrade gracefully via .catch.
  // Requiring accessToken here caused a logged-in user with no/stale JWT to see
  // an empty "请登录" hub while the rest of the UI showed them as signed in.
  if (!account?.twitterId) {
    hubRewardSeries = buildThirtyDaySeries([]);
    const chartCaption = $("#chartCaption");
    if (chartCaption) chartCaption.textContent = "过去30天收益为 0 $BUIDL";
    renderHubPreview({
      user: { twitterName: "请登录 TagAI 账户", twitterUsername: "connect" },
      tweets: [],
      credit: 0,
      buidlAmount: 0,
      buidlUsd: 0,
      social: { posts: 0 },
      signalHits: 0,
      requiresLogin: true
    });
    return;
  }
  // Guard against concurrent calls causing flash
  if (_hubLoadInFlight) return;
  // Dedupe redundant re-triggers (e.g. renderRoute + loadBuidlData both fire on a
  // fresh /hub load). A second batch fires ~30 concurrent requests and can get
  // degraded responses that overwrite the good first render — that was the source
  // of values flickering correct↔wrong each load. User actions pass { force: true }.
  if (!opts.force && Date.now() - _hubLastLoadAt < 2500) return;
  _hubLoadInFlight = true;

  try {
  const ethAddr = account.ethAddr;
  const twitterId = account?.twitterId;
  const username = account?.twitterUsername;

  const [, credits, communityTweets, profile, userTweets, userBlinks, rewards, unclaimed, dailyRewards, ipshare, kolFee, capturedFee, holdingList, vpop, ipshareList] =
    await Promise.all([
      apiGet("/community/detail", { tick: TICK }).then((community) => {
        currentCommunity = community || currentCommunity;
        return currentCommunity;
      }).catch(() => currentCommunity),
      apiGet("/community/communityCredits", { tick: TICK, pages: 0 }).catch(() => []),
      apiGet("/curation/communityTweets", { tick: TICK, pages: 0, twitterId }).catch(() => currentTweets),
      apiGet("/user/getUserProfile", { twitterId }).catch(() => account),
      apiGet("/curation/userTweets", { twitterId, pages: 0 }).catch(() => []),
      apiGet("/curation/userBlinks", { twitterId, pages: 0 }).catch(() => []),
      apiGet("/curation/userCurationRewards", { twitterId, tick: TICK }).catch(() => []),
      apiGet("/curation/userUnclaimableCurationRewards", { twitterId, tick: TICK }).catch(() => []),
      apiGet("/curation/userDailyCurationRewards", { twitterId, tick: TICK, days: 30 }).catch(() => []),
      ethAddr ? apiGet("/user/ipshare", { ethAddr }).catch(() => null) : Promise.resolve(null),
      ethAddr ? apiGet("/ipshare/kolFee", { ethAddr }).catch(() => 0) : Promise.resolve(0),
      ethAddr ? apiGet("/ipshare/capturedFee", { ethAddr }).catch(() => 0) : Promise.resolve(0),
      ethAddr ? apiPost("/community/holdingList", { twitterId, ethAddr }).catch(() => []) : Promise.resolve([]),
      apiPost("/user/getVPOP", { twitterId }).catch(() => null),
      apiGet("/ipshare/list", { pages: 0 }).catch(() => currentIpshares)
    ]);

  if (Array.isArray(communityTweets) && communityTweets.length) currentTweets = communityTweets;
  if (Array.isArray(ipshareList) && ipshareList.length) currentIpshares = ipshareList;
  if ((profile && typeof profile === "object") || (vpop && typeof vpop === "object")) {
    const patch = { ...(profile || {}), ...(vpop || {}) };
    // getUserProfile/getVPOP can return null/blank identity fields (e.g. ethAddr:null).
    // Never let them clobber the session's wallet/identity — otherwise the next hub
    // load keys off a wrong/empty ethAddr and twitterId, breaking BUIDL holdings,
    // IPShare and the credit-row match, which makes values flicker correct↔wrong
    // on every reload. Keep whatever the account already has.
    for (const key of ["ethAddr", "twitterId", "twitterUsername", "accessToken"]) {
      if (account[key]) delete patch[key];
    }
    accountStore.patchAccount(patch, { refreshHub: false });
  }

  // Resolve IPShare data for current user: prefer direct API result, fallback to list match
  let resolvedIpshare = null;
  if (ipshare && typeof ipshare === "object" && (Number(ipshare.supply || ipshare.shareSupply || 0) > 0 || ipshare.created)) {
    resolvedIpshare = ipshare;
  } else if (Array.isArray(ipshareList) && ipshareList.length) {
    // Try to find user in the full IPShare list by ethAddr or twitterUsername
    const lowerEth = String(ethAddr || "").toLowerCase();
    const lowerUsername = String(username || "").toLowerCase();
    resolvedIpshare = ipshareList.find((row) =>
      (lowerEth && String(row.ethAddr || "").toLowerCase() === lowerEth) ||
      (lowerUsername && String(row.twitterUsername || "").toLowerCase() === lowerUsername)
    ) || null;
  }

  const ownCredit = Array.isArray(credits) ? credits.find((row) => accountMatches(row, account)) || credits.find((row) => String(row.twitterUsername || "").toLowerCase() === username.toLowerCase()) : null;
  const buidlCommunityTweets = (Array.isArray(communityTweets) && communityTweets.length ? communityTweets : currentTweets).filter(isBuidlRow);
  // personalTweets: all user tweets (not filtered by BUIDL tick — user may post across communities)
  const personalTweets = Array.isArray(userTweets) && userTweets.length ? userTweets : currentTweets.filter((row) => accountMatches(row, account));
  // BUIDL-specific personal tweets (for signal stats)
  const personalBuidlTweets = personalTweets.filter(isBuidlRow);
  // Posts in last 7 days in BUIDL community
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const buidlPostsLast7d = personalBuidlTweets.filter((t) => {
    const time = new Date(t.tweetTime || 0).getTime();
    return time > sevenDaysAgo;
  });
  const personalBlinks = (Array.isArray(userBlinks) ? userBlinks : []).filter(isBuidlRow);
  // Validation: BUIDL community tweets the user interacted with (liked, replied, curated)
  const validationTweets = buidlCommunityTweets.filter((row) => !accountMatches(row, account) && hasUserInteraction(row));
  // userVoteCount: VP interactions only (liked + replied + retweeted — all cost VP)
  const userLikeCount = validationTweets.reduce((sum, item) => sum + Number(item.liked || 0), 0);
  const userReplyCount = validationTweets.reduce((sum, item) => sum + Number(item.replied || 0), 0);
  const userRetweetCount = validationTweets.reduce((sum, item) => sum + Number(item.retweeted || 0), 0);
  const userVoteCount = userLikeCount + userReplyCount + userRetweetCount;
  const rewardRows = [...(Array.isArray(rewards) ? rewards : []), ...(Array.isArray(unclaimed) ? unclaimed : [])].filter((row) => !row.tick || String(row.tick).toUpperCase() === TICK);
  const rewardTotal = rewardRows.reduce((sum, row) => sum + Number(row.amount || row.reward || row.authorAmount || row.curateAmount || 0), 0);
  // Split rewards: only count past 7 days
  const signalRewardAmount = buidlPostsLast7d.reduce((sum, t) => sum + Number(t.authorAmount || 0), 0);
  const curationRewardAmount = buidlPostsLast7d.reduce((sum, t) => sum + Number(t.curateAmount || 0), 0);
  // If we have unclaimed rewards that aren't split, attribute them to curation
  const totalClaimableReward = rewardTotal + signalRewardAmount + curationRewardAmount;
  const holdingRows = Array.isArray(holdingList?.list) ? holdingList.list : Array.isArray(holdingList) ? holdingList : [];
  const buidlHolding = holdingRows.find((row) => String(row.tick || row.symbol || row.tokenName || row.community?.tick || "").toUpperCase() === TICK);
  const buidlAmount = tokenAmountFromRow(buidlHolding);
  // If /community/holdingList (auth-only POST) didn't return the BUIDL holding, we
  // read the real ERC20 balance on-chain — but do NOT await it here. It must never
  // block the hub render: an unreachable/slow public RPC would otherwise hang
  // loadHubData forever and the page would show no data. See updateHubBuidlOnchain
  // called after renderHubPreview below.
  const tokenPrice =
    Number(buidlHolding?.price || buidlHolding?.community?.price || currentCommunity?.price || currentCommunity?.usdPrice || currentCommunity?.tokenPrice || 0) ||
    Number(currentCommunity?.marketCap || 0) * bnbUsd;
  hubRewardSeries = buildThirtyDaySeries(Array.isArray(dailyRewards) ? dailyRewards : []);
  const thirtyDayRewardTotal = hubRewardSeries.reduce((sum, value) => sum + value, 0);
  const weeklyRewardTotal = hubRewardSeries.slice(-7).reduce((sum, value) => sum + value, 0);
  const chartCaption = $("#chartCaption");
  if (chartCaption) chartCaption.textContent = `过去30天收益为 ${formatNumber(thirtyDayRewardTotal)} $BUIDL`;

  const model = {
    user: { ...accountStore.getAccount(), ...(profile || {}), ...(ownCredit || {}) },
    tweets: personalTweets,
    votes: validationTweets,
    ipshare: resolvedIpshare,
    credit: ownCredit?.credit ?? profile?.credit ?? vpop?.credit ?? account?.credit ?? account?.vp ?? 0,
    creditFactor: ownCredit?.creditFactor || null,
    buidlAmount,
    buidlUsd: tokenPrice && buidlAmount ? tokenPrice * buidlAmount : 0,
    social: { posts: personalTweets.length },
    // OP/VP from /user/getVPOP (auth-only; falls back to whatever is on the account).
    op: Number((vpop && vpop.op) ?? account?.op ?? 0),
    vp: Number((vpop && vpop.vp) ?? account?.vp ?? 0),
    signalHits: personalBuidlTweets.filter((t) => Number(t.authorAmount || t.curateAmount || 0) > 0).length,
    buidlPostsLast7d: buidlPostsLast7d.length,
    blinksCount: personalBlinks.length,
    voteCount: userVoteCount,
    replyCount: userReplyCount,
    likeCount: userLikeCount,
    retweetCount: userRetweetCount,
    economyCount: personalBlinks.length,
    weeklyReward: weeklyRewardTotal,
    signalReward: signalRewardAmount,
    // 验证投票（策展奖励）over the same 7-day window as the card caption,
    // sourced from /curation/userDailyCurationRewards (NOT the all-time claimable total).
    voteReward: weeklyRewardTotal,
    feeIncome: Number(kolFee || 0) + Number(capturedFee || 0)
  };
  renderHubPreview(model);
  _hubLastLoadAt = Date.now();
  // Non-blocking on-chain BUIDL holding fallback (only when holdingList gave none).
  if (!(buidlAmount > 0) && isHexAddress(ethAddr) && isHexAddress(currentCommunity?.token)) {
    updateHubBuidlOnchain(ethAddr, currentCommunity.token, tokenPrice);
  }
  } finally {
    _hubLoadInFlight = false;
  }
}

// Reads the real BUIDL ERC20 balance on-chain and patches just the hub holding
// field. Runs after the hub has already rendered, so a slow/unreachable RPC can
// never block the page (bscRpcCall is also timeout-bounded).
async function updateHubBuidlOnchain(ethAddr, token, tokenPrice) {
  try {
    const bal = await bscRpcCall("eth_call", [{ to: token, data: encodeAbi("0x70a08231", ["address"], [ethAddr]) }, "latest"]);
    const amount = Number(BigInt(bal || "0x0")) / 1e18;
    if (!(amount > 0) || window.location.pathname !== "/hub") return;
    const el = $("#hubBuidl");
    if (!el) return;
    el.textContent = formatNumber(amount);
    if (el.nextElementSibling) {
      const usd = tokenPrice && amount ? tokenPrice * amount : 0;
      el.nextElementSibling.textContent = usd ? `约 ${formatUsd(usd)}` : "—";
    }
  } catch (_) { /* RPC unavailable — keep the holdingList value */ }
}

function drawReputation() {
  const canvas = $("#reputationCanvas");
  if (!canvas) return;
  const context = canvas.getContext("2d");
  const cx = canvas.width / 2;
  const cy = canvas.height / 2 + 4;
  const radius = 78;
  const values = [0.72, 0.66, 0.82, 0.58, 0.74];
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#202020";
  context.lineWidth = 2;

  for (let ring = 1; ring <= 3; ring += 1) {
    context.beginPath();
    for (let i = 0; i < 5; i += 1) {
      const angle = -Math.PI / 2 + (i * Math.PI * 2) / 5;
      const x = cx + Math.cos(angle) * radius * (ring / 3);
      const y = cy + Math.sin(angle) * radius * (ring / 3);
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    context.stroke();
  }

  context.beginPath();
  values.forEach((value, i) => {
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    const x = cx + Math.cos(angle) * radius * value;
    const y = cy + Math.sin(angle) * radius * value;
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.closePath();
  context.fillStyle = "rgba(92, 119, 91, 0.18)";
  context.fill();
  context.stroke();
}

function drawRewardChart() {
  const canvas = $("#rewardCanvas");
  if (!canvas) return;
  const context = canvas.getContext("2d");
  const values = hubRewardSeries?.length
    ? hubRewardSeries
    : Array.from({ length: 30 }, (_, index) => 34 + Math.sin(index / 2.4) * 13 + (index % 6) * 4 + (index > 21 ? 12 : 0));
  const max = Math.max(...values, 1);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#202020";
  context.setLineDash([3, 7]);
  for (let y = 28; y < canvas.height - 26; y += 28) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();
  }
  context.setLineDash([]);
  const gap = canvas.width / values.length;
  values.forEach((value, index) => {
    const height = (value / max) * 100;
    context.fillStyle = index > 23 ? "#5c775b" : "#aeb5a6";
    context.fillRect(index * gap + 4, canvas.height - height - 24, Math.max(8, gap - 7), height);
  });
  context.fillStyle = "#625d54";
  context.font = "12px monospace";
  const high = Math.max(...values);
  const latest = values.at(-1) || 0;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  context.fillText(`Highest ${formatNumber(high)} · Latest ${formatNumber(latest)} · Avg ${formatNumber(avg)}`, 10, canvas.height - 6);
}

function renderAccountState() {
  const account = accountStore.getAccount();
  const walletButton = $("#walletButton");
  if (walletButton) {
    walletButton.classList.toggle("is-connected", Boolean(account));
    walletButton.setAttribute("aria-label", account ? `Account ${displayName(account)}` : "connect");
    if (account) {
      const profile = profileImageUrl(account);
      walletButton.innerHTML = `
        <span class="account-avatar small">${profile ? `<img src="${profile}" alt="">` : `<span>${displayName(account).slice(0, 1)}</span>`}</span>
        <span class="wallet-label">${safeText(account.twitterUsername || account.twitterName, "account")}</span>
      `;
    } else {
      walletButton.textContent = "connect";
    }
  }
  const summary = $("#accountSummary");
  if (summary) {
    summary.innerHTML = account
      ? `
        <div class="account-summary-profile">
          <span class="account-avatar">${profileImageUrl(account) ? `<img src="${profileImageUrl(account)}" alt="">` : `<span>${displayName(account).slice(0, 1)}</span>`}</span>
          <strong>${displayName(account)}</strong>
          <small>@${safeText(account.twitterUsername, account.twitterId)}</small>
        </div>
        <div><span>Wallet</span><strong>${account.ethAddr ? compactAddress(account.ethAddr) : "未绑定"}</strong><small>${account.accessToken ? "TagAI JWT active" : "需要 bondEth"}</small></div>
        <div><span>VP / OP</span><strong>${formatNumber(account.vp ?? 0)} / ${formatNumber(account.op ?? 0)}</strong><small>来自 tiptag-api getVPOP</small></div>
        <div><span>Account</span><strong>${account.accountType === 1 ? "Email" : "Twitter"}</strong><small>${account.walletType === 1 ? "Privy wallet" : "External wallet"}</small></div>
      `
      : `
        <div><span>Session</span><strong>未登录</strong><small>请使用 TagAI / Privy 登录</small></div>
        <div><span>Storage</span><strong>accountInfo</strong><small>唯一账户会话</small></div>
      `;
  }
  $("#loginTwitterButton")?.toggleAttribute("hidden", Boolean(account));
  $("#emailLoginForm")?.toggleAttribute("hidden", Boolean(account));
  const logout = $("#logoutButton");
  if (logout) logout.hidden = !account;
}

function setAccountStatus(message) {
  const status = $("#accountStatus");
  if (status) status.textContent = message || "";
}

function openAccountModal() {
  renderAccountState();
  $("#accountModal").hidden = false;
}

function closeAccountModal() {
  $("#accountModal").hidden = true;
}

async function logoutAccount() {
  await window.BUIDLaiPrivy?.logout?.().catch(() => {});
  accountStore.clear();
  setAccountStatus("已退出 TagAI accountInfo。");
}

async function pollTagaiLoginState(state) {
  for (let attempt = 0; attempt < 18; attempt += 1) {
    try {
      const result = await apiGet("/user/login", { state });
      if (result?.code === 3 && result.account) {
        accountStore.setAccount(result.account);
        history.replaceState({}, "", window.location.pathname);
        return;
      }
      if (result?.code && result.code !== 1) break;
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function completePrivyTwitterLogin({ privyAccessToken, accessToken, refreshToken }) {
  setAccountStatus("Twitter OAuth 已完成，正在向 tiptag-api 换取 TagAI accountInfo...");
  try {
    const account = await apiGet("/auth/login", { privyAccessToken, accessToken, refreshToken });
    const saved = accountStore.setAccount(account);
    if (!saved) throw new Error("tiptag-api did not return a valid accountInfo.");
    setAccountStatus("登录成功：已写入 TagAI accountInfo。");
    closeAccountModal();
    return saved;
  } catch (error) {
    const message = errorMessage(error, "tiptag-api /auth/login failed.");
    setAccountStatus(`Twitter login failed: ${message}`);
    throw error;
  }
}

async function completePrivyEmailLogin({ privyAccessToken, email }) {
  setAccountStatus("Email 验证已完成，正在向 tiptag-api 换取 TagAI accountInfo...");
  const account = await apiGet("/auth/loginEmail", { accessToken: privyAccessToken, email });
  const saved = accountStore.setAccount(account);
  if (!saved) throw new Error("tiptag-api did not return a valid accountInfo.");
  setAccountStatus("登录成功：已写入 TagAI accountInfo。");
  closeAccountModal();
  return saved;
}

async function bondEthByPrivyAccessToken({ privyAccessToken, ethAddr }) {
  const account = accountStore.getAccount();
  if (!account?.twitterId) return null;
  setAccountStatus("正在通过 tiptag-api 绑定 Privy embedded wallet...");
  await apiPost("/user/bondEthByPrivyAccessToken", {
    twitterId: account.twitterId,
    ethAddr,
    privyAccessToken
  });
  const saved = accountStore.patchAccount({ ethAddr, walletType: 1 });
  setAccountStatus("Privy embedded wallet 已绑定。");
  return saved;
}

window.BUIDLaiAccount = {
  getAccount: () => accountStore.getAccount(),
  setAccount: (account) => accountStore.setAccount(account),
  clear: () => accountStore.clear(),
  completePrivyTwitterLogin,
  completePrivyEmailLogin,
  bondEthByPrivyAccessToken
};

function setupAccountControls() {
  window.addEventListener("buidlai:account-status", (event) => setAccountStatus(event.detail?.message || ""));
  $("#accountModalClose")?.addEventListener("click", closeAccountModal);
  $("#accountModal")?.addEventListener("click", (event) => {
    if (event.target.id === "accountModal") closeAccountModal();
  });
  $("#accountWalletButton")?.addEventListener("click", () => {
    closeAccountModal();
    renderWalletMenu();
    $("#walletMenu").hidden = false;
  });
  $("#loginTwitterButton")?.addEventListener("click", () => {
    if (window.BUIDLaiPrivy?.loginWithTwitter) {
      setAccountStatus("正在打开 Privy Twitter OAuth...");
      window.BUIDLaiPrivy.loginWithTwitter();
    } else {
      setAccountStatus("请挂载 TagAI 同款 Privy React 登录适配器：Twitter OAuth 成功后调用 BUIDLaiAccount.completePrivyTwitterLogin。");
    }
  });
  $("#logoutButton")?.addEventListener("click", async () => {
    await logoutAccount();
  });
  $("#emailLoginForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#emailLoginInput");
    input.disabled = true;
    try {
      if (window.BUIDLaiPrivy?.loginWithEmail) {
        await window.BUIDLaiPrivy.loginWithEmail(input.value);
      } else {
        setAccountStatus("请挂载 TagAI 同款 Privy Email 登录适配器：完成验证码后调用 BUIDLaiAccount.completePrivyEmailLogin。");
      }
    } catch {
      setAccountStatus("Email 登录失败，请稍后重试。");
    } finally {
      input.disabled = false;
    }
  });
  const state = new URLSearchParams(window.location.search).get("state");
  if (state) pollTagaiLoginState(state);
  renderAccountState();
  loadPrivyAdapter();
}

async function loadPrivyAdapter() {
  try {
    const response = await fetch("/privy-adapter.js", { method: "HEAD", cache: "no-store" });
    if (!response.ok || !response.headers.get("content-type")?.includes("javascript")) return;
    await import("/privy-adapter.js");
  } catch {
    // The adapter is optional until `npm run build:privy` has been run.
  }
}

function setupWalletButton() {
  const button = $("#walletButton");
  const menu = $("#walletMenu");
  button.addEventListener("click", () => {
    renderWalletMenu();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".wallet-zone")) menu.hidden = true;
  });
}

function startClock() {
  const clock = $("#clock");
  const tick = () => {
    clock.textContent = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date());
  };
  tick();
  setInterval(tick, 30000);
}

function drawNetwork() {
  const canvas = $("#networkCanvas");
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#fbf7f1";
  context.fillRect(0, 0, width, height);

  const center = { x: width * 0.52, y: height * 0.52 };
  const nodes = Array.from({ length: 220 }, (_, index) => {
    const ring = index < 90 ? 90 : index < 150 ? 150 : 220;
    const angle = (index * 137.5 * Math.PI) / 180;
    const jitter = Math.sin(index * 7.1) * 26;
    return {
      x: center.x + Math.cos(angle) * (ring + jitter) * (0.65 + (index % 11) / 18),
      y: center.y + Math.sin(angle) * (ring + jitter) * (0.45 + (index % 7) / 18),
      strong: index % 17 === 0
    };
  });

  context.lineWidth = 0.55;
  nodes.forEach((node, index) => {
    if (index % 3 !== 0) return;
    const target = nodes[(index * 13) % nodes.length];
    context.strokeStyle = index % 5 === 0 ? "rgba(255, 141, 38, 0.28)" : "rgba(69, 100, 69, 0.28)";
    context.beginPath();
    context.moveTo(node.x, node.y);
    context.lineTo(target.x, target.y);
    context.stroke();
  });

  nodes.forEach((node, index) => {
    context.beginPath();
    context.fillStyle = node.strong ? "#5c775b" : index % 8 === 0 ? "#ff8d26" : "rgba(75, 96, 76, 0.62)";
    context.arc(node.x, node.y, node.strong ? 3.6 : 1.6, 0, Math.PI * 2);
    context.fill();
  });
}

// ======================== IPShare Trade / Stake ========================

const IPSHARE_CONTRACT = "0x95450AaD4Cc195e03BB4791B7f6f04aC6D9BA922";
const BSC_CHAIN_ID = 56;
const BSC_CHAIN_ID_HEX = "0x38";

// IPShare3 ABI fragments (only what we need)
const IPSHARE_ABI = {
  buyShares: "function buyShares(address subject, address buyer, uint256 amount) payable",
  sellShares: "function sellShares(address subject, uint256 amount, uint256 expectReceive)",
  stake: "function stake(address subject, uint256 amount)",
  unstake: "function unstake(address subject, uint256 amount)",
  redeem: "function redeem(address subject)",
  claim: "function claim(address subject)",
  ipshareBalance: "function ipshareBalance(address subject, address holder) view returns (uint256)",
  getStakerInfo: "function getStakerInfo(address subject, address staker) view returns (address, uint256, uint256, uint256, uint256, uint256)",
  getBuyPriceAfterFee: "function getBuyPriceAfterFee(address subject, uint256 amount) view returns (uint256)",
  getSellPriceAfterFee: "function getSellPriceAfterFee(address subject, uint256 amount) view returns (uint256)"
};

// Encode function calls for IPShare contract
function encodeFunctionData(signature, args) {
  // Simple ABI encoding for known IPShare functions
  const funcName = signature.split("(")[0].replace("function ", "").trim();
  const selectorMap = {
    buyShares: "0xdd06f6bd",
    sellShares: "0x39952b88",
    stake: "0xadc9772e",
    unstake: "0xc2a672e0",
    redeem: "0x95a2251f",
    claim: "0x1e83409a",
    ipshareBalance: "0xad76a521",
    getStakerInfo: "0x59d1d9bf",
    getBuyPriceAfterFee: "0x0f026f6d",
    getSellPriceAfterFee: "0x2267a89c"
  };
  const selector = selectorMap[funcName];
  if (!selector) throw new Error(`Unknown function: ${funcName}`);
  const encoded = args.map((arg) => {
    if (typeof arg === "bigint") return arg.toString(16).padStart(64, "0");
    if (typeof arg === "string" && arg.startsWith("0x")) return arg.slice(2).padStart(64, "0").toLowerCase();
    return BigInt(arg).toString(16).padStart(64, "0");
  });
  return selector + encoded.join("");
}

function toWei(value) {
  return BigInt(Math.floor(Number(value) * 1e18));
}

function fromWei(value) {
  return Number(BigInt(value)) / 1e18;
}

// Calculate buy cost locally (with 7% fee)
function calculateBuyCost(supply, amount) {
  const price = (amount * (amount ** 2 + 3 * amount * supply + 3 * (supply ** 2))) / 300000;
  return price / 0.93;
}

// Calculate sell proceeds locally (with 7% fee)
function calculateSellProceeds(supply, sellAmount) {
  const newSupply = supply - sellAmount;
  const price = (sellAmount * (sellAmount ** 2 + 3 * sellAmount * newSupply + 3 * (newSupply ** 2))) / 300000;
  return price * 0.93;
}

async function ensureBscChain(provider) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BSC_CHAIN_ID_HEX }]
    });
  } catch (switchError) {
    if (switchError.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: BSC_CHAIN_ID_HEX,
          chainName: "BNB Smart Chain",
          nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
          rpcUrls: ["https://bsc-dataseed.binance.org"],
          blockExplorerUrls: ["https://bscscan.com/"]
        }]
      });
    } else {
      throw switchError;
    }
  }
}

async function callContract(provider, from, to, data, value = "0x0") {
  return provider.request({
    method: "eth_sendTransaction",
    params: [{
      from,
      to,
      data,
      value
    }]
  });
}

async function readContract(provider, to, data) {
  return provider.request({
    method: "eth_call",
    params: [{ to, data }, "latest"]
  });
}

let tradeMode = "buy";
let stakeMode = "stake";

function openTradeModal() {
  const ctx = window._hubIpshareContext || {};
  const account = accountStore.getAccount();
  const subject = ctx.subject || account?.ethAddr || "";
  $("#tradeSubjectAddr").textContent = subject ? compactAddress(subject) : "未绑定钱包";
  $("#tradeCurrentSupply").textContent = formatNumber(ctx.supply || 0);
  $("#tradeCurrentPrice").textContent = `${formatNumber(ctx.pricePerShare || 0)} BNB`;
  tradeMode = "buy";
  $("#tradeBuyTab").classList.add("is-active");
  $("#tradeSellTab").classList.remove("is-active");
  $("#tradeAmountLabel").textContent = "Buy Amount (shares)";
  $("#tradeSubmitButton").textContent = "Buy IPShare";
  $("#tradeAmountInput").value = "1";
  updateTradeCost();
  $("#tradeStatus").textContent = "";
  $("#ipshareTradeModal").hidden = false;
}

function openStakeModal() {
  const ctx = window._hubIpshareContext || {};
  const account = accountStore.getAccount();
  const subject = ctx.subject || account?.ethAddr || "";
  $("#stakeSubjectAddr").textContent = subject ? compactAddress(subject) : "未绑定钱包";
  $("#stakeBalance").textContent = "查询中...";
  $("#stakeCurrentAmount").textContent = "查询中...";
  stakeMode = "stake";
  $("#stakeTab").classList.add("is-active");
  $("#unstakeTab").classList.remove("is-active");
  $("#stakeAmountLabel").textContent = "Stake Amount (shares)";
  $("#stakeSubmitButton").textContent = "Stake IPShare";
  $("#stakeAmountInput").value = "1";
  $("#stakeStatus").textContent = "";
  $("#ipshareStakeModal").hidden = false;
  loadStakeBalances(subject);
}

async function loadStakeBalances(subject) {
  if (!activeProvider || !connectedAddress || !subject) {
    $("#stakeBalance").textContent = "请先连接钱包";
    $("#stakeCurrentAmount").textContent = "-";
    return;
  }
  try {
    await ensureBscChain(activeProvider);
    const balanceData = encodeFunctionData("ipshareBalance", [subject, connectedAddress]);
    const balanceResult = await readContract(activeProvider, IPSHARE_CONTRACT, balanceData);
    const balance = fromWei(balanceResult);
    $("#stakeBalance").textContent = `${formatNumber(balance)} shares`;

    const stakerData = encodeFunctionData("getStakerInfo", [subject, connectedAddress]);
    const stakerResult = await readContract(activeProvider, IPSHARE_CONTRACT, stakerData);
    // getStakerInfo returns (address, uint256 stakedAmount, uint256, uint256, uint256, uint256)
    const stakedHex = "0x" + stakerResult.slice(66, 130);
    const staked = fromWei(stakedHex);
    $("#stakeCurrentAmount").textContent = `${formatNumber(staked)} shares`;
  } catch (error) {
    $("#stakeBalance").textContent = "查询失败";
    $("#stakeCurrentAmount").textContent = "查询失败";
  }
}

function updateTradeCost() {
  const ctx = window._hubIpshareContext || {};
  const supply = ctx.supply || 0;
  const amount = Number($("#tradeAmountInput").value) || 0;
  if (amount <= 0) {
    $("#tradeCostValue").textContent = "0 BNB";
    $("#tradeCostUsd").textContent = "≈ $0";
    return;
  }
  if (tradeMode === "buy") {
    const cost = calculateBuyCost(supply, amount);
    $("#tradeCostLabel").textContent = "Estimated cost:";
    $("#tradeCostValue").textContent = `${formatNumber(cost)} BNB`;
    $("#tradeCostUsd").textContent = `≈ ${formatUsd(cost * bnbUsd)}`;
  } else {
    const proceeds = calculateSellProceeds(supply, Math.min(amount, supply));
    $("#tradeCostLabel").textContent = "Estimated receive:";
    $("#tradeCostValue").textContent = `${formatNumber(proceeds)} BNB`;
    $("#tradeCostUsd").textContent = `≈ ${formatUsd(proceeds * bnbUsd)}`;
  }
}

async function handleTrade(event) {
  event.preventDefault();
  const ctx = window._hubIpshareContext || {};
  const subject = ctx.subject;
  const supply = ctx.supply || 0;
  const amount = Number($("#tradeAmountInput").value) || 0;

  if (!subject) return setTradeStatus("无法交易：用户未绑定钱包地址。");
  if (!activeProvider || !connectedAddress) return setTradeStatus("请先连接 OKX / MetaMask 钱包。");
  if (amount <= 0) return setTradeStatus("请输入有效的数量。");

  try {
    await ensureBscChain(activeProvider);
    const amountWei = toWei(amount);

    if (tradeMode === "buy") {
      const cost = calculateBuyCost(supply, amount);
      const costWei = toWei(cost * 1.02); // 2% slippage buffer
      const slippageAmount = toWei(amount * 0.98);
      const data = encodeFunctionData("buyShares", [subject, connectedAddress, slippageAmount]);
      setTradeStatus("等待钱包确认交易...");
      const hash = await callContract(activeProvider, connectedAddress, IPSHARE_CONTRACT, data, "0x" + costWei.toString(16));
      setTradeStatus(`交易已提交: ${compactAddress(hash)}。等待确认...`);
      setTimeout(() => loadHubData({ force: true }), 5000);
    } else {
      const proceeds = calculateSellProceeds(supply, amount);
      const expectWei = toWei(proceeds * 0.95); // 5% slippage tolerance
      const data = encodeFunctionData("sellShares", [subject, amountWei, expectWei]);
      setTradeStatus("等待钱包确认交易...");
      const hash = await callContract(activeProvider, connectedAddress, IPSHARE_CONTRACT, data);
      setTradeStatus(`卖出交易已提交: ${compactAddress(hash)}。等待确认...`);
      setTimeout(() => loadHubData({ force: true }), 5000);
    }
  } catch (error) {
    setTradeStatus(`交易失败: ${errorMessage(error, "请检查钱包余额或网络")}`);
  }
}

async function handleStake(event) {
  event.preventDefault();
  const ctx = window._hubIpshareContext || {};
  const subject = ctx.subject;
  const amount = Number($("#stakeAmountInput").value) || 0;

  if (!subject) return setStakeStatus("无法质押：用户未绑定钱包地址。");
  if (!activeProvider || !connectedAddress) return setStakeStatus("请先连接 OKX / MetaMask 钱包。");
  if (amount <= 0) return setStakeStatus("请输入有效的数量。");

  try {
    await ensureBscChain(activeProvider);
    const amountWei = toWei(amount);

    if (stakeMode === "stake") {
      const data = encodeFunctionData("stake", [subject, amountWei]);
      setStakeStatus("等待钱包确认质押交易...");
      const hash = await callContract(activeProvider, connectedAddress, IPSHARE_CONTRACT, data);
      setStakeStatus(`质押交易已提交: ${compactAddress(hash)}。等待确认...`);
      setTimeout(() => { loadHubData({ force: true }); loadStakeBalances(subject); }, 5000);
    } else {
      const data = encodeFunctionData("unstake", [subject, amountWei]);
      setStakeStatus("等待钱包确认解除质押交易...");
      const hash = await callContract(activeProvider, connectedAddress, IPSHARE_CONTRACT, data);
      setStakeStatus(`解除质押交易已提交: ${compactAddress(hash)}。等待确认...`);
      setTimeout(() => { loadHubData({ force: true }); loadStakeBalances(subject); }, 5000);
    }
  } catch (error) {
    setStakeStatus(`质押操作失败: ${errorMessage(error, "请检查余额或网络")}`);
  }
}

function setTradeStatus(msg) { $("#tradeStatus").textContent = msg || ""; }
function setStakeStatus(msg) { $("#stakeStatus").textContent = msg || ""; }

function setupIpshareControls() {
  // Trade modal
  $("#hubTradeButton")?.addEventListener("click", openTradeModal);
  $("#ipshareTradeClose")?.addEventListener("click", () => { $("#ipshareTradeModal").hidden = true; });
  $("#ipshareTradeModal")?.addEventListener("click", (e) => { if (e.target.id === "ipshareTradeModal") $("#ipshareTradeModal").hidden = true; });
  $("#tradeBuyTab")?.addEventListener("click", () => {
    tradeMode = "buy";
    $("#tradeBuyTab").classList.add("is-active");
    $("#tradeSellTab").classList.remove("is-active");
    $("#tradeAmountLabel").textContent = "Buy Amount (shares)";
    $("#tradeSubmitButton").textContent = "Buy IPShare";
    updateTradeCost();
  });
  $("#tradeSellTab")?.addEventListener("click", () => {
    tradeMode = "sell";
    $("#tradeSellTab").classList.add("is-active");
    $("#tradeBuyTab").classList.remove("is-active");
    $("#tradeAmountLabel").textContent = "Sell Amount (shares)";
    $("#tradeSubmitButton").textContent = "Sell IPShare";
    updateTradeCost();
  });
  $("#tradeAmountInput")?.addEventListener("input", updateTradeCost);
  $("#ipshareTradeForm")?.addEventListener("submit", handleTrade);

  // Stake modal
  $("#hubStakeButton")?.addEventListener("click", openStakeModal);
  $("#ipshareStakeClose")?.addEventListener("click", () => { $("#ipshareStakeModal").hidden = true; });
  $("#ipshareStakeModal")?.addEventListener("click", (e) => { if (e.target.id === "ipshareStakeModal") $("#ipshareStakeModal").hidden = true; });
  $("#stakeTab")?.addEventListener("click", () => {
    stakeMode = "stake";
    $("#stakeTab").classList.add("is-active");
    $("#unstakeTab").classList.remove("is-active");
    $("#stakeAmountLabel").textContent = "Stake Amount (shares)";
    $("#stakeSubmitButton").textContent = "Stake IPShare";
  });
  $("#unstakeTab")?.addEventListener("click", () => {
    stakeMode = "unstake";
    $("#unstakeTab").classList.add("is-active");
    $("#stakeTab").classList.remove("is-active");
    $("#stakeAmountLabel").textContent = "Unstake Amount (shares)";
    $("#stakeSubmitButton").textContent = "Unstake IPShare";
  });
  $("#stakeMaxButton")?.addEventListener("click", () => {
    const text = stakeMode === "stake" ? $("#stakeBalance").textContent : $("#stakeCurrentAmount").textContent;
    const value = parseFloat(text) || 0;
    if (value > 0) $("#stakeAmountInput").value = value.toString();
  });
  $("#ipshareStakeForm")?.addEventListener("submit", handleStake);
}

startClock();
registerInjectedProviders();
setupAccountControls();
setupWalletButton();
setupRouter();
setupSignalControls();
setupAgentsControls();
setupIpshareControls();
drawNetwork();
loadBuidlData();
