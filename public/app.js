const API_BASE = "/api";
const TICK = "BUIDL";

// ======================== i18n (zh / en) ========================
let currentLang = "zh";
try { currentLang = localStorage.getItem("lang") === "en" ? "en" : "zh"; } catch (_) { /* ignore */ }

// Pick the string for the active language. Used everywhere dynamic text is rendered.
function t(zh, en) { return currentLang === "en" ? en : zh; }

// Swap all static [data-zh]/[data-en] text + placeholders to the active language.
function applyStaticLang() {
  const en = currentLang === "en";
  document.querySelectorAll("[data-zh]").forEach((el) => {
    const val = el.getAttribute(en ? "data-en" : "data-zh");
    if (val != null) el.textContent = val;
  });
  document.querySelectorAll("[data-zh-ph]").forEach((el) => {
    const val = el.getAttribute(en ? "data-en-ph" : "data-zh-ph");
    if (val != null) el.setAttribute("placeholder", val);
  });
  document.documentElement.setAttribute("lang", en ? "en" : "zh-CN");
}

function setLang(lang) {
  currentLang = lang === "en" ? "en" : "zh";
  try { localStorage.setItem("lang", currentLang); } catch (_) { /* ignore */ }
  applyStaticLang();
  document.querySelectorAll(".lang-option").forEach((b) => {
    b.classList.toggle("is-active", b.getAttribute("data-lang") === currentLang);
  });
  // Re-render the active dynamic view so JS-generated text picks up the language.
  try { renderRoute(window.location.pathname); } catch (_) { /* ignore */ }
  try { renderActivityTicker(); } catch (_) { /* ignore */ }
  scheduleAlignHero();
}

function setupLangToggle() {
  document.querySelectorAll(".lang-option").forEach((b) => {
    b.addEventListener("click", () => setLang(b.getAttribute("data-lang")));
    b.classList.toggle("is-active", b.getAttribute("data-lang") === currentLang);
  });
  applyStaticLang();
}

// Align the home hero: the image top crosses the vertical center of the
// Explore card, while the protocol label shares the card's top edge.
function alignHero() {
  const grid = document.querySelector(".hero-grid");
  const card = document.querySelector(".hero-grid .network-card");
  if (!grid || !card) return;
  if (window.matchMedia("(max-width: 980px)").matches) {
    grid.style.removeProperty("--hero-top-offset");
    return;
  }
  grid.style.setProperty("--hero-top-offset", `${Math.round(card.offsetHeight / 2)}px`);
}
const scheduleAlignHero = () => requestAnimationFrame(() => requestAnimationFrame(alignHero));

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
let signalFeedRequestId = 0;
let signalPageDataPromise = null;
let miniTags = [];
const SIGNAL_TAG_LOOKBACK_DAYS = 7;
const SIGNAL_TAG_FETCH_PAGES = 60;
const SIGNAL_TAG_PAGE_SIZE = 30;
const SIGNAL_POSTS_CUTOFF_TIME = Date.UTC(2026, 5, 1);
const BUIDLAI_CREDIT_FETCH_PAGES = 20;
let agentTab = "ipshare";
let currentCredits = [];
let currentBuidlaiCreditMap = new Map();
let buidlaiCreditsPromise = null;
let currentEarnRows = [];
let bnbUsd = 650;
let currentTrades = [];
let currentAccount = null;
let hubRewardSeries = null;
let communityActivities = [];
let activityIndex = 0;
let lastCommunityActivity = null;

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

function safeAttr(value, fallback = "") {
  return safeText(value, fallback)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function signalTweetTimeValue(tweet) {
  const raw = tweet?.tweetTime || tweet?.createdAt || tweet?.createTime || tweet?.timestamp || tweet?.time || tweet?.date;
  const value = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}

function filterSignalTweetsByCutoff(tweets) {
  return (Array.isArray(tweets) ? tweets : []).filter((tweet) => signalTweetTimeValue(tweet) >= SIGNAL_POSTS_CUTOFF_TIME);
}

function tweetIdentity(tweet) {
  return tweet?.tweetId || `${tweet?.twitterId || ""}-${tweet?.tweetTime || ""}-${tweet?.content || ""}`;
}

function mergeTweetRows(baseRows, nextRows) {
  const map = new Map();
  [...(Array.isArray(baseRows) ? baseRows : []), ...(Array.isArray(nextRows) ? nextRows : [])].forEach((tweet) => {
    const id = tweetIdentity(tweet);
    if (id) map.set(id, tweet);
  });
  return Array.from(map.values());
}

function translateActionType(actionType) {
  const action = String(actionType || "");
  const labels = {
    "Post Signal": t("发布信号", "Post Signal"),
    Buy: t("买入", "Buy"),
    Sell: t("卖出", "Sell"),
    Upvote: t("投票", "Upvote"),
    Comment: t("评论", "Comment"),
    Tip: t("打赏", "Tip"),
    "Dark Forest": t("黑暗森林", "Dark Forest")
  };
  return labels[action] || safeText(action, t("动态", "Activity"));
}

function activityTimeValue(row) {
  const raw = row?.timestamp || row?.createdAt || row?.createTime || row?.tweetTime || row?.time || row?.date;
  const value = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}

function buildFallbackActivity() {
  const candidates = [];
  const latestTweet = (Array.isArray(currentTweets) ? currentTweets : [])
    .slice()
    .sort((a, b) => activityTimeValue(b) - activityTimeValue(a))[0];
  if (latestTweet) {
    candidates.push({
      actionType: "Post Signal",
      actorId: latestTweet.twitterId || latestTweet.twitterUsername || latestTweet.ethAddr,
      actorName: latestTweet.twitterUsername || latestTweet.twitterName || latestTweet.twitterId,
      address: latestTweet.ethAddr || latestTweet.address,
      timestamp: latestTweet.tweetTime || latestTweet.createdAt || latestTweet.createTime
    });
  }
  const latestTrade = (Array.isArray(currentTrades) ? currentTrades : [])
    .slice()
    .sort((a, b) => activityTimeValue(b) - activityTimeValue(a))[0];
  if (latestTrade) {
    candidates.push({
      actionType: latestTrade.isBuy || latestTrade.side === "buy" || latestTrade.type === "buy" ? "Buy" : "Sell",
      actorId: latestTrade.twitterId || latestTrade.twitterUsername || latestTrade.trader || latestTrade.address,
      actorName: latestTrade.twitterUsername || latestTrade.twitterName || latestTrade.trader || latestTrade.address,
      address: latestTrade.trader || latestTrade.address || latestTrade.ethAddr,
      timestamp: latestTrade.timestamp || latestTrade.createdAt || latestTrade.time
    });
  }
  return candidates
    .filter((row) => row.actorId || row.actorName || row.address)
    .sort((a, b) => activityTimeValue(b) - activityTimeValue(a))[0] || null;
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
      tagLabel = cashtagMatch ? cashtagMatch[1] : (primaryTweetTag(tweet) || tweet.tick || TICK);
    }
    const score = tweetReward(tweet);
    const profileImg = getProfileImage(tweet);
    const initial = safeAttr(avatarInitial(tweet), "B");
    const card = document.createElement("article");
    card.className = "signal-post-card";
    card.innerHTML = `
      <div class="signal-avatar"><span>${initial}</span>${profileImg ? `<img src="${safeAttr(profileImg)}" alt="" loading="lazy" onerror="this.remove()">` : ""}</div>
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
      <div class="signal-score">${formatNumber(score || 0)}</div>
    `;
    feed.appendChild(card);
  });
}

function primaryTweetTag(tweet) {
  const tags = tweet?.tags;
  if (Array.isArray(tags)) return safeText(tags[0], "");
  if (typeof tags === "string" && tags.trim()) {
    try {
      const parsed = JSON.parse(tags);
      if (Array.isArray(parsed)) return safeText(parsed[0], "");
    } catch {
      return tags;
    }
  }
  return "";
}

function parseCreditFactor(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeLookupValue(value) {
  return String(value || "").trim().toLowerCase();
}

function buidlaiCreditKeys(row) {
  const keys = [];
  const twitterId = normalizeLookupValue(row?.twitterId);
  const username = normalizeLookupValue(row?.twitterUsername || row?.username);
  const ethAddr = normalizeLookupValue(row?.ethAddr || row?.address);
  if (twitterId) keys.push(`tid:${twitterId}`);
  if (username) keys.push(`tw:${username}`);
  if (ethAddr) keys.push(`addr:${ethAddr}`);
  return keys;
}

function rebuildBuidlaiCreditMap(rows) {
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const factor = parseCreditFactor(row?.creditFactor);
    const model = {
      credit: Number(row?.credit || 0),
      twitterReputation: Number(factor[3] || 0)
    };
    buidlaiCreditKeys(row).forEach((key) => map.set(key, model));
  });
  currentBuidlaiCreditMap = map;
  return map;
}

