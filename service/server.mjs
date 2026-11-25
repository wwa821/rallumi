import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Codex } from './rpc.mjs';
import { validateGroupName } from './group-management.mjs';
import { Room } from './room.mjs';
import { conversationProject, listConversations, listLocalProjects, localProject } from './catalog.mjs';
import { composeCatalog, turnOptions } from './compose.mjs';
import { maxAttachment, storeAttachment, getAttachment, serveAttachment } from './attachments.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const cwd=path.resolve(process.env.ROOM_WORKSPACE || path.join(root,'..'));
const port=Number(process.env.ROOM_PORT || 4321);
const host='127.0.0.1:'+port, origin='http://'+host;
const dir=process.env.ROOM_DATA || path.join(root,'.local');
const token=process.env.RALLUMI_TOKEN_FILE && (await readFile(process.env.RALLUMI_TOKEN_FILE,'utf8')).trim();
if (!/^[a-f0-9]{64}$/.test(token || '')) throw Error('缺少 Rallumi 本机连接凭证');
const authorization=Buffer.from('Bearer '+token);
await mkdir(dir,{recursive:true,mode:0o700});
const rpc = new Codex();
const clients = new Map();
const rooms = new Map();
const groupOperations = new Set();
const roomMutations = new Map();
const dbPath = path.join(dir,'room.sqlite');
let db, notice;

function groups(archived=false) {
  return db.prepare(`SELECT groups.id,groups.name,group_avatars.attachment_id AS avatarId FROM groups
    LEFT JOIN group_avatars ON group_avatars.group_id=groups.id
    LEFT JOIN group_archive ON group_archive.room_id=groups.id
    WHERE (group_archive.room_id IS NOT NULL)=? ORDER BY groups.id`).all(Number(archived));
}
function openRoom(id) {
  if (!rooms.has(id)) {
    const room = new Room(dbPath, new Codex(), cwd, id, groups().find(group => group.id === id).name);
    room.changed = broadcast;
    rooms.set(id, room);
    room.startNativeMonitoring();
  }
  return rooms.get(id);
}
function snapshot(id) {
  const available=groups();
  const roomId=available.some(group=>group.id===id) ? id : 0;
  const data=roomId ? openRoom(roomId).state() : {messages:[],members:[],active:[],approvals:[],tasks:[],retries:[],paused:false};
  return {...data,language:appLanguage(),roomId,groups:available,archivedGroups:groups(true),managing:groupOperations.has(roomId)};
}
function broadcast() {
  if (notice) return;
  notice = setTimeout(() => {
    notice = null;
    const frames = new Map();
    for (const [client, id] of clients) {
      if (!frames.has(id)) frames.set(id, 'data: ' + JSON.stringify(snapshot(id)) + '\n\n');
      client.write(frames.get(id));
    }
  }, 70);
}
function appLanguage() {
  return db.prepare("SELECT value FROM app_settings WHERE key='language'").get()?.value || 'en';
}
const files={
  '/i18n.js':['i18n.js','text/javascript'],
  '/translations.js':['translations.js','text/javascript'],
  '/mentions.js':['mentions.js','text/javascript'],
  '/markdown.js':['markdown.js','text/javascript'],'/vendor/markdown-it.mjs':['vendor/markdown-it.mjs','text/javascript'],'/':['index.html','text/html'],'/ui.js':['ui.js','text/javascript'],'/organization.js':['organization.js','text/javascript'],'/style.css':['style.css','text/css']};
const placementsInFlight = new Set();
function assertRoomIdle(room) {
  room.assertIdle();
  if (roomMutations.get(room.id)) throw Error('群设置正在更新，请稍候再试');
  if (room.data.members.some(member=>placementsInFlight.has(member.thread || member.id))) {
    throw Error('群里正在更新会话位置，请稍候再试');
  }
}
async function manageRoom(room,operation) {
  assertRoomIdle(room);
  groupOperations.add(room.id);
  broadcast();
  try { return await operation(); }
  finally { groupOperations.delete(room.id); broadcast(); }
}
function validateAvatar(roomId, id) {
  if (id===null) return;
  if (typeof id!=='string') throw Error('请选择有效的头像图片');
  const avatar=getAttachment(db,roomId,id);
  if (!avatar?.type || avatar.size>2*1024*1024) throw Error('头像须为不超过 2 MB 的图片');
}
const projectCleared = id => !!db.prepare('SELECT 1 FROM independent_conversations WHERE id=?').get(id);

