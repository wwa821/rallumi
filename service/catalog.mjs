import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

async function desktopProjects() {
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(homedir(), '.codex'));
  const statePath = path.join(codexHome, '.codex-global-state.json');
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    return {
      assignments: state['thread-project-assignments'] || {},
      aliases: state['app-server-project-id-by-legacy-project-id-by-host']?.['local:'+codexHome] || {},
      projects: state['local-projects'] || {},
      order: state['project-order'] || []
    };
  } catch (error) {
    if (error.code === 'ENOENT') return {assignments:{}, aliases:{}, projects:{}, order:[]};
    throw error;
  }
}

export async function listLocalProjects(rpc) {
  const projects = [];
  let cursor;
  do {
    const page = await rpc.call('project/list',{limit:100,cursor});
    projects.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return projects.filter(project=>path.isAbsolute(project.roots?.[0]?.path || '')).map(project=>({
    id:project.id,name:project.name,cwd:project.roots[0].path
  }));
}

export async function localProject(rpc,id) {
  const {project} = await rpc.call('project/read',{projectId:id});
  const cwd = project.roots?.[0]?.path;
  if (!cwd || !path.isAbsolute(cwd)) throw Error('所选项目没有可用的本机工作目录');
  return {id:project.id,name:project.name,cwd};
}

function canonicalProject(desktop,id) {
  return id ? desktop.aliases[id] || id : null;
}

function resolvedProject(thread, cleared, desktop) {
  const explicit=thread.projectId || desktop.assignments[thread.id]?.projectId;
  if (thread.projectId || cleared(thread.id)) return canonicalProject(desktop,thread.projectId);
  if (explicit) return canonicalProject(desktop,explicit);
  const rootMatch=Object.values(desktop.projects).find(project=>project.rootPaths?.[0]===thread.cwd);
  return canonicalProject(desktop,rootMatch?.id);
}

export async function conversationProject(thread, cleared) {
  return resolvedProject(thread,cleared,await desktopProjects());
}

export async function listConversations(rpc, query, cleared = () => false) {
  const [native,desktop]=await Promise.all([listLocalProjects(rpc),desktopProjects()]);
  const projects=new Map(native.map(p=>[p.id,p.name]));
  for (const project of Object.values(desktop.projects)) {
    projects.set(canonicalProject(desktop,project.id),project.name);
  }
  const projectFilter=query.get('project');
  const order=desktop.order.map(id=>canonicalProject(desktop,id));
  let cursor=query.get('cursor');
  const threads=[];
  for (let batch=0;batch<5;batch++) {
    const page=await rpc.call('thread/list',{
      limit:40,cursor,searchTerm:query.get('q') || null,
      archived:query.get('view') === 'archived',currentAccountOnly:true,
      sortKey:'updated_at',useStateDbOnly:false
    });
    for (const t of page.data) {
      if (t.ephemeral) continue;
      const projectId=resolvedProject(t,cleared,desktop);
      if (projectFilter!==null && (projectId || '')!==projectFilter) continue;
      threads.push({
        id:t.id,title:t.name || t.preview?.trim().split('\n')[0].slice(0,80) || '未命名会话',
        cwd:t.cwd,project:projects.get(projectId) || null,projectId,
        section:t.section?.name || null,updatedAt:t.updatedAt
      });
    }
    cursor=page.nextCursor;
    if (projectFilter===null || threads.length || !cursor) break;
  }
  return {
    threads,order,cursor,
    projects:[...new Set([...order,...projects.keys()])].filter(id=>projects.has(id)).map(id=>({id,name:projects.get(id)}))
  };
}