async function loadBuidlaiCreditMap() {
  if (buidlaiCreditsPromise) return buidlaiCreditsPromise;
  buidlaiCreditsPromise = (async () => {
    const rows = [];
    for (let page = 0; page < BUIDLAI_CREDIT_FETCH_PAGES; page += 1) {
      const pageRows = await apiGet("/community/communityCredits", { tick: TICK, pages: page }).catch(() => []);
      if (!Array.isArray(pageRows) || !pageRows.length) break;
      rows.push(...pageRows);
      if (pageRows.length < SIGNAL_TAG_PAGE_SIZE) break;
    }
    return rebuildBuidlaiCreditMap(rows.length ? rows : currentCredits);
  })().catch((error) => {
    buidlaiCreditsPromise = null;
    throw error;
  });
  return buidlaiCreditsPromise;
}

function buidlaiCreditForTweet(tweet) {
  for (const key of buidlaiCreditKeys(tweet)) {
    const match = currentBuidlaiCreditMap.get(key);
    if (match) return match;
  }
  return null;
}

function estimateTwitterReputation(tweet) {
  const followers = Math.max(0, Number(tweet?.followers || 0));
  if (!followers) return 0;
  const followings = Math.max(0, Number(tweet?.followings || 0));
  const audience = Math.log10(followers + 10);
  const balance = Math.log10(followers + 10) / Math.max(1, Math.log10(followings + 10));
  return Math.max(0, audience * audience * Math.min(2, Math.max(0.5, balance)));
}

function twitterReputationForTweet(tweet) {
  const credit = buidlaiCreditForTweet(tweet);
  const exact = Number(credit?.twitterReputation || 0);
  return exact > 0 ? exact : estimateTwitterReputation(tweet);
}

function tweetInteractionWeight(tweet) {
  return 1 +
    Number(tweet?.replyCount || 0) * 3 +
    Number(tweet?.curateCount || 0) * 3 +
    Number(tweet?.retweetCount || 0) * 2 +
    Number(tweet?.quoteCount || 0) * 2 +
    Number(tweet?.likeCount || 0);
}

function applyBuidlaiPoBAmounts(tweets) {
  const rows = Array.isArray(tweets) ? tweets : [];
  const pool = rows.reduce((sum, tweet) => sum + Number(tweet?.amount || 0), 0);
  const weights = rows.map((tweet) => twitterReputationForTweet(tweet) * tweetInteractionWeight(tweet));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  rows.forEach((tweet, index) => {
    const original = Number(tweet?.amount || 0);
    const score = pool > 0 && totalWeight > 0 ? pool * weights[index] / totalWeight : original;
    tweet.buidlaiPoBAmount = Number.isFinite(score) ? score : original;
    tweet.buidlaiTwitterReputation = twitterReputationForTweet(tweet);
  });
  return rows;
}

// The top-right reward shown on a signal card. BUIDLai uses a local PoB
// discovery score with Twitter Reputation as the only credit factor.
function tweetReward(tweet) {
  return Number(tweet?.buidlaiPoBAmount ?? tweet?.amount ?? 0);
}

function signalTagTimeWeight(tweetTime) {
  const time = new Date(tweetTime || 0).getTime();
  if (!Number.isFinite(time) || time <= 0) return 0;
  const ageMs = Date.now() - time;
  if (ageMs < 0) return 1;
  const ageDays = ageMs / (24 * 3600 * 1000);
  if (ageDays > SIGNAL_TAG_LOOKBACK_DAYS) return 0;
  if (ageDays <= 1) return 1;
  return Math.pow(0.5, ageDays - 1);
}

function tweetTrendingScore(tweet) {
  return Number(tweet.likeCount || 0) + Number(tweet.replyCount || 0) +
    Number(tweet.retweetCount || 0) + Number(tweet.quoteCount || 0) + Number(tweet.curateCount || 0);
}

// Order tweets by the active feed mode (Trending = engagement, New = recency).
function sortTweetsByMode(tweets, mode) {
  const arr = Array.isArray(tweets) ? [...tweets] : [];
  if (mode === "trending") {
    arr.sort((a, b) => (tweetTrendingScore(b) - tweetTrendingScore(a)) || (tweetReward(b) - tweetReward(a)));
  } else {
    arr.sort((a, b) => signalTweetTimeValue(b) - signalTweetTimeValue(a));
  }
  return arr;
}

// Does this tweet belong to the given sub-tag (by its tags[] field or a $CASHTAG)?
function tweetMatchesTag(tweet, tagName) {
  const upper = String(tagName || "").toUpperCase();
  if (!upper) return false;
  let tags = tweet.tags;
  if (typeof tags === "string") { try { tags = JSON.parse(tags); } catch { tags = null; } }
  if (Array.isArray(tags) && tags.some((x) => String(x).toUpperCase() === upper)) return true;
  const cashtag = upper.replace(/[^A-Z0-9_]/g, "");
  if (!cashtag) return false;
  return new RegExp("\\$" + cashtag + "(?![A-Za-z0-9_])", "i").test(String(tweet.content || ""));
}

function buildMiniTagsFromTweets(tweets) {
  const tagSet = new Map();
  (Array.isArray(tweets) ? tweets : []).forEach((tweet) => {
    const content = String(tweet.content || "");
    const matches = content.matchAll(/\$([A-Za-z][A-Za-z0-9_]{1,})/g);
    for (const match of matches) {
      const name = match[1];
      tagSet.set(name.toUpperCase(), name);
    }
    if (!tweet.tags) return;
    try {
      const parsed = typeof tweet.tags === "string" ? JSON.parse(tweet.tags) : tweet.tags;
      if (Array.isArray(parsed)) {
        parsed.forEach((tag) => {
          if (tag && typeof tag === "string" && tag.length > 1) {
            tagSet.set(tag.toUpperCase(), tag);
          }
        });
      }
    } catch {}
  });
  return Array.from(tagSet.values()).map((name) => ({
    id: name,
    name,
    tag: name,
    tick: TICK,
    type: 1
  }));
}

function mergeMiniTags(apiTags, tweetTags) {
  const map = new Map();
  [...(Array.isArray(apiTags) ? apiTags : []), ...(Array.isArray(tweetTags) ? tweetTags : [])].forEach((tag) => {
    const name = tag?.name || tag?.tag || tag?.tick || "";
    const key = String(name).toUpperCase();
    if (!key || key === TICK) return;
    map.set(key, { ...(map.get(key) || {}), ...tag, name, tag: tag?.tag || name, tick: tag?.tick || TICK });
  });
  return Array.from(map.values());
}

// Sort sub-tags by the summed top-right reward across all in-scope #BUIDL posts.
function sortMiniTagsByReward(tags, tweets) {
  const rows = Array.isArray(tweets) ? tweets : [];
  tags.forEach((tag) => {
    const name = tag.name || tag.tag || "";
    tag.postCount = rows.reduce((sum, t) => sum + (tweetMatchesTag(t, name) ? 1 : 0), 0);
    tag.rewardSum = rows.reduce(
      (sum, t) => sum + (tweetMatchesTag(t, name) ? tweetReward(t) : 0),
      0
    );
  });
  return tags
    .filter((tag) => Number(tag.postCount || 0) > 0)
    .sort((a, b) => (b.rewardSum || 0) - (a.rewardSum || 0) || (b.postCount || 0) - (a.postCount || 0));
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
  // Hide the #BUIDL chip itself — it's the community, already covered by "All".
  const items = (miniTags.length ? miniTags : []).filter(
    (tag) => String(tag.name || tag.tag || tag.tick || "").toUpperCase() !== TICK
  );
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
  const raw = row?.profile || row?.profileImg || row?.profileImage || row?.profile_image_url || row?.avatar || "";
  if (raw) {
    return String(raw)
      .replace("_normal.", "_200x200.")
      .replace("normal", "200x200");
  }
  const username = String(row?.twitterUsername || row?.username || "").replace(/^@/, "").trim();
  return username ? `https://unavatar.io/x/${encodeURIComponent(username)}` : "";
}