async function memberPlacement(room, member) {
  if (!member.thread) {
    return {projectId:member.location?.id || null,cwd:member.location?.cwd || room.cwd,created:false};
  }
  const {thread} = await rpc.call('thread/read',{threadId:member.thread});
  return describeConversation(thread);
}
async function describeConversation(thread) {
  return {
    projectId:await conversationProject(thread,projectCleared),cwd:thread.cwd,created:true,threadId:thread.id,
    threadTitle:thread.name || thread.preview?.trim().split('\n')[0].slice(0,80) || null
  };
}
async function rebindMember(room,{memberId,expectedThread,threadId}) {
  const member=room.data.members.find(entry=>entry.id===memberId);
  if (!member || (member.thread || null)!==expectedThread) throw Error('成员会话已变更，请重新打开设置');
  if (typeof threadId!=='string' || !threadId) throw Error('请选择已有 Codex 会话');
  if (threadId===member.thread) return memberPlacement(room,member);
  if (room.data.members.some(entry=>entry.thread===threadId)) throw Error('该会话已绑定给本群另一位成员');
  const {thread}=await rpc.call('thread/read',{threadId});
  if (thread.id!==threadId || thread.ephemeral) throw Error('无法绑定所选的 Codex 会话');
  const placement=await describeConversation(thread);
  let settings=member.settings;
  if (settings) {
    const {overrides}=await turnOptions(rpc,thread.cwd || room.cwd,settings);
    settings={...settings,overrides};
  }
  room.rebindConversation(member,{threadId,location:{id:placement.projectId,cwd:thread.cwd || room.cwd},settings});
  return placement;
}
async function moveMember(room, name, projectId) {
  if (projectId!==null && (typeof projectId!=='string' || !projectId)) throw Error('无效的项目');
  const member = room.member(name);
  const threadId = member.thread;
  const key = threadId || member.id;
  if (placementsInFlight.has(key)) throw Error('正在保存存放位置，请稍候');
  placementsInFlight.add(key);
  try {
    const project = projectId ? await localProject(rpc,projectId) : null;
    if (room.member(name)!==member || member.thread!==threadId) throw Error('成员会话已变更，请重新打开设置');
    if (!threadId) {
      member.location = project || {id:null,cwd:room.cwd};
      room.save();
      return {projectId,cwd:member.location.cwd,created:false};
    }
    const {thread} = await rpc.call('thread/metadata/update',{threadId,projectId:projectId ?? ''});
    if (thread.id!==threadId || (thread.projectId || null)!==projectId) throw Error('Codex 未确认存放位置，请刷新后核对');
    if (projectId) db.prepare('DELETE FROM independent_conversations WHERE id=?').run(threadId);
    else db.prepare('INSERT OR IGNORE INTO independent_conversations(id) VALUES(?)').run(threadId);
    return {projectId,cwd:thread.cwd,created:true};
  } finally {
    placementsInFlight.delete(key);
  }
}
async function memberDirectory(room, name) {
  const member = room.member(name);
  if (!member.thread) return member.location?.cwd || room.cwd;
  const {thread} = await rpc.call('thread/read',{threadId:member.thread});
  return thread.cwd || room.cwd;
}
async function sharedSkills(room, recipients) {
  if (!Array.isArray(recipients) || !recipients.length || recipients.length > room.data.members.length ||
      recipients.some(name => typeof name !== 'string')) throw Error('请选择至少一位群成员');
  const directories = new Set(await Promise.all([...new Set(recipients)].map(name=>memberDirectory(room,name))));
  const catalogs = await Promise.all([...directories].map(directory=>composeCatalog(rpc,directory,['skills'])));
  for (const catalog of catalogs) {
    if (catalog.errors.skills) throw Error('无法读取 Skill：'+catalog.errors.skills);
  }
  return catalogs[0].skills.filter(skill=>catalogs.every(catalog=>catalog.skills.some(entry=>entry.id===skill.id)));
}
async function requestBody(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Error('内容超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const server=http.createServer(async(req,res)=>{
  const json=(status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};
  let mutationRoom;
  try{
    if(req.headers.host!==host || (req.headers.origin && req.headers.origin!==origin)) return json(403,{error:'仅接受本机群聊页面请求'});
    const supplied=Buffer.from(req.headers.authorization || '');
    if (supplied.length!==authorization.length || !timingSafeEqual(supplied,authorization)) {
      return json(401,{error:'请从 Codex 的 Rallumi 插件打开群聊'});
    }
    const url=new URL(req.url,origin);
    if (req.method==='GET' && url.pathname==='/api/health') return json(200,{app:'rallumi-preview'});
    const file=Object.hasOwn(files,url.pathname) && files[url.pathname];
    if(req.method==='GET' && file){
      res.setHeader('Content-Security-Policy',"default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      res.setHeader('Cache-Control','no-cache');
      res.setHeader('Content-Type',file[1]+'; charset=utf-8');
      res.end(await readFile(path.join(root,'public',file[0])));return;
    }
    const id = Number(url.searchParams.get('room') || 1);

    if(req.method==='GET' && url.pathname==='/api/state') return json(200,snapshot(id));
    if(req.method==='GET' && url.pathname==='/api/events'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
      clients.set(res,id); res.write('data: '+JSON.stringify(snapshot(id))+'\n\n');
      const heartbeat=setInterval(()=>res.write(': alive\n\n'),20000);
      res.on('close',()=>{clearInterval(heartbeat);clients.delete(res);});return;
    }
    const available=groups().some(group=>group.id===id);
    // Older Codex plugin bridges only allow-listed the display settings route.
    const appPreferences=url.pathname==='/api/preferences' ||
      (url.pathname==='/api/group/visibility' && url.searchParams.get('scope')==='app');
    const globalRoute=appPreferences || ['/api/groups','/api/group/restore'].includes(url.pathname);
    if (!available && !globalRoute) return json(404,{error:'群聊不存在或已归档'});
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      return json(200,{projects:await listLocalProjects(rpc),cwd});
    }
    if (req.method === 'GET' && url.pathname === '/api/threads') {
      return json(200, await listConversations(rpc, url.searchParams, projectCleared));
    }
    if (req.method === 'GET' && url.pathname === '/api/skills') {
      return json(200,{skills:await sharedSkills(openRoom(id),url.searchParams.getAll('member'))});
    }
    if (req.method === 'GET' && url.pathname === '/api/member/location') {
      const room = openRoom(id);
      const [location,projects] = await Promise.all([
        memberPlacement(room,room.member(url.searchParams.get('member'))),
        listLocalProjects(rpc)
      ]);
      return json(200,{...location,projects});
    }
    if (req.method === 'GET' && url.pathname === '/api/compose') {
      const directory = await memberDirectory(openRoom(id),url.searchParams.get('member'));
      const keys = url.searchParams.get('view') === 'skills' ? ['skills'] : ['models','permissions','plugins'];
      return json(200,await composeCatalog(rpc,directory,keys));
    }
    if (req.method === 'GET' && url.pathname === '/api/attachment') {
      const file = getAttachment(db,id,url.searchParams.get('id'));
      if (!file) return json(404,{error:'找不到附件'});
      return await serveAttachment(res,file);
    }
    if (req.method === 'POST' && url.pathname === '/api/attachment' && req.headers['content-type'] === 'application/octet-stream') {
      if (req.headers.origin !== origin) return json(403,{error:'请从群聊页面上传'});
      const body = await requestBody(req,maxAttachment);
      if (!body.length) throw Error('附件是空文件');
      return json(201,await storeAttachment(db,dir,id,url.searchParams.get('name'),body));
    }
    if (req.method!=='POST' || !req.headers['content-type']?.startsWith('application/json')) return json(404,{error:'未找到'});
    const b = JSON.parse((await requestBody(req,64000)).toString());
    if (appPreferences) {
      if (!['en','zh-CN'].includes(b.language)) return json(400,{error:'Unsupported language'});
      db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES('language',?)").run(b.language);
      broadcast();
      return json(200,{language:b.language});
    }
    if (url.pathname === '/api/groups') {
      const name=validateGroupName(b.name);
      if (db.prepare('SELECT 1 FROM groups WHERE name=?').get(name)) throw Error('已有同名群聊或归档');
      const result=db.prepare('INSERT INTO groups(name) VALUES(?)').run(name);
      broadcast();
      return json(201,{id:Number(result.lastInsertRowid),name});
    }
    if (url.pathname==='/api/group/restore') {
      db.prepare('DELETE FROM group_archive WHERE room_id=?').run(id);
      broadcast();
      return json(200,{ok:true});
    }
    if (groupOperations.has(id)) return json(409,{error:'正在更新群聊会话，请稍候再试'});
    if (!groups().some(group=>group.id===id)) return json(404,{error:'群聊已归档'});
    const room = openRoom(id);
    if (!['/api/group/archive','/api/message/remove','/api/member/conversation'].includes(url.pathname)) {
      mutationRoom=id;
      roomMutations.set(id,(roomMutations.get(id) || 0)+1);
    }
    switch(url.pathname){
      case '/api/group/rename': {
        const name=validateGroupName(b.name);
        if (db.prepare('SELECT 1 FROM groups WHERE name=? AND id<>?').get(name,id)) throw Error('已有同名群聊或归档');
        db.prepare('UPDATE groups SET name=? WHERE id=?').run(name,id);
        room.name=name;
        broadcast();
        return json(200,{id,name});
      }
      case '/api/group/archive': {
        assertRoomIdle(room);
        db.prepare('INSERT OR IGNORE INTO group_archive(room_id) VALUES(?)').run(id);
        broadcast();
        break;
      }
      case '/api/message/remove': {
        if (!Number.isSafeInteger(b.id) || b.id<1) throw Error('无效的消息');
        if (b.reset===true) {
          await manageRoom(room,async()=>{
            const items=await Promise.all(room.data.members.map(async member=>{
              const location=await memberPlacement(room,member);
              return [member.id,{threadId:null,location:{id:location.projectId,cwd:location.cwd || room.cwd}}];
            }));
            room.removeMessage(b.id,new Map(items));
          });
        } else {
          assertRoomIdle(room);
          room.removeMessage(b.id);
        }
        break;
      }
      case '/api/task/save': return json(200,{id:room.saveTask(b,attachments=>attachments.flatMap(item=>{
        const file=getAttachment(db,id,item.id);
        return file ? [{name:file.name,path:file.path}] : [];
      }))});
      case '/api/group/visibility': room.setDisplaySettings(b.showAgentInteractions,b.chatFontSize); break;
      case '/api/group/avatar': {
        validateAvatar(id,b.avatarId);
        if (b.avatarId===null) db.prepare('DELETE FROM group_avatars WHERE group_id=?').run(id);
        else db.prepare('INSERT OR REPLACE INTO group_avatars VALUES(?,?)').run(id,b.avatarId);
        broadcast();
        break;
      }
      case '/api/member/profile': {
        if (b.avatarId!==undefined) validateAvatar(id,b.avatarId);
        room.setMemberProfile(b.name,{personality:b.personality,avatarId:b.avatarId,colorHex:b.colorHex});
        break;
      }
      case '/api/organization': room.organization.edit(b.from,b.to,b.remove===true); break;
      case '/api/native-queue/cancel': await room.cancelNativeQueue(b.clientId); break;
      case '/api/native-queue/stop-sync': room.stopNativeSync(b.clientId); break;
      case '/api/retry': return json(200,await room.retry(b.id,{fork:b.fork===true}));
      case '/api/member/location': return json(200,await moveMember(room,b.name,b.projectId));
      case '/api/member/conversation': return json(200,await manageRoom(room,()=>rebindMember(room,b)));
      case '/api/member/remove': room.remove(b.name); break;
      case '/api/member/rename': {
        const member = room.rename(b.name,String(b.newName || '').trim());
        if ((member.roomCreated || member.branchFrom) && member.thread && !member.titleSet) {
          try {
            const suffix=member.branchFrom ? '（群聊分支）' : '';
            await rpc.call('thread/name/set',{threadId:member.thread,name:room.name+' · '+member.name+suffix});
            member.titleSet = true;
            room.save();
          } catch (error) {
            console.warn('群成员已更名，原生标题将在下一轮重试：'+error.message);
          }
        }
        return json(200,{name:member.name});
      }
      case '/api/member/settings': {
        const directory = await memberDirectory(room,b.name);
        const {model,effort,permissions,disabledPlugins} = b.settings || {};
        const selections = {model,effort,permissions,disabledPlugins};
        const {overrides} = await turnOptions(rpc,directory,selections);
        room.configure(b.name,{...selections,overrides});
        break;
      }
      case '/api/message':{
        const msg=String(b.text||'');
        const ids = b.attachments || [];
        if (!Array.isArray(ids) || ids.length > 8 || ids.some(key => typeof key !== 'string')) throw Error('每条消息最多 8 个附件');
        const attachments = [...new Set(ids)].map(key => {
          const file = getAttachment(db,id,key);
          if (!file) throw Error('附件已失效，请重新添加');
          return {...file,image:!!file.type};
        });
        const selection = b.skill;
        if ((!msg.trim() && !attachments.length && !selection) || msg.length>16000) throw Error('请输入消息、添加附件或选择 Skill，文字最多 16000 字');
        let skill, skillTargets;
        if (selection) {
          if (typeof selection.id !== 'string' || !selection.id) throw Error('请选择 Skill');
          const targets = selection.targets ?? (selection.target ? [selection.target] : []);
          skill = (await sharedSkills(room,targets)).find(entry=>entry.id===selection.id);
          if (!skill) throw Error('所选成员已无法共同使用这个 Skill，请重新选择');
          skillTargets=[...new Set(targets)];
        }
        const messageId=room.post(msg,{attachments,skill,skillTargets,taskId:b.taskId,replyTo:b.replyTo,clientSendId:typeof b.clientSendId==='string' && /^[0-9a-f]{32}$/.test(b.clientSendId) ? b.clientSendId : undefined});
        return json(200,{ok:true,messageId});
      }
      case '/api/member': {
        let location;
        if (b.thread) {
          const {thread} = await rpc.call('thread/read', {threadId:b.thread});
          if (thread.id !== b.thread || thread.ephemeral) throw Error('无法绑定所选的原会话');
        } else {
          if (b.projectId && typeof b.projectId!=='string') throw Error('无效的项目');
          location = b.projectId ? await localProject(rpc,b.projectId) : {id:null,cwd};
        }
        room.join(String(b.name||'').trim(), String(b.role||'项目协作').slice(0,300), b.thread||null,location);
        break;
      }
      case '/api/pause':
        if (b.stop===true) room.stopDiscussion();
        else room.pause(b.paused===true);
        break;
      case '/api/approval': room.decide(b.id,b.allow===true);break;
      default:return json(404,{error:'未找到'});
    }
    json(200,{ok:true});
  }catch(e){json(400,{error:e.message});}
  finally {
    if (mutationRoom!==undefined) {
      const remaining=roomMutations.get(mutationRoom)-1;
      if (remaining) roomMutations.set(mutationRoom,remaining);
      else roomMutations.delete(mutationRoom);
    }
  }
});
server.on('error',e=>{console.error(e.message);process.exit(1);});
server.listen(port,'127.0.0.1',()=>{
  db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)');
  db.exec('CREATE TABLE IF NOT EXISTS group_archive(room_id INTEGER PRIMARY KEY)');
  db.exec('CREATE TABLE IF NOT EXISTS group_avatars(group_id INTEGER PRIMARY KEY, attachment_id TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS independent_conversations(id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE IF NOT EXISTS attachment(id TEXT PRIMARY KEY, room INTEGER NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, type TEXT, size INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO groups VALUES(1,?)').run('Rallumi Starter Group');
  db.exec('CREATE TABLE IF NOT EXISTS room(id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
  for (const record of db.prepare("SELECT id FROM room WHERE EXISTS (SELECT 1 FROM json_each(data,'$.nativeQueue')) OR EXISTS (SELECT 1 FROM json_each(data,'$.handoffBatches'))").all()) openRoom(record.id);
  console.log('Agent 群聊 '+origin);
});
function stopService() {
  for (const room of rooms.values()) {
    for (const run of room.active.values()) run.rpc.child?.kill();
    room.rpc.child?.kill();
  }
  rpc.child?.kill();
  process.exit(0);
}
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,stopService);
if (process.send) process.on('disconnect',stopService);
