import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [publicDir,esbuild]=process.argv.slice(2);
if (!publicDir || !esbuild) throw Error('Usage: node build-panel.mjs <Rallumi public directory> <esbuild executable>');
const read=name=>readFileSync(path.join(publicDir,name),'utf8');
const script=execFileSync(esbuild,[path.join(publicDir,'ui.js'),'--bundle','--minify','--format=iife','--log-level=error'],
  {encoding:'utf8'});
const transport=readFileSync(new URL('./panel-transport.js',import.meta.url),'utf8');
const html=read('index.html')
  .replace(/<link rel="stylesheet" href="\/style\.css[^"]*">/,()=>'<style>'+read('style.css')+'</style>')
  .replace(/<script src="\/ui\.js[^"]*" type="module"><\/script>/,()=>'<script>'+transport+'</script><script>'+script+'</script>');
if (!html.includes('rallumi_chat_request') || html.includes('src="/ui.js')) throw Error('Unable to bundle the Rallumi UI');
writeFileSync(new URL('./chat.html',import.meta.url),html);
