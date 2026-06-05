// TokenWise Background Service Worker v2
// Added: context portability session capture
import { CONFIG, MODELS } from './config.js';

let authToken = null;
let currentUser = null;
let sessionBuffer = [];
let flushTimer = null;

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.local.set({
      settings: { showWidget:true, showOnClaude:true, showOnChatGPT:true, showOnGemini:true, defaultModel:'claude-3-sonnet', budgetAlertThreshold:5.00, theme:'auto', position:'bottom-right' },
      sessionHistory: [], totalSpend: 0, installDate: Date.now(),
    });
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
  chrome.alarms.create('dailyBudgetCheck', { periodInMinutes: 60 });
  chrome.alarms.create('sessionFlush', { periodInMinutes: 5 });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'GET_AUTH':    sendResponse({ user: currentUser, token: authToken }); break;
        case 'SET_AUTH':    authToken=msg.token; currentUser=msg.user; await chrome.storage.local.set({ cachedUser:msg.user, authToken:msg.token }); sendResponse({ ok:true }); break;
        case 'CLEAR_AUTH':  authToken=null; currentUser=null; await chrome.storage.local.remove(['cachedUser','authToken']); sendResponse({ ok:true }); break;
        case 'LOG_SESSION': bufferSession(msg.data); sendResponse({ ok:true }); break;
        case 'SAVE_CONTEXT': await saveContextSession(msg.data); sendResponse({ ok:true }); break;
        case 'GET_CONTEXT':  const ctx = await getLatestContext(); sendResponse({ context: ctx }); break;
        case 'GET_SETTINGS': const { settings } = await chrome.storage.local.get('settings'); sendResponse({ settings }); break;
        case 'SET_SETTINGS': await chrome.storage.local.set({ settings:msg.settings }); broadcastToContentScripts({ type:'SETTINGS_UPDATED', settings:msg.settings }); sendResponse({ ok:true }); break;
        case 'GET_STATS':   const stats = await getLocalStats(); sendResponse({ stats }); break;
        case 'CHECK_BUDGET': await checkBudgetAlert(msg.cost); sendResponse({ ok:true }); break;
        case 'PING':        sendResponse({ ok:true, version:chrome.runtime.getManifest().version }); break;
        default:            sendResponse({ error:'Unknown message type' });
      }
    } catch (err) { console.error('[TokenWise BG]', err); sendResponse({ error:err.message }); }
  })();
  return true;
});

function bufferSession(data) {
  sessionBuffer.push({ ...data, buffered_at: Date.now() });
  updateLocalStats(data);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushSessions, 3000);
}

async function flushSessions() {
  if (!sessionBuffer.length) return;
  const toFlush = [...sessionBuffer];
  sessionBuffer = [];
  const { authToken: storedToken } = await chrome.storage.local.get('authToken');
  const token = authToken || storedToken;
  if (!token) {
    const { pendingSessions=[] } = await chrome.storage.local.get('pendingSessions');
    await chrome.storage.local.set({ pendingSessions: [...pendingSessions, ...toFlush] });
    return;
  }
  for (const session of toFlush) {
    try {
      await fetch(`${CONFIG.NETLIFY_BASE}/log-session`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body:JSON.stringify(sanitizeSession(session)) });
    } catch(e) { console.warn('[TokenWise] flush error:', e.message); }
  }
}

function sanitizeSession(s) {
  return { tokens:Math.max(0,Math.min(2000000,parseInt(s.tokens)||0)), words:Math.max(0,parseInt(s.words)||0), characters:Math.max(0,parseInt(s.characters)||0), source_url:String(s.source_url||'').substring(0,200), model_used:String(s.model_used||'').substring(0,50), site:String(s.site||'').substring(0,50), cost_usd:Math.max(0,parseFloat(s.cost_usd)||0), prompt_text:s.prompt_text?String(s.prompt_text).substring(0,8000):undefined, prompt_type:s.prompt_type||undefined };
}

// Context portability
async function saveContextSession(data) {
  const { authToken: storedToken } = await chrome.storage.local.get('authToken');
  const token = authToken || storedToken;
  if (!token) return;
  try {
    await fetch(`${CONFIG.NETLIFY_BASE}/context-portability?action=save`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body:JSON.stringify(data) });
  } catch(e) { console.warn('[ctx save]', e.message); }
}

