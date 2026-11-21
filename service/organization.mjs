import {randomUUID} from 'node:crypto';

const settled = new Set(['completed','failed','interrupted','closed']);
const agentStatuses = {
  pendingInit:'starting', running:'running', completed:'completed',
  errored:'failed', interrupted:'interrupted', shutdown:'closed', notFound:'closed'
};

export class Organization {
  owners = new Map();
  reading = new Set();

  constructor(data, changed) {
    this.data = data;
    this.changed = changed;
    for (const member of data.members) member.id ||= randomUUID();
    data.management ||= [];
    data.nativeChildren ||= {};
    for (const child of Object.values(data.nativeChildren)) {
      if (!settled.has(child.status)) child.status = 'interrupted';
    }
  }
  edit(from,to,remove) {
    const {members,management} = this.data;
    if (![from,to].every(id=>members.some(member=>member.id===id))) throw Error('只能编辑群内常驻成员的管理关系');
    const existing = management.findIndex(edge=>edge.from===from && edge.to===to);
    if (remove) {
      if (existing < 0) return;
      management.splice(existing,1);
    } else {
      if (existing >= 0) return;
      const pending = [to], visited = new Set();
      while (pending.length) {
        const id = pending.pop();
        if (id===from) throw Error('这条连线会形成循环管理关系');
        if (visited.has(id)) continue;
        visited.add(id);
        pending.push(...management.filter(edge=>edge.from===id).map(edge=>edge.to));
      }
      management.push({from,to});
    }
    this.changed();
  }
  removeMember(id) {
    this.data.management = this.data.management.filter(edge=>edge.from!==id && edge.to!==id);
  }
  responsibility(id) {
    const names = ids => this.data.members.filter(member=>ids.includes(member.id)).map(member=>member.name);
    const edges = this.data.management;
    return {
      managers:names(edges.filter(edge=>edge.to===id).map(edge=>edge.from)),
      reports:names(edges.filter(edge=>edge.from===id).map(edge=>edge.to))
    };
  }
  snapshot() {
    return {
      edges:this.data.management,
      children:Object.values(this.data.nativeChildren).sort((a,b)=>b.updatedAt-a.updatedAt)
    };
  }
  owner(id,rpc) {
    const record = this.owners.get(id);
    return record?.rpc === rpc ? record : null;
  }
  update(child,changes) {
    if (!Object.entries(changes).some(([key,value])=>child[key]!==value)) return;
    Object.assign(child,changes,{updatedAt:Date.now()});
    this.changed();
  }
  register(id,parent,owner,changes={}) {
    if (!id || id===parent || id===owner.rootThreadId || this.data.members.some(member=>member.thread===id)) return;
    let record = this.data.nativeChildren[id];
    if (record && record.rootMemberId!==owner.rootMemberId) return;
    if (!record) {
      record = this.data.nativeChildren[id] = {
        id,parentThreadId:parent,rootMemberId:owner.rootMemberId,name:'子 Agent',
        status:'starting',updatedAt:Date.now(),...changes
      };
      this.changed();
    } else {
      const patch = {...changes};
      if (patch.status==='starting' || (patch.status==='running' && settled.has(record.status))) delete patch.status;
      this.update(record,patch);
    }
    if (!this.owner(id,owner.rpc)) this.owners.set(id,owner);
    return record;
  }
  async readMetadata(child,owner) {
    if (!child || child.name!=='子 Agent' || this.reading.has(child.id)) return;
    this.reading.add(child.id);
    try {
      const {thread} = await owner.rpc.call('thread/read',{threadId:child.id});
      if (this.owner(child.id,owner.rpc) !== owner) return;
      const changes = {};
      const title = thread.agentNickname || thread.name || thread.agentRole;
      if (title) changes.name=title;
      if (thread.parentThreadId && (thread.parentThreadId===owner.rootThreadId || this.owner(thread.parentThreadId,owner.rpc))) {
        changes.parentThreadId=thread.parentThreadId;
      }
      if (!child.task && thread.preview) changes.task=thread.preview.slice(0,4000);
      this.update(child,changes);
    } catch {
      // Some native subthreads do not expose metadata until they are persisted.
    } finally {
      this.reading.delete(child.id);
    }
  }
  observe({method,params:p={}},rpc,rootOwner) {
    const item = p.item;
    if (method==='thread/started' && p.thread?.parentThreadId) {
      const parent = p.thread.parentThreadId;
      const owner = rootOwner || this.owner(parent,rpc);
      if (!owner) return;
      this.register(p.thread.id,parent,owner,{
        name:p.thread.agentNickname || p.thread.name || p.thread.agentRole || '子 Agent'
      });
      return;
    }
    const directOwner = this.owner(p.threadId,rpc);
    const owner = rootOwner || directOwner;
    if (!owner) return;
    if ((method==='item/started' || method==='item/completed') && item?.type==='collabAgentToolCall') {
      if (item.tool==='spawnAgent' && item.status!=='failed' && item.status!=='interrupted') {
        for (const id of item.receiverThreadIds || []) {
          this.register(id,item.senderThreadId || p.threadId,owner,item.prompt?{task:item.prompt.slice(0,4000)}:{});
        }
      }
      for (const [id,state] of Object.entries(item.agentsStates || {})) {
        const child = this.data.nativeChildren[id];
        if (!child || !this.owner(id,rpc)) continue;
        const status = agentStatuses[state.status];
        const patch = state.message && status==='completed' ? {result:state.message.slice(0,8000)} : {};
        if (status && !(status==='closed' && settled.has(child.status))) patch.status=status;
        this.update(child,patch);
      }
    }
    if (item?.type==='subAgentActivity' && method==='item/completed') {
      const status = {started:'starting',interrupted:'interrupted',completed:'completed'}[item.kind];
      if (status) {
        const child=this.register(item.agentThreadId,p.threadId,owner,{status});
        if (child) void this.readMetadata(child,this.owner(child.id,rpc));
      }
    }
    if (!directOwner) return;
    const child = this.data.nativeChildren[p.threadId];
    if (method==='turn/started') this.update(child,{status:'running'});
    if (method==='turn/completed') {
      const status = {completed:'completed',failed:'failed',interrupted:'interrupted'}[p.turn.status];
      if (status) this.update(child,{status});
    }
    if (method==='thread/closed' && !settled.has(child.status)) this.update(child,{status:'closed'});
    if (method==='thread/status/changed' && p.status?.type==='systemError') this.update(child,{status:'failed'});
    if (method==='thread/status/changed' && p.status?.type==='active' && !settled.has(child.status)) {
      this.update(child,{status:'running'});
    }
    if (method==='thread/name/updated' && p.threadName) this.update(child,{name:p.threadName});
    if (method==='item/completed' && item?.type==='agentMessage' && item.text) {
      this.update(child,{result:item.text.slice(0,8000)});
    }
  }
  disconnect(rpc,rootMemberId) {
    for (const [id,owner] of this.owners) {
      if (owner.rpc!==rpc || (rootMemberId && owner.rootMemberId!==rootMemberId)) continue;
      this.owners.delete(id);
      const child = this.data.nativeChildren[id];
      if (!settled.has(child.status)) this.update(child,{status:'interrupted'});
    }
  }
}
