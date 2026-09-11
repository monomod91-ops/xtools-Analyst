import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PLANS} from '../server/plan.mjs';

// Component-level DOM fixture only. It does not replace browser visual testing.
class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.attributes={};this.className='';this._text='';this.checked=false;}
  append(...nodes){this.children.push(...nodes);for(const n of nodes)if(typeof n==='object')n.parent=this;}
  prepend(n){this.children.unshift(n);n.parent=this;}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  set textContent(v){this._text=String(v);this.children=[];}
  get textContent(){return this._text+this.children.map(n=>typeof n==='string'?n:n.textContent).join('');}
  setAttribute(k,v){this.attributes[k]=v;}
  addEventListener(k,v){this.listeners[k]=v;}
  all(){return [this,...this.children.flatMap(n=>n instanceof Element?n.all():[])];}
  querySelector(selector){return this.all().find(n=>selector[0]==='.'?n.className.split(' ').includes(selector.slice(1)):selector[0]==='#'?n.id===selector.slice(1):n.tagName===selector);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
  focus(){} scrollIntoView(){}
}
test('pricing selection sends the chosen tier with consent and displays exact monthly caps',async()=>{
  const shell=new Element('div'),root=new Element('div'),body=new Element('body');shell.id='membership';root.id='root';body.append(shell,root);
  const calls=[];
  const fetch=async(url,options={})=>{
    calls.push({url,options});
    if(url.endsWith('/plan'))return Response.json({plan:PLANS[1],plans:PLANS.map(p=>({...p,acceptingPayments:true})),acceptingPayments:true});
    if(url.endsWith('/status'))return Response.json({active:false,subscriptionStatus:'none',acceptingPayments:true});
    return Response.json({error:'checkout fixture reached'},{status:409});
  };
  const document={body,createElement:tag=>new Element(tag),getElementById:id=>body.all().find(n=>n.id===id)};
  const sdk={getUser:async()=>({id:'fixture',email:'fixture@example.test'}),handleAuthCallback:async()=>null,onAuthChange:()=>{}};
  const context=vm.createContext({document,window:{fetch,addEventListener(){}},location:{href:'https://fixture.test/',assign(){}},history:{replaceState(){}},sdk,URL,URLSearchParams,Intl,Date,Response,AbortSignal,setTimeout,clearTimeout});
  let source=readFileSync(new URL('../client/membership.mjs',import.meta.url),'utf8');
  source=source.replace(/^import .*?;\n/,'const {login,signup,logout,getUser,handleAuthCallback,requestPasswordRecovery,updateUser,onAuthChange}=sdk;\n');
  source=source.replace(/\nstart\(\);\s*$/,'\nawait start();');
  await new vm.Script('(async()=>{'+source+'})()').runInContext(context);
  const cards=shell.all().filter(n=>n.className.split(' ').includes('circle-plan'));
  assert.equal(cards.length,4);
  for(const p of PLANS){
    const card=cards.find(n=>n.attributes['aria-label']===p.name);
    assert.ok(card.textContent.includes(new Intl.NumberFormat('ja-JP',{style:'currency',currency:'JPY'}).format(p.amount)));
    assert.ok(card.textContent.includes(p.limits.analysis.toLocaleString('ja-JP')+' 人分'));
  }
  const select=shell.all().find(n=>n.tagName==='select');select.value='max1000';select.listeners.change();
  let panel=shell.querySelector('.circle-auth');
  let buy=panel.all().find(n=>n.tagName==='button'&&n.textContent.includes('申し込む'));
  assert.ok(buy.textContent.includes('12,800'));
  await buy.listeners.click();assert.equal(calls.filter(c=>c.url.endsWith('/checkout')).length,0);
  panel=shell.querySelector('.circle-auth');panel.all().find(n=>n.type==='checkbox').checked=true;
  buy=panel.all().find(n=>n.tagName==='button'&&n.textContent.includes('申し込む'));
  await buy.listeners.click();
  const call=calls.find(c=>c.url.endsWith('/checkout'));
  assert.deepEqual(JSON.parse(call.options.body),{planId:'max1000'});
  assert.equal(call.options.headers['X-Circle-Request'],'membership');
});
