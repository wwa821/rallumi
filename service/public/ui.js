import { t, diagnostic, language, setLanguage } from './i18n.js';
import { copyText, flashButtonLabel, markdownBody } from './markdown.js?v=group-management';
import { mountOrganization } from './organization.js?v=layered-layout';
import { everyoneMention } from './mentions.js';
const $=id=>document.getElementById(id);
const productName=$('product-name').textContent;
const transport=globalThis.rallumiTransport;
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
let roomId = Number(new URLSearchParams(location.search).get('room') ?? 1);
let stream, selectedThread = null, previewThread = null, groupKey = '';
let groupAvatarDraft, groupMenuTarget, groupEditTarget, removeMessageTarget;
let chatFontDraft=14;
const drafts = new Map();
const pendingSentMotion = new Set();
const thinkingStages = new Set(['等待模型回复','模型推理中']);
const attachmentsByRoom = new Map();
const skillsByRoom = new Map();
const tasksByRoom = new Map();
let taskEditor, taskViewKey;
let profileDraft, settingsMember, settingsRequest = 0, skillRequest = 0, skillOptions = [];
let selectedSkill, skillLoading = false, skillError = '';
const sizeLimit = 20 * 1024 * 1024;
let composeOptions;
let messageClock, messageDate, savingLanguage = false;
function updateLanguage(value) {
  setLanguage(value);
  messageClock = new Intl.DateTimeFormat(language,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  messageDate = new Intl.DateTimeFormat(language,{year:'numeric',month:'long',day:'numeric',weekday:'long'});
  $('app-language').value=language;
  setSidebarCollapsed($('group-sidebar').hidden);
  groupKey=memberKey=appearanceKey='';
  taskViewKey=undefined;
  setNewMessageCount(newMessageCount);
}
let historyDay = '', newMessageCount = 0;
let state, connected=false, sending=false, historyCount=-1, memberKey='', appearanceKey='', searchEpoch=0, cursor, searchTimer;
async function api(route,data,id=roomId){
  const url = new URL('/api/'+route,location.origin==='null' ? 'http://127.0.0.1:4317' : location.origin);
  url.searchParams.set('room',id);
  const res=await request(url.pathname+url.search,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});
  const out=await res.json();if(!res.ok)throw Error(diagnostic(out.error)||t('请求失败'));return out;
}
function request(route,options) {
  return transport ? transport.request(route,options) : fetch(route,options);
}
function showAttachment(image,address) {
  if (!transport) { image.src=address; return; }
  transport.attachment(address).then(url=>{ image.src=url; }).catch(()=>image.remove());
}
const organization = mountOrganization(api, memberTint);
function fail(e){$('error').textContent=diagnostic(e.message);}
function setSidebarCollapsed(collapsed) {
  const toggle=$('sidebar-toggle');
  const label=collapsed ? t('展开群聊列表') : t('收起群聊列表');
  $('app-layout').classList.toggle('sidebar-collapsed',collapsed);
  $('group-sidebar').hidden=collapsed;
  toggle.setAttribute('aria-expanded',String(!collapsed));
  toggle.setAttribute('aria-label',label);
  toggle.title=label;
}
try {
  const saved=localStorage.getItem('agent-room-sidebar');
  setSidebarCollapsed(saved===null ? matchMedia('(max-width:480px)').matches : saved==='collapsed');
} catch { setSidebarCollapsed(matchMedia('(max-width:480px)').matches); }
$('sidebar-toggle').onclick=()=>{
  const collapsed=!$('group-sidebar').hidden;
  setSidebarCollapsed(collapsed);
  try { localStorage.setItem('agent-room-sidebar',collapsed ? 'collapsed' : 'expanded'); } catch {}
};
function avatarSymbol(symbol) {
  const namespace='http://www.w3.org/2000/svg';
  const icon=document.createElementNS(namespace,'svg');
  const use=document.createElementNS(namespace,'use');
  use.setAttribute('href','#avatar-'+symbol);
  icon.setAttribute('class','avatar-symbol');
  icon.setAttribute('aria-hidden','true');
  icon.append(use);
  return icon;
}
function groupAvatar(group) {
  const node=el('span','group-avatar');
  node.append(avatarSymbol('group'));
  node.setAttribute('aria-hidden','true');
  if (group.avatarId) {
    const image=el('img');
    image.alt='';
    image.onerror=()=>image.remove();
    showAttachment(image,'/api/attachment?'+new URLSearchParams({room:group.id,id:group.avatarId}));
    node.append(image);
  }
  return node;
}
let mentionOptions=[], mentionIndex=0, mentionRange=null, avatarClickTimer;
function messageMentions(text) {
  return [...text.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map(match=>match[1]);
}
function mentionAtCaret(input) {
  if (input.selectionStart!==input.selectionEnd) return null;
  const caret=input.selectionStart;
  const match=input.value.slice(0,caret).match(/@([\p{L}\p{N}_-]*)$/u);
  if (!match) return null;
  const tail=input.value.slice(caret).match(/^[\p{L}\p{N}_-]*/u)[0];
  return {start:caret-match[0].length,end:caret+tail.length,query:match[1],name:match[1]+tail};
}
function mention(name, range = mentionRange) {
  const input = $('message');
  const partial = mentionAtCaret(input);
  if (!range && partial && !everyoneMention(partial.name,state.members.map(member=>member.name)) &&
      !state.members.some(member=>member.name===partial.name)) range=partial;
  const {start,end} = range || {start:input.selectionStart,end:input.selectionEnd};
  const prefix = input.value.slice(0,start);
  const suffix = input.value.slice(end);
  const alreadyMentioned = messageMentions(prefix+' '+suffix).includes(name);
  closeMentions();
  if (!alreadyMentioned || range) {
    const space = suffix && /^\s/u.test(suffix) ? '' : ' ';
    const leading = prefix && !/\s$/u.test(prefix) ? ' ' : '';
    input.setRangeText(leading+'@'+name+space,start,end,'end');
    if (!space && /^[ \t]/u.test(suffix)) input.setSelectionRange(input.selectionEnd+1,input.selectionEnd+1);
  }
  input.focus({preventScroll:true});
  controls();
}
function closeMentions() {
  mentionOptions=[];
  mentionRange=null;
  $('mention-list').hidden=true;
  $('mention-open').setAttribute('aria-expanded','false');
  $('message').removeAttribute('aria-activedescendant');
}
function highlightMention() {
  const list=$('mention-list');
  for (const [index,option] of [...list.children].entries()) {
    option.setAttribute('aria-selected',String(index===mentionIndex));
  }
  const option=list.children[mentionIndex];
  if(mentionOptions.length && option) {
    $('message').setAttribute('aria-activedescendant',option.id);
    option.scrollIntoView({block:'nearest'});
  } else $('message').removeAttribute('aria-activedescendant');
}
function chooseMention(name) {
  if (mentionRange) mention(name);
}
function showMentions() {
  const input=$('message'), list=$('mention-list');
  mentionRange=mentionAtCaret(input);
  if (!state?.members.length || !mentionRange) return closeMentions();
  const query=mentionRange.query.toLocaleLowerCase();
  const names=state.members.map(member=>member.name);
  const alias=everyoneMention('All',names) && (query ? 'all'.startsWith(query) : language==='en') ? 'All' : '全体';
  const candidates=[{name:alias,role:t('发送给当前群的所有成员')},...state.members]
    .map(member=>{
      const name=member.name.toLocaleLowerCase();
      const rank=name===query ? 0 : name.startsWith(query) ? 1 : name.includes(query) ? 2
        : member.role?.toLocaleLowerCase().includes(query) ? 3 : Infinity;
      return {member,rank};
    })
    .filter(({rank})=>Number.isFinite(rank))
    .sort((a,b)=>a.rank-b.rank)
    .map(({member})=>member);
  mentionOptions=candidates.map(member=>member.name);
  mentionIndex=0;
  list.replaceChildren(...candidates.map(({name,role},index)=>{
    const option=el('li','mention-option');
    const description=el('span','mention-description');
    description.append(el('strong','','@'+name));
    description.title=role ? '@'+name+' · '+role : '@'+name;
    if (role) description.append(el('small','',role));
    const icon=everyoneMention(name,names) ? el('span','avatar mention-all','@') : avatar(name);
    icon.setAttribute('aria-hidden','true');
    option.append(icon);
    option.append(description);
    option.id='mention-option-'+index;
    option.setAttribute('role','option');
    option.onpointerdown=event=>event.preventDefault();
    option.onclick=()=>chooseMention(name);
    return option;
  }));
  if (!mentionOptions.length) {
    const empty=el('li','mention-empty',t('找不到匹配的群成员'));
    empty.setAttribute('role','status');
    list.append(empty);
  }
  list.hidden=false;
  $('mention-open').setAttribute('aria-expanded','true');
  highlightMention();
}
function memberColor(name) {
  return state.members.find(member=>member.name===name)?.color ?? 0;
}
const profileColors=[
  ['墨蓝','#344e78'],['湖蓝','#087ca7'],['靛青','#4b50a5'],['岩青','#3c5960'],
  ['孔雀青','#087b72'],['松绿','#3d6855'],['蕨绿','#567829'],['橄榄','#71743a'],
  ['暖铜','#814720'],['陶土','#af573e'],['琥珀','#a36a18'],['沙金','#ce9d46'],
  ['砖红','#a33634'],['酒红','#88465c'],['莓红','#ab3f78'],['烟粉','#a96d7c'],
  ['灰紫','#76546d'],['梅紫','#754bb0'],['葡萄紫','#573768'],['丁香灰','#8b7aa5'],
  ['石墨','#596475'],['深灰','#3e4653'],['暖灰','#74685f'],['雾灰','#8798a5']
];
function colorInk(hex) {
  const channels=hex.slice(1).match(/../g).map(channel=>parseInt(channel,16)/255);
  const linear=channels.map(channel=>channel<=0.04045 ? channel/12.92 : ((channel+0.055)/1.055)**2.4);
  const luminance=0.2126*linear[0]+0.7152*linear[1]+0.0722*linear[2];
  return luminance>0.179 ? '#000' : '#fff';
}
function memberTint(node,name,hex=state.members.find(member=>member.name===name)?.colorHex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? '')) return node;
  node.style.setProperty('--member-accent',hex);
  node.style.setProperty('--member-avatar-ink',colorInk(hex));
  node.style.setProperty('--member-bubble','color-mix(in srgb, '+hex+' 12%, white)');
  node.style.setProperty('--member-border','color-mix(in srgb, '+hex+' 18%, white)');
  return node;
}
function avatar(name,id=state.members.find(member=>member.name===name)?.avatarId,hex=state.members.find(member=>member.name===name)?.colorHex) {
  const icon=memberTint(el('span','avatar c'+memberColor(name)),name,hex);
  icon.append(avatarSymbol('person'));
  if (id) {
    const picture=el('img');
    picture.alt='';
    picture.onerror=()=>picture.remove();
    showAttachment(picture,'/api/attachment?'+new URLSearchParams({room:roomId,id}));
    icon.append(picture);
  }
  return icon;
}
function settingsAvatar(name) {
  const icon = avatar(name);
  if (!state.members.some(member => member.name === name)) return icon;
  const button = el('button','avatar-button');
  button.type = 'button';
  button.setAttribute('aria-label',t('{0}的设置',name));
  button.title = t('单击打开设置 · 双击 @{0}',name);
  button.onpointerdown = event => {
    if (event.pointerType==='mouse') event.preventDefault();
  };
  button.onclick = event => {
    clearTimeout(avatarClickTimer);
    if (!event.detail) { void openSettings(name); return; }
    if (event.detail===1) avatarClickTimer=setTimeout(()=>{
      if (button.isConnected) void openSettings(name);
    },500);
  };
  button.ondblclick = event => {
    event.preventDefault();
    clearTimeout(avatarClickTimer);
    mention(name);
  };
  button.append(icon);
  return button;
}
function row(name,text,note,attachments = [],skill,contributors=[]){
  if(name==='系统')return el('p','system',diagnostic(text));
  const line=el('div',name==='你'?'msg msg-self':'msg msg-agent c'+memberColor(name)), a=el('article'), head=el('div','meta',name==='你' ? t('你') : name);
  if (name!=='你') memberTint(line,name);
  const body=name==='你' ? el('div','body',text) : markdownBody(text);
  head.append(el('small','',note));
  a.append(head,body);
  if (attachments.length) {
    const files = el('div',text ? 'sent-files with-caption' : 'sent-files');
    for (const file of attachments) {
      const link = el('a','sent-file');
      const address='/api/attachment?'+new URLSearchParams({room:roomId,id:file.id});
      link.href=transport ? '#' : address;
      link.download = file.name;
      if (transport) link.onclick=async event=>{
        event.preventDefault();
        try {
          const download=el('a');
          download.href=await transport.attachment(address);
          download.download=file.name;
          download.click();
        } catch (error) { fail(error); }
      };
      if (file.image) {
        const thumbnail = el('img');
        showAttachment(thumbnail,address);
        thumbnail.alt = file.name;
        thumbnail.loading = 'lazy';
        link.append(thumbnail);
      }
      link.append(el('span','',file.name));
      files.append(link);
    }
    body.append(files);
  }
  if (skill) a.append(el('div','skill-chip',skillCaption(skill)));
  if (contributors.length) {
    const credits=el('div','message-contributors');
    credits.append(el('span','',t('贡献成员')),...contributors.map(label=>memberTint(el('span','contributor c'+memberColor(label),label),label)));
    a.append(credits);
  }
  if (name!=='你') line.append(settingsAvatar(name));
  line.append(a);
  return line;
}
function controls(){
  const draft=$('message').value;
  const skill=skillsByRoom.get(roomId);
  const hasDraft=!!(draft.trim() || draftFiles().length || skill);
  const unfinishedMention=/@\s*$/u.test(draft);
  const refs=messageMentions(draft);
  const names=state?.members.map(member=>member.name) || [];
  const isEveryone = name => everyoneMention(name,names);
  const unknown=refs.find(name=>!isEveryone(name) && !names.includes(name));
  const summary=$('send-targets');
  if (hasDraft && state?.members.length) {
    const targets=[...new Set([...refs,...(skill?.targets || [])])];
    const all=!targets.length || refs.some(isEveryone);
    const recipients=all ? names : targets;
    const waiting=state.active.filter(entry=>recipients.includes(entry.name)).length;
    summary.textContent=unfinishedMention ? t('请选择 @ 成员') : unknown ? t('未识别的成员 @{0}',unknown)
      : (all ? t('发给全体（{0} 位）',names.length) : t('发给 {0}',targets.join(language==='en' ? ', ' : '、')))+
        (!state.paused && waiting ? t(' · {0} 位将排队',waiting) : '');
  } else summary.textContent='';
  summary.title=summary.textContent;
  $('send').textContent=sending ? t('发送中') : t('发送');
  $('send').disabled=!connected || state?.managing || state?.paused || !state?.members.length || sending || !hasDraft || unfinishedMention || !!unknown;
  $('open-group-settings').disabled = !connected || !roomId;
  $('open-tasks').disabled = !connected || !roomId;
  $('open-organization').disabled = !connected || !roomId;
  $('pick-skill').disabled = !connected || !state?.members.length;
  $('pause').disabled=!connected || !roomId || !!state?.managing;
}
function animateSentMessage(row) {
  const bubble=row.querySelector('.body:not(:empty)');
  if (!bubble) return;
  bubble.classList.add('sent-arrival');
  bubble.addEventListener('animationend',()=>bubble.classList.remove('sent-arrival'),{once:true});
}
function nearLatest(scroll) {
  return scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<90;
}
function setNewMessageCount(count) {
  newMessageCount=count;
  const button=$('jump-to-latest');
  button.hidden=!count;
  if (count) button.textContent=t('↓ {0} 条新消息',count);
}
$('scroll').addEventListener('scroll',event=>{
  if (newMessageCount && nearLatest(event.currentTarget)) setNewMessageCount(0);
},{passive:true});
$('jump-to-latest').onclick=()=>{
  const scroll=$('scroll');
  setNewMessageCount(0);
  const far=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight>2*scroll.clientHeight;
  scroll.scrollTo({top:scroll.scrollHeight,behavior:far || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
  $('message').focus({preventScroll:true});
};
function visibleMessage(snapshot,message) {
  return snapshot.showAgentInteractions!==false || !(message.interaction || message.kind==='question');
}
function render(s){
  if (!savingLanguage && s.language && s.language!==language) updateLanguage(s.language);
  state=s;
  document.querySelector('.chat').style.setProperty('--chat-font-size',(s.chatFontSize ?? 14)+'px');
  renderTasks();
  organization.update(s);
  const sc=$('scroll'),stick=nearLatest(sc);
  const live=$('live');
  const previous=new Map([...live.children].map(line=>[line.dataset.member,line]));
  const appended=historyCount<0 ? [] : s.messages.slice(historyCount);
  const incoming=appended.filter(message=>message.author!=='你' && message.author!=='系统' && visibleMessage(s,message));
  const unanimatedReplies=new Set(incoming.map(message=>message.id));
  const currentGroup=s.groups.find(group=>group.id===s.roomId);
  const groupName = currentGroup?.name || productName;
  $('roomname').textContent = groupName;
  $('room-member-count').textContent = currentGroup ? '('+s.members.length+')' : '';
  document.title = currentGroup ? groupName + ' · ' + productName : productName;
  const nextGroupKey = JSON.stringify([s.roomId,s.groups,s.archivedGroups]);
  if (groupKey !== nextGroupKey) {
    groupKey = nextGroupKey;
    closeGroupMenu();
    renderArchivedGroups();
    $('room-avatar').hidden=!currentGroup;
    if (currentGroup) $('room-avatar').replaceChildren(groupAvatar(currentGroup));
    $('groups').replaceChildren(...s.groups.map(group=>{
      const button = el('button','group-link');
      button.append(groupAvatar(group),el('span','group-link-name',group.name));
      button.type = 'button';
      if (group.id === s.roomId) button.setAttribute('aria-current','page');
      button.onclick = () => {
        if (matchMedia('(max-width:480px)').matches) {
          setSidebarCollapsed(true);
          try { localStorage.setItem('agent-room-sidebar','collapsed'); } catch {}
        }
        if (group.id !== roomId) openGroup(group.id);
      };
      const item=el('div','group-entry');
      const more=el('button','group-more','⋯');
      more.type='button';
      more.setAttribute('aria-label',t('{0}的群聊操作',group.name));
      more.onclick=()=>showGroupMenu(group,more);
      item.oncontextmenu=event=>{
        event.preventDefault();
        showGroupMenu(group,more,event);
      };
      item.append(button,more);
      return item;
    }));
  }
  $('open-organization').title = t('群成员（{0}）',s.members.length);
  $('emptyhint').textContent = !s.roomId ? '从左侧新建群聊，或恢复已归档的群聊。' : s.members.length ? t('向全体提问，或在群成员里点名。') : t('先在群成员里添加你的协作伙伴。');
  $('status').textContent=s.paused ? t('已暂停') : '';
  $('pause').textContent=s.paused?t('继续讨论'):t('暂停讨论');
  const key=JSON.stringify(s.members.map(m=>[m.name,m.role,m.color,m.avatarId,m.colorHex]));
  if(key!==memberKey){
    memberKey=key;$('members').replaceChildren(...s.members.map(m=>{
      const b=el('button','member');b.type='button';b.title=t('点名 @{0}',m.name);
      const info=el('span','',m.name);info.append(el('small','',m.role));b.append(info);b.onclick=()=>{ $('organization').close(); mention(m.name); };
      const remove = el('button','remove-member',t('移除'));
      remove.type = 'button';
      remove.setAttribute('aria-label',t('移除成员 {0}',m.name));
      remove.onclick = async () => {
        if (!window.confirm(t('将「{0}」移出当前群聊？其历史消息和 Codex 会话会保留。',m.name))) return;
        $('member-management-error').textContent='';
        try { await api('member/remove',{name:m.name},s.roomId); }
        catch(error) { $('member-management-error').textContent=diagnostic(error.message); }
      };
      const item = el('div','member-row');
      item.append(settingsAvatar(m.name),b,remove);
      return item;
    }));
  }
  const appearance=JSON.stringify([language,s.historyRevision,s.showAgentInteractions,s.members.map(member=>[member.name,member.color,member.avatarId,member.colorHex])]);
  if (historyCount>s.messages.length || appearance!==appearanceKey ||
      s.messages.slice(Math.max(0,historyCount)).some(msg=>msg.kind==='rename')) {
    appearanceKey=appearance;
    historyCount = -1;
    historyDay = '';
    $('history').replaceChildren();
  }
  for(const msg of s.messages.slice(Math.max(0,historyCount))){
    if (!visibleMessage(s,msg)) continue;
    const date = new Date(msg.time);
    const hasTime = msg.time != null && Number.isFinite(date.getTime());
    const day = hasTime ? messageDate.format(date) : '';
    const dayChanged = day && day!==historyDay;
    const time = hasTime ? messageClock.format(date) : '';
    const lockNotice=msg.author==='系统' && /^(.+?) · (?:原 Codex 会话(?:正被其他窗口使用|仍有写入者|被占用)|Codex 后台拒绝续接|thread [\w-]+ already has an active writer)/i.exec(msg.text);
    const message=lockNotice ? lockNotice[1]+' · '+t('Codex 后台拒绝续接，消息尚未发送。') : msg.text;
    const entry = row(msg.author,message,time,msg.attachments,msg.skill,msg.contributors);
    entry.id='message-'+msg.id;
    const prior=previous.get(msg.author);
    if (unanimatedReplies.has(msg.id) && msg.text && prior?.classList.contains('msg-thinking')) {
      entry.querySelector('article').classList.add('reply-arrival');
      prior.classList.remove('msg-thinking');
    }
    if (msg.author!=='系统') entry.querySelector('article').append(messageActions(msg,s.roomId));
    if (lockNotice) {
      entry.dataset.writer=lockNotice[1];
      const previous=$('history').lastElementChild;
      if (!dayChanged && previous?.dataset.writer===entry.dataset.writer &&
          !s.retries.includes(previous.querySelector('[data-retry]')?.dataset.retry)) previous.hidden=true;
    }
    if (msg.retryId) {
      const actions=el('span','retry-actions');
      actions.hidden=true;
      actions.dataset.retry=msg.retryId;
      const retry=el('button','',t('检查原会话'));
      const fork=el('button','',t('用分支继续'));
      retry.type=fork.type='button';
      const status=el('small','retry-status');
      status.setAttribute('role','status');
      async function recover(useFork) {
        retry.disabled=fork.disabled=true;
        $('error').textContent='';
        status.textContent='';
        try {
          const result=await api('retry',{id:msg.retryId,fork:useFork},s.roomId);
          if (result.blocked) status.textContent=useFork ? t('分支未能继续，请查看群内提示。') : t('Codex 后台仍拒绝群聊写入。即使会话空闲，也可能出现这个状态。');
        } catch (error) { fail(error); }
        finally { retry.disabled=fork.disabled=false; }
      }
      retry.onclick=()=>recover(false);
      fork.onclick=()=>{
        if (window.confirm(t('创建带历史记录的 Codex 分支，并将该成员切换到分支继续这条消息？之后群聊会写入分支，原会话仍可单独查看。'))) void recover(true);
      };
      actions.append(retry,fork,status);
      entry.append(actions);
    }
    if (dayChanged) {
      $('history').append(el('div','chat-date-divider',day));
      historyDay=day;
    }
    $('history').append(entry);
  }
  const retries = new Set(s.retries || []);
  for (const actions of $('history').querySelectorAll('[data-retry]')) actions.hidden=!retries.has(actions.dataset.retry);
  historyCount=s.messages.length;$('empty').hidden=!!s.messages.length;
  for (const messageId of pendingSentMotion) {
    const row=$('message-'+messageId);
    if (!row) continue;
    pendingSentMotion.delete(messageId);
    animateSentMessage(row);
  }
  const active=shownActivity(s);
  for (const [index,a] of active.entries()) {
    const updated=row(a.name,a.text,diagnostic(a.activity)+(a.queued?t(' · 排队 {0} 条',a.queued):''));
    if (a.startedAt && !a.native) updated.querySelector('.meta').append(el('small','elapsed'));
    if (a.native) {
      updated.querySelector('.body').textContent=a.stopSyncId ?
        t('可在 Codex 原会话查看。群聊会继续检查同一条消息。') :
        t('沿用原会话设置，可在 Codex 查看进度或处理审批。');
      if (a.cancelId) {
        const cancel=el('button','',t('取消排队'));
        cancel.type='button';
        cancel.onclick=async ()=>{
          cancel.disabled=true;
          try { await api('native-queue/cancel',{clientId:a.cancelId},s.roomId); }
          catch (error) { cancel.disabled=false; fail(error); }
        };
        updated.lastElementChild.append(cancel);
      }
      if (a.stopSyncId) {
        const stop=el('button','',t('停止同步'));
        stop.type='button';
        stop.onclick=async ()=>{
          if (!window.confirm(t('停止在群聊同步这一轮？Codex 原会话仍可继续处理。'))) return;
          stop.disabled=true;
          try { await api('native-queue/stop-sync',{clientId:a.stopSyncId},s.roomId); }
          catch (error) { stop.disabled=false; fail(error); }
        };
        updated.lastElementChild.append(stop);
      }
    }
    const saved=previous.get(a.name);
    const line=saved?.dataset.appearance===appearance ? saved : updated;
    line.dataset.appearance=appearance;
    const sameTurn=saved?.dataset.startedAt===String(a.startedAt);
    const firstReply=sameTurn && !a.native && !!a.text && saved.dataset.hasReply==='false';
    const article=line.lastElementChild;
    if (line!==updated) article.replaceChildren(...updated.lastElementChild.childNodes);
    if (!sameTurn) article.classList.remove('reply-arrival');
    if (firstReply) article.classList.add('reply-arrival');
    line.dataset.member=a.name;
    line.dataset.startedAt=String(a.startedAt);
    line.dataset.hasReply=String(!!a.text);
    line.classList.toggle('msg-thinking',thinkingStages.has(a.activity) && !a.native);
    if (live.children[index]!==line) live.insertBefore(line,live.children[index] || null);
  }
  while (live.children.length>active.length) live.lastElementChild.remove();
  renderElapsed();
  const approvalKey=JSON.stringify([language,s.approvals]);
  if($('approvals').dataset.key!==approvalKey){
    $('approvals').dataset.key=approvalKey;
    $('approvals').replaceChildren(...s.approvals.map(a=>{
      const box=el('div','request');box.append(el('strong','',t('{0} 请求审批',a.name)),el('pre','',a.detail));
      for(const allow of [false,true]){
        const b=el('button','',allow?t('允许本次'):t('拒绝'));b.disabled=allow&&!a.allow;
        b.onclick=()=>api('approval',{id:a.id,allow}).catch(fail);box.append(b);
      }return box;
    }));
  }
  if (stick) {
    sc.scrollTop=sc.scrollHeight;
    if (newMessageCount) setNewMessageCount(0);
  } else if (incoming.length) setNewMessageCount(newMessageCount+incoming.length);
  controls();
}
function shownActivity(snapshot) {
  return snapshot.active.filter(entry=>snapshot.showAgentInteractions!==false || !entry.interaction);
}
function renderElapsed() {
  if (!state?.active.length) return;
  for (const [index, entry] of shownActivity(state).entries()) {
    const label = $('live').children[index]?.querySelector('.elapsed');
    if (!label) continue;
    const elapsed = Math.max(0,Math.floor((Date.now()-entry.startedAt)/1000));
    const idle = Date.now()-entry.updatedAt > 90000;
    const duration = elapsed < 60 ? t('{0} 秒',elapsed) : t('{0} 分 {1} 秒',Math.floor(elapsed/60),elapsed%60);
    label.textContent = duration + (idle ? t(' · 暂无新进度') : '');
  }
}
setInterval(renderElapsed,1000);
function renderTasks() {
  const tasks=state?.tasks || [];
  const selected=tasks.find(task=>task.id===tasksByRoom.get(roomId));
  const notice=selected || tasks[0];
  const key=JSON.stringify([roomId,tasks,selected?.id]);
  if (key===taskViewKey) return;
  taskViewKey=key;
  const banner=$('task-announcement');
  banner.hidden=!notice;
  if (notice) {
    banner.replaceChildren(el('span','task-announcement-label',t('群公告')),el('strong','',notice.title),el('span','task-preview',notice.requirements));
    banner.onclick=()=>openTaskBoard(notice.id);
  }
  const chip=$('compose-task');
  chip.hidden=!selected;
  if (selected) {
    const clear=el('button','','×');
    clear.type='button';
    clear.setAttribute('aria-label',t('取消关联群公告'));
    clear.onclick=()=>{tasksByRoom.delete(roomId);renderTasks();};
    chip.replaceChildren(el('span','',t('关联任务 · {0}',selected.title)),clear);
  }
  if ($('tasks-dialog').open) renderTaskCards();
}
function renderTaskCards(focusId) {
  const list=$('task-cards');
  list.replaceChildren();
  for (const task of state.tasks || []) {
    const card=el('article','task-card');
    const heading=el('h3','',task.title);
    if (task.id===focusId) card.classList.add('task-highlight');
    card.append(heading,el('h4','',t('必须遵守')),el('div','task-copy',task.requirements));
    if (task.reference) card.append(el('h4','',t('参考资料')),el('div','task-copy',task.reference));
    const tools=el('div','task-card-actions');
    const edit=el('button','',t('编辑'));
    edit.type='button';
    edit.setAttribute('aria-label',t('编辑 {0}',task.title));
    edit.onclick=()=>openTaskEditor(task);
    const choose=el('button','primary',tasksByRoom.get(roomId)===task.id ? t('已用于发言') : t('用于发言'));
    choose.type='button';
    choose.setAttribute('aria-label',choose.textContent+' '+task.title);
    choose.onclick=()=>{
      tasksByRoom.set(roomId,task.id);
      $('tasks-dialog').close();
      renderTasks();
      $('message').focus();
    };
    tools.append(edit,choose);
    if (task.sourceId) {
      const source=el('button','',t('查看原消息'));
      source.type='button';
      source.onclick=()=>{
        $('tasks-dialog').close();
        const message=$('message-'+task.sourceId);
        if (message) {
          message.tabIndex=-1;
          message.focus({preventScroll:true});
          message.scrollIntoView({block:'center'});
        }
      };
      tools.prepend(source);
    }
    card.append(tools);
    list.append(card);
  }
  if (!list.children.length) list.append(el('p','task-empty',t('可以从一条群聊消息建立群公告，也可以直接新建。')));
  list.querySelector('.task-highlight')?.scrollIntoView({block:'nearest'});
}
function openTaskBoard(focusId) {
  if (!state) return;
  if (!$('tasks-dialog').open) $('tasks-dialog').showModal();
  renderTaskCards(focusId);
}
function openTaskEditor(task,source) {
  taskEditor={id:task?.id,room:roomId,sourceId:task?.sourceId || source?.id};
  $('tasks-dialog').close();
  $('task-editor-title').textContent=task ? t('编辑群公告') : t('新建群公告');
  $('task-title').value=task?.title || '';
  $('task-requirements').value=task?.requirements || source?.text.slice(0,6000) || '';
  $('task-reference').value=task?.reference || '';
  $('task-editor-source').textContent=taskEditor.sourceId ? t('已关联原消息及其附件') : '';
  $('task-error').textContent='';
  $('save-task').disabled=false;
  $('task-editor').showModal();
}
$('open-tasks').onclick=()=>openTaskBoard();
$('close-tasks').onclick=()=>$('tasks-dialog').close();
$('new-task').onclick=()=>openTaskEditor();
$('close-task-editor').onclick=()=>$('task-editor').close();
$('task-form').onsubmit=async event=>{
  event.preventDefault();
  const current=taskEditor;
  $('save-task').disabled=true;
  $('task-error').textContent='';
  try {
    const {id}=await api('task/save',{
      id:current.id,sourceId:current.sourceId,title:$('task-title').value,
      requirements:$('task-requirements').value,reference:$('task-reference').value
    },current.room);
    if (taskEditor!==current || roomId!==current.room) return;
    $('task-editor').close();
    openTaskBoard(id);
  } catch (error) {
    if (taskEditor===current) $('task-error').textContent=diagnostic(error.message);
  } finally {
    if (taskEditor===current) $('save-task').disabled=false;
  }
};
function renderGroupAvatarSettings() {
  $('group-avatar-preview').replaceChildren(groupAvatar(groupAvatarDraft));
  $('pick-group-avatar').disabled=!!groupAvatarDraft.saving;
  $('clear-group-avatar').disabled=!!groupAvatarDraft.saving || !groupAvatarDraft.avatarId;
}
async function saveGroupAvatar(file) {
  const draft=groupAvatarDraft;
  if (draft.saving) return;
  const status=$('group-avatar-status');
  if (file?.size>2*1024*1024) {
    status.textContent=t('头像图片不能超过 2 MB');
    return;
  }
  draft.saving=true;
  status.textContent=t('正在保存群头像…');
  renderGroupAvatarSettings();
  try {
    const avatarId=file ? await upload({file},draft.id) : null;
    await api('group/avatar',{avatarId},draft.id);
    draft.avatarId=avatarId;
    if (groupAvatarDraft===draft) status.textContent=avatarId ? t('群头像已更新') : t('已恢复默认群头像');
  } catch (error) {
    if (groupAvatarDraft===draft) status.textContent=diagnostic(error.message);
  } finally {
    draft.saving=false;
    if (groupAvatarDraft===draft) renderGroupAvatarSettings();
  }
}
$('pick-group-avatar').onclick=()=>$('group-avatar-input').click();
$('group-avatar-input').onchange=()=>{
  const input=$('group-avatar-input');
  const file=input.files[0];
  input.value='';
  if (file) void saveGroupAvatar(file);
};
$('clear-group-avatar').onclick=()=>saveGroupAvatar(null);
function renderFontPreview() {
  $('chat-font-value').value=chatFontDraft+' px';
  $('chat-font-preview').style.setProperty('--chat-font-size',chatFontDraft+'px');
  $('decrease-chat-font').disabled=chatFontDraft<=12;
  $('increase-chat-font').disabled=chatFontDraft>=20;
}
$('decrease-chat-font').onclick=()=>{ chatFontDraft--; renderFontPreview(); };
$('increase-chat-font').onclick=()=>{ chatFontDraft++; renderFontPreview(); };
$('open-app-settings').onclick=()=>$('app-settings').showModal();
$('close-app-settings').onclick=()=>$('app-settings').close();
$('app-language').onchange=async event=>{
  const select=event.currentTarget, status=$('app-settings-status');
  select.disabled=true;
  savingLanguage=true;
  status.textContent=t('正在保存语言设置…');
  try {
    // Desktop may keep an older plugin bridge alive after reloading the panel.
    const saved=await api('group/visibility?scope=app',{language:select.value},0);
    updateLanguage(saved.language);
    if (state) render({...state,language:saved.language});
    status.textContent='';
  } catch {
    select.value=language;
    status.textContent=t('无法保存语言设置，请重试。');
  } finally {
    savingLanguage=false;
    select.disabled=false;
  }
};
$('open-guide').onclick=()=>{
  const coordinator=state?.members.find(member=>member.name==='Coordinator' || member.name==='统筹')?.name || 'Coordinator';
  $('guide-example').textContent=t('@{0} 我想做一份产品试用计划，帮我列出三个步骤。',coordinator);
  $('guide').showModal();
};
$('close-guide').onclick=()=>$('guide').close();
$('open-group-settings').onclick=()=>{
  groupAvatarDraft={...state.groups.find(group=>group.id===roomId)};
  $('group-avatar-status').textContent='';
  renderGroupAvatarSettings();
  $('show-agent-interactions').checked=state.showAgentInteractions!==false;
  chatFontDraft=state.chatFontSize ?? 14;
  renderFontPreview();
  $('group-settings-status').textContent='';
  $('group-settings').showModal();
};
$('close-group-settings').onclick=()=>$('group-settings').close();
$('group-settings-form').onsubmit=async event=>{
  event.preventDefault();
  const id=roomId;
  const save=$('save-group-settings');
  save.disabled=true;
  try {
    await api('group/visibility',{showAgentInteractions:$('show-agent-interactions').checked,chatFontSize:chatFontDraft},id);
    if (id===roomId) $('group-settings').close();
  } catch(error) {
    $('group-settings-status').textContent=diagnostic(error.message);
  } finally { save.disabled=false; }
};
function openGroup(id, {openMembers=false}={}) {
  if (stream) drafts.set(roomId, $('message').value);
  stream?.close();
  pendingSentMotion.clear();
  setNewMessageCount(0);
  roomId = id;
  connected = false;
  state = null;
  historyCount = -1;
  closeMentions();
  closeGroupMenu();
  $('remove-message').close();
  $('tasks-dialog').close();
  $('task-editor').close();
  $('group-settings').close();
  $('picker').close();
  $('settings').close();
  renderTasks();
  memberKey = '';
  $('message').value = drafts.get(id) || '';
  renderDraftFiles();
  $('room-member-count').textContent = '';
  $('status').textContent = t('正在连接');
  $('error').textContent = '';
  $('empty').hidden = true;
  for (const section of ['history','live','approvals','members']) $(section).replaceChildren();
  $('organization').close();
  controls();
  if (!transport) {
    const url = new URL(location.href);
    url.searchParams.set('room',id);
    history.replaceState(null,'',url);
  }
  const connection = transport ? transport.subscribe(id) : new EventSource('/api/events?room='+id);
  stream = connection;
  connection.onmessage = event => {
    if (stream !== connection) return;
    connected = true;
    const snapshot=JSON.parse(event.data);
    if (!snapshot.roomId && snapshot.groups.length) {
      openGroup(snapshot.groups[0].id);
      return;
    }
    if (!snapshot.roomId && roomId) {
      openGroup(0);
      return;
    }
    render(snapshot);
    if (openMembers) {
      openMembers=false;
      $('open-organization').click();
    }
  };
  connection.onerror = () => {
    if (stream !== connection) return;
    connected = false;
    $('status').textContent = t('连接中断，正在重连');
    controls();
  };
}
function closeGroupMenu(restoreFocus=false) {
  $('group-menu').hidden=true;
  if (restoreFocus) groupMenuTarget?.trigger.focus();
  groupMenuTarget=null;
}
function showGroupMenu(group,trigger,event) {
  const menu=$('group-menu');
  groupMenuTarget={group,trigger};
  menu.hidden=false;
  const bounds=trigger.getBoundingClientRect();
  const x=event?.clientX || bounds.left;
  const y=event?.clientY || bounds.bottom;
  menu.style.left=Math.max(4,Math.min(x,innerWidth-menu.offsetWidth-4))+'px';
  menu.style.top=Math.max(4,Math.min(y,innerHeight-menu.offsetHeight-4))+'px';
  $('rename-group').focus({preventScroll:true});
}
document.addEventListener('pointerdown',event=>{
  if (groupMenuTarget && !$('group-menu').contains(event.target) && !groupMenuTarget.trigger.contains(event.target)) closeGroupMenu();
});
document.addEventListener('keydown',event=>{
  if (event.key==='Escape' && groupMenuTarget) {
    event.preventDefault();
    closeGroupMenu(true);
  }
});
function editGroup(group=null) {
  groupEditTarget=group;
  closeGroupMenu();
  $('group-editor-title').textContent=group ? t('重命名群聊') : t('新建群聊');
  $('submit-group').textContent=group ? t('保存群名') : t('创建群聊');
  $('group-name').value=group?.name || '';
  $('group-error').textContent='';
  $('group-dialog').showModal();
}
function renderArchivedGroups() {
  const groups=state?.archivedGroups || [];
  $('show-archived-groups').hidden=!groups.length;
  $('archived-group-list').replaceChildren(...groups.map(group=>{
    const row=el('div','archived-group-row');
    const restore=el('button','',t('恢复'));
    restore.type='button';
    restore.setAttribute('aria-label',t('恢复 {0}',group.name));
    restore.onclick=async()=>{
      restore.disabled=true;
      try {
        await api('group/restore',{},group.id);
        $('archived-groups').close();
        openGroup(group.id);
      } catch (error) { $('archived-groups-error').textContent=diagnostic(error.message); restore.disabled=false; }
    };
    row.append(el('span','',group.name),restore);
    return row;
  }));
}
$('show-archived-groups').onclick=()=>{
  $('archived-groups-error').textContent='';
  $('archived-groups').showModal();
};
$('close-archived-groups').onclick=()=>$('archived-groups').close();
$('create').onclick = () => editGroup();
$('rename-group').onclick=()=>editGroup(groupMenuTarget.group);
$('archive-group').onclick=async()=>{
  const {group}=groupMenuTarget;
  closeGroupMenu();
  if (!window.confirm(t('删除「{0}」？群聊会移到已归档群聊，历史和 Codex 会话保留。',group.name))) return;
  try { await api('group/archive',{},group.id); }
  catch (error) { fail(error); }
};
$('close-group').onclick = () => $('group-dialog').close();
$('new-group').onsubmit = async event => {
  event.preventDefault();
  const submit = $('submit-group'), target=groupEditTarget;
  submit.disabled = true;
  $('group-error').textContent = '';
  try {
    const group = await api(target ? 'group/rename' : 'groups',{name:$('group-name').value},target?.id ?? roomId);
    $('group-dialog').close();
    if (!target) openGroup(group.id,{openMembers:true});
  } catch (error) { $('group-error').textContent = diagnostic(error.message); }
  finally { submit.disabled = false; }
};
function messageActions(message,id) {
  const actions=el('div','message-icon-actions');
  const copy=el('button','message-action-icon copy-message');
  copy.type='button';
  copy.setAttribute('aria-label',t('复制消息'));
  copy.title=t('复制消息');
  copy.append(el('span',''));
  copy.hidden=!message.text;
  const status=el('small','message-action-status');
  status.setAttribute('role','status');
  copy.onclick=async()=>{
    try { await copyText(message.text); status.textContent=t('已复制'); }
    catch { status.textContent=t('复制失败'); }
    setTimeout(()=>{status.textContent='';},1400);
  };
  const remove=el('button','message-action-icon remove-message-icon');
  remove.type='button';
  remove.setAttribute('aria-label',t('移除消息'));
  remove.title=t('移除消息');
  remove.append(el('span',''));
  remove.onclick=()=>{
    removeMessageTarget={message,id};
    $('remove-message-error').textContent='';
    $('remove-message').showModal();
  };
  actions.append(copy,remove);
  if (message.author==='你' || message.taskId) {
    const label=message.taskId ? t('查看群公告') : t('设为群公告');
    const notice=el('button','message-action-icon notice-message-icon');
    notice.type='button';
    notice.setAttribute('aria-label',label);
    notice.title=label;
    notice.append(el('span',''));
    notice.onclick=()=>{
      if (message.taskId) return openTaskBoard(message.taskId);
      const existing=state.tasks.find(task=>task.sourceId===message.id);
      if (existing) openTaskBoard(existing.id);
      else openTaskEditor(null,message);
    };
    actions.append(notice);
  }
  actions.append(status);
  return actions;
}
async function removeMessage(reset) {
  const target=removeMessageTarget;
  const controls=[$('hide-message'),$('reset-message')];
  controls.forEach(button=>{button.disabled=true;});
  try {
    await api('message/remove',{id:target.message.id,reset},target.id);
    if (reset) tasksByRoom.delete(target.id);
    $('remove-message').close();
  } catch (error) { $('remove-message-error').textContent=diagnostic(error.message); }
  finally { controls.forEach(button=>{button.disabled=false;}); }
}
$('hide-message').onclick=()=>removeMessage(false);
$('reset-message').onclick=()=>removeMessage(true);
$('close-remove-message').onclick=()=>$('remove-message').close();
updateLanguage('en');
openGroup(roomId);
function draftFiles(id = roomId) {
  if (!attachmentsByRoom.has(id)) attachmentsByRoom.set(id,[]);
  return attachmentsByRoom.get(id);
}
function renderDraftFiles() {
  const nodes = draftFiles().map(entry => {
    const chip = el('span','file-chip');
    const remove = el('button','','×');
    remove.type = 'button';
    remove.setAttribute('aria-label',t('移除附件 {0}',entry.file.name));
    remove.onclick = () => {
      const entries = draftFiles();
      entries.splice(entries.indexOf(entry),1);
      renderDraftFiles();
      controls();
    };
    chip.append(el('span','',entry.file.name),remove);
    return chip;
  });
  const skill = skillsByRoom.get(roomId);
  if (skill) {
    const chip = el('span','file-chip skill-chip');
    const remove = el('button','','×');
    remove.type = 'button';
    remove.setAttribute('aria-label',t('移除待发送 Skill'));
    remove.onclick = () => { skillsByRoom.delete(roomId); renderDraftFiles(); controls(); };
    const edit = el('button','skill-edit',skillCaption(skill));
    edit.type = 'button';
    edit.setAttribute('aria-label',t('编辑 {0}',skillCaption(skill)));
    edit.onclick = () => $('pick-skill').click();
    chip.append(edit,remove);
    nodes.push(chip);
  }
  $('draft-files').replaceChildren(...nodes);
}
function addFiles(files) {
  $('error').textContent = '';
  for (const file of files) {
    if (!file.size || file.size > sizeLimit) { fail(Error(t('{0} 须为 0–20 MB 之间的非空文件',file.name))); continue; }
    if (draftFiles().length >= 8) { fail(Error(t('每条消息最多 8 个附件'))); break; }
    draftFiles().push({file});
  }
  renderDraftFiles();
  controls();
}
async function upload(entry, id) {
  if (entry.id) return entry.id;
  const query = new URLSearchParams({room:id,name:entry.file.name});
  const response = await request('/api/attachment?'+query,{
    method:'POST',headers:{'Content-Type':'application/octet-stream'},body:entry.file
  });
  const data = await response.json();
  if (!response.ok) throw Error(diagnostic(data.error) || t('上传失败'));
  entry.id = data.id;
  return entry.id;
}
$('attach').onclick = () => $('file-input').click();
$('file-input').onchange = () => { addFiles($('file-input').files); $('file-input').value = ''; };
$('compose').ondragover = event => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
};
$('compose').ondrop = event => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  addFiles(event.dataTransfer.files);
};
$('message').onpaste = event => {
  const files = event.clipboardData?.files;
  if (!files?.length) return;
  if (!event.clipboardData.getData('text/plain')) event.preventDefault();
  addFiles(files);
};
$('compose').onsubmit=async e=>{
  e.preventDefault();if($('send').disabled)return;
  const id=roomId, draft=$('message').value, entries=[...draftFiles(id)], skill=skillsByRoom.get(id), taskId=tasksByRoom.get(id);
  const connection=stream;
  sending=true;controls();$('error').textContent='';
  try {
    const attachments = [];
    for (const entry of entries) attachments.push(await upload(entry,id));
    const {messageId}=await api('message',{text:draft,attachments,skill,taskId},id);
    if (stream===connection && Number.isInteger(messageId)) {
      const row=$('message-'+messageId);
      if (row) animateSentMessage(row);
      else pendingSentMotion.add(messageId);
    }
    attachmentsByRoom.set(id,draftFiles(id).filter(entry=>!entries.includes(entry)));
    if (roomId===id && $('message').value===draft) $('message').value='';
    else if(drafts.get(id)===draft) drafts.delete(id);
    if (skillsByRoom.get(id)===skill) skillsByRoom.delete(id);
    renderDraftFiles();
  } catch(e){fail(e);}finally{sending=false;controls();}
};
function optionsInto(id, items, fallback, value) {
  const select = $(id);
  select.replaceChildren(new Option(fallback,''));
  for (const item of items) {
    const opt = new Option(item.name,item.id);
    opt.disabled = !!item.disabled;
    opt.title = item.description || '';
    select.append(opt);
  }
  select.value = value || '';
}
const effortNames = {none:'无',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最高',ultra:'Ultra'};
function renderEfforts(value) {
  const model = composeOptions?.models.find(entry=>entry.id===$('model').value);
  optionsInto('effort',(model?.efforts || []).map(o=>({id:o.reasoningEffort,name:t(effortNames[o.reasoningEffort] || o.reasoningEffort),description:o.description})),t('使用会话或模型默认值'),value);
  $('effort').disabled = !model;
}
$('model').onchange = () => renderEfforts();
async function openSettings(name) {
  const member = state?.members.find(member => member.name === name);
  if (!member) { fail(Error(t('该成员已不在群内'))); return; }
  const request = ++settingsRequest;
  settingsMember = {id:member.id,name,room:roomId,threadId:member.thread || null};
  $('settings-title').textContent = t('{0} · 成员设置',name);
  $('rename-name').value = name;
  $('rename-status').textContent = '';
  profileDraft={name,room:roomId,avatarId:member.avatarId || null,colorHex:member.colorHex || null};
  $('profile-avatar-status').textContent='';
  $('pick-avatar').disabled=false;
  $('profile-personality').value=member.personality || '';
  $('profile-color-status').textContent='';
  $('profile-personality-status').textContent='';
  $('save-profile-color').disabled=false;
  $('save-personality').disabled=false;
  $('profile-color').value=profileDraft.colorHex || '';
  renderProfileColorOptions();
  renderProfileAvatar();
  $('settings').showModal();
  $('settings').querySelector('.settings-scroll').scrollTop=0;
  void loadMemberPlacement(name,request);
  await loadMemberRunSettings(name,request,member.settings || {});
}
async function loadMemberRunSettings(name,request,previous={}) {
  $('apply-settings').disabled = true;
  $('settings-status').textContent = t('正在读取本机 Codex 配置…');
  try {
    const catalog = await api('compose?'+new URLSearchParams({member:name}));
    if (request !== settingsRequest) return;
    composeOptions = catalog;
    optionsInto('model',composeOptions.models,t('沿用会话模型'),previous.model);
    optionsInto('permission',composeOptions.permissions.map(profile=>({
      ...profile,name:profile.description || profile.id,disabled:!profile.allowed
    })),t('沿用会话权限'),previous.permissions);
    renderEfforts(previous.effort);
    $('custom-plugins').checked = previous.disabledPlugins !== undefined;
    $('custom-plugins').disabled = !composeOptions.plugins.some(plugin=>plugin.enabled);
    $('plugin-list').replaceChildren(...composeOptions.plugins.map(plugin=>{
      const label = el('label','plugin-option');
      if (!plugin.enabled) {
        label.append(el('span','',t('{0}（Codex 中未启用）',plugin.name)));
        return label;
      }
      const check = el('input');
      check.type = 'checkbox';
      check.value = plugin.id;
      check.checked = !previous.disabledPlugins?.includes(plugin.id);
      label.append(check,el('span','',plugin.name));
      return label;
    }));
    togglePlugins();
    const labels = {models:t('模型'),skills:'Skill',plugins:t('插件'),permissions:t('权限')};
    const errors = Object.keys(composeOptions.errors).map(key=>labels[key]);
    $('settings-status').textContent = errors.length ? t('本机 Codex 暂未返回：{0}',errors.join(language==='en' ? ', ' : '、')) : '';
    $('apply-settings').disabled = false;
  } catch (error) { if (request === settingsRequest) $('settings-status').textContent = diagnostic(error.message); }
}
function renderProfileAvatar() {
  $('profile-avatar-preview').replaceChildren(avatar(profileDraft.name,profileDraft.avatarId,profileDraft.colorHex));
  $('clear-avatar').disabled=!profileDraft.avatarId || !!profileDraft.savingAvatar;
  $('clear-profile-color').disabled=!$('profile-color').value.trim();
}
async function saveProfileAvatar(file) {
  const current=profileDraft;
  if (current.savingAvatar) return;
  if (file?.size>2*1024*1024) {
    $('profile-avatar-status').textContent=t('头像图片不能超过 2 MB');
    return;
  }
  current.savingAvatar=true;
  $('pick-avatar').disabled=true;
  $('clear-avatar').disabled=true;
  $('profile-avatar-status').textContent=t('正在保存头像…');
  try {
    const avatarId=file ? await upload({file},current.room) : null;
    await api('member/profile',{name:current.name,avatarId},current.room);
    current.avatarId=avatarId;
    if (profileDraft===current && roomId===current.room) $('profile-avatar-status').textContent=avatarId ? t('头像已更新') : t('已恢复默认头像');
  } catch (error) {
    if (profileDraft===current) $('profile-avatar-status').textContent=diagnostic(error.message);
  } finally {
    current.savingAvatar=false;
    if (profileDraft===current && roomId===current.room) {
      $('pick-avatar').disabled=false;
      renderProfileAvatar();
    }
  }
}
$('pick-avatar').onclick=()=>$('profile-avatar-input').click();
$('profile-avatar-input').onchange=()=>{
  const input=$('profile-avatar-input');
  const file=input.files[0];
  input.value='';
  if (file) void saveProfileAvatar(file);
};
$('clear-avatar').onclick=()=>saveProfileAvatar(null);
function colorFromField() {
  const value=$('profile-color').value.trim();
  if (!value) return null;
  const match=value.match(/^#?([0-9a-f]{6})$/i);
  return match ? '#'+match[1].toLowerCase() : undefined;
}
function updateColorPreview() {
  const value=colorFromField();
  if (value!==undefined) profileDraft.colorHex=value;
  for (const button of $('profile-color-options').children) {
    button.setAttribute('aria-pressed',String(button.dataset.color===value));
  }
  renderProfileAvatar();
}
function renderProfileColorOptions() {
  $('profile-color-options').replaceChildren(...profileColors.map(([label,hex])=>{
    const button=el('button','profile-color-swatch');
    button.type='button';
    button.dataset.color=hex;
    button.style.setProperty('--swatch',hex);
    button.setAttribute('aria-label',t(label));
    button.title=t(label)+' '+hex.toUpperCase();
    button.style.setProperty('--swatch-ink',colorInk(hex));
    button.onclick=()=>{
      $('profile-color').value=hex;
      updateColorPreview();
    };
    return button;
  }));
  updateColorPreview();
}
$('profile-color').oninput=updateColorPreview;
$('clear-profile-color').onclick=()=>{
  $('profile-color').value='';
  updateColorPreview();
};
async function saveProfileField(form,status,fields,confirmation) {
  const current=profileDraft;
  const save=form.querySelector('button[type=submit]');
  save.disabled=true;
  status.textContent='';
  try {
    await api('member/profile',{name:current.name,...fields},current.room);
    if (profileDraft===current && roomId===current.room) {
      status.textContent=confirmation;
      flashButtonLabel(save,t('已保存'));
    }
  } catch(error) {
    if (profileDraft===current) status.textContent=diagnostic(error.message);
  } finally {
    if (profileDraft===current) save.disabled=false;
  }
}
$('member-color-form').onsubmit=event=>{
  event.preventDefault();
  const status=$('profile-color-status');
  const colorHex=colorFromField();
  if (colorHex===undefined) {
    status.textContent=t('请输入 6 位颜色值，例如 #4477AA，或直选上方色块。');
    $('profile-color').focus();
    return;
  }
  void saveProfileField(event.currentTarget,status,{colorHex},t('颜色已保存'));
};
$('member-personality-form').onsubmit=event=>{
  event.preventDefault();
  void saveProfileField(event.currentTarget,$('profile-personality-status'),
    {personality:$('profile-personality').value},t('性格已保存'));
};
let memberPlacement;
function renderMemberPlacement() {
  $('member-placement').hidden=memberPlacement.created;
  $('change-member-thread').textContent=memberPlacement.created ? t('更换会话') : t('选择会话');
  const projectName=memberPlacement.projects.find(project=>project.id===memberPlacement.projectId)?.name ||
    memberPlacement.projectName ||
    (memberPlacement.projectId ? t('Codex 项目') : t('独立聊天'));
  $('bound-thread-title').textContent=memberPlacement.created
    ? projectName+' / '+(memberPlacement.threadTitle || t('未命名会话'))
    : projectName+' / '+t('首次发言时创建');
  if (memberPlacement.created) {
    $('member-project-status').textContent='';
    return;
  }
  const box=$('member-project');
  const move=box.value !== (memberPlacement.projectId || '');
  $('member-project-save').disabled=!move;
  const project=memberPlacement.projects.find(item=>item.id===box.value);
  const cwd=project?.cwd || state.cwd;
  $('member-project-status').textContent=cwd ? t('工作目录 · {0}',cwd) : '';
}
async function loadMemberPlacement(name,request) {
  memberPlacement = null;
  $('member-placement').hidden=true;
  $('bound-thread-title').textContent=t('正在读取会话地址…');
  $('change-member-thread').textContent=settingsMember.threadId ? t('更换会话') : t('选择会话');
  const box=$('member-project');
  box.disabled=true;
  $('member-project-save').disabled=true;
  replaceProjectOptions(box,[]);
  $('member-project-status').textContent='';
  try {
    const data=await api('member/location?'+new URLSearchParams({member:name}));
    if(request!==settingsRequest) return;
    memberPlacement=data;
    settingsMember.threadId=data.threadId || null;
    replaceProjectOptions(box,data.projects);
    if(data.projectId && !data.projects.some(project=>project.id===data.projectId)) {
      box.append(new Option(t('原项目'),data.projectId));
    }
    box.value=data.projectId || '';
    box.disabled=false;
    renderMemberPlacement();
  } catch(error) {
    if(request===settingsRequest) $('bound-thread-title').textContent=diagnostic(error.message);
  }
}
$('member-project').onchange=renderMemberPlacement;
$('member-placement').onsubmit=async event=>{
  event.preventDefault();
  const current=settingsMember, request=settingsRequest, box=$('member-project');
  if(!memberPlacement || $('member-project-save').disabled) return;
  box.disabled=true;
  $('member-project-save').disabled=true;
  try {
    const result=await api('member/location',{name:current.name,projectId:box.value || null},current.room);
    if(request!==settingsRequest) return;
    memberPlacement={...memberPlacement,...result};
    renderMemberPlacement();
    $('member-project-status').textContent=t('已保存。')+$('member-project-status').textContent;
    flashButtonLabel($('member-project-save'),t('已保存'));
  } catch(error) {
    if(request!==settingsRequest) return;
    $('member-project-status').textContent=diagnostic(error.message);
    $('member-project-save').disabled=false;
  } finally { if(request===settingsRequest) box.disabled=false; }
};
function togglePlugins() {
  for (const check of $('plugin-list').querySelectorAll('input')) check.disabled = !$('custom-plugins').checked;
}
$('custom-plugins').onchange = togglePlugins;
$('rename-agent').onsubmit = async event => {
  event.preventDefault();
  const current = settingsMember;
  const newName = $('rename-name').value.trim();
  if (newName === current.name) return;
  $('rename-save').disabled = true;
  $('rename-status').textContent = '';
  try {
    const result = await api('member/rename',{name:current.name,newName},current.room);
    settingsMember = {...current,name:result.name};
    if (profileDraft?.room===current.room && profileDraft.name===current.name) profileDraft.name=result.name;
    $('settings-title').textContent = t('{0} · 成员设置',result.name);
    $('rename-name').value = result.name;
    $('rename-status').textContent = t('已更名');
    const pending = skillsByRoom.get(current.room);
    if (pending) pending.targets = pending.targets.map(target=>target===current.name ? result.name : target);
    const draft = $('message');
    draft.value = draft.value.replace(/@([\p{L}\p{N}_-]+)/gu,(match,name)=>name===current.name?'@'+result.name:match);
    renderDraftFiles();
    controls();
  } catch (error) { $('rename-status').textContent = diagnostic(error.message); }
  finally { $('rename-save').disabled = false; }
};
$('close-settings').onclick = () => $('settings').close();
$('settings').onclose = () => { settingsRequest++; };
async function saveMemberSettings(settings) {
  const current = settingsMember;
  $('apply-settings').disabled = true;
  $('reset-settings').disabled = true;
  $('settings-status').textContent='';
  const request=settingsRequest;
  try {
    await api('member/settings',{name:current.name,settings},current.room);
    if (request!==settingsRequest) return;
    if (!Object.keys(settings).length) {
      $('model').value='';
      $('permission').value='';
      renderEfforts();
      $('custom-plugins').checked=false;
      for (const check of $('plugin-list').querySelectorAll('input')) check.checked=true;
      togglePlugins();
    }
    $('settings-status').textContent=t('运行设置已保存');
    flashButtonLabel($('apply-settings'),t('已保存'));
  } catch (error) {
    if (request===settingsRequest) $('settings-status').textContent=diagnostic(error.message);
  } finally {
    if (request===settingsRequest) {
      $('apply-settings').disabled=false;
      $('reset-settings').disabled=false;
    }
  }
}
$('reset-settings').onclick = () => saveMemberSettings({});
$('apply-settings').onclick = () => {
  const options = {model:$('model').value,effort:$('effort').value,permissions:$('permission').value};
  if ($('custom-plugins').checked) {
    options.disabledPlugins = [...$('plugin-list').querySelectorAll('input:not(:checked)')].map(input=>input.value);
  }
  return saveMemberSettings(options);
};
function skillCaption(skill) {
  return skill.name + ' → ' + (skill.targets || [skill.target]).join('、');
}
function skillMembers() {
  return [...$('skill-members').querySelectorAll('input:checked')].map(input=>input.value);
}
function renderSkillResults() {
  const words = $('skill-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = skillOptions.filter(skill=>{
    const text = (skill.name+' '+(skill.description || '')).toLowerCase();
    return words.every(word=>text.includes(word));
  });
  const targets = skillMembers();
  $('skill-status').textContent = skillLoading ? t('正在读取可用 Skill…')
    : skillError || (!targets.length ? t('先选择执行成员')
    : results.length ? t('找到 {0} 个可用 Skill',results.length)
    : words.length ? t('没有匹配的 Skill') : t('所选成员没有共同可用的 Skill'));
  const rows = document.createDocumentFragment();
  for (const skill of results) {
    const label = el('label','skill-result');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'chosen-skill';
    radio.value = skill.id;
    radio.checked = selectedSkill === skill.id;
    radio.onchange = () => {
      selectedSkill = skill.id;
      $('apply-skill').disabled = false;
      $('apply-skill').textContent = t('添加 {0}',skill.name);
    };
    const copy = el('span','');
    copy.append(el('strong','',skill.name));
    if (skill.description) copy.append(el('small','',skill.description));
    label.append(radio,copy);
    rows.append(label);
  }
  $('skill-list').replaceChildren(rows);
  const selected = skillOptions.find(skill=>skill.id===selectedSkill);
  $('apply-skill').disabled = !selected || !targets.length || skillLoading;
  $('apply-skill').textContent = selected ? t('添加 {0}',selected.name) : '添加到消息';
  $('skill-all').textContent = targets.length === state.members.length ? t('清空') : t('全选');
}
async function loadSkills() {
  const request = ++skillRequest;
  const targets = skillMembers();
  skillLoading = !!targets.length;
  skillError = '';
  skillOptions = [];
  renderSkillResults();
  if (!targets.length) return;
  try {
    const params = new URLSearchParams(targets.map(name=>['member',name]));
    const result = await api('skills?'+params);
    if (request !== skillRequest) return;
    skillOptions = result.skills.sort((a,b)=>a.name.localeCompare(b.name));
    if (!skillOptions.some(skill=>skill.id===selectedSkill)) selectedSkill = null;
  } catch (error) {
    if (request === skillRequest) skillError = diagnostic(error.message);
  } finally {
    if (request === skillRequest) {
      skillLoading = false;
      renderSkillResults();
    }
  }
}
$('pick-skill').onclick = () => {
  const pending = skillsByRoom.get(roomId);
  const names = state.members.map(member=>member.name);
  const mentions = messageMentions($('message').value);
  const initial = pending?.targets || (mentions.some(name=>everyoneMention(name,names)) || names.length===1 ? names : mentions);
  selectedSkill = pending?.id;
  $('skill-search').value = '';
  $('skill-members').replaceChildren(...names.map(name=>{
    const label = el('label','skill-member-option');
    const check = el('input');
    check.type = 'checkbox';
    check.value = name;
    check.checked = initial.includes(name);
    check.onchange = loadSkills;
    const nameLabel=el('span','skill-member-name',name);
    label.title=name;
    label.append(check,nameLabel);
    return label;
  }));
  $('skill-dialog').showModal();
  loadSkills();
};
$('close-skill').onclick = () => $('skill-dialog').close();
$('skill-dialog').onclose = () => { skillRequest++; };
$('skill-search').oninput = renderSkillResults;
$('skill-all').onclick = () => {
  const select = skillMembers().length !== state.members.length;
  for (const input of $('skill-members').querySelectorAll('input')) input.checked = select;
  loadSkills();
};
$('apply-skill').onclick = () => {
  const skill = skillOptions.find(skill=>skill.id===selectedSkill);
  const targets = skillMembers();
  if (!skill || !targets.length) return;
  skillsByRoom.set(roomId,{id:skill.id,name:skill.name,targets});
  renderDraftFiles();
  controls();
  $('skill-dialog').close();
};
$('message').oninput = event => {
  controls();
  if (!event.isComposing) showMentions();
};
$('message').oncompositionend = showMentions;
$('message').onclick = showMentions;
$('message').onblur = closeMentions;
$('message').onkeyup = event => {
  if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key) && !event.isComposing) showMentions();
};
$('message').onkeydown = event => {
  if (event.isComposing || event.keyCode===229) return;
  if (!$('mention-list').hidden) {
    if (event.key==='Escape') { event.preventDefault(); closeMentions(); return; }
    if (mentionOptions.length && ['ArrowDown','ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const direction=event.key==='ArrowDown' ? 1 : -1;
      mentionIndex=(mentionIndex+direction+mentionOptions.length)%mentionOptions.length;
      highlightMention();
      return;
    }
    if (!event.shiftKey && (event.key==='Enter' || (event.key==='Tab' && mentionOptions.length))) {
      event.preventDefault();
      if (mentionOptions.length) chooseMention(mentionOptions[mentionIndex]);
      return;
    }
  }
  if (event.key==='Enter' && !event.shiftKey) {event.preventDefault();$('compose').requestSubmit();}
};
$('mention-open').onclick = () => {
  const input=$('message');
  input.focus();
  const prefix=input.value.slice(0,input.selectionStart);
  if (!/@[\p{L}\p{N}_-]*$/u.test(prefix)) {
    input.setRangeText(prefix && !/\s$/.test(prefix) ? ' @' : '@',input.selectionStart,input.selectionEnd,'end');
  }
  showMentions();
  controls();
};
$('pause').onclick=()=>api('pause',{paused:!state.paused}).catch(fail);
$('invite').onclick=()=>{ $('dialog').showModal(); if ($('source').value==='new') void loadProjects(); };$('close').onclick=()=>$('dialog').close();
const conversationGroups = new Map();
const seenThreads = new Set();
let pickerTarget=null, pickerSaving=false, pickerProjects=[];
function selectThread(button, thread) {
  previewThread = thread;
  $('threads').querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed','false');
  button?.setAttribute('aria-pressed','true');
  $('preview-title').textContent = thread?.title || t('选择一条会话');
  $('preview-details').hidden = !thread;
  $('use-thread').disabled = !thread || pickerSaving;
  if (!thread) return;
  $('preview-project').textContent = [thread.project || t('独立对话'),diagnostic(thread.section)].filter(Boolean).join(' / ');
  $('preview-path').textContent = thread.cwd || '—';
  $('preview-date').textContent = thread.updatedAt ? new Date(thread.updatedAt*1000).toLocaleString(language) : '—';
}
async function load(more=false){
  const epoch=++searchEpoch;
  if (!more) {
    $('threads').replaceChildren();
    conversationGroups.clear();
    seenThreads.clear();
    selectThread(null,null);
    cursor = null;
  }
  $('more').hidden=true;$('picker-status').textContent=t('读取中…');
  try {
    const params=new URLSearchParams({q:$('query').value,view:$('threadview').value});
    if ($('picker-project').value!=='*') params.set('project',$('picker-project').value);
    if (more && cursor) params.set('cursor',cursor);
    const out=await api('threads?'+params);
    if (epoch!==searchEpoch) return;
    pickerProjects=out.projects;
    renderPickerProjects($('picker-project').value);
    const attached = new Map(state.members.filter(member=>member.thread).map(member=>[member.thread,member.name]));
    for (const thread of out.threads) {
      if (seenThreads.has(thread.id)) continue;
      seenThreads.add(thread.id);
      const key = JSON.stringify([thread.projectId || '',thread.section]);
      if (!conversationGroups.has(key)) {
        const group = el('section','catalog-group');
        const heading = [thread.project || t('独立对话'),diagnostic(thread.section)].filter(Boolean).join(' / ');
        group.dataset.projectId = thread.projectId || '';
        group.append(el('h3','',heading));
        conversationGroups.set(key,group);
      }
      const button = el('button','thread-card');
      button.type = 'button';
      button.setAttribute('aria-pressed','false');
      const title = el('strong','thread-title',thread.title);
      button.title = thread.title;
      const member = attached.get(thread.id);
      const date = thread.updatedAt ? new Date(thread.updatedAt*1000).toLocaleDateString(language) : '';
      const isCurrent=thread.id===pickerTarget?.threadId;
      button.disabled = !!member || isCurrent;
      const badge=isCurrent ? t('当前会话') : member ? t('已入群') : date;
      if (member && !isCurrent) button.title = thread.title + t(' · 已入群为 {0}',member);
      button.append(el('span','thread-icon','▤'),title,
        el('small',member || isCurrent?'thread-attached':'thread-date',badge),el('span','thread-check','✓'));
      button.onclick = () => selectThread(button,thread);
      conversationGroups.get(key).append(button);
    }
    const projectOrder = id=>out.order.includes(id) ? out.order.indexOf(id) : out.order.length;
    const groups = [...conversationGroups.values()].sort((a,b)=>projectOrder(a.dataset.projectId)-projectOrder(b.dataset.projectId));
    $('threads').append(...groups);
    cursor=out.cursor;
    $('more').hidden=!cursor;
    $('picker-status').textContent=seenThreads.size ? t('已加载 {0} 条会话',seenThreads.size) :
      cursor ? t('本页没有匹配的会话，可继续加载') : t('没有匹配的会话');
  } catch(error) { if (epoch===searchEpoch) $('picker-status').textContent=diagnostic(error.message); }
}
let projects = [], independentCwd = '', projectRequest = 0;
function describeLocation() {
  const project = projects.find(entry=>entry.id===$('new-project').value);
  const directory = project?.cwd || independentCwd || state?.cwd;
  $('location-note').textContent = directory ? t('工作目录 · {0}',directory) : '';
}
function replaceProjectOptions(select,entries) {
  select.replaceChildren(new Option(t('独立聊天'),''));
  if (!entries.length) return;
  const group=el('optgroup');
  group.label=t('Codex 项目');
  group.append(...entries.map(project=>new Option(project.name,project.id)));
  select.append(group);
}
async function loadProjects() {
  const request = ++projectRequest;
  const select = $('new-project');
  const previous = select.value;
  select.disabled = true;
  $('location-note').textContent = t('正在读取本机 Codex 项目…');
  try {
    const result = await api('projects');
    if (request!==projectRequest) return;
    projects=result.projects;
    independentCwd=result.cwd;
    replaceProjectOptions(select,projects);
    select.value = projects.some(project=>project.id===previous) ? previous : '';
    describeLocation();
  } catch (error) {
    if (request===projectRequest) $('location-note').textContent=t('读取项目失败，可继续新建独立聊天。');
  } finally {
    if (request===projectRequest) select.disabled=false;
  }
}
$('new-project').onchange=describeLocation;
$('source').onchange = () => {
  $('existing').hidden = $('source').value!=='existing';
  $('new-location').hidden = !$('existing').hidden;
  if ($('existing').hidden) void loadProjects();
  if (!$('existing').hidden && !selectedThread) $('open-picker').focus();
};
function renderPickerProjects(selected) {
  const box=$('picker-project');
  box.replaceChildren(new Option(t('全部项目'),'*'),new Option(t('独立聊天'),''),
    ...pickerProjects.map(project=>new Option(project.name,project.id)));
  if (selected && selected!=='*' && !pickerProjects.some(project=>project.id===selected)) {
    box.append(new Option(t('当前项目'),selected));
  }
  box.value=selected;
}
function openThreadPicker(target=null) {
  pickerTarget=target;
  $('query').value='';
  $('threadview').value='active';
  renderPickerProjects(target && memberPlacement?.created ? memberPlacement.projectId || '' : '*');
  $('picker-note').textContent=target ? t('仅切换该成员以后使用的会话，两边已有历史都会保留。') :
    t('消息与回复会写入所选的 Codex 原会话。');
  $('picker-error').textContent='';
  $('use-thread').textContent=target ? t('确认绑定') : t('使用此会话');
  $('threads').inert = false;
  $('picker').showModal();
  void load();
}
$('open-picker').onclick = () => openThreadPicker();
$('change-member-thread').onclick = () => openThreadPicker(settingsMember);
$('close-picker').onclick = () => $('picker').close();
$('picker').onclose = () => { searchEpoch++; clearTimeout(searchTimer); pickerTarget=null; };
$('use-thread').onclick = async () => {
  if (!previewThread || pickerSaving) return;
  if (pickerTarget) {
    const target=pickerTarget, thread=previewThread, request=settingsRequest;
    pickerSaving=true;
    $('use-thread').disabled=true;
    $('picker-error').textContent='';
    try {
      const placement=await api('member/conversation',{
        memberId:target.id,expectedThread:target.threadId,threadId:thread.id
      },target.room);
      if (request!==settingsRequest || target!==settingsMember) return;
      target.threadId=placement.threadId;
      memberPlacement={...placement,projects:pickerProjects,projectName:thread.project};
      renderMemberPlacement();
      if (pickerTarget===target) $('picker').close();
      const preferences=state?.members.find(member=>member.id===target.id)?.settings || {};
      void loadMemberRunSettings(target.name,++settingsRequest,preferences);
    } catch (error) {
      if (pickerTarget===target) $('picker-error').textContent=diagnostic(error.message);
    } finally {
      pickerSaving=false;
      $('use-thread').disabled=!previewThread;
    }
    return;
  }
  selectedThread = previewThread;
  $('chosen-thread').textContent = selectedThread.title;
  $('open-picker').textContent = t('更换会话');
  $('joinerror').textContent = '';
  $('picker').close();
};
$('query').oninput = () => {
  clearTimeout(searchTimer);
  searchEpoch++;
  selectThread(null,null);
  $('threads').inert = true;
  searchTimer = setTimeout(() => { load(); $('threads').inert = false; },250);
};
$('more').onclick = () => load(true);
$('threadview').onchange = $('picker-project').onchange = () => {
  clearTimeout(searchTimer); $('threads').inert = false; load();
};
$('join').onsubmit=async e=>{
  e.preventDefault();try{
    const thread=$('source').value==='existing'?selectedThread?.id:null;
    if($('source').value==='existing' && !thread)throw Error(t('请选择已有会话'));
    if (!thread && $('new-project').disabled) throw Error(t('正在读取项目，请稍候'));
    await api('member',{name:$('name').value,role:$('role').value,thread,projectId:thread ? null : $('new-project').value || null});
    $('dialog').close();$('join').reset();$('existing').hidden=true;$('joinerror').textContent='';
    $('new-location').hidden=false;
    describeLocation();
    selectedThread = null;
    $('chosen-thread').textContent = t('尚未选择会话');
    $('open-picker').textContent = t('浏览 Codex 会话');
  }catch(e){$('joinerror').textContent=diagnostic(e.message);}
};
