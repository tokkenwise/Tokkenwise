// TokenWise Content Script v2
// Added: smart switch warnings, context portability, follow-up detection, Sentry
(function() {
  'use strict';

  const host = location.hostname;
  const SITE = host.includes('claude.ai')?'claude':host.includes('openai.com')||host.includes('chatgpt.com')?'chatgpt':host.includes('gemini.google.com')?'gemini':null;
  if (!SITE) return;

  const SELECTORS = {
    claude:  ['[contenteditable="true"][data-placeholder]','div.ProseMirror','div[contenteditable="true"]'],
    chatgpt: ['#prompt-textarea','textarea[data-id="root"]','div[contenteditable="true"][id]','textarea'],
    gemini:  ['div.ql-editor[contenteditable="true"]','rich-textarea div[contenteditable="true"]','div[contenteditable="true"]'],
  };

  const MODELS = {
    'claude-3-opus':  {name:'Claude 3 Opus',  inputPer1M:15,  context:200000},
    'claude-3-sonnet':{name:'Claude 3.5 Sonnet',inputPer1M:3,  context:200000},
    'claude-3-haiku': {name:'Claude 3 Haiku', inputPer1M:0.25,context:200000},
    'gpt-4o':         {name:'GPT-4o',         inputPer1M:5,   context:128000},
    'gpt-4-turbo':    {name:'GPT-4 Turbo',    inputPer1M:10,  context:128000},
    'gpt-3.5':        {name:'GPT-3.5 Turbo',  inputPer1M:0.5, context:16000},
    'gemini-1.5-pro': {name:'Gemini 1.5 Pro', inputPer1M:3.5, context:1000000},
    'gemini-flash':   {name:'Gemini Flash',   inputPer1M:0.35,context:1000000},
  };
  const SITE_MODELS = { claude:['claude-3-sonnet','claude-3-haiku','claude-3-opus'], chatgpt:['gpt-4o','gpt-3.5','gpt-4-turbo'], gemini:['gemini-1.5-pro','gemini-flash'] };

  let settings = { showWidget:true, defaultModel:SITE==='claude'?'claude-3-sonnet':SITE==='chatgpt'?'gpt-4o':'gemini-1.5-pro', theme:'auto' };
  let currentModel = settings.defaultModel;
  let widget = null, currentInput = null, lastText = '', sessionCost = 0;
  let debounceTimer = null, submitObserver = null;
  let activeContext = null; // context portability
  let lastSessionText = ''; // for context capture
  let switchWarnShown = false;

  // Load settings
  chrome.runtime.sendMessage({ type:'GET_SETTINGS' }, res => {
    if (res?.settings) { settings={...settings,...res.settings}; currentModel=settings.defaultModel||currentModel; }
    if (settings.showWidget) init();
  });

  // Load active context from background
  chrome.runtime.sendMessage({ type:'GET_CONTEXT' }, res => { activeContext=res?.context||null; });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type==='SETTINGS_UPDATED') { settings={...settings,...msg.settings}; if(widget)applyTheme(); if(!settings.showWidget&&widget)removeWidget(); if(settings.showWidget&&!widget)init(); }
  });

  function init() { waitForInput(); observeNavigation(); }

  function waitForInput(retries=0) {
    const input=findInput();
    if(input) attachToInput(input);
    else if(retries<30) setTimeout(()=>waitForInput(retries+1),500);
  }

  function findInput() {
    for(const sel of SELECTORS[SITE]||[]) { const el=document.querySelector(sel); if(el&&isVisible(el))return el; }
    return null;
  }

  function isVisible(el) { const r=el.getBoundingClientRect(); return r.width>0&&r.height>0; }

  function attachToInput(input) {
    if(currentInput===input)return;
    currentInput=input;
    if(!widget) createWidget();
    input.addEventListener('input',onInput);
    input.addEventListener('keydown',onKeydown);
    input.addEventListener('paste',()=>setTimeout(onInput,50));
    watchForSubmit(input);
    onInput();
  }

  function observeNavigation() {
    let lastUrl=location.href;
    new MutationObserver(()=>{ if(location.href!==lastUrl){lastUrl=location.href;currentInput=null;setTimeout(waitForInput,800);} }).observe(document.body,{subtree:true,childList:true});
  }

  // ── WIDGET ─────────────────────────────────────────────────────────────────
  function createWidget() {
    widget=document.createElement('div');
    widget.id='tokenwise-widget';
    widget.setAttribute('data-site',SITE);
    const models=SITE_MODELS[SITE]||[];
    widget.innerHTML=`
<div class="tw-header">
  <div class="tw-logo"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect width="14" height="14" rx="3.5" fill="url(#twg)"/><path d="M4 9.5L7 4.5L10 9.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><defs><linearGradient id="twg" x1="0" y1="0" x2="14" y2="14"><stop offset="0%" stop-color="#00a572"/><stop offset="100%" stop-color="#6d55e8"/></linearGradient></defs></svg><span>TokenWise</span></div>
  <div class="tw-controls"><button class="tw-btn-icon tw-minimize" title="Minimize">—</button><button class="tw-btn-icon tw-close" title="Hide">×</button></div>
</div>
<div class="tw-body">
  <div class="tw-main-stat"><div class="tw-token-count" id="tw-tokens">0</div><div class="tw-token-label">tokens</div><div class="tw-cost" id="tw-cost">$0.000000</div></div>
  <div class="tw-context-bar-wrap">
    <div class="tw-context-labels"><span>Context window</span><span id="tw-context-pct">0%</span></div>
    <div class="tw-context-bar"><div class="tw-context-fill" id="tw-context-fill" style="width:0%"></div></div>
    <div class="tw-context-limit" id="tw-context-limit">/ 200,000</div>
  </div>
  <div class="tw-model-row"><label class="tw-model-label">Model</label><select class="tw-model-select" id="tw-model-select">${models.map(id=>`<option value="${id}" ${id===currentModel?'selected':''}>${MODELS[id]?.name||id}</option>`).join('')}</select></div>
  <div class="tw-stats-row">
    <div class="tw-stat"><div class="tw-stat-val" id="tw-words">0</div><div class="tw-stat-key">words</div></div>
    <div class="tw-stat"><div class="tw-stat-val" id="tw-chars">0</div><div class="tw-stat-key">chars</div></div>
    <div class="tw-stat"><div class="tw-stat-val" id="tw-session-cost">$0.00</div><div class="tw-stat-key">session</div></div>
  </div>
  <div class="tw-warn" id="tw-warn" style="display:none"><span>⚠️</span><span id="tw-warn-text">Approaching context limit</span></div>
  <div class="tw-switch-warn" id="tw-switch-warn" style="display:none">
    <span>🔀</span>
    <div style="flex:1"><div style="font-weight:700;font-size:10px">Follow-up detected</div><div id="tw-switch-warn-text" style="font-size:10px;margin-top:1px">Switching models may lose context</div></div>
    <button class="tw-carry-btn" id="tw-carry-btn">Carry →</button>
  </div>
  <div class="tw-ctx-banner" id="tw-ctx-banner" style="display:none">
    <span>💬</span><div style="flex:1;font-size:10px"><strong>Context available</strong> from <span id="tw-ctx-site"></span></div>
    <button class="tw-carry-btn" id="tw-inject-btn">Inject</button>
  </div>
</div>
<div class="tw-minimized" id="tw-minimized" style="display:none" onclick="this.parentElement.querySelector('.tw-body').style.display='';this.parentElement.querySelector('.tw-header').style.display='';this.style.display='none'">
  <span id="tw-mini-tokens">0</span><span class="tw-mini-label">tokens</span>
</div>`;
    document.body.appendChild(widget);
    applyTheme();
    widget.querySelector('#tw-model-select')?.addEventListener('change',e=>{currentModel=e.target.value;checkSwitchWarning();onInput();});
    widget.querySelector('.tw-minimize')?.addEventListener('click',toggleMinimize);
    widget.querySelector('.tw-close')?.addEventListener('click',()=>{ removeWidget(); chrome.runtime.sendMessage({type:'GET_SETTINGS'},res=>{const s={...(res?.settings||{}),showWidget:false};chrome.runtime.sendMessage({type:'SET_SETTINGS',settings:s});}); });
    widget.querySelector('#tw-carry-btn')?.addEventListener('click',injectContext);
    widget.querySelector('#tw-inject-btn')?.addEventListener('click',injectContext);
    makeDraggable(widget);
    showActiveContextBanner();
  }

  function showActiveContextBanner() {
    if(!activeContext||!widget)return;
    const banner=widget.querySelector('#tw-ctx-banner');
    const siteEl=widget.querySelector('#tw-ctx-site');
    if(banner&&siteEl){ siteEl.textContent=activeContext.site; banner.style.display='flex'; }
  }

  function injectContext() {
    if(!activeContext||!currentInput)return;
    const preamble=`[Context from previous session on ${activeContext.site}: ${activeContext.context_summary}]\n\n`;
    if(currentInput.tagName==='TEXTAREA'){
      currentInput.value=preamble+(currentInput.value||'');
      currentInput.dispatchEvent(new Event('input'));
    } else {
      currentInput.focus();
      document.execCommand('selectAll',false,null);
      const existing=currentInput.innerText||'';
      document.execCommand('insertText',false,preamble+existing);
    }
    // Mark as used
    chrome.runtime.sendMessage({type:'MARK_CONTEXT_USED',id:activeContext.id});
    widget.querySelector('#tw-ctx-banner').style.display='none';
    activeContext=null;
  }

  // Smart switch warning — detect follow-up prompt when model differs from site default
  function checkSwitchWarning() {
    if(!widget||!lastText)return;
    const t=lastText.toLowerCase().trim();
    const siteDefault = SITE==='claude'?'claude-3-sonnet':SITE==='chatgpt'?'gpt-4o':'gemini-1.5-pro';
    const isDifferentModel = currentModel!==siteDefault;
    const followUpSignals = /^(also|what about|can you|following up|one more|and |but |however|additionally|furthermore|now |next |then )/.test(t) || (/\b(it|that|them|this|those|these)\b/.test(t) && lastText.length<120);
    const warn=widget.querySelector('#tw-switch-warn');
    if(warn){ warn.style.display=(isDifferentModel&&followUpSignals&&!switchWarnShown)?'flex':'none'; if(isDifferentModel&&followUpSignals)switchWarnShown=true; }
  }

  function toggleMinimize() {
    const body=widget.querySelector('.tw-body'), header=widget.querySelector('.tw-header'), mini=widget.querySelector('#tw-minimized');
    const isMin=body.style.display==='none';
    body.style.display=isMin?'':'none'; header.style.display=isMin?'':'none'; mini.style.display=isMin?'none':'flex';
  }

  function removeWidget() { widget?.remove(); widget=null; }

  function applyTheme() {
    if(!widget)return;
    const prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark=settings.theme==='dark'||(settings.theme==='auto'&&prefersDark);
    widget.setAttribute('data-theme',isDark?'dark':'light');
  }

  // ── INPUT HANDLER ────────────────────────────────────────────────────────
  function onInput() { clearTimeout(debounceTimer); debounceTimer=setTimeout(updateWidget,80); }

  function onKeydown(e) {
    if(e.key==='Enter'&&!e.shiftKey){
      const text=getText();
      if(text.trim()){
        const tokens=window.TokenWise?.countTokens(text)||0;
        lastSessionText=text;
        logSession(text,tokens);
        switchWarnShown=false;
      }
    }
  }

  function getText() {
    if(!currentInput)return'';
    return currentInput.tagName==='TEXTAREA'?currentInput.value:(currentInput.innerText||currentInput.textContent||'');
  }

  function updateWidget() {
    if(!widget||!currentInput)return;
    const text=getText();
    if(text===lastText)return;
    lastText=text;
    const tokens=window.TokenWise?.countTokens(text)||0;
    const words=text.trim()?text.trim().split(/\s+/).length:0;
    const chars=text.length;
    const model=MODELS[currentModel];
    const cost=(tokens/1e6)*(model?.inputPer1M||3);
    const context=model?.context||200000;
    const pct=Math.min(100,(tokens/context)*100);

    widget.querySelector('#tw-tokens').textContent=tokens.toLocaleString();
    widget.querySelector('#tw-cost').textContent=fmtCost(cost);
    widget.querySelector('#tw-words').textContent=words.toLocaleString();
    widget.querySelector('#tw-chars').textContent=chars.toLocaleString();
    widget.querySelector('#tw-context-pct').textContent=pct.toFixed(1)+'%';
    widget.querySelector('#tw-context-fill').style.width=pct+'%';
    widget.querySelector('#tw-context-limit').textContent='/ '+context.toLocaleString();
    widget.querySelector('#tw-mini-tokens').textContent=tokens.toLocaleString();

    const fill=widget.querySelector('#tw-context-fill');
    fill.classList.toggle('tw-fill-warn',pct>70); fill.classList.toggle('tw-fill-danger',pct>90);

    const warn=widget.querySelector('#tw-warn'), warnText=widget.querySelector('#tw-warn-text');
    if(pct>90){warn.style.display='flex';warnText.textContent=`${pct.toFixed(0)}% of context used`;}
    else if(pct>70){warn.style.display='flex';warnText.textContent='Approaching context limit';}
    else{warn.style.display='none';}

    sessionCost=Math.max(sessionCost,cost);
    widget.querySelector('#tw-session-cost').textContent='$'+sessionCost.toFixed(4);
    if(cost>0) chrome.runtime.sendMessage({type:'CHECK_BUDGET',cost});

    checkSwitchWarning();
  }

  // ── SESSION LOGGING ───────────────────────────────────────────────────────
  function watchForSubmit(input) {
    if(submitObserver) submitObserver.disconnect();
    submitObserver=new MutationObserver(()=>{
      const currentText=getText();
      if(lastText.trim()&&(!currentText||currentText.length<10)){
        // Prompt was submitted — save context for portability
        if(lastSessionText.length>50){
          chrome.runtime.sendMessage({ type:'SAVE_CONTEXT', data:{ conversation_text:lastSessionText, site:location.hostname, model_used:currentModel, token_count:window.TokenWise?.countTokens(lastSessionText)||0 } });
        }
        sessionCost=0;
        if(widget) widget.querySelector('#tw-session-cost').textContent='$0.0000';
      }
    });
    submitObserver.observe(input,{characterData:true,childList:true,subtree:true});
  }

  function logSession(text,tokens) {
    const model=MODELS[currentModel];
    const cost=(tokens/1e6)*(model?.inputPer1M||3);
    chrome.runtime.sendMessage({ type:'LOG_SESSION', data:{ tokens, words:text.trim().split(/\s+/).filter(Boolean).length, characters:text.length, source_url:location.hostname, model_used:currentModel, site:SITE, cost_usd:cost, prompt_text:text, prompt_type:classifyPrompt(text) } });
  }

  function classifyPrompt(text) {
    const t=text.toLowerCase();
    if(/```|function |const |def |class /.test(text))return'code';
    if(/write|draft|essay|article|blog/.test(t))return'writing';
    if(/analyze|analyse|summarize|compare/.test(t))return'analysis';
    if(/\?$/.test(t.trim()))return'qa';
    return'general';
  }

  // ── DRAG ──────────────────────────────────────────────────────────────────
  function makeDraggable(el) {
    let isDragging=false,startX,startY,origX,origY;
    const header=el.querySelector('.tw-header'); if(!header)return;
    header.style.cursor='grab';
    header.addEventListener('mousedown',e=>{ if(e.target.closest('.tw-controls'))return; isDragging=true; startX=e.clientX; startY=e.clientY; const r=el.getBoundingClientRect(); origX=r.left; origY=r.top; header.style.cursor='grabbing'; e.preventDefault(); });
    document.addEventListener('mousemove',e=>{ if(!isDragging)return; el.style.left=Math.max(0,origX+e.clientX-startX)+'px'; el.style.top=Math.max(0,origY+e.clientY-startY)+'px'; el.style.right='auto'; el.style.bottom='auto'; });
    document.addEventListener('mouseup',()=>{ isDragging=false; header.style.cursor='grab'; });
  }

  function fmtCost(cost) {
    if(!cost||cost===0)return'$0.000000';
    if(cost<0.0001)return'$'+cost.toFixed(7);
    if(cost<0.001) return'$'+cost.toFixed(6);
    if(cost<0.01)  return'$'+cost.toFixed(5);
    return'$'+cost.toFixed(4);
  }
})();
