import { t, diagnostic, language } from './i18n.js';
const svgNS = 'http://www.w3.org/2000/svg';
const labels = {
  starting:'启动中',running:'工作中',completed:'已完成',failed:'失败',interrupted:'已中断',closed:'已关闭'
};
const live = status => status==='starting' || status==='running';
const byId = id => document.getElementById(id);
function element(tag,text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent=text;
  return node;
}
function button(text,action) {
  const node=element('button',text);
  node.type='button';
  node.onclick=action;
  return node;
}
function svg(tag,attributes) {
  const node=document.createElementNS(svgNS,tag);
  for (const [key,value] of Object.entries(attributes)) node.setAttribute(key,value);
  return node;
}
export function layoutOrganization(nodes, edges) {
  const incoming = new Map(nodes.map(node=>[node.id,0]));
  const outgoing = new Map(nodes.map(node=>[node.id,[]]));
  const depth = new Map(nodes.map(node=>[node.id,0]));
  const links = edges.filter(({from,to})=>depth.has(from) && depth.has(to));
  for (const link of links) {
    outgoing.get(link.from).push(link.to);
    incoming.set(link.to,incoming.get(link.to)+1);
  }
  const queue = nodes.filter(node=>!incoming.get(node.id)).map(node=>node.id);
  for (const from of queue) {
    for (const to of outgoing.get(from)) {
      depth.set(to,Math.max(depth.get(to),depth.get(from)+1));
      incoming.set(to,incoming.get(to)-1);
      if (!incoming.get(to)) queue.push(to);
    }
  }

  const rows = [];
  const entries = new Map();
  function place(level, entry) {
    (rows[level] ||= []).push(entry);
    return entry;
  }
  for (const node of nodes) {
    entries.set(node.id,place(depth.get(node.id),{node,parents:[],children:[]}));
  }

  // Give edges that skip a level a slot alongside its cards, so the line has a clear passage.
  const routes = [];
  for (const link of links) {
    const from = depth.get(link.from), to = depth.get(link.to);
    if (from>=to) continue;
    const waypoints = [];
    let previous = entries.get(link.from);
    for (let level=from+1;level<to;level++) {
      const waypoint = place(level,{parents:[previous],children:[]});
      previous.children.push(waypoint);
      waypoints.push(waypoint);
      previous=waypoint;
    }
    const target = entries.get(link.to);
    previous.children.push(target);
    target.parents.push(previous);
    routes.push({link,waypoints});
  }

  function align(row, neighbors) {
    const scores = new Map(row.map((entry,index)=>{
      const neighborsOnNextRow = entry[neighbors];
      const score = neighborsOnNextRow.length
        ? neighborsOnNextRow.reduce((sum,neighbor)=>sum+neighbor.position,0)/neighborsOnNextRow.length
        : (index+.5)/row.length;
      return [entry,score];
    }));
    row.sort((a,b)=>scores.get(a)-scores.get(b));
    measure(row);
  }
  function measure(row) {
    row.forEach((entry,index)=>{entry.position=(index+.5)/row.length;});
  }
  rows.forEach(measure);
  for (let pass=0;pass<2;pass++) {
    for (let level=1;level<rows.length;level++) align(rows[level],'parents');
    for (let level=rows.length-2;level>=0;level--) align(rows[level],'children');
  }
  for (let level=1;level<rows.length;level++) align(rows[level],'parents');
  return {rows,routes};
}

