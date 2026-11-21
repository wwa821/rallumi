import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class Codex {
  pending = new Map();
  serial = 0;
  async connect() {
    if (this.ready) return this.ready;
    const child = spawn(process.env.ROOM_CODEX || 'codex', ['app-server', '--listen', 'stdio://'], {stdio:['pipe','pipe','inherit']});
    this.child = child;
    const lost = err => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      for (const task of this.pending.values()) task.reject(err);
      this.pending.clear();
      this.onLost?.(err);
    };
    child.on('error', lost);
    child.stdin.on('error', lost);
    child.on('exit', code => lost(new Error('Codex 连接已关闭（' + code + '）')));
    createInterface({input:child.stdout}).on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (this.child !== child) return;
      if (msg.method) this.onEvent?.(msg);
      else {
        const task = this.pending.get(msg.id);
        if (!task) return;
        this.pending.delete(msg.id);
        if (msg.error) task.reject(Object.assign(new Error(msg.error.message),{rpcCode:msg.error.code}));
        else task.resolve(msg.result);
      }
    });
    this.ready = this.request('initialize', {clientInfo:{name:'local_agent_room', title:'Agent 群聊', version:'0.1'}, capabilities:{experimentalApi:true}},AbortSignal.timeout(15000))
      .then(() => this.send({method:'initialized'}))
      .catch(err => { child.kill(); throw err; });
    return this.ready;
  }
  send(msg) {
    if (!this.child?.stdin.writable) throw new Error('Codex 未连接');
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }
  request(method, params, signal) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const onAbort=()=>{
        this.pending.delete(id);
        reject(signal.reason);
      };
      const cleanup=()=>signal?.removeEventListener('abort',onAbort);
      signal?.addEventListener('abort',onAbort,{once:true});
      this.pending.set(id,{
        resolve:result=>{ cleanup(); resolve(result); },
        reject:error=>{ cleanup(); reject(error); }
      });
      try { this.send({id,method,params}); }
      catch (err) { this.pending.delete(id); cleanup(); reject(err); }
    });
  }
  async call(method, params, signal) { await this.connect(); return this.request(method, params, signal); }
}
