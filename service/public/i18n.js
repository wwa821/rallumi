import { english } from './translations.js';

export let language = 'en';

export function t(message, ...values) {
  const template = language === 'en' && Object.hasOwn(english, message) ? english[message] : message;
  return template.replace(/\{(\d+)\}/g, (placeholder,index) => values[index] ?? placeholder);
}

const diagnosticPatterns = Object.keys(english).filter(key => key.includes('{0}')).map(key => {
  const parts = key.split(/\{\d+\}/);
  const escaped = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return [key,new RegExp('^'+escaped.join('(.+?)')+'$','s')];
});

export function diagnostic(message) {
  if (typeof message !== 'string' || language !== 'en') return message;
  if (Object.hasOwn(english,message)) return t(message);
  if (message.includes(' · ')) {
    const at = message.indexOf(' · ');
    const detail = message.slice(at+3);
    if (Object.hasOwn(english,detail)) return message.slice(0,at+3)+t(detail);
  }
  const matching = diagnosticPatterns.find(([,pattern])=>pattern.test(message));
  return matching ? t(matching[0],...matching[1].exec(message).slice(1)) : message;
}

const attributes = ['aria-label', 'title', 'placeholder'];
const textBindings = [];
const attributeBindings = [];
const nodes = document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{
  acceptNode(node) {
    if (node.parentElement.closest('script, style, svg')) return NodeFilter.FILTER_REJECT;
    return Object.hasOwn(english,node.data.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
  }
});
for (let node = nodes.nextNode(); node; node = nodes.nextNode()) textBindings.push([node,node.data]);
for (const element of document.querySelectorAll(attributes.map(name=>'['+name+']').join(','))) {
  for (const attribute of attributes) {
    const value = element.getAttribute(attribute);
    if (Object.hasOwn(english,value)) attributeBindings.push([element,attribute,value]);
  }
}

export function setLanguage(value) {
  language = value === 'zh-CN' ? value : 'en';
  document.documentElement.lang = language;
  for (const [node,original] of textBindings) {
    const key = original.trim();
    node.data = original.replace(key,()=>t(key));
  }
  for (const [element,attribute,key] of attributeBindings) element.setAttribute(attribute,t(key));
}