export function mountOrganization(api, memberTint) {
  const dialog=byId('organization'), canvas=dialog.querySelector('.org-canvas');
  const graph=byId('org-levels'), lines=byId('org-lines');
  const hint=()=>t('点击上级下方圆点，再点下属上方圆点。');
  let state, signature='', selected='', source='', cursor, nodes=[], edges=[], routes=[], saving=false;
  const waypoints = new Map();
  const ports = new Map();
  const get = id => nodes.find(node=>node.id===id);
  function status(text) { byId('org-status').textContent=diagnostic(text); }
  function reset() { source='';cursor=null;byId('org-cancel').hidden=true; }
  function draw() {
    if (!dialog.open) return;
    const rect=canvas.getBoundingClientRect();
    const defs=svg('defs',{});
    for (const native of [false,true]) {
      const marker=svg('marker',{id:native?'org-native-tip':'org-tip',refX:8,refY:4,markerWidth:8,markerHeight:8,orient:'auto',markerUnits:'userSpaceOnUse',viewBox:'0 0 8 8'});
      marker.append(svg('path',{d:'M 0 0 L 8 4 L 0 8 Z',class:native?'org-native-fill':'org-fill'}));
      defs.append(marker);
    }
    lines.replaceChildren(defs);
    function point(node) {
      if (!node) return null;
      const bounds=node.getBoundingClientRect();
      return [bounds.left+bounds.width/2-rect.left,bounds.top+bounds.height/2-rect.top];
    }
    function curve([x,y],[u,v]) {
      const middle=(y+v)/2;
      return `C ${x} ${middle}, ${u} ${middle}, ${u} ${v}`;
    }
    function edge(start,end,native,stops=[],preview=false) {
      if (!start || !end) return;
      const target = preview ? end : [end[0],end[1]-7];
      let d=`M ${start.join(' ')}`;
      let previous=start;
      for (const stop of stops) {
        const bounds=waypoints.get(stop).getBoundingClientRect();
        const x=bounds.left+bounds.width/2-rect.left;
        const top=[x,bounds.top-rect.top];
        const bottom=[x,bounds.bottom-rect.top];
        d+=` ${curve(previous,top)} L ${bottom.join(' ')}`;
        previous=bottom;
      }
      d+=` ${curve(previous,target)}`;
      lines.append(svg('path',{d,class:native?'org-native-edge':'org-edge',fill:'none',
        'marker-end':'url(#'+(native?'org-native-tip':'org-tip')+')'}));
    }
    for (const {link,waypoints:stops} of routes) {
      edge(point(ports.get(link.from)?.out),point(ports.get(link.to)?.in),link.native,stops);
    }
    if (source && cursor) edge(point(ports.get(source)?.out),cursor,false,[],true);
  }
  function viewData() {
    const permanent = state.members.map(member=>({...member,status:state.active.some(run=>run.name===member.name)?'running':null}));
    const children = state.organization?.children || [];
    const lineage = new Map(children.map(child=>[child.id,child]));
    const visible = new Set();
    for (const child of children) {
      if (!byId('org-history').checked && !live(child.status)) continue;
      for (let parent=child; parent && !visible.has(parent.id); parent=lineage.get(parent.parentThreadId)) {
        visible.add(parent.id);
      }
    }
    const native = children.filter(child=>visible.has(child.id));
    nodes=[...permanent,...native.map(child=>({...child,native:true}))];
    edges=[...(state.organization?.edges || [])];
    for (const child of native) {
      const parent=get(child.parentThreadId) || permanent.find(member=>member.id===child.rootMemberId);
      if (parent) edges.push({from:parent.id,to:child.id,native:true});
    }
  }
  async function edit(from,to,remove) {
    if (saving) return;
    const room=state.roomId;
    saving=true;
    try {
      await api('organization',{from,to,remove},room);
      if(state.roomId!==room) return;
      reset();
      render(remove?t('已移除管理关系。'):t('已保存管理关系。'));
    } catch (error) {
      if(state.roomId===room) status(diagnostic(error.message));
    } finally {saving=false;}
  }
  function select(id) {
    selected=id;
    render(source?t('点击目标上方圆点完成连线。'):hint());
    ports.get(id)?.card.focus();
  }
  function render(message=hint()) {
    viewData();
    ports.clear();
    waypoints.clear();
    const layout=layoutOrganization(nodes,edges);
    routes=layout.routes;
    graph.replaceChildren();
    if (!nodes.length) graph.append(element('p',t('群成员会显示在这里。')));
    for (const [level,group] of layout.rows.entries()) {
      const row=element('section');
      row.className='org-tier';
      row.setAttribute('aria-label',t('第 {0} 层',level+1));
      for (const entry of group) {
        const {node}=entry;
        if (!node) {
          const lane=element('div');
          lane.className='org-waypoint';
          lane.setAttribute('aria-hidden','true');
          waypoints.set(entry,lane);
          row.append(lane);
          continue;
        }
        const frame=element('div');
        frame.className='org-node';
        const card=button(node.name,()=>select(node.id));
        card.className='org-card';
        if (!node.native) {
          card.classList.add('c'+(node.color ?? 0));
          memberTint(card,node.name,node.colorHex);
        }
        card.setAttribute('aria-pressed',String(selected===node.id));
        if (node.native || node.status) card.append(element('small',(node.native?t('原生子 Agent · '):'')+t(labels[node.status] || '')));
        if (node.native) card.dataset.native='';
        const incoming=button('',()=>{
          if (source) void edit(source,node.id,false);
          else status(t('请先点击上级 Agent 下方的圆点。'));
        });
        incoming.className='org-port org-in';
        incoming.setAttribute('aria-label',t('连入 {0}',node.name));
        const outgoing=button('',()=>{
          source=source===node.id?'':node.id;
          selected=node.id;cursor=null;
          render(source?t('从「{0}」出发，点击目标节点上方圆点。',node.name):hint());
          ports.get(node.id)?.out.focus();
        });
        outgoing.className='org-port org-out';
        outgoing.setAttribute('aria-label',t('从 {0} 引出管理箭头',node.name));
        outgoing.setAttribute('aria-pressed',String(source===node.id));
        if (source && source!==node.id) incoming.dataset.target='';
        if(node.native) {
          incoming.disabled=true;
          outgoing.disabled=true;
          incoming.setAttribute('aria-hidden','true');
          outgoing.setAttribute('aria-hidden','true');
        }
        frame.append(card,incoming,outgoing);
        row.append(frame);
        ports.set(node.id,{card,in:incoming,out:outgoing});
      }
      graph.append(row);
    }
    const details=byId('org-details'), node=get(selected);
    details.replaceChildren();
    if (node) {
      details.append(element('strong',node.name));
      for (const [label,value] of [[t('职责'),node.role],[t('委派任务'),node.task],[t('结果'),node.result]]) {
        if (value) details.append(element('p',label+' · '+value));
      }
      const relations=element('div');
      relations.className='org-relations';
      for (const edge of edges.filter(edge=>edge.from===node.id || edge.to===node.id)) {
        const parent=get(edge.from), child=get(edge.to);
        if (!parent || !child) continue;
        const label=parent.name+' → '+child.name;
        if (edge.native) relations.append(element('span',label));
        else {
          const remove=button(label+' ×',()=>edit(edge.from,edge.to,true));
          remove.setAttribute('aria-label',t('移除 {0}',label));
          relations.append(remove);
        }
      }
      details.append(relations);
    }
    byId('org-cancel').hidden=!source;
    status(message);
    draw();
  }
  byId('open-organization').onclick=()=>{
    byId('member-management-error').textContent='';
    dialog.showModal();
    render();
  };
  byId('org-close').onclick=()=>dialog.close();
  byId('org-cancel').onclick=()=>{reset();render();};
  byId('org-history').onchange=()=>render();
  dialog.onclose=reset;
  canvas.onpointermove=event=>{
    if (!source) return;
    const rect=canvas.getBoundingClientRect();
    cursor=[event.clientX-rect.left,event.clientY-rect.top];draw();
  };
  canvas.onpointerleave=()=>{cursor=null;draw();};
  new ResizeObserver(draw).observe(canvas);
  return {update(next) {
    if (state?.roomId!==next.roomId) {reset();selected='';signature='';}
    state=next;
    const key=JSON.stringify([language,state.members.map(m=>[m.id,m.name,m.role,m.color,m.colorHex]),state.organization,state.active.map(r=>r.name)]);
    if(key===signature) return;
    signature=key;
    if(dialog.open)render(source?t('点击目标上方圆点完成连线。'):hint());
  }};
}
