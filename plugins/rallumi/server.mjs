import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const origin='http://127.0.0.1:4321';
const tokenFile=process.env.RALLUMI_TOKEN_FILE;
const resourceUri='ui://rallumi/preview-v3';
const mimeType='text/html;profile=mcp-app';
const resource={uri:resourceUri,name:'Rallumi',mimeType};
const icon={
  src:'data:image/png;base64,'+await readFile(new URL('./assets/rallumi-symbol.png',import.meta.url),'base64'),
  mimeType:'image/png',
  sizes:['256x256']
};
const tool={
  name:'rallumi_open',
  title:'Rallumi',
  icons:[icon],
  description:'Open local Rallumi group chats.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},
  annotations:{readOnlyHint:true,openWorldHint:false},
  _meta:{
    ui:{resourceUri,visibility:['app']},
    'openai/ui':{entrypoints:[{type:'global'}]}
  }
};
const bridge={
  name:'rallumi_chat_request',
  title:'Rallumi group chat request',
  description:'Read or update local chats from the Rallumi panel.',
  inputSchema:{
    type:'object',properties:{
      route:{type:'string'},method:{enum:['GET','POST']},body:{type:'string'},
      binary:{type:'boolean'}
    },required:['route','method'],additionalProperties:false
  },
  _meta:{ui:{visibility:['app']}}
};
const reads=new Set(['state','projects','threads','skills','member/location','compose','attachment']);
const writes=new Set([
  'preferences','groups','group/restore','group/archive','group/rename','group/avatar','group/visibility',
  'member','member/remove','member/location','member/rename','member/profile','member/settings','member/conversation',
  'organization','retry','approval','task/save','message','message/remove','pause',
  'native-queue/cancel','native-queue/stop-sync','attachment'
]);

async function relay(args) {
  if (typeof args?.route!=='string' || !args.route.startsWith('/api/')) {
    throw rpcError(-32602,'无效的本机群聊路径');
  }
  const target=new URL(args.route,origin);
  const route=target.pathname.slice('/api/'.length);
  if (target.origin!==origin || !(args.method==='GET' ? reads : args.method==='POST' ? writes : new Set()).has(route) ||
      (args.binary && (args.method!=='POST' || route!=='attachment'))) {
    throw rpcError(-32602,'该请求不属于 Rallumi 群聊');
  }
  const options={method:args.method,signal:AbortSignal.timeout(25000),headers:new Headers()};
  try {
    options.headers.set('Authorization','Bearer '+(await readFile(tokenFile,'utf8')).trim());
  } catch {
    return {status:503,type:'application/json',body:JSON.stringify({error:'请重新运行安装 Rallumi，修复本机连接'})};
  }
  if (args.method==='POST') {
    options.headers.set('Origin',origin);
    options.headers.set('Content-Type',args.binary ? 'application/octet-stream' : 'application/json');
    options.body=args.binary ? Buffer.from(args.body || '','base64') : args.body;
  }
  try {
    const response=await fetch(target,options);
    const type=response.headers.get('content-type') || 'application/octet-stream';
    const binary=!type.startsWith('application/json');
    const body=binary ? Buffer.from(await response.arrayBuffer()).toString('base64') : await response.text();
    return {status:response.status,type,binary,body};
  } catch {
    return {status:503,type:'application/json',body:JSON.stringify({error:'暂时无法连接 Rallumi 本机服务'})};
  }
}

function rpcError(code,message) {
  return Object.assign(new Error(message),{code});
}

async function handle(method,params={}) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion:['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(params.protocolVersion)
          ? params.protocolVersion : '2025-11-25',
        capabilities:{tools:{},resources:{}},
        serverInfo:{name:'rallumi',version:'0.3.2',icons:[icon]}
      };
    case 'ping': return {};
    case 'tools/list': return {tools:[tool,bridge]};
    case 'tools/call':
      if (params.name===tool.name) return {content:[{type:'text',text:'Rallumi local group chats'}]};
      if (params.name===bridge.name) return {content:[],_meta:await relay(params.arguments)};
      throw rpcError(-32602,'Unknown tool');
    case 'resources/list': return {resources:[resource]};
    case 'resources/templates/list': return {resourceTemplates:[]};
    case 'resources/read':
      if (![resourceUri,'ui://rallumi/chat-v2','ui://rallumi/home'].includes(params.uri)) {
        throw rpcError(-32002,'Resource not found');
      }
      return {contents:[{
        uri:params.uri,mimeType,
        text:await readFile(new URL('./chat.html',import.meta.url),'utf8')
      }]};
    default: throw rpcError(-32601,'Method not found');
  }
}

const lines=createInterface({input:process.stdin});
for await (const line of lines) {
  let request;
  try { request=JSON.parse(line); } catch { continue; }
  if (!request || !Object.hasOwn(request,'id')) continue;
  const respond=payload=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,...payload})+'\n');
  void handle(request.method,request.params)
    .then(result=>respond({result}))
    .catch(error=>respond({error:{code:error.code || -32603,message:error.message}}));
}
