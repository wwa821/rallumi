import { t } from './i18n.js';
import MarkdownIt from './vendor/markdown-it.mjs';

const parser = new MarkdownIt({html:false,linkify:true,breaks:true});
const escape = parser.utils.escapeHtml;
const validate = parser.validateLink.bind(parser);
const localFile = /^file:\/\/(?:localhost)?\/[^/]/i;
parser.validateLink = url => localFile.test(url) || validate(url);
const rules = parser.renderer.rules;

function copyPath(href) {
  if (!localFile.test(href) && !/^(?:\/(?!\/)|\.{1,2}\/)/.test(href)) return null;
  const encoded = href.replace(/^file:\/\/(?:localhost)?/i,'').replace(/#L\d+(?:-L\d+)?$/i,'');
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}
function linkAttributes(href) {
  const path = copyPath(href);
  if (path) return ' href="#" data-copy-file="'+escape(path)+'" title="'+escape(t('复制文件路径 · {0}',path))+'"';
  if (/^https?:\/\//i.test(href)) return ' href="'+escape(href)+'" target="_blank" rel="noopener noreferrer"';
  if (/^mailto:/i.test(href)) return ' href="'+escape(href)+'"';
  return '';
}
rules.link_open = (tokens,index) => '<a'+linkAttributes(tokens[index].attrGet('href') || '')+'>';
// Render referenced images as links. Uploaded images use the room's existing attachment gallery.
rules.image = (tokens,index,options,env,renderer) => {
  const token=tokens[index];
  const label=renderer.renderInlineAsText(token.children || [],options,env);
  return '<a class="markdown-image-link"'+linkAttributes(token.attrGet('src') || '')+'>'+escape(label || '图片')+'</a>';
};
rules.table_open = () => '<div class="markdown-table" tabindex="0" role="region" aria-label="'+escape(t('消息表格'))+'"><table>\n';
rules.table_close = () => '</table></div>\n';
for (const key of ['th_open','td_open']) {
  rules[key] = (tokens,index,options,env,renderer) => {
    const token=tokens[index];
    const alignment=token.attrGet('style')?.match(/^text-align:(left|center|right)$/)?.[1];
    if (alignment) {
      token.attrs=token.attrs.filter(([name])=>name!=='style');
      token.attrJoin('class','markdown-align-'+alignment);
    }
    if(key==='th_open') token.attrSet('scope','col');
    return renderer.renderToken(tokens,index,options);
  };
}
for (const key of ['fence','code_block']) {
  const render=rules[key];
  rules[key] = (tokens,index,options,env,renderer) => {
    const name=parser.utils.unescapeAll(tokens[index].info || '').trim().split(/\s+/)[0];
    return '<div class="markdown-code"><div class="markdown-code-bar"><span>'+escape(name || t('代码'))+'</span>'+
      '<button type="button" data-copy-code>'+escape(t('复制代码'))+'</button></div>'+render(tokens,index,options,env,renderer)+'</div>\n';
  };
}

export function renderMarkdown(text) {
  return parser.render(text);
}
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
  }
  const field=document.createElement('textarea');
  field.value=text;
  field.className='markdown-clipboard';
  const focused=document.activeElement;
  document.body.append(field);
  field.select();
  try {
    if (!document.execCommand('copy')) throw Error(t('无法复制'));
  } finally {
    field.remove();
    focused?.focus({preventScroll:true});
  }
}

const buttonFeedback = new WeakMap();
export function flashButtonLabel(button,label) {
  const previous=buttonFeedback.get(button);
  const original=previous?.original ?? button.textContent;
  clearTimeout(previous?.timer);
  button.textContent=label;
  button.classList.add('control-confirmed');
  const timer=setTimeout(()=>{
    button.textContent=original;
    button.classList.remove('control-confirmed');
    buttonFeedback.delete(button);
  },1400);
  buttonFeedback.set(button,{original,timer});
}

export function markdownBody(text) {
  const body=document.createElement('div');
  body.className='body markdown-output';
  if (!text) return body;
  try { body.innerHTML=renderMarkdown(text); }
  catch { body.className='body'; body.textContent=text; }
  body.addEventListener('click',async event=>{
    const control=event.target.closest('[data-copy-file],[data-copy-code]');
    if (!control || !body.contains(control)) return;
    event.preventDefault();
    const code=control.hasAttribute('data-copy-code');
    const value=code ? control.closest('.markdown-code').querySelector('pre code')?.textContent : control.dataset.copyFile;
    if (!value) return;
    let feedback=body.querySelector('.markdown-feedback');
    if (!feedback) {
      feedback=document.createElement('small');
      feedback.className='markdown-feedback';
      feedback.setAttribute('role','status');
      body.append(feedback);
    }
    try {
      await copyText(value);
      if (code) flashButtonLabel(control,t('已复制'));
      feedback.textContent=code?t('已复制代码'):t('已复制文件路径');
    } catch { feedback.textContent=t('复制失败，请手动选择内容复制'); }
  });
  return body;
}