function avatarInitial(row) {
  return safeText(row?.twitterName || row?.twitterUsername || row?.username, "B").trim().slice(0, 1).toUpperCase();
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
        ? `<strong>${formatNumber(agent.credit)}</strong><small>Reputation</small>`
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
          <span>Reputation · ${formatNumber(agent.credit)}</span>
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
    feed.innerHTML = `<article class="mini-post"><strong>${mode === "vote" ? t("暂无验证投票", "No validations yet") : t("暂无信号", "No signals yet")}</strong><p>${mode === "vote" ? t("这里将显示当前登录用户在 #BUIDL 社区的互动、点赞、评论和验证投票。", "Your interactions, likes, comments and validation votes in #BUIDL will appear here.") : t("这里将显示当前登录用户在 #BUIDL 社区的发帖。", "Your posts in the #BUIDL community will appear here.")}</p><footer>#${TICK}</footer></article>`;
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
}

function getIssuedDistribution() {
  const rows = getDistributionRows();
  if (!rows.length) return 0;
  const now = Math.ceil(Date.now() / 1000);
  return rows.reduce((sum, row) => {
    const start = Number(row.start || 0);
    const end = Number(row.end || 0);
    const amount = Number(row.amount || 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(amount) || now <= start) return sum;
    return sum + Math.max(0, Math.min(now, end) - start) * amount;
  }, 0);
}

function getBuidlFdvUsd() {
  const marketCapBnb = Number(currentCommunity?.marketCap || currentCommunity?.mCap || 0);
  if (marketCapBnb > 0) return marketCapBnb * bnbUsd;
  const latestTrade = currentTrades.slice().reverse().find((row) =>
    Number(row?.close || row?.high || row?.low || row?.open || 0) > 0
  );
  const marketCapRaw = Number(latestTrade?.close || latestTrade?.high || latestTrade?.low || latestTrade?.open || 0);
  return marketCapRaw > 0 ? (marketCapRaw / 1e9) * bnbUsd : 0;
}

function applyValueDiscoveryMetrics(tweets = currentTweets) {
  const tweetList = Array.isArray(tweets) ? tweets : [];
  $("#signalPosts").textContent = formatNumber(tweetList.length || 0);
  const connections = tweetList.reduce((sum, item) =>
    sum + Number(item.replyCount || 0) + Number(item.retweetCount || 0) + Number(item.likeCount || 0) + Number(item.quoteCount || 0), 0);
  $("#connectCount").textContent = formatNumber(connections);
  $("#creditIssued").textContent = formatNumber(getIssuedDistribution() || Number(currentCommunity?.totalClaimedSocialRewards || 0));
  $("#buidlFdv").textContent = formatUsd(getBuidlFdvUsd());
}

function buildExploreNetworkMetrics({ community, tweets } = {}) {
  const tweetList = Array.isArray(tweets) ? tweets : [];
  return {
    signalMinersCount: uniqueCount(tweetList, (row) => row.twitterId || row.twitterUsername || row.ethAddr),
    signalCount: tweetList.length,
    miningCount: getTotalDistribution() || Number(community?.totalClaimedSocialRewards || 0)
  };
}

function applyExploreNetworkMetrics(metrics) {
  if (!metrics || typeof metrics !== "object") return false;
  $("#signalMinersCount").textContent = formatNumber(metrics.signalMinersCount || 0);
  $("#signalCount").textContent = formatNumber(metrics.signalCount || 0);
  $("#signalPosts").textContent = formatNumber(metrics.signalCount || 0);
  $("#miningCount").textContent = formatNumber(metrics.miningCount || 0);
  scheduleAlignHero();
  return true;
}

function applyIpshareData(ipshares) {
  if (!Array.isArray(ipshares)) return;
  currentIpshares = ipshares;
}

let _hubLoadInFlight = false;
let _hubLastLoadAt = 0;
// Last-good per-section values so a transient endpoint failure never wipes the hub to 0.
// Persisted to localStorage (per twitterId) so it also survives a full page refresh.
let _hubCache = { twitterId: null, ownCredit: null, ipshare: null, buidlAmount: 0 };

function loadHubCache(twitterId) {
  try {
    const raw = JSON.parse(localStorage.getItem("hubCache") || "null");
    if (raw && raw.twitterId === twitterId) return raw;
  } catch (_) { /* ignore */ }
  return { twitterId, ownCredit: null, ipshare: null, buidlAmount: 0 };
}

function saveHubCache() {
  try { localStorage.setItem("hubCache", JSON.stringify(_hubCache)); } catch (_) { /* ignore */ }
}

async function loadBuidlData() {
  const state = $("#apiState");
  try {
    const [community, tweets, ipshares, credits, trades, ethPrice] = await Promise.all([
      apiGet("/community/detail", { tick: TICK }),
      apiGet("/curation/communityTweets", { tick: TICK, pages: 0 }),
      apiGet("/ipshare/list", { pages: 0 }),
      apiGet("/community/communityCredits", { tick: TICK, pages: 0 }).catch(() => currentCredits),
      apiGet("/community/getTokenTradeData", { tick: TICK, isNew: true }).catch(() => currentTrades),
      apiGet("/tiptag/getETHPrice").catch(() => bnbUsd)
    ]);
    bnbUsd = Number(ethPrice) || bnbUsd;
    applyCommunityData(community);
    applyIpshareData(ipshares);
    currentCredits = Array.isArray(credits) ? credits : currentCredits;
    rebuildBuidlaiCreditMap(currentCredits);
    currentTrades = Array.isArray(trades) ? trades : currentTrades;
    currentTweets = Array.isArray(tweets) && tweets.length ? tweets : [];
    applyExploreNetworkMetrics(buildExploreNetworkMetrics({
      community: currentCommunity,
      tweets: currentTweets
    }));
    applyValueDiscoveryMetrics(currentTweets);
    renderTweets(currentTweets);
    // Note: do NOT re-trigger loadHubData here. renderRoute("/hub") is the single
    // authoritative hub trigger, and the hub fetches its own community/detail. A
    // second batch here raced the first and overwrote good data with degraded
    // responses (credit/reputation flickering correct↔wrong each load).
    state.textContent = "live";
  } catch (error) {
    currentTweets = [];
    renderTweets(currentTweets);
    state.textContent = "offline";
  }
}

async function refreshExploreNetworkMetrics() {
  try {
    const [community, tweets] = await Promise.all([
      apiGet("/community/detail", { tick: TICK }).catch(() => currentCommunity),
      apiGet("/curation/communityTweets", { tick: TICK, pages: 0 }).catch(() => currentTweets)
    ]);
    currentCommunity = community || currentCommunity;
    currentTweets = Array.isArray(tweets) ? tweets : currentTweets;
    applyExploreNetworkMetrics(buildExploreNetworkMetrics({
      community: currentCommunity,
      tweets: currentTweets
    }));
    applyValueDiscoveryMetrics(currentTweets);
  } catch (_) { /* keep last-good values */ }
}

function renderActivityTicker() {
  const typeEl = $("#activityType");
  const actorEl = $("#activityActor");
  const addressEl = $("#activityAddress");
  if (!typeEl || !actorEl || !addressEl) return;
  const fallback = lastCommunityActivity || buildFallbackActivity();
  if (!communityActivities.length && !fallback) {
    typeEl.textContent = t("加载动态", "Loading activity");
    actorEl.textContent = "";
    addressEl.textContent = "";
    return;
  }
  const activity = communityActivities.length
    ? communityActivities[activityIndex % communityActivities.length]
    : fallback;
  const actorId = safeText(activity.actorId, "id");
  const actorName = safeText(activity.actorName, actorId).replace(/^@/, "");
  typeEl.textContent = translateActionType(activity.actionType);
  actorEl.textContent = `@${actorName || actorId}`;
  addressEl.textContent = activity.address ? compactAddress(String(activity.address)) : "";
  lastCommunityActivity = activity;
  if (communityActivities.length) activityIndex = (activityIndex + 1) % communityActivities.length;
}

