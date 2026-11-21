(() => {
  const pending=new Map();
  const icons=new Map();
  let serial=0;
  function send(message) {
    window.parent.postMessage({jsonrpc:'2.0',...message},'*');
  }
  function call(method,params,timeout=30000) {
    return new Promise((resolve,reject)=>{
      const id=++serial;
      const deadline=setTimeout(()=>{
        pending.delete(id);
        reject(new Error('Codex 插件连接超时'));
      },timeout);
      pending.set(id,message=>{
        clearTimeout(deadline);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      send({id,method,params});
    });
  }
  window.addEventListener('message',({source,data})=>{
    if (source!==window.parent || data?.jsonrpc!=='2.0' || !pending.has(data.id)) return;
    const finish=pending.get(data.id);
    pending.delete(data.id);
    finish(data);
  });
  const ready=call('ui/initialize',{
    protocolVersion:'2026-01-26',appInfo:{name:'Rallumi',version:'0.3.2'},appCapabilities:{}
  },5000).then(()=>send({method:'ui/notifications/initialized'}));
  void ready.catch(()=>{});
  function encode(blob) {
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>resolve(String(reader.result).split(',')[1]);
      reader.onerror=()=>reject(new Error('无法读取附件'));
      reader.readAsDataURL(blob);
    });
  }
  async function request(route,{method='GET',body}={}) {
    await ready;
    const binary=body instanceof Blob;
    const result=await call('tools/call',{
      name:'rallumi_chat_request',arguments:{route,method,binary,body:binary ? await encode(body) : body}
    });
    const payload=result?._meta;
    if (!payload || !Number.isInteger(payload.status)) throw Error('Codex 未返回 Rallumi 响应');
    const content=payload.binary ? Uint8Array.from(atob(payload.body),char=>char.charCodeAt(0)) : payload.body;
    return new Response(content,{status:payload.status,headers:{'Content-Type':payload.type}});
  }
  async function attachment(route) {
    if (!icons.has(route)) {
      if (icons.size>=48) {
        const first=icons.keys().next().value;
        icons.delete(first);
      }
      icons.set(route,request(route).then(async res=>{
        if (!res.ok) throw Error('附件暂不可用');
        return 'data:'+res.headers.get('Content-Type')+';base64,'+await encode(await res.blob());
      }).catch(error=>{ icons.delete(route); throw error; }));
    }
    return icons.get(route);
  }
  function subscribe(room) {
    let closed=false,timer,last;
    const connection={close(){ closed=true; clearTimeout(timer); }};
    async function poll() {
      try {
        const res=await request('/api/state?room='+room);
        if (!res.ok) throw Error('本机群聊服务暂未连接');
        const data=await res.text();
        if (!closed && data!==last) {
          last=data;
          connection.onmessage?.({data});
        }
      } catch {
        last=undefined;
        if (!closed) connection.onerror?.();
      } finally {
        if (!closed) timer=setTimeout(poll,document.hidden ? 7000 : 1500);
      }
    }
    timer=setTimeout(poll,0);
    return connection;
  }
  globalThis.rallumiTransport={request,attachment,subscribe};
})();
