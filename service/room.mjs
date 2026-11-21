import { everyoneMention } from './public/mentions.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Codex } from './rpc.mjs';
import { Organization } from './organization.mjs';
import { localProject } from './catalog.mjs';

const askTool = {
  type:'function', name:'ask_member', description:'在群里同时向一位或多位成员公开提问，结束本轮后并行投递，收齐后再唤起你。',
  inputSchema:{type:'object', properties:{member:{type:'string'},members:{type:'array',items:{type:'string'},minItems:1},question:{type:'string'}}, required:['question'], additionalProperties:false}
};
const lockWaits = [1000,2000,4000,8000,15000,20000,22000];
const activeWriter = /already has an active writer/i;
const writerConflict = /already has an active writer|此会话正在其他窗口工作|Codex 报告会话正在运行/i;
const lockMessage = 'Codex 后台拒绝续接，消息尚未发送。';
const nativeSyncDelayMs = 60000;
const nativeEmptyReplyGraceMs = 15000;

export class Room {
  queues = new Map();
  active = new Map();
  loaded = new Set();
  approvals = new Map();
  nativeMonitors = new Set();
  paused = false;
  constructor(dbPath, rpc, cwd, id = 1, name = 'Rallumi Starter Group') {
    this.id = id;
    this.name = name;
    this.rpc = rpc; this.cwd = cwd;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('CREATE TABLE IF NOT EXISTS room(id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    const saved = this.db.prepare('SELECT data FROM room WHERE id=?').get(id);
    const defaults = [
      ['Coordinator','Understand the request, delegate when useful, and answer the user directly'],
      ['Research','Find and verify sources, and distinguish facts, inferences, and unknowns'],
      ['Execution','Complete assigned work and deliver results the user can use'],
      ['Review','Check for errors and omissions, and identify what needs to change']
    ];
    this.data = saved ? JSON.parse(saved.data) : {members:(id === 1 ? defaults : []).map(([name,role]) => ({name,role,thread:null,cursor:0})), messages:[]};
    this.data.retries ||= {};
    this.data.nativeQueue ||= {};
    this.data.handoffBatches ||= {};
    this.data.showAgentInteractions ??= true;
    this.data.chatFontSize ??= 14;
    this.data.members.forEach((member,index)=>{ member.color ??= index%4; });
    this.data.tasks ||= [];
    this.data.historyRevision ??= 0;
    this.organization = new Organization(this.data,()=>this.save());
    if (!saved && id === 1) {
      const [coordinator,...reports] = this.data.members;
      for (const member of reports) this.organization.edit(coordinator.id,member.id,false);
    }
    if (this.data.busy) this.add('系统','上次服务在讨论中退出，请确认任务状态后再发送。');
    this.paused = !!this.data.paused;
    this.save();
    rpc.onEvent = msg => this.event(msg);
    rpc.onLost = err => {
      this.loaded.clear();
      this.organization.disconnect(rpc);
      for (const [name, run] of this.active) {
        if (run.rpc === rpc && !run.handingOff) this.finish(name, err.message);
      }
    };
  }
  save() {
    this.data.busy = this.active.size > 0 || [...this.queues.values()].some(q => q.length);
    this.data.paused = this.paused;
    this.db.prepare('INSERT OR REPLACE INTO room VALUES(?,?)').run(this.id, JSON.stringify(this.data));
    this.changed?.();
  }
  add(author,text,kind='text',attachments,skill,retryId,meta={}) {
    const id=this.data.messages.length+1;
    this.data.messages.push({id,author,text,kind,time:Date.now(),attachments,skill,retryId,...meta});
    this.save();
    return id;
  }
  state() {
    const nativeRuns = this.data.members.flatMap(member=>{
      const pending=this.data.nativeQueue[member.id];
      if (!pending || this.active.has(member.name)) return [];
      return [{name:member.name,text:'',activity:pending.activity,startedAt:pending.since,
        queued:this.queues.get(member.name)?.length||0,
        native:true,interaction:!!pending.chain?.length,
        cancelId:pending.queued ? pending.clientId : undefined,
        stopSyncId:pending.syncDelayed ? pending.clientId : undefined}];
    });
    const retrying = new Set([...this.active.values()].map(run=>run.job.retryId));
    for (const pending of Object.values(this.data.nativeQueue)) retrying.add(pending.retryId);
    return {cwd:this.cwd, showAgentInteractions:this.data.showAgentInteractions, chatFontSize:this.data.chatFontSize, tasks:this.data.tasks.filter(task=>this.visibleTask(task)).map(({files,...task})=>task), retries:Object.keys(this.data.retries).filter(id=>!retrying.has(id)), organization:this.organization.snapshot(), members:this.data.members, messages:this.data.messages.filter(message=>!message.removed), historyRevision:this.data.historyRevision, paused:this.paused,
      active:[...this.active].map(([name,r]) => ({name,text:[...r.items.values()].join('\n\n'), activity:r.activity,interaction:!!(r.job.chain.length || r.asked?.length),startedAt:r.startedAt,updatedAt:r.updatedAt || r.startedAt,queued:this.queues.get(name)?.length||0})).concat(nativeRuns),
      approvals:[...this.approvals].map(([id,a]) => ({id,name:a.name,detail:a.detail,allow:a.allow}))};
  }
  assertIdle() {
    if (this.active.size || this.approvals.size || Object.keys(this.data.nativeQueue).length ||
        Object.keys(this.data.handoffBatches).length || [...this.queues.values()].some(queue=>queue.length)) {
      throw Error('群里还有进行中或待执行的任务，请结束任务后再操作');
    }
  }
  visibleTask(task) {
    return !task.sourceId || !this.data.messages[task.sourceId-1]?.removed;
  }
  switchConversations(bindings,{reset=false}={}) {
    for (const member of this.data.members) {
      const binding=bindings.get(member.id);
      const previous=member.thread;
      if (this.loaded.delete(previous)) void this.rpc.call('thread/unsubscribe',{threadId:previous}).catch(()=>{});
      member.thread=binding.threadId;
      member.location=binding.location;
      member.roomCreated=false;
      member.titleSet=!!binding.threadId;
      if (previous && binding.threadId) member.branchFrom=previous;
      else delete member.branchFrom;
      if (reset) {
        member.cursor=this.data.messages.length;
        member.contextReset=true;
      } else delete member.contextReset;
    }
    if (reset) {
      this.data.retries={};
      this.data.contextResetAt=this.data.messages.length;
    }
  }
  rebindConversation(member,{threadId,location,settings}) {
    const previous=member.thread;
    member.thread=threadId;
    member.location=location;
    member.cursor=this.data.messages.length;
    member.roomCreated=false;
    member.titleSet=true;
    delete member.branchFrom;
    delete member.contextReset;
    if (settings) member.settings=settings;
    for (const [id,pending] of Object.entries(this.data.retries)) {
      if (pending.memberId===member.id) delete this.data.retries[id];
    }
    this.save();
    if (this.loaded.delete(previous)) void this.rpc.call('thread/unsubscribe',{threadId:previous}).catch(()=>{});
  }
  removeMessage(id,bindings) {
    const message=this.data.messages[id-1];
    if (!message || message.id!==id || message.author==='系统' || message.removed) throw Error('该消息已移除或不可移除');
    if (bindings) this.switchConversations(bindings,{reset:true});
    message.removed=true;
    this.data.historyRevision++;
    this.save();
  }
  validateName(name) {
    if (!/^[\p{L}\p{N}_-]{1,16}$/u.test(name) || ['全体','你','系统'].includes(name)) throw Error('名称请使用 1–16 个汉字、字母、数字、下划线或短横线');
  }
  rename(previous, name) {
    const member = this.member(previous);
    if (name === previous) return member;
    this.validateName(name);
    if (this.data.members.some(entry=>entry.name===name)) throw Error('群内已有同名成员');
    if (this.active.size || Object.keys(this.data.nativeQueue).length || Object.keys(this.data.handoffBatches).length || [...this.queues.values()].some(queue=>queue.length)) throw Error('群里还有正在处理的任务，任务结束后可以改名');
    member.name = name;
    for (const pending of Object.values(this.data.retries)) {
      pending.job.chain=pending.job.chain.map(item=>item===previous ? name : item);
      if (Object.hasOwn(pending.job.handoffCredits || {},previous)) {
        pending.job.handoffCredits={...pending.job.handoffCredits,[name]:pending.job.handoffCredits[previous]};
        delete pending.job.handoffCredits[previous];
      }
    }
    if (member.roomCreated || member.branchFrom) member.titleSet = false;
    for (const msg of this.data.messages) {
      if (msg.author === previous) msg.author = name;
      if (msg.skill?.target === previous) msg.skill.target = name;
      if (msg.skill?.targets) msg.skill.targets = msg.skill.targets.map(target=>target===previous ? name : target);
    }
    this.add('系统','「'+previous+'」更名为「'+name+'」','rename');
    return member;
  }
  join(name,role,thread,location) {
    this.validateName(name);
    if (this.data.members.some(m => m.name===name || (thread && m.thread===thread))) throw Error('成员名称或会话已在群内');
    const palette=[0,1,2,3];
    const color=palette.find(color=>!this.data.members.some(member=>member.color===color)) ?? this.data.members.length%palette.length;
    this.data.members.push({id:randomUUID(),name,role,thread:thread||null,cursor:0,location,color});
    this.add('系统',name+' 加入了群聊');
  }
  remove(name) {
    if (!this.data.members.some(member => member.name === name)) throw Error('该成员已不在群内');
    const involved = run => run.job.chain.includes(name) || run.asked?.some(request=>request.targets.includes(name));
    if (this.active.has(name) || this.data.nativeQueue[this.member(name).id] || this.queues.get(name)?.length ||
        [...this.active.values()].some(involved) ||
        Object.values(this.data.handoffBatches).some(batch=>batch.owner===name || batch.targets.includes(name)) ||
        [...this.queues.values()].some(queue => queue.some(job => job.chain.includes(name)))) {
      throw Error('该成员有待处理任务，完成后再移除');
    }
    const member = this.data.members.find(member => member.name === name);
    this.organization.removeMember(member.id);
    for (const [id,pending] of Object.entries(this.data.retries)) if (pending.memberId===member.id || pending.job.chain.includes(name)) delete this.data.retries[id];
    this.data.members = this.data.members.filter(member => member.name !== name);
    this.queues.delete(name);
    if (this.loaded.delete(member.thread)) {
      void this.rpc.call('thread/unsubscribe', {threadId:member.thread}).catch(() => {});
    }
    this.add('系统', name + ' 已移出群聊');
  }
  member(name) {
    const member = this.data.members.find(member => member.name === name);
    if (!member) throw Error('该成员已不在群内');
    return member;
  }
  setDisplaySettings(show,fontSize=this.data.chatFontSize ?? 14) {
    if (typeof show!=='boolean') throw Error('无效的协作显示设置');
    if (!Number.isInteger(fontSize) || fontSize<12 || fontSize>20) throw Error('聊天字号须为 12–20 px 的整数');
    this.data.showAgentInteractions=show;
    this.data.chatFontSize=fontSize;
    this.save();
  }
  setMemberProfile(name,{personality,avatarId,colorHex}) {
    const member=this.member(name);
    if (personality!==undefined && (typeof personality!=='string' || personality.length>1000)) throw Error('性格描述最多 1000 字');
    if (colorHex!==undefined && colorHex!==null && (typeof colorHex!=='string' || !/^#[0-9a-f]{6}$/i.test(colorHex))) throw Error('请选择有效的成员颜色');
    if (personality!==undefined) member.personality=personality.trim();
    if (avatarId!==undefined) member.avatarId=avatarId;
    if (colorHex!==undefined) member.colorHex=colorHex?.toLowerCase() || null;
    this.save();
  }
  configure(name, settings) {
    this.member(name).settings = settings;
    this.save();
  }
  saveTask(input, resolveFiles) {
    const {id,sourceId}=input;
    const fields = Object.fromEntries(['title','requirements','reference'].map(key=>[key,typeof input[key]==='string' ? input[key].trim() : '']));
    if (!fields.title || fields.title.length>80 || !fields.requirements || fields.requirements.length>6000 || fields.reference.length>4000) {
      throw Error('请填写任务名称（最多 80 字）和必须遵守的要求（最多 6000 字），参考资料最多 4000 字');
    }
    const existing=id && this.data.tasks.find(task=>task.id===id && this.visibleTask(task));
    if (id && !existing) throw Error('群公告已失效');
    const source=sourceId==null ? null : this.data.messages.find(msg=>msg.id===sourceId && msg.author==='你' && !msg.removed);
    if (sourceId!=null && !source) throw Error('找不到群内原消息');
    const task={id:existing?.id || randomUUID(),...fields,sourceId:source?.id,updatedAt:Date.now(),files:resolveFiles(source?.attachments || [])};
    if (existing) Object.assign(existing,task);
    else this.data.tasks.unshift(task);
    this.save();
    return task.id;
  }
  post(text, choices = {}) {
    if (/@\s*$/u.test(text)) throw Error('请选择 @ 成员后再发送');
    if (this.paused) throw Error('请先继续讨论');
    if (!this.data.members.length) throw Error('请先添加群成员');
    if (choices.taskId && !this.data.tasks.some(task=>task.id===choices.taskId && this.visibleTask(task))) throw Error('群公告已失效，请重新选择');
    const refs = [...text.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map(m=>m[1]);
    const members = this.data.members.map(m=>m.name);
    const isEveryone = name => everyoneMention(name,members);
    const unknown = refs.filter(name=>!isEveryone(name) && !members.includes(name));
    if (unknown.length) throw Error('未找到成员 @'+unknown[0]+'。请在成员名后加空格');
    const skillTargets = choices.skillTargets || [];
    if (skillTargets.some(name=>!members.includes(name))) throw Error('所选 Skill 的执行成员已不在群内');
    const targets = refs.some(isEveryone) ? members
      : refs.length || skillTargets.length ? [...new Set([...refs,...skillTargets])]
      : members;
    const attachments = choices.attachments?.map(({id,name,size,image}) => ({id,name,size,image}));
    const record = attachments?.length ? attachments : undefined;
    const messageId=this.add('你',text,'text',record,choices.skill ? {name:choices.skill.name,targets:skillTargets} : undefined,undefined,{taskId:choices.taskId});
    for (const name of targets) {
      this.enqueue(name,{
        prompt:text, chain:[], depth:0, taskId:choices.taskId, attachments:choices.attachments,
        skill:skillTargets.includes(name) ? choices.skill : undefined
      });
    }
    return messageId;
  }
  async retry(id,{fork=false}={}) {
    if (this.paused) throw Error('请先继续讨论');
    if (typeof id!=='string' || !Object.hasOwn(this.data.retries,id)) throw Error('这条消息已重试或不可重试');
    const pending = this.data.retries[id];
    const member = this.data.members.find(member=>member.id===pending.memberId);
    if (!member) throw Error('该成员已不在群内');
    if (this.active.has(member.name) || this.data.nativeQueue[member.id]) throw Error('该成员还有任务，请等当前任务结束后再重试');
    const job={...pending.job,retryId:id};
    await this.enqueue(member.name,{...job,fork},true);
    return {blocked:Object.hasOwn(this.data.retries,id) && !this.active.has(member.name) && !this.data.nativeQueue[member.id]};
  }
  enqueue(name,job,first=false) {
    if (this.paused) return;
    if (!this.queues.has(name)) this.queues.set(name,[]);
    const queue=this.queues.get(name);
    if (first) queue.unshift(job);
    else queue.push(job);
    return this.run(name);
  }
  async resume(member,r) {
    const waits = r.job.retryId ? [0] : [...lockWaits,0];
    for (const wait of waits) {
      try {
        const {thread} = await r.rpc.call('thread/resume',{threadId:member.thread,excludeTurns:true});
        if (thread.id !== member.thread || thread.ephemeral) throw Error('无法续接所选的原会话');
        if (thread.status?.type==='active') throw Error('Codex 报告会话正在运行');
        return true;
      } catch (error) {
        if (this.active.get(member.name)!==r || r.cancel) return false;
        if (activeWriter.test(error.message) && this.canUseNativeQueue(member,r.job)) throw error;
        if (!writerConflict.test(error.message) || !wait) throw error;
        r.activity='等待 Codex 后台允许续接';
        this.changed?.();
        await delay(wait,undefined,{signal:r.wait.signal}).catch(error=>{
          if (error.name!=='AbortError') throw error;
        });
        if (this.active.get(member.name)!==r || r.cancel) return false;
      }
    }
  }
  async run(name) {
    const job = this.queues.get(name)?.[0];
    if (this.paused || this.active.has(name) || !job) return;
    const m = this.member(name);
    if (this.data.nativeQueue[m.id] || (!job.retryId && Object.values(this.data.retries).some(pending=>pending.memberId===m.id))) return;
    this.queues.get(name).shift();
    // Reload adopted sessions from disk for each turn so native edits between turns are visible.
    const rpc = job.fork || (m.thread && !m.roomCreated) ? new Codex() : this.rpc;
    const r = {job,items:new Map(),childIds:new Set(),turn:null,activity:'续接会话',startedAt:Date.now(),cancel:false,wait:new AbortController(),rpc};
    if (rpc !== this.rpc) {
      rpc.onEvent = message => this.event(message, rpc);
      rpc.onLost = error => { if (this.active.get(name) === r && !r.handingOff) this.finish(name, error.message); };
    }
    this.active.set(name,r); this.save();
    let branching=job.fork;
    try {
      const overrides = m.settings?.overrides;
      if (branching) {
        const source=m.thread;
        r.activity='创建 Codex 会话分支';
        this.changed?.();
        const {thread}=await rpc.call('thread/fork',{threadId:source,excludeTurns:true});
        if (!thread.id || thread.id===source || thread.ephemeral) throw Error('未得到可保存的 Codex 会话分支');
        if (this.active.get(name)!==r) return;
        m.branchFrom=source;
        m.thread=thread.id;
        m.titleSet=false;
        branching=false;
        this.add('系统',name+' 已切换到 Codex 会话分支，后续群聊会写入该分支。');
      } else if (!m.thread) {
        const location = m.location?.id ? await localProject(rpc,m.location.id) : m.location;
        const out = await rpc.call('thread/start',{
          cwd:(m.contextReset && m.location?.cwd) || location?.cwd || this.cwd,
          ...(location ? {projectId:location.id} : {}),
          sandbox:'workspace-write',approvalPolicy:'on-request',dynamicTools:[askTool]
        });
        if (location) m.location=location;
        m.thread = out.thread.id; m.roomCreated = true; this.loaded.add(m.thread); this.save();
      } else if (rpc !== this.rpc || !this.loaded.has(m.thread)) {
        if (!await this.resume(m,r)) {
          if (this.active.get(name)===r) this.finish(name,'已暂停');
          return;
        }
        if (rpc === this.rpc) this.loaded.add(m.thread);
      }
      if (this.active.get(name)!==r) return;
      if ((m.roomCreated || m.branchFrom) && !m.titleSet) {
        try {
          const suffix=m.branchFrom ? '（群聊分支）' : '';
          await rpc.call('thread/name/set', {threadId:m.thread,name:this.name+' · '+m.name+suffix});
          m.titleSet = true;
          this.save();
        } catch (error) {
          console.warn('设置群聊会话标题失败，将在下一轮重试：'+error.message);
        }
      }
      if (this.active.get(name)!==r) return;
      if (r.cancel) { this.finish(name,'已暂停'); return; }
      const {input,additionalContext,cursor}=this.prepareTurn(m,job);
      r.cursor=cursor;
      r.activity='等待模型回复'; r.updatedAt=Date.now(); this.changed?.();
      const out = await rpc.call('turn/start', {
        threadId:m.thread, input, additionalContext, ...overrides
      });
      if (this.active.get(name)!==r) return;
      r.turn=out.turn.id;
      if (r.cancel) await this.interrupt(m,r);
    } catch (error) {
      if (this.active.get(name)!==r) return;
      if (writerConflict.test(error.message) && !r.turn && !r.cancel && !r.items.size) {
        if (activeWriter.test(error.message) && this.canUseNativeQueue(m,job) && await this.handoffToNativeQueue(m,r)) return;
        const id = job.retryId || randomUUID();
        const {fork,...savedJob}=job;
        this.data.retries[id] = {memberId:m.id,job:savedJob};
        this.finish(name,lockMessage,id);
      } else if (branching && !r.cancel) {
        this.add('系统',name+' · 创建会话分支失败：'+error.message);
        this.finish(name,error.message,job.retryId);
      } else this.finish(name,error.message);
    }
  }
  prepareTurn(member,job,{native=false}={}) {
    const history = this.data.messages.filter(x=>x.id>Math.max(member.cursor || 0,this.data.contextResetAt || 0) && !x.removed && x.author!=='系统' && (!x.taskId || x.taskId===job.taskId));
    const cursor = this.data.messages.length;
    const members = this.data.members.map(x=>x.name+'（'+x.role+'）').join('、');
    const responsibility = this.organization.responsibility(member.id);
    const context = [
      '你在本地群聊中以「'+member.name+'」发言。职责：'+member.role+'。群成员：'+members+'。',
      '本轮的组织架构：直属负责人 '+(responsibility.managers.join('、') || '无')+'；直属成员 '+(responsibility.reports.join('、') || '无')+'。组织关系可直接用于回答职责和人数。现有信息足够时，直接回答，不联系其他成员或创建子 Agent。仅在用户明确要求委派、需要其他成员独有的信息或操作，或独立子任务确实值得并行处理时委派。需要临时子 Agent 时，使用 Codex 原生子 Agent 能力，并在汇报前等待结果。',
      '按自己的身份回答，不替别人发言。'+(native
        ? '需要群成员协助时，在最终答复末尾写 /ask 成员甲、成员乙、成员丙 具体任务。同一问题一次点名多人，不同问题分行写 /ask。群聊并行投递，收齐后统一回传。请避免在群里逐条复述投递进度。'
        : '需要群成员协助时，用 ask_member 的 members 一次点名多人。遇到只支持单人的工具版本或无此工具时，改在最终答复末尾写 /ask 成员甲、成员乙、成员丙 具体问题。不同问题可以分行写 /ask 或在本轮多次登记。群聊并行投递，收齐后统一回传。请避免在群里逐条复述投递进度。')+
        '普通 @ 只是引用。被要求答复时直接给出答案，群系统将自动送回提问者。',
      '以下是群内可见的新消息：', JSON.stringify(history.slice(native ? -30 : -100).map(x=>[x.author,x.text])).slice(native ? -12000 : -48000),
    ];
    if (member.personality) context.splice(1,0,'用户设置的沟通风格：'+member.personality);
    const input = [{type:'text', text:job.prompt || (job.skill ? '请调用所选 Skill。' : '请查看这条消息的附件。'), text_elements:[]}];
    if (job.skill) input.push({type:'skill',name:job.skill.name,path:job.skill.id});
    const additionalContext = {room:{kind:'application', value:context.join('\n')}};
    const task=this.data.tasks.find(task=>task.id===job.taskId && this.visibleTask(task));
    if (task) {
      const parts=['当前任务「'+task.title+'」','必须遵守的任务要求：',task.requirements];
      if (task.reference) parts.push('参考资料：',task.reference);
      if (task.files.length) parts.push('任务原消息的附件（本机路径）：',JSON.stringify(task.files));
      additionalContext.task={kind:'application',value:parts.join('\n')};
    }
    const files = job.attachments || [];
    for (const file of files.filter(file => file.image)) input.push({type:'localImage',path:file.path});
    if (files.length) {
      additionalContext.attachments = {kind:'application', value:'本条消息的附件（原名与本机路径）：\n'+
        JSON.stringify(files.map(({name,path})=>({name,path})))};
    }
    if (native) {
      const contextText=Object.values(additionalContext).map(part=>part.value).join('\n');
      input.splice(1,0,{type:'text',text:'[群聊上下文]\n'+contextText,text_elements:[]});
    }
    return {input,additionalContext,cursor};
  }
  canUseNativeQueue(member,job) {
    return member.thread && !job.fork && !Object.keys(member.settings?.overrides || {}).length;
  }
  async handoffToNativeQueue(member,run) {
    const {input,cursor}=this.prepareTurn(member,run.job,{native:true});
    const {chain,depth,taskId,contributors,handoffCredits,batchId}=run.job;
    const request=run.job.request ?? run.job.prompt;
    const pending={
      cursor,chain,depth,taskId,contributors,handoffCredits,batchId,request,
      clientId:randomUUID(),threadId:member.thread,retryId:run.job.retryId,
      since:Date.now(),activity:'正在交给 Codex 原会话'
    };
    run.handingOff=true;
    run.activity=pending.activity;
    this.data.nativeQueue[member.id]=pending;
    this.save();
    try {
      const {queuedSubmission}=await this.rpc.call('thread/queue/add',{
        threadId:pending.threadId,clientUserMessageId:pending.clientId,
        input
      },AbortSignal.timeout(15000));
      pending.submissionId=queuedSubmission.id;
      pending.queued=true;
      pending.activity='已交给 Codex 原会话，等待处理';
    } catch (error) {
      if (Number.isInteger(error.rpcCode)) {
        console.warn('Codex 原会话队列未接收输入：'+error.message);
        delete this.data.nativeQueue[member.id];
        return false;
      }
      // A transport failure may occur after the queue item was persisted.
      pending.activity='等待 Codex 确认接收';
    }
    this.active.delete(member.name);
    this.releaseRun(member,run);
    this.save();
    void this.monitorNativeQueue(member);
    return true;
  }
  startNativeMonitoring() {
    // Local in-flight turns cannot be recovered. Native queued turns can still report back.
    for (const [id,batch] of Object.entries(this.data.handoffBatches)) {
      for (const name of batch.targets) {
        if (batch.replies.some(reply=>reply.name===name)) continue;
        const member=this.data.members.find(member=>member.name===name);
        if (this.data.nativeQueue[member?.id]?.batchId===id ||
          Object.values(this.data.retries).some(entry=>entry.memberId===member?.id && entry.job.batchId===id) ||
          Object.values(this.data.handoffBatches).some(child=>child.owner===name && child.resume.batchId===id)) continue;
        batch.replies.push({name,error:'群聊服务重启前未收到结果',contributors:[]});
      }
      this.flushHandoffBatch(id,batch);
    }
    this.save();
    for (const member of this.data.members) {
      if (this.data.nativeQueue[member.id]) void this.monitorNativeQueue(member);
    }
  }
  async findNativeTurn(pending,signal) {
    let cursor;
    const seenCursors=new Set();
    do {
      const page=await this.rpc.call('thread/turns/list',{
        threadId:pending.threadId,cursor,limit:8,sortDirection:'desc',itemsView:'full'
      },signal);
      const turn=page.data.find(turn=>turn.id===pending.turnId ||
        turn.items.some(item=>item.type==='userMessage' && item.clientId===pending.clientId));
      if (turn) return turn;
      if (page.data.some(turn=>turn.startedAt && turn.startedAt*1000 < pending.since-5000)) return;
      cursor=page.nextCursor;
      if (seenCursors.has(cursor)) throw Error('Codex 回合分页暂不可用');
      seenCursors.add(cursor);
    } while (cursor);
  }
  updateNativeSync(pending,activity,{uncertain=false,queued=false,turnId=pending.turnId}={}) {
    const uncertainSince=uncertain ? pending.uncertainSince || Date.now() : undefined;
    const syncDelayed=uncertain && Date.now()-uncertainSince>=nativeSyncDelayMs;
    if (syncDelayed) activity='暂未同步结果，仍在重查';
    if (pending.activity===activity && pending.uncertainSince===uncertainSince &&
        pending.syncDelayed===syncDelayed && pending.queued===queued && pending.turnId===turnId) return;
    Object.assign(pending,{activity,uncertainSince,syncDelayed,queued,turnId});
    this.save();
  }
  async monitorNativeQueue(member) {
    const pending=this.data.nativeQueue[member.id];
    if (!pending || this.nativeMonitors.has(member.id)) return;
    this.nativeMonitors.add(member.id);
    try {
      while (this.data.nativeQueue[member.id]===pending) {
        try {
          const signal=AbortSignal.timeout(15000);
          const turn=await this.findNativeTurn(pending,signal);
          if (this.data.nativeQueue[member.id]!==pending) return;
          // Cross-client history can show a terminal-looking status before its end was recorded.
          const terminal=turn?.status==='completed' ||
            (Number.isFinite(turn?.completedAt) && ['interrupted','failed'].includes(turn.status));
          if (terminal) {
            const answer=turn.items.filter(item=>item.type==='agentMessage').map(item=>item.text).join('\n\n').trim();
            if (turn.status==='completed' && !answer) {
              if (pending.emptyReplySince==null) {
                pending.emptyReplySince=Date.now();
                this.save();
              }
              this.updateNativeSync(pending,'正在同步 Codex 原会话',{uncertain:true,turnId:turn.id});
              if (Date.now()-pending.emptyReplySince<nativeEmptyReplyGraceMs) {
                await delay(2500);
                continue;
              }
            }
            const issue=turn.status==='completed' ? null
              : '原会话的这一轮'+(turn.status==='interrupted' ? '已中断。' : '未完成。');
            const childIds=new Set();
            for (const item of turn.items) this.captureNativeCredits(item,childIds);
            const childNames=await Promise.all([...childIds].map(async id=>{
              try {
                const {thread}=await this.rpc.call('thread/read',{threadId:id},AbortSignal.timeout(15000));
                return thread.agentNickname || thread.name || thread.agentRole || '子 Agent '+id.slice(-5);
              } catch { return '子 Agent '+id.slice(-5); }
            }));
            if (this.data.nativeQueue[member.id]!==pending) return;
            this.completeNativeQueue(member,pending,answer,issue,childNames);
            return;
          }
          if (turn) {
            const running=turn.status==='inProgress';
            this.updateNativeSync(pending,running ? 'Codex 原会话正在处理' : '正在同步 Codex 原会话',
              {uncertain:!running,turnId:turn.id});
          } else {
            let queued;
            if (!pending.turnId) {
              const {data}=await this.rpc.call('thread/queue/list',{threadId:pending.threadId,limit:50},signal);
              if (this.data.nativeQueue[member.id]!==pending) return;
              queued=data.find(item=>item.clientUserMessageId===pending.clientId);
              if (queued) pending.submissionId=queued.id;
            }
            this.updateNativeSync(pending,queued ? '已交给 Codex 原会话，等待处理' : '正在核对 Codex 原会话',
              {uncertain:!queued,queued:!!queued});
          }
        } catch {
          if (this.data.nativeQueue[member.id]===pending) {
            this.updateNativeSync(pending,'正在恢复 Codex 同步',{uncertain:true});
          }
        }
        await delay(pending.syncDelayed ? 15000 : pending.turnId ? 2500 : 5000);
      }
    } finally {
      this.nativeMonitors.delete(member.id);
      if (this.data.nativeQueue[member.id]) void this.monitorNativeQueue(member);
    }
  }
  stopNativeSync(clientId) {
    if (typeof clientId!=='string' || !clientId) throw Error('无效的队列消息');
    const member=this.data.members.find(entry=>this.data.nativeQueue[entry.id]?.clientId===clientId);
    if (!member) throw Error('这条消息已处理');
    const pending=this.data.nativeQueue[member.id];
    if (!pending.syncDelayed) throw Error('正在同步，稍后可重新查看状态');
    this.completeNativeQueue(member,pending,'','已停止在群聊同步这一轮。原会话的结果可在 Codex 查看。');
  }
  completeNativeQueue(member,pending,answer,issue,childNames=[]) {
    delete this.data.nativeQueue[member.id];
    if (pending.retryId) delete this.data.retries[pending.retryId];
    const name=member.name;
    const run={job:{chain:pending.chain || [],depth:pending.depth || 0,taskId:pending.taskId,
      contributors:pending.contributors,handoffCredits:pending.handoffCredits,batchId:pending.batchId,request:pending.request}};
    run.contributors=[...new Set([...(pending.contributors || []),...childNames])].filter(label=>label!==name);
    const result=this.extractHandoff(name,run,answer,issue);
    if (!result.error && pending.cursor) member.cursor=Math.max(member.cursor || 0,pending.cursor);
    if (result.answer) this.add(name,result.answer,'text',undefined,undefined,undefined,{taskId:run.job.taskId,contributors:run.contributors,interaction:!!(run.job.chain.length || run.asked?.length)});
    if (result.error || (!result.answer && !run.asked)) {
      this.add('系统',name+' · '+(result.error || '原会话已完成，这一轮没有文字回复。'));
    }
    this.save();
    this.continueHandoff(name,run,result.answer,result.error);
    void this.run(name);
  }
  async cancelNativeQueue(clientId) {
    if (typeof clientId!=='string' || !clientId) throw Error('无效的队列消息');
    const member=this.data.members.find(member=>this.data.nativeQueue[member.id]?.clientId===clientId);
    if (!member) throw Error('这条消息已处理');
    const pending=this.data.nativeQueue[member.id];
    if (pending.turnId || !pending.submissionId) throw Error('消息已交给 Codex，请在原会话查看或停止');
    const {deleted}=await this.rpc.call('thread/queue/delete',{
      threadId:pending.threadId,queuedSubmissionId:pending.submissionId
    });
    if (this.data.nativeQueue[member.id]!==pending) return;
    if (!deleted) throw Error('Codex 已取走该消息，请在原会话查看或停止');
    this.completeNativeQueue(member,pending,'','已取消原会话中的排队消息。');
  }
  releaseRun(member,run) {
    run.wait.abort();
    if (run.rpc !== this.rpc) {
      this.organization.disconnect(run.rpc,member.id);
      run.rpc.child?.kill();
    }
  }
  ask(name,r,recipients,question) {
    const targets=[...new Set(Array.isArray(recipients) ? recipients : [recipients])];
    const prior=r.asked || [];
    const unavailable=targets.some(target=>target===name || r.job.chain.includes(target) ||
      !this.data.members.some(member=>member.name===target) || prior.some(request=>request.targets.includes(target)));
    if (r.cancel || this.paused || r.job.depth>=3 || !targets.length || unavailable ||
        typeof question!=='string' || !question.trim()) throw Error('无法投递，请检查成员名、重复提问或讨论深度');
    r.asked=[...prior,{targets,question:question.trim().slice(0,6000)}];
  }
  finish(name,error,retryId) {
    const r=this.active.get(name);
    if (!r) return;
    const m=this.data.members.find(m=>m.name===name);
    let answer=[...r.items.values()].join('\n\n').trim();
    ({answer,error}=this.extractHandoff(name,r,answer,error));
    const children=[...(r.childIds || [])].map(id=>this.data.nativeChildren[id]?.name || '子 Agent '+id.slice(-5));
    r.contributors=[...new Set([...(r.job.contributors || []),...children])].filter(label=>label!==name);
    if(answer) this.add(name,answer,'text',undefined,undefined,undefined,{taskId:r.job.taskId,contributors:r.contributors,interaction:!!(r.job.chain.length || r.asked?.length)});
    if ((error || r.cancel) && (!retryId || !this.data.messages.some(msg=>msg.retryId===retryId))) {
      this.add('系统',name+' · '+(error||'已暂停'),'text',undefined,undefined,retryId);
    }
    if (r.job.retryId && !retryId && (!r.cancel || r.turn)) delete this.data.retries[r.job.retryId];
    for (const [id,a] of this.approvals) if((a.owner || a.name)===name) this.approvals.delete(id);
    this.active.delete(name);
    this.releaseRun(m,r);
    if(!r.cancel && !error) m.cursor=r.cursor;
    if (!retryId) this.continueHandoff(name,r,answer,error);
    this.save(); void this.run(name);
  }
  extractHandoff(name,r,answer,error) {
    const lines=answer.split('\n');
    const actions=[];
    while (lines.length && /^\/ask[ \t]/u.test(lines.at(-1))) actions.unshift(lines.pop());
    if (!error && !r.cancel && !this.paused && actions.length) {
      try {
        for (const action of actions) {
          const match=action.match(/^\/ask[ \t]+(@[^\s、，,]+(?:[ \t]+@[^\s、，,]+)+|\S+)[ \t]+(.+)$/u);
          if (!match) throw Error('无法识别派工，请填写成员名和具体问题');
          const targets=match[1].split(/[、，,\s]+/u).map(target=>target.replace(/^@/u,''));
          this.ask(name,r,targets,match[2]);
        }
        answer=lines.join('\n').trim();
      } catch(e) { error=e.message; }
    }
    return {answer,error};
  }
  continueHandoff(name,r,answer,error) {
    if (r.cancel || this.paused) return;
    const {taskId,depth}=r.job;
    const handoffCredits={...r.job.handoffCredits};
    if (r.asked?.length && !error) {
      const id=randomUUID();
      this.data.handoffBatches[id]={owner:name,targets:r.asked.flatMap(request=>request.targets),replies:[],resume:{
        chain:r.job.chain,depth:depth+1,taskId,batchId:r.job.batchId,handoffCredits,contributors:r.contributors,
        request:r.job.request ?? r.job.prompt
      }};
      const questions=new Map();
      for (const {targets,question} of r.asked) questions.set(question,[...(questions.get(question) || []),...targets]);
      for (const [question,targets] of questions) {
        const mentions=targets.map(target=>'@'+target).join(' ');
        this.add(name,mentions+' '+question,'question',undefined,undefined,undefined,{taskId});
        for (const target of targets) this.enqueue(target,{
          prompt:name+' 提问：'+question,chain:[...r.job.chain,name],depth:depth+1,taskId,batchId:id
        });
      }
    } else if (r.job.batchId) {
      const batch=this.data.handoffBatches[r.job.batchId];
      if (batch?.targets.includes(name) && !batch.replies.some(reply=>reply.name===name)) {
        batch.replies.push({name,answer,error:error || (!answer && '未返回可用结果'),contributors:r.contributors || []});
        if (!this.flushHandoffBatch(r.job.batchId,batch)) this.save();
      }
    } else if (r.job.chain.length) {
      const chain=[...r.job.chain], target=chain.pop();
      const received=(!error && answer) ? [name,...r.contributors] : [];
      const contributors=[...new Set([...(Object.hasOwn(handoffCredits,target) ? handoffCredits[target] : []),...received])];
      delete handoffCredits[target];
      this.enqueue(target,{prompt:name+(error?' 未完成，请说明影响：'+error:' 答复了你的问题：'+answer)+'\n请据此继续原任务。',chain,depth,taskId,handoffCredits,contributors});
    }
  }
  flushHandoffBatch(id,batch) {
    if (batch.targets.length!==batch.replies.length || this.paused) return false;
    const replies=batch.targets.map(name=>batch.replies.find(reply=>reply.name===name));
    const received=replies.filter(reply=>!reply.error).flatMap(reply=>[reply.name,...reply.contributors]);
    const contributors=[...new Set([...(batch.resume.contributors || []),...received])];
    const prompt=[
      '部员已回传。你负责给发起人交付这项任务的结果。先回到发起人的问题，结合前文理解最新消息。若最新消息只是补充资料、纠正信息或指定获取信息的方式，用它来完成之前尚未回答的问题。',
      batch.resume.request ? '本次协作由这条消息触发：\n'+batch.resume.request : '从前文确认触发这次协作的请求。',
      '部员反馈（供你判断和取舍）：',
      replies.map(reply=>reply.name+(reply.error?' 未完成：'+reply.error:' 回复：'+reply.answer)).join('\n\n'),
      '直接给出解决问题的结论或可用成果，再按需要补充依据和下一步。合并重复内容，只保留关系到结论的细节。涉及比较、排序或推荐时，说清取舍依据。信息不足以确定顺序或结论时，给出有条件的建议，并说明哪项待确认的信息会改变判断。区分已确认事实和推断，回复篇幅与提问所需的详略一致。'
    ].join('\n\n');
    delete this.data.handoffBatches[id];
    this.enqueue(batch.owner,{...batch.resume,contributors,prompt},true);
    this.save();
    return true;
  }
  captureNativeCredits(item, ids) {
    if (item?.type==='collabAgentToolCall' && item.status==='completed') {
      for (const [id,state] of Object.entries(item.agentsStates || {})) {
        if (state.status==='completed' && state.message) ids.add(id);
      }
    }
    if (item?.type==='subAgentActivity' && item.kind==='completed' && item.agentThreadId) ids.add(item.agentThreadId);
  }
  event({id,method,params:p={}}, rpc = this.rpc) {
    const originId = p.thread?.parentThreadId || p.threadId;
    const member = this.data.members.find(member=>member.thread===originId);
    const name = member?.name;
    const active = this.active.get(name);
    const r = active?.rpc === rpc ? active : null;
    const own = r && {rpc,rootMemberId:member.id,rootThreadId:member.thread};
    if (id===undefined) this.organization.observe({method,params:p},rpc,own);
    const nativeOwner = this.organization.owner(p.threadId,rpc);
    const nativeRoot = nativeOwner && this.data.members.find(member=>member.id===nativeOwner.rootMemberId);
    const rootRun = nativeRoot && this.active.get(nativeRoot.name);
    const approver = r ? name : rootRun?.rpc===rpc ? this.data.nativeChildren[p.threadId]?.name : null;
    const approvalOwner = r ? name : nativeRoot?.name;
    if(id!==undefined) {
      if(method==='item/tool/call' && p.tool==='ask_member' && r) {
        let message='已登记，结束本轮后并行投递，收齐后统一回传。', success=true;
        try { this.ask(name,r,p.arguments?.members ?? p.arguments?.member,p.arguments?.question); } catch(e){message=e.message; success=false;}
        rpc.send({id,result:{success,contentItems:[{type:'inputText',text:message}]}});
        this.changed?.();
      } else if (approver && method === 'item/permissions/requestApproval') {
        const detail = ['申请本轮额外权限', p.cwd, p.reason, JSON.stringify(p.permissions,null,2)].filter(Boolean).join('\n');
        const requested = Object.fromEntries(Object.entries(p.permissions).filter(([,value]) => value != null));
        this.approvals.set(randomUUID(),{rpc,rpcId:id,name:approver,owner:approvalOwner,detail,allow:true,requested});
        this.changed?.();
      } else if(approver && ['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method)) {
        const detail=[p.command || (p.grantRoot?'写入 '+p.grantRoot:'修改文件'),p.cwd,p.reason,p.additionalPermissions && JSON.stringify(p.additionalPermissions)].filter(Boolean).join('\n');
        this.approvals.set(randomUUID(),{rpc,rpcId:id,name:approver,owner:approvalOwner,detail,allow:!p.availableDecisions || p.availableDecisions.includes('accept')});
        this.changed?.();
      } else rpc.send({id,error:{code:-32601,message:'此群聊客户端未提供该交互：'+method}});
      return;
    }
    if(!r) return;
    const tid=p.turnId || p.turn?.id;
    if(r.turn && tid && r.turn!==tid) return;
    if(method==='turn/started') r.turn=p.turn.id;
    if(method==='item/agentMessage/delta') r.items.set(p.itemId,(r.items.get(p.itemId)||'')+p.delta);
    if(method==='item/completed' && p.item.type==='agentMessage') r.items.set(p.item.id,p.item.text);
    if(method==='item/completed') this.captureNativeCredits(p.item,r.childIds);
    if (method === 'error' && p.willRetry) {
      r.activity = 'Codex 正在重试';
      r.updatedAt = Date.now();
    }
    if (method === 'item/started') {
      const stage = {commandExecution:'执行命令',fileChange:'修改文件',mcpToolCall:'调用工具',
        dynamicToolCall:'调用工具',webSearch:'搜索资料',agentMessage:'正在发言',reasoning:'模型推理中'}[p.item.type];
      if (stage) { r.activity=stage; r.updatedAt=Date.now(); }
    }
    if (method === 'item/agentMessage/delta') {
      r.activity = '正在发言';
      r.updatedAt = Date.now();
    }
    if (method==='turn/completed') {
      for (const item of p.turn.items || []) this.captureNativeCredits(item,r.childIds);
      this.finish(name,p.turn.status==='completed'?null:(p.turn.error?.message||p.turn.status));
      return;
    }
    this.changed?.();
  }
  decide(id,allow) {
    const a=this.approvals.get(id);
    if(!a || (allow && !a.allow)) throw Error('审批已失效或不支持此决定');
    const result = a.requested
      ? {permissions:allow ? a.requested : {},scope:'turn'}
      : {decision:allow ? 'accept' : 'decline'};
    a.rpc.send({id:a.rpcId,result});
    this.approvals.delete(id);
    this.changed?.();
  }
  async interrupt(m,r) {
    try { await r.rpc.call('turn/interrupt',{threadId:m.thread,turnId:r.turn}); }
    catch(e){ if(this.active.get(m.name)===r) this.add('系统','中断请求失败：'+e.message); }
  }
  pause(value) {
    this.paused=value;
    if(value) {
      this.queues.clear();
      this.data.handoffBatches={};
      for(const id of [...this.approvals.keys()]) this.decide(id,false);
      for(const [name,r] of this.active){r.cancel=true; r.wait.abort(); if(r.turn) void this.interrupt(this.data.members.find(m=>m.name===name),r);}
    }
    this.save();
  }
}