async function getLatestContext() {
  const { authToken: storedToken } = await chrome.storage.local.get('authToken');
  const token = authToken || storedToken;
  if (!token) return null;
  try {
    const res = await fetch(`${CONFIG.NETLIFY_BASE}/context-portability?action=get`, { headers:{ Authorization:`Bearer ${token}` } });
    const data = await res.json();
    return data.context || null;
  } catch(e) { return null; }
}

async function updateLocalStats(session) {
  const { localStats={} } = await chrome.storage.local.get('localStats');
  const today = new Date().toISOString().split('T')[0];
  if (!localStats[today]) localStats[today] = { tokens:0, cost:0, sessions:0 };
  localStats[today].tokens += session.tokens||0;
  localStats[today].cost   += session.cost_usd||0;
  localStats[today].sessions += 1;
  const keys = Object.keys(localStats).sort();
  if (keys.length > 30) delete localStats[keys[0]];
  await chrome.storage.local.set({ localStats });
}

async function getLocalStats() {
  const { localStats={}, pendingSessions=[] } = await chrome.storage.local.get(['localStats','pendingSessions']);
  const today = new Date().toISOString().split('T')[0];
  const todayStats = localStats[today] || { tokens:0, cost:0, sessions:0 };
  const allDays = Object.values(localStats);
  return { today:todayStats, total:{ tokens:allDays.reduce((s,d)=>s+d.tokens,0), cost:allDays.reduce((s,d)=>s+d.cost,0), sessions:allDays.reduce((s,d)=>s+d.sessions,0) }, history:localStats, pendingSync:pendingSessions.length };
}

async function checkBudgetAlert(newCost) {
  const { settings={}, budgetSpentToday=0, budgetResetDate } = await chrome.storage.local.get(['settings','budgetSpentToday','budgetResetDate']);
  const threshold = settings.budgetAlertThreshold||5.00;
  const today = new Date().toDateString();
  if (budgetResetDate !== today) { await chrome.storage.local.set({ budgetSpentToday:newCost, budgetResetDate:today, lastBudgetAlert:null }); return; }
  const spent = budgetSpentToday + newCost;
  await chrome.storage.local.set({ budgetSpentToday:spent });
  const pct = spent/threshold;
  const { lastBudgetAlert } = await chrome.storage.local.get('lastBudgetAlert');
  if (pct>=1.0 && lastBudgetAlert!=='100') { await chrome.storage.local.set({ lastBudgetAlert:'100' }); chrome.notifications.create('budget-100',{type:'basic',iconUrl:'icons/icon48.png',title:'⚠️ TokenWise Budget Alert',message:`You've reached your $${threshold.toFixed(2)} daily AI spend limit.`,priority:2}); }
  else if (pct>=0.9 && !['90','100'].includes(lastBudgetAlert)) { await chrome.storage.local.set({ lastBudgetAlert:'90' }); chrome.notifications.create('budget-90',{type:'basic',iconUrl:'icons/icon48.png',title:'TokenWise — 90% of budget used',message:`$${spent.toFixed(4)} of $${threshold.toFixed(2)} used.`,priority:1}); }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'dailyBudgetCheck') {
    const { budgetResetDate } = await chrome.storage.local.get('budgetResetDate');
    if (budgetResetDate !== new Date().toDateString()) await chrome.storage.local.set({ budgetSpentToday:0, budgetResetDate:new Date().toDateString(), lastBudgetAlert:null });
  }
  if (alarm.name === 'sessionFlush') await flushSessions();
});

async function broadcastToContentScripts(msg) {
  const tabs = await chrome.tabs.query({ url:['https://claude.ai/*','https://chat.openai.com/*','https://chatgpt.com/*','https://gemini.google.com/*'] });
  for (const tab of tabs) chrome.tabs.sendMessage(tab.id, msg).catch(()=>{});
}

(async () => {
  const { cachedUser, authToken: storedToken } = await chrome.storage.local.get(['cachedUser','authToken']);
  if (storedToken && cachedUser) { authToken=storedToken; currentUser=cachedUser; }
})();