async function loadCommunityActivity() {
  try {
    const rows = await apiGet("/community/activity", { tick: TICK, limit: 30 });
    communityActivities = Array.isArray(rows) ? rows : [];
    if (communityActivities.length) lastCommunityActivity = communityActivities[0];
    activityIndex = 0;
    renderActivityTicker();
  } catch (_) {
    renderActivityTicker();
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
    $("#walletMenu").hidden = true;
    renderAccountState();
    if (accountStore.isLoggedIn()) await bondConnectedWallet();
    activeProvider.on?.("accountsChanged", (nextAccounts) => {
      connectedAddress = nextAccounts?.[0] || "";
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
  const isAtoc = route === "/atoc";
  $("#homeView").hidden = isHub || isSignal || isAgents || isEconomy || isAtoc;
  $("#hubView").hidden = !isHub;
  $("#signalView").hidden = !isSignal;
  $("#agentsView").hidden = !isAgents;
  $("#economyView").hidden = !isEconomy;
  $("#atocView").hidden = !isAtoc;
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
  if (isAtoc) {
    if (_currentAtocData) renderAtoc(_currentAtocData);
    loadAtocPage();
  }
  scheduleAlignHero();
}

function setupSignalControls() {
  $("#signalTrendingButton")?.addEventListener("click", () => {
    signalMode = "trending";
    $("#signalTrendingButton").classList.add("is-active");
    $("#signalNewButton").classList.remove("is-active");
    // Keep the selected sub-tag — just re-sort its feed by the new mode.
    loadSignalFeed();
  });
  $("#signalNewButton")?.addEventListener("click", () => {
    signalMode = "new";
    $("#signalNewButton").classList.add("is-active");
    $("#signalTrendingButton").classList.remove("is-active");
    // Keep the selected sub-tag — just re-sort its feed by the new mode.
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

// ======================== ATOC Agent ========================
// Data comes from the ATOC dashboard (atocdashboard.tagclaw.com), proxied
// same-origin via server.mjs at /atoc-data (no CORS upstream).

let _atocLoadInFlight = false;
let _currentAtocData = null;

async function loadAtocPage() {
  if (_atocLoadInFlight) return;
  _atocLoadInFlight = true;
  try {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch("/atoc-data", { cache: "no-store" });
        if (!res.ok) throw new Error(`atoc-data ${res.status}`);
        renderAtoc(await res.json());
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw lastErr;
  } catch (error) {
    $("#atocActions").innerHTML = `<div class="atoc-empty">${t("数据加载失败", "Data load failed")}: ${errorMessage(error, t("ATOC dashboard 不可达", "ATOC dashboard unreachable"))} <button class="atoc-retry" type="button" onclick="loadAtocPage()">${t("重试", "Retry")}</button></div>`;
  } finally {
    _atocLoadInFlight = false;
  }
}

function atocTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderAtoc(data = {}) {
  _currentAtocData = data;
  const wallet = data.overview?.wallet || {};
  const market = data.ecosystem?.market || {};
  const claimBuidl = Number(wallet.claimableRewards?.BUIDL || 0);
  const claimable = t("可领取", "Claimable");
  // Profile
  if ($("#atocOp")) $("#atocOp").textContent = formatNumber(wallet.op ?? 0);
  if ($("#atocVp")) $("#atocVp").textContent = formatNumber(wallet.vp ?? 0);
  if ($("#atocBuidl")) {
    $("#atocBuidl").textContent = formatNumber(claimBuidl);
    const usd = claimBuidl * Number(market.spotPrice || 0);
    $("#atocBuidl").nextElementSibling.textContent = usd ? `${claimable} · ${t("约", "approx.")} ${formatUsd(usd)}` : claimable;
  }
  if ($("#atocCredit")) {
    $("#atocCredit").textContent = formatNumber(wallet.claimableTotal ?? 0);
    $("#atocCredit").nextElementSibling.textContent = t("可领取奖励合计", "Total claimable rewards");
  }
  const addrEl = $("#atocAddr");
  if (addrEl) addrEl.textContent = market.poolAddress ? compactAddress(market.poolAddress) : (data.workspace || "BUIDL-CTO");

  // Agent status dots
  const setDot = (id, status) => {
    const el = $(id);
    if (!el) return;
    el.className = "atoc-dot" + (status?.status === "ok" ? " is-ok" : status?.status ? " is-warn" : "");
    el.title = status?.summary || status?.status || "";
  };
  setDot("#atocStatusCore", data.agents?.core?.status);
  setDot("#atocStatusOp", data.agents?.op?.status);
  setDot("#atocStatusOnchain", data.agents?.onchain?.status);
  setDot("#atocStatusGov", data.agents?.gov?.status);

  renderAtocActions(data.activity?.recentActions || []);
  renderAtocX(data.agents?.op?.topPosts || data.ecosystem?.community?.topPosts || []);
  renderAtocOnchain(data.agents?.onchain || {});
  renderAtocGov(data.agents?.gov || {});

  // TAS charts
  const history = Array.isArray(data.agents?.tasOs?.history) ? data.agents.tasOs.history : [];
  const hl = data.headline || {};
  if ($("#atocTasTotal")) $("#atocTasTotal").textContent = Number(hl.tasTotal || 0).toFixed(4);
  if ($("#atocTasSocial")) $("#atocTasSocial").textContent = Number(hl.tasSocial || 0).toFixed(4);
  if ($("#atocTasEconomic")) $("#atocTasEconomic").textContent = Number(hl.tasEconomic || 0).toFixed(4);
  drawAtocLine("#atocChartTotal", history.map((h) => Number(h.tasTotal || 0)), "#2b8a3e");
  drawAtocLine("#atocChartSocial", history.map((h) => Number(h.tasSocial || 0)), "#1971c2");
  drawAtocLine("#atocChartEconomic", history.map((h) => Number(h.tasEconomic || 0)), "#e8590c");

  renderAtocOoda(data.agents?.tasOs?.ooda || {});
  renderAtocBudget(data.agents?.tasOs?.budgetDirective || {});
  renderAtocHistory(history);
  renderAtocWiki(data.wiki || {});
}

function renderAtocActions(actions) {
  const el = $("#atocActions");
  if (!el) return;
  if (!actions.length) { el.innerHTML = `<div class="atoc-empty">${t("暂无操作", "No actions yet")}</div>`; return; }
  el.innerHTML = actions.slice(0, 8).map((a) => {
    const vp = a.vp != null ? `VP ${Number(a.vp).toFixed(2)}` : "";
    const op = a.opCost != null ? `OP ${Number(a.opCost).toFixed(2)}` : "";
    const detail = safeText(a.reason || a.tweetId || a.replyId || a.postId || "", "—");
    return `<div class="atoc-act-row${a.success === false ? " is-fail" : ""}">
      <span class="atoc-act-time">${atocTime(a.timestamp)}</span>
      <span class="atoc-act-op">op</span>
      <span class="atoc-act-kind">${safeText(a.action || a.kind, "—")}</span>
      <span class="atoc-act-vp">${vp}${op ? `<br><b>${op}</b>` : ""}</span>
      <span class="atoc-act-detail">${detail}</span>
    </div>`;
  }).join("");
}

function renderAtocX(posts) {
  const el = $("#atocXActivity");
  if (!el) return;
  if (!posts.length) { el.innerHTML = `<div class="atoc-empty">${t("暂无 X 活动", "No X activity")}</div>`; return; }
  el.innerHTML = posts.slice(0, 5).map((p) => `
    <article class="atoc-x-post">
      <div class="atoc-x-head"><strong>${safeText(p.twitterName, "Agent")}</strong><small>@${safeText(p.twitterUsername, "agent")}</small><span class="atoc-x-credit">${formatNumber(p.credit || 0)}</span></div>
      <p>${safeText(p.contentPreview, "")}</p>
      <footer>♥ ${p.likeCount || 0} · ↻ ${p.retweetCount || 0} · 💬 ${p.replyCount || 0} · ❝ ${p.quoteCount || 0}</footer>
    </article>`).join("");
}

function renderAtocOnchain(onchain) {
  const liq = $("#atocLiquidity");
  if (!liq) return;
  const ex = onchain.execution || {};
  const mode = ex.mode || onchain.status?.status || "—";
  const ctx = ex.decisionContext || {};
  liq.innerHTML = `
    <div class="atoc-kv"><label>${t("模式", "Mode")}</label><span>${safeText(mode, "—")}</span></div>
    <div class="atoc-kv"><label>${t("可领取合计", "Claimable Total")}</label><strong>${formatNumber(ctx.claimableTotal ?? 0)}</strong></div>
    <div class="atoc-kv"><label>TAS_economic</label><span>${Number(ctx.tasEconomic || 0).toFixed(4)}</span></div>
    <div class="atoc-kv"><label>${t("覆盖", "Coverage")}</label><span>${safeText(ctx.coverage, "—")}</span></div>
    <p class="atoc-note">${safeText(ex.operatorSummary, onchain.signal?.summary || t("暂无近期流动性操作", "No recent liquidity operations"))}</p>`;
}

function renderAtocGov(gov) {
  const adjust = $("#atocGovAdjust");
  if (adjust) {
    const delta = gov.delta || {};
    adjust.innerHTML = `
      <div class="atoc-kv"><label>${t("变更", "Changes")}</label><span>${delta.changeCount ?? 0} ${t("项", "items")}</span></div>
      <p class="atoc-note">${safeText(delta.summary || gov.note, t("近期无代币分发 / 声誉调整", "No recent token distribution / reputation adjustments"))}</p>`;
  }
  const list = $("#atocGovList");
  if (list) {
    const proposals = Array.isArray(gov.proposals) ? gov.proposals : [];
    list.innerHTML = proposals.length
      ? proposals.slice(0, 5).map((p) => `
        <div class="atoc-gov-item">
          <div><strong>${safeText(p.title || p.name, "proposal")}</strong><span class="atoc-tag-pill">${safeText(p.status, "—")}</span></div>
          <p class="atoc-note">${safeText(p.summary, "")}</p>
        </div>`).join("")
      : `<div class="atoc-empty">${t("暂无治理提案", "No governance proposals")}</div>`;
  }
}

function renderAtocOoda(ooda) {
  const badge = $("#atocOodaBadge");
  if (badge) {
    badge.textContent = safeText(ooda.posture, "—");
    badge.className = "atoc-badge" + (ooda.posture === "degraded" ? " is-warn" : ooda.posture ? " is-ok" : "");
  }
  const el = $("#atocOodaCycle");
  if (!el) return;
  el.innerHTML = `
    <h4>OODA LAST CYCLE</h4>
    <div class="atoc-kv"><label>HEALTH</label><strong>${Number(ooda.healthScore || 0).toFixed(3)}</strong></div>
    <div class="atoc-kv"><label>VERDICT</label><span>${safeText(ooda.verdict, "—")}</span></div>
    <div class="atoc-kv"><label>ISSUES</label><span>${ooda.issueCount ?? 0}</span></div>
    <ul class="atoc-issues">${(ooda.issues || []).slice(0, 3).map((i) => `<li>${safeText(i, "")}</li>`).join("")}</ul>`;
}

function renderAtocBudget(bd) {
  const el = $("#atocBudget");
  if (!el) return;
  const dir = bd.trend?.trends?.total?.direction || "—";
  el.innerHTML = `
    <h4>BUDGET DIRECTIVE</h4>
    <div class="atoc-kv"><label>CURRENT TAS</label><strong>${Number(bd.currentTAS || 0).toFixed(4)}</strong></div>
    <div class="atoc-kv"><label>TARGET TAS</label><strong>${Number(bd.targetTAS || 0).toFixed(4)}</strong></div>
    <div class="atoc-kv"><label>TREND</label><span>${safeText(dir, "—")}</span></div>
    <p class="atoc-note">${safeText(bd.trend?.trends?.total?.component, "")} slope ${Number(bd.trend?.trends?.total?.slope || 0).toFixed(4)}</p>`;
}

function renderAtocHistory(history) {
  const el = $("#atocTasHistory");
  if (!el) return;
  const rows = history.slice(-6).reverse();
  el.innerHTML = `<h4>TAS &amp; HISTORY</h4>` + (rows.length
    ? rows.map((h) => {
      const d = Number(h.delta || 0);
      return `<div class="atoc-hist-row"><span>${atocTime(h.timestamp)}</span><strong>${Number(h.tasTotal || 0).toFixed(4)}</strong><em class="${d >= 0 ? "t-up" : "t-down"}">${d >= 0 ? "+" : ""}${d.toFixed(4)}</em></div>`;
    }).join("")
    : `<div class="atoc-empty">—</div>`);
}

function renderAtocWiki(wiki) {
  const fresh = $("#atocWikiFresh");
  if (fresh) fresh.textContent = wiki.indexSummary?.freshness || wiki.freshness || "—";
  const el = $("#atocWiki");
  if (!el) return;
  const idx = wiki.indexSummary || {};
  const arch = wiki.architecture || {};
  const flow = Array.isArray(arch.dataFlow) ? arch.dataFlow : [];
  // The dashboard provides this header in Chinese; show an English version in EN mode.
  const archDescription = (currentLang === "en" && /原始数据/.test(arch.description || ""))
    ? "ATOC LLM WIKI — Raw Data → Comprehension & Extraction → Decision Dashboard → 4-Agent Consumption"
    : safeText(arch.description, "ATOC LLM WIKI");
  const translateWikiFlow = (value) => {
    if (currentLang !== "en") return value;
    const normalized = String(value || "").trim();
    const flowLabels = {
      "原始数据": "Raw Data",
      "理解提取": "Comprehension & Extraction",
      "决策面板": "Decision Dashboard",
      "4 Agent 消费": "4-Agent Consumption",
      "4 Agent消费": "4-Agent Consumption",
      "Agent 消费": "Agent Consumption"
    };
    return flowLabels[normalized] || normalized
      .replace(/原始数据/g, "Raw Data")
      .replace(/理解提取/g, "Comprehension & Extraction")
      .replace(/决策面板/g, "Decision Dashboard")
      .replace(/4\s*Agent\s*消费/g, "4-Agent Consumption")
      .replace(/Agent\s*消费/g, "Agent Consumption");
  };
  el.innerHTML = `
    <div class="atoc-wiki-card">
      <h4>DATA LAYER OVERVIEW</h4>
      <div class="atoc-kv"><label>${t("可用", "Available")}</label><span>${wiki.available ? t("是", "Yes") : t("否", "No")}</span></div>
      <div class="atoc-kv"><label>${t("新鲜度", "Freshness")}</label><span>${safeText(wiki.freshness, "—")} (${Number(wiki.ageHours || 0).toFixed(1)}h)</span></div>
      <div class="atoc-kv"><label>VP</label><span>${formatNumber(idx.vpCurrent ?? 0)} (gap ${formatNumber(idx.vpGap ?? 0)}/${idx.vp24hTarget ?? 0})</span></div>
      <div class="atoc-kv"><label>OP</label><span>${formatNumber(idx.opCurrent ?? 0)} (target ${idx.op24hTarget ?? 0})</span></div>
      <div class="atoc-kv"><label>${t("未策展", "Uncurated")}</label><span>${wiki.uncuratedCount ?? 0}</span></div>
    </div>
    <div class="atoc-wiki-card">
      <h4>${archDescription}</h4>
      <ol class="atoc-flow-list">${flow.slice(0, 6).map((f) => `<li>${safeText(translateWikiFlow(f), "")}</li>`).join("")}</ol>
    </div>
    <div class="atoc-wiki-card">
      <h4>TAS SUMMARY</h4>
      <p class="atoc-note">${safeText(idx.tasSummary, "—")}</p>
    </div>`;
}

function drawAtocLine(selector, values, color) {
  const canvas = $(selector);
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const pad = 14;
  const data = (values || []).filter((v) => Number.isFinite(v));
  if (data.length < 2) return;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const x = (i) => pad + (i / (data.length - 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - min) / range) * (H - pad * 2);
  // baseline grid
  ctx.strokeStyle = "rgba(0,0,0,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, H - pad); ctx.lineTo(W - pad, H - pad); ctx.stroke();
  // line
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((v, i) => { i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)); });
  ctx.stroke();
  // dots
  ctx.fillStyle = color;
  data.forEach((v, i) => { ctx.beginPath(); ctx.arc(x(i), y(v), 2, 0, Math.PI * 2); ctx.fill(); });
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
  $("#ecoSocialMiners").textContent = formatNumber(socialMiners);
  $("#ecoVolume").textContent = formatVolume(volume);
  $("#ecoDistributed").textContent = formatNumber(distributed);
  $("#ecoKnowledge").textContent = formatNumber(knowledge);

  $("#ecoBuidlPrice").textContent = formatUsd(getBuidlFdvUsd());

  drawTradeCanvas();
  drawMiningRewardCanvas();
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

// VP economics (mirrors tagai-ui src/config.ts).
const PREDICT_VOTE_COST = 10;
const PREDICT_MAX_VP = 200;
const PREDICT_VP_RECOVER_DAY = 3;

// Live event-prediction state: the events currently rendered (keyed by marketMaker)
// plus the pending vote being confirmed in the modal.
const predictionEventState = {
  events: new Map(),
  pending: null // { marketMaker, choice: 'yes'|'no' }
};

async function loadPredictionData(tab) {
  const list = $("#predictionList");
  if (!list) return;
  list.innerHTML = `<div class="prediction-loading">${t("加载中…", "Loading…")}</div>`;

  const twitterId = accountStore.getAccount()?.twitterId || undefined;
  try {
    if (tab === "battle") {
      const data = await apiGet("/predict/getPredictBattleData", { tick: TICK, twitterId, pageIndex: 0 });
      const battles = data?.battle || [];
      const tweets = data?.tweets || {};
      await attachMarketReserves(battles);
      renderPredictionBattles(battles, tweets);
    } else {
      const events = await apiGet("/predict/getPredictEventData", { tick: TICK, twitterId, pageIndex: 0 });
      const list = Array.isArray(events) ? events : [];
      await attachMarketReserves(list);
      predictionEventState.events = new Map(list.map((e) => [String(e.marketMaker), e]));
      renderPredictionEvents(list);
    }
  } catch (error) {
    list.innerHTML = `<div class="prediction-empty">${t("预测数据加载失败。", "Failed to load prediction data.")}</div>`;
  }
}

// Event lifecycle (mirrors tagai-ui PredictHeader.vue):
//  - trading phase:  now < endTime
//  - voting phase:   status === 2 && endTime <= now < endTime + 24h
//  - ended/settled:  winner set, or now >= endTime + 24h
function eventPhase(event) {
  const now = Date.now();
  const tradeEnd = Number(event.endTime || 0) * 1000;
  const voteEnd = tradeEnd + 86400000;
  if (event.winner || event.status === 3) return "ended";
  if (event.status === 2 && tradeEnd <= now && now < voteEnd) return "voting";
  if (now >= voteEnd) return "ended";
  if (now < tradeEnd) return "trading";
  return "ended";
}

function eventPhaseLabel(event) {
  const phase = eventPhase(event);
  const now = Date.now();
  const tradeEnd = Number(event.endTime || 0) * 1000;
  const voteEnd = tradeEnd + 86400000;
  if (phase === "voting") return `${t("投票中 · 剩余 ", "Voting · ")}${formatDuration(voteEnd - now)}`;
  if (phase === "trading") return `${t("交易中 · 剩余 ", "Trading · ")}${formatDuration(tradeEnd - now)}`;
  return t("已结束", "Ended");
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0h";
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function hasVoted(event) {
  return event.voteResult !== null && event.voteResult !== undefined && event.voteResult !== 0;
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
    list.innerHTML = `<div class="prediction-empty">${t("#BUIDL 暂无预测事件。", "No prediction events in #BUIDL yet.")}</div>`;
    return;
  }

  list.innerHTML = "";
  events.forEach((event) => {
    const marketMaker = String(event.marketMaker || "");
    // Trading-phase odds come from on-chain reserves; voting-phase tallies come
    // from the community vote volume (voteYes / voteNo).
    const phase = eventPhase(event);
    const voteYes = Number(event.voteYes || 0);
    const voteNo = Number(event.voteNo || 0);
    const voteTotal = voteYes + voteNo;
    let pctYes;
    let pctNo;
    if (voteTotal > 0) {
      pctYes = Math.round((voteYes / voteTotal) * 100);
      pctNo = 100 - pctYes;
    } else {
      const odds = marketPercents(event);
      pctYes = odds.pctA;
      pctNo = odds.pctB;
    }
    const poolReserve = Number(event.reserveA || 0) + Number(event.reserveB || 0);
    const endDate = event.endTime ? new Date(event.endTime * 1000).toLocaleString() : "—";
    const voted = hasVoted(event);
    const canVote = phase === "voting";
    const detailUrl = `https://tagai.fun/predict-event-detail/${marketMaker}`;

    const yesTag = event.voteResult === 1 ? `<span class="vote-mark">✓ ${t("你的选择", "Your pick")}</span>` : "";
    const noTag = event.voteResult === 2 ? `<span class="vote-mark">✓ ${t("你的选择", "Your pick")}</span>` : "";

    // Voting controls: live buttons during the voting phase, otherwise a static
    // odds display. A vote requires Twitter login (handled in handleVoteClick).
    const voteControls = canVote
      ? `
        <div class="prediction-vote-actions">
          <button class="vote-btn vote-btn-yes${event.voteResult === 1 ? " is-picked" : ""}" data-vote="yes" data-market="${marketMaker}" ${voted ? "disabled" : ""}>
            ${t("投 Yes", "Vote Yes")} <small>${pctYes}%</small> ${yesTag}
          </button>
          <button class="vote-btn vote-btn-no${event.voteResult === 2 ? " is-picked" : ""}" data-vote="no" data-market="${marketMaker}" ${voted ? "disabled" : ""}>
            ${t("投 No", "Vote No")} <small>${pctNo}%</small> ${noTag}
          </button>
        </div>
        ${voted ? `<p class="prediction-voted-note">${t("你已投票，等待结算后领取奖励。", "You've voted. Rewards unlock after settlement.")}</p>` : ""}`
      : `
        <div class="prediction-votes">
          <div class="prediction-vote-yes"><strong>Yes</strong><span>${pctYes}%</span>${yesTag}</div>
          <div class="prediction-vote-no"><strong>No</strong><span>${pctNo}%</span>${noTag}</div>
        </div>`;

    const card = document.createElement("article");
    card.className = "prediction-card";
    card.innerHTML = `
      <div class="prediction-card-header">
        <h3>${safeText(event.title, t("预测事件", "Prediction Event"))}</h3>
        <span class="prediction-status ${predictionStatusClass(event.status)}">${eventPhaseLabel(event)}</span>
      </div>
      <div class="prediction-event-body">
        <p class="prediction-event-content">${safeText(event.content, "").slice(0, 220)}</p>
        ${voteControls}
      </div>
      <div class="prediction-bar">
        <div class="prediction-bar-a" style="width:${pctYes}%"></div>
        <div class="prediction-bar-b" style="width:${pctNo}%"></div>
      </div>
      <div class="prediction-card-footer">
        <span>${t("结束", "Ends")}: ${endDate}</span>
        <span class="prediction-meta-right">
          ${voteTotal > 0 ? `${t("投票量", "Votes")}: ${formatNumber(voteTotal)} VP · ` : ""}${t("资金池", "Pool")}: ${formatNumber(poolReserve)} $${safeText(event.tick, TICK)}
          <a class="prediction-detail-link" href="${detailUrl}" target="_blank" rel="noopener noreferrer">${t("详情 ↗", "Detail ↗")}</a>
        </span>
      </div>
    `;
    list.appendChild(card);
  });

  // Wire up the live vote buttons.
  list.querySelectorAll(".vote-btn[data-vote]").forEach((btn) => {
    btn.addEventListener("click", () => {
      handleVoteClick(btn.getAttribute("data-market"), btn.getAttribute("data-vote"));
    });
  });
}

// ======================== Event Prediction Voting ========================
// Mirrors tagai-ui PredictHeader.vue: a logged-in user spends VP to vote YES/NO
// on an event's outcome via POST /predict/voteEventPrediction. Live tallies and a
// "you voted" marker provide immediate feedback; the same data is on tagai.fun.

// Compute the user's currently available VP (it recovers linearly over time),
// matching the formula in tagai-ui's useCommunityMember / PredictHeader.
async function fetchUserPredictVP() {
  const account = accountStore.getAccount();
  if (!account?.twitterId) return PREDICT_MAX_VP;
  try {
    const info = await apiGet("/predict/getUserPredictVP", { twitterId: account.twitterId, tick: TICK });
    if (info && typeof info === "object" && "lastUpdateVPStamp" in info && "predictVP" in info) {
      if (!info.lastUpdateVPStamp || Number(info.lastUpdateVPStamp) === 0) return PREDICT_MAX_VP;
      const recovered = Number(info.predictVP) + (Date.now() - Number(info.lastUpdateVPStamp)) * PREDICT_MAX_VP / (86400000 * PREDICT_VP_RECOVER_DAY);
      return Math.floor(Math.min(recovered, PREDICT_MAX_VP));
    }
  } catch (_) { /* default below */ }
  return PREDICT_MAX_VP;
}

async function handleVoteClick(marketMaker, choice) {
  const event = predictionEventState.events.get(String(marketMaker));
  if (!event) return;

  // Must be logged in to vote — reuse the existing TagAI/Privy account modal.
  if (!accountStore.isLoggedIn()) {
    showToast(t("请先登录后再投票。", "Please log in to vote."), "warn");
    openAccountModal();
    return;
  }
  if (hasVoted(event)) {
    showToast(t("你已经为该事件投过票了。", "You already voted on this event."), "warn");
    return;
  }

  predictionEventState.pending = { marketMaker: String(marketMaker), choice };
  openVoteModal(event, choice);

  // Load the user's VP in the background and update the modal.
  $("#voteModalRemain").textContent = "…";
  const vp = await fetchUserPredictVP();
  $("#voteModalRemain").textContent = formatNumber(vp);
  const confirm = $("#voteModalConfirm");
  if (vp < PREDICT_VOTE_COST) {
    confirm.disabled = true;
    setVoteModalStatus(t("VP 不足，无法投票。", "Insufficient VP to vote."), "error");
  } else {
    confirm.disabled = false;
    setVoteModalStatus("", "");
  }
}

function openVoteModal(event, choice) {
  $("#voteModalTitle").textContent = safeText(event.title, "");
  $("#voteModalChoice").textContent = choice === "yes"
    ? t("你选择：Yes", "Your choice: Yes")
    : t("你选择：No", "Your choice: No");
  $("#voteModalCost").textContent = String(PREDICT_VOTE_COST);
  $("#voteModalRemain").textContent = "—";
  setVoteModalStatus("", "");
  $("#voteModalConfirm").disabled = false;
  $("#voteModal").hidden = false;
}

function closeVoteModal() {
  $("#voteModal").hidden = true;
  predictionEventState.pending = null;
}

function setVoteModalStatus(message, kind) {
  const el = $("#voteModalStatus");
  if (!el) return;
  el.textContent = message || "";
  el.className = "account-status" + (kind ? ` is-${kind}` : "");
}

// Map backend vote error codes (config/code.js) to readable messages.
function voteErrorMessage(error) {
  const msg = errorMessage(error, "");
  const map = {
    "User not registered steem": t("请先在 tagai.fun 完成社交账户注册后再投票。", "Register your social account on tagai.fun before voting."),
    "Market not in voting period": t("该事件当前不在投票阶段。", "This event is not in the voting period."),
    "User already voted": t("你已经为该事件投过票了。", "You already voted on this event."),
    "Insufficient vp": t("VP 不足，无法投票。", "Insufficient VP to vote."),
    "Execute failed": t("投票执行失败，请稍后重试。", "Vote failed, please try again.")
  };
  return map[msg] || msg || t("投票失败。", "Vote failed.");
}

async function confirmVote() {
  const pending = predictionEventState.pending;
  const account = accountStore.getAccount();
  if (!pending || !account?.twitterId) return;
  const confirm = $("#voteModalConfirm");
  confirm.disabled = true;
  setVoteModalStatus(t("投票提交中…", "Submitting vote…"), "");

  const voteResult = pending.choice === "yes" ? 1 : 2;
  try {
    await apiPost("/predict/voteEventPrediction", {
      twitterId: account.twitterId,
      marketAddr: pending.marketMaker,
      voteResult,
      voteVp: PREDICT_VOTE_COST
    });
    // Optimistically reflect the vote locally so feedback is immediate.
    const event = predictionEventState.events.get(pending.marketMaker);
    if (event) {
      event.voteResult = voteResult;
      if (voteResult === 1) event.voteYes = Number(event.voteYes || 0) + PREDICT_VOTE_COST;
      else event.voteNo = Number(event.voteNo || 0) + PREDICT_VOTE_COST;
    }
    closeVoteModal();
    showToast(t("投票成功！", "Vote submitted!"), "success");
    // Re-fetch authoritative tallies from the API.
    loadPredictionData("event");
  } catch (error) {
    setVoteModalStatus(voteErrorMessage(error), "error");
    confirm.disabled = false;
  }
}

function setupVoteModalControls() {
  $("#voteModalClose")?.addEventListener("click", closeVoteModal);
  $("#voteModal")?.addEventListener("click", (event) => {
    if (event.target.id === "voteModal") closeVoteModal();
  });
  $("#voteModalConfirm")?.addEventListener("click", confirmVote);
}

// ======================== Toast ========================
let toastTimer = null;
function showToast(message, kind = "info") {
  const host = $("#toastHost");
  if (!host) {
    // Fallback for environments without the toast host.
    setAccountStatus(message);
    return;
  }
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-visible"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("is-visible");
    setTimeout(() => el.remove(), 300);
  }, 3200);
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

async function loadRecentSignalTweets() {
  const pages = [];
  for (let page = 0; page < SIGNAL_TAG_FETCH_PAGES; page += 1) {
    const rows = await apiGet("/curation/communityTweets", { tick: TICK, pages: page }).catch(() => []);
    if (!Array.isArray(rows) || !rows.length) break;
    pages.push(rows);
    const oldest = rows.reduce((min, tweet) => {
      const time = new Date(tweet?.tweetTime || 0).getTime();
      return Number.isFinite(time) && time > 0 ? Math.min(min, time) : min;
    }, Infinity);
    if (rows.length < SIGNAL_TAG_PAGE_SIZE || oldest < SIGNAL_POSTS_CUTOFF_TIME) break;
  }
  const seen = new Set();
  const tweets = [];
  for (const page of pages) {
    if (!Array.isArray(page)) continue;
    for (const tweet of page) {
      const id = tweet?.tweetId || `${tweet?.twitterId || ""}-${tweet?.tweetTime || ""}-${tweet?.content || ""}`;
      if (seen.has(id)) continue;
      seen.add(id);
      tweets.push(tweet);
    }
  }
  return filterSignalTweetsByCutoff(tweets)
    .sort((a, b) => signalTweetTimeValue(b) - signalTweetTimeValue(a));
}

async function loadSignalTweetsForTag(tagName) {
  let source = filterSignalTweetsByCutoff(currentTweets);
  let matches = source.filter((tweet) => tweetMatchesTag(tweet, tagName));
  const maxPages = Math.max(SIGNAL_TAG_FETCH_PAGES, 60);

  for (let page = 0; page < maxPages; page += 1) {
    const rows = await apiGet("/curation/communityTweets", { tick: TICK, pages: page }).catch(() => []);
    if (!Array.isArray(rows) || !rows.length) break;

    const scopedRows = filterSignalTweetsByCutoff(rows);
    if (scopedRows.length) {
      source = mergeTweetRows(source, scopedRows);
      matches = source.filter((tweet) => tweetMatchesTag(tweet, tagName));
    }

    const oldest = rows.reduce((min, tweet) => {
      const time = signalTweetTimeValue(tweet);
      return time > 0 ? Math.min(min, time) : min;
    }, Infinity);
    if (rows.length < SIGNAL_TAG_PAGE_SIZE || oldest < SIGNAL_POSTS_CUTOFF_TIME) break;
  }

  if (source.length > currentTweets.length) currentTweets = source;
  return matches;
}

async function loadSignalPage() {
  const requestId = ++signalFeedRequestId;
  renderMiniTags();
  currentTweets = filterSignalTweetsByCutoff(currentTweets);
  renderSignalFeed(currentTweets);
  try {
    signalPageDataPromise = Promise.all([
      apiGet("/communityMiniTag/getCommunityMiniTags", { tick: TICK }).catch(() => []),
      loadRecentSignalTweets().catch(() => currentTweets),
      loadBuidlaiCreditMap().catch(() => currentBuidlaiCreditMap)
    ]);
    const [tags, tweets] = await signalPageDataPromise;
    const scopedTweets = filterSignalTweetsByCutoff(Array.isArray(tweets) && tweets.length ? tweets : currentTweets);
    currentTweets = applyBuidlaiPoBAmounts(scopedTweets);
    const tagSourceTweets = currentTweets;
    const tweetMiniTags = buildMiniTagsFromTweets(tagSourceTweets);

    // Merge API mini tags with tags actually present in the current in-scope feed.
    miniTags = mergeMiniTags(tags, tweetMiniTags);

    // Order sub-tags by the summed top-right reward of all in-scope #BUIDL posts.
    miniTags = sortMiniTagsByReward(miniTags, tagSourceTweets);

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
    if (requestId === signalFeedRequestId) renderSignalFeed(currentTweets);
    else if (selectedMiniTag) loadSignalFeed();
  } catch {
    if (requestId === signalFeedRequestId) renderSignalFeed(fallbackTweets);
  } finally {
    signalPageDataPromise = null;
  }
}

async function loadSignalFeed() {
  const requestId = ++signalFeedRequestId;
  const tagSnapshot = selectedMiniTag;
  const modeSnapshot = signalMode;
  try {
    let tweets;
    let hasScopedTagFeed = false;
    if (tagSnapshot) {
      hasScopedTagFeed = true;
      const tagName = tagSnapshot.tag || tagSnapshot.name || "";
      // Prefer the current All feed. The tag endpoint often returns old rows,
      // while many live sub-tags only exist as $CASHTAGs in tweet content.
      let localSourceTweets = currentTweets;
      if (!localSourceTweets.length && signalPageDataPromise) {
        const pageData = await signalPageDataPromise.catch(() => null);
        const pageTweets = Array.isArray(pageData?.[1]) ? filterSignalTweetsByCutoff(pageData[1]) : [];
        if (pageTweets.length) {
          localSourceTweets = applyBuidlaiPoBAmounts(pageTweets);
          currentTweets = localSourceTweets;
        }
      }
      tweets = filterSignalTweetsByCutoff(localSourceTweets).filter((t) => tweetMatchesTag(t, tagName));
      if (!Array.isArray(tweets) || !tweets.length) tweets = await loadSignalTweetsForTag(tagName);
      // If local feed has no rows yet, use the tag endpoint as a supplement.
      if (!Array.isArray(tweets) || !tweets.length) {
        tweets = await apiGet("/curation/tagTweets", {
          communityId: TICK,
          tag: tagName,
          pages: 0
        }).catch(() => null);
        tweets = filterSignalTweetsByCutoff(tweets);
      }
      // Apply the Trending/New ordering within the selected tag's posts.
      tweets = sortTweetsByMode(tweets, modeSnapshot);
    } else if (modeSnapshot === "trending") {
      tweets = filterSignalTweetsByCutoff(await apiGet("/curation/communityTrendingTweets", { tick: TICK, pages: 0 }));
    } else {
      tweets = filterSignalTweetsByCutoff(await apiGet("/curation/communityTweets", { tick: TICK, pages: 0 }));
    }
    const result = hasScopedTagFeed ? (Array.isArray(tweets) ? tweets : []) : (Array.isArray(tweets) && tweets.length ? tweets : filterSignalTweetsByCutoff(currentTweets));
    await loadBuidlaiCreditMap().catch(() => currentBuidlaiCreditMap);
    if (requestId !== signalFeedRequestId) return;
    renderSignalFeed(applyBuidlaiPoBAmounts(result));
  } catch {
    if (requestId !== signalFeedRequestId) return;
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
      const scopedFreshTweets = filterSignalTweetsByCutoff(freshTweets);
      if (scopedFreshTweets.length) {
        currentTweets = scopedFreshTweets;
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
  $("#hubSocial").textContent = `${formatNumber(social.posts ?? tweetCount)} ${t("条帖子", "posts")} · ${formatNumber(social.followings ?? user.followings ?? 0)} ${t("关注", "Following")} · ${formatNumber(social.followers ?? user.followers ?? 0)} ${t("粉丝", "Followers")}`;
  const opValue = Number(model.op ?? user.op ?? 0);
  const vpValue = Number(model.vp ?? user.vp ?? 0);
  if ($("#hubOp")) $("#hubOp").textContent = formatNumber(opValue);
  if ($("#hubVp")) $("#hubVp").textContent = formatNumber(vpValue);
  $("#hubBuidl").textContent = formatNumber(buidlAmount);
  $("#hubBuidl").nextElementSibling.textContent = buidlUsd ? `约 ${formatUsd(buidlUsd)}` : "—";
  $("#hubCredit").textContent = formatNumber(credit);
  $("#hubCredit").nextElementSibling.textContent = `${formatNumber(model.signalHits ?? 0)}${t("信号命中", " signal hits")}`;

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
  if (miningCaption) miningCaption.textContent = `${t("7天", "7d")} · ${formatNumber(miningTotal)} $BUIDL`;
  if (proofCaption) proofCaption.textContent = `${t("7天", "7d")} · ${formatNumber(weeklyReward)} $BUIDL`;

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

  const L = {
    signal: t("信号发布", "Signal Posts"), trade: t("社交交易", "Social Trades"),
    vote: t("验证投票", "Validation Votes"), economy: t("社区经济参与", "Community Economy"),
    like: t("点赞", "Likes"), reply: t("评论", "Replies"), retweet: t("转发", "Reposts")
  };
  buildScoreRows("#reputationMetrics", [
    { label: "IPShare", value: formatNumber(cfIpshare), rawValue: cfIpshare },
    { label: L.signal, value: 0 },
    { label: L.trade, value: 0 },
    { label: L.vote, value: 0 },
    { label: L.economy, value: formatNumber(cfEconomy), rawValue: cfEconomy }
  ]);
  buildScoreRows("#actionTrace", [
    { label: L.signal, value: signalValue },
    { label: L.trade, value: model.blinksCount ?? 0 },
    { label: L.vote, value: model.voteCount ?? 0 },
    { label: L.like, value: model.likeCount ?? 0 },
    { label: L.reply, value: model.replyCount ?? 0 },
    { label: L.retweet, value: model.retweetCount ?? 0 }
  ]);
  buildScoreRows("#miningRewards", [
    { label: L.signal, value: formatNumber(model.signalReward ?? 0), rawValue: model.signalReward ?? 0 },
    { label: L.vote, value: formatNumber(model.voteReward ?? 0), rawValue: model.voteReward ?? 0 }
  ]);
  buildScoreRows("#proofMetrics", [
    { label: L.signal, value: signalValue },
    { label: L.trade, value: model.blinksCount ?? 0 },
    { label: L.vote, value: model.voteCount ?? 0 }
  ]);
  if (model.requiresLogin) {
    $("#hubRecentSignals").innerHTML = `<article class="mini-post"><strong>${t("需要登录", "Login required")}</strong><p>${t("Hub 只展示当前 TagAI accountInfo 的个人信号数据。", "The hub only shows the personal signal data of the current TagAI accountInfo.")}</p><footer>Privy Twitter / Email</footer></article>`;
    $("#hubRecentVotes").innerHTML = `<article class="mini-post"><strong>${t("需要登录", "Login required")}</strong><p>${t("验证投票和互动数据需要 AccessToken + twitterId。", "Validation votes and interactions require an AccessToken + twitterId.")}</p><footer>checkTwitterAuth</footer></article>`;
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
    if (chartCaption) chartCaption.textContent = t("过去30天收益为 0 $BUIDL", "30-day rewards: 0 $BUIDL");
    renderHubPreview({
      user: { twitterName: t("请登录 TagAI 账户", "Sign in to TagAI"), twitterUsername: "connect" },
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

  // Restore last-good cache (survives full refresh) so a failing reload never shows 0.
  if (_hubCache.twitterId !== twitterId) _hubCache = loadHubCache(twitterId);

  const [, credits, communityTweets, profile, userTweets, userBlinks, rewards, unclaimed, dailyRewards, ipshare, kolFee, capturedFee, holdingList, vpop, ipshareList] =
    await Promise.all([
      apiGet("/community/detail", { tick: TICK }).then((community) => {
        currentCommunity = community || currentCommunity;
        return currentCommunity;
      }).catch(() => currentCommunity),
      apiGet("/community/communityCredits", { tick: TICK, pages: 0 }).catch(() => currentCredits),
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
  if (Array.isArray(credits) && credits.length) currentCredits = credits;
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

  // Resilience: under load some endpoints transiently fail (ECONNRESET). A failed
  // communityCredits / ipshare fetch must NOT wipe the already-shown reputation/
  // IPShare to 0 — reuse the last good value when this load came back empty.
  const creditsArr = (Array.isArray(credits) && credits.length) ? credits
    : (Array.isArray(currentCredits) && currentCredits.length) ? currentCredits : [];
  let ownCredit = creditsArr.find((row) => accountMatches(row, account))
    || creditsArr.find((row) => String(row.twitterUsername || "").toLowerCase() === username.toLowerCase())
    || null;
  if (ownCredit) _hubCache.ownCredit = ownCredit;
  else if (_hubCache.ownCredit) ownCredit = _hubCache.ownCredit;
  if (!resolvedIpshare && _hubCache.ipshare) resolvedIpshare = _hubCache.ipshare;
  else if (resolvedIpshare) _hubCache.ipshare = resolvedIpshare;
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
  let buidlAmount = tokenAmountFromRow(buidlHolding);
  if (buidlAmount > 0) _hubCache.buidlAmount = buidlAmount;
  else if (_hubCache.buidlAmount > 0) buidlAmount = _hubCache.buidlAmount; // keep last good on transient failure
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
  if (chartCaption) chartCaption.textContent = t(`过去30天收益为 ${formatNumber(thirtyDayRewardTotal)} $BUIDL`, `30-day rewards: ${formatNumber(thirtyDayRewardTotal)} $BUIDL`);

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
  saveHubCache();
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
    if (!(amount > 0)) return;
    _hubCache.buidlAmount = amount; // remember so transient RPC failures don't zero it next load
    saveHubCache();
    if (window.location.pathname !== "/hub") return;
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
setupLangToggle();
registerInjectedProviders();
setupAccountControls();
setupWalletButton();
setupRouter();
setupSignalControls();
setupAgentsControls();
setupIpshareControls();
setupVoteModalControls();
drawNetwork();
loadBuidlData();
setInterval(refreshExploreNetworkMetrics, 30_000);
loadCommunityActivity();
setInterval(loadCommunityActivity, 30_000);
setInterval(renderActivityTicker, 4_000);
scheduleAlignHero();
window.addEventListener("resize", scheduleAlignHero);
window.addEventListener("load", scheduleAlignHero);
