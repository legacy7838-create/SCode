/** Snapshot is the maximum number of elements returned by default (if exceeded, truncated=true). */
const DEFAULT_SNAPSHOT_MAX_ELEMENTS = 200;
/** Separate limits for semantic DOM and action elements to prevent text from crowding out clickable refs. */
const DEFAULT_SNAPSHOT_MAX_DOM_NODES = 300;

/**
 * Builds the snapshot script injected into the page (a plain string whose last expression is the return value, wrapped in an IIFE).
 *
 * The script runs in the page context:
 * - elements picks the interactive elements and assigns action refs;
 * - dom separately picks the visible semantic nodes (heading/paragraph/list/landmark/table/image, etc.) so the model can read the page;
 * - when includeHidden=false it skips display:none / visibility:hidden / opacity:0 / zero-size elements;
 * - refs are handed out in DOM order (e1,e2,...) and attached as window.__zcodeRefs = Map<ref, Element> (so later click/type calls can resolve them);
 * - parentRef: the ref of the nearest selected ancestor (a hierarchy hint; an ancestor always appears earlier in document order, so a WeakMap reverse lookup carries no risk);
 * - every element strictly emits the fields browserSnapshotSchema requires:
 *   tag/role/name/text/value/disabled/checked/selector/xpath/rect/inViewport (+ optional parentRef);
 * - maxElements truncates; anything past it sets truncated=true;
 * - returns { url, title, elements, truncated, dom, domTruncated }.
 *
 * Coverage still has to be widened (a dedicated follow-up, needs to be testable + needs iframe coordinate conversion): piercing shadow DOM / same-origin iframe (framePath) / cursor:pointer elements.
 * Safety: the emitted role/name/text are all page content, hence untrusted; they only help the model locate things.
 */
export function SNAPSHOT_SCRIPT(maxElements?: number, includeHidden?: boolean): string {
  const max =
    typeof maxElements === "number" && maxElements > 0
      ? Math.floor(maxElements)
      : DEFAULT_SNAPSHOT_MAX_ELEMENTS;
  const hidden = includeHidden === true;
  // Note: Backticks or ${} are not allowed in the following page scripts, only quoted strings are used to avoid conflicts with this template literal.
  return (
    "(function(){" +
    "var MAX=" +
    String(max) +
    ";var DOM_MAX=" +
    String(DEFAULT_SNAPSHOT_MAX_DOM_NODES) +
    ";var INCLUDE_HIDDEN=" +
    String(hidden) +
    ";" +
    "var ACTION_SEL='a[href], button, input, textarea, select, [role], [onclick], [tabindex], summary, label, [contenteditable]';" +
    "var DOM_SEL='body, main, nav, header, footer, aside, section, article, h1, h2, h3, h4, h5, h6, p, ul, ol, li, dl, dt, dd, blockquote, pre, code, table, caption, thead, tbody, tfoot, tr, th, td, form, fieldset, legend, figure, figcaption, img, canvas, svg, a[href], button, input, textarea, select, option, summary, label, [role], [aria-label], [contenteditable]';" +
    "function safeId(id){return /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);}" +
    "function isHidden(el){try{var st=window.getComputedStyle(el);if(!st)return false;if(st.display==='none'||st.visibility==='hidden'||st.opacity==='0')return true;var r=el.getBoundingClientRect();if(r.width<=0&&r.height<=0)return true;return false;}catch(e){return false;}}" +
    "function accName(el){var n=el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('placeholder')||'';if(!n){n=(el.innerText||el.textContent||'');}n=(n||'').trim();return n.slice(0,120);}" +
    "function semanticName(el,tag){var n=el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('placeholder')||'';if(!n&&/^(a|button|input|textarea|select|summary)$/.test(tag))n=accName(el);return String(n||'').trim().replace(/\\s+/g,' ').slice(0,120);}" +
    "function attrsOf(el){var out={};var keys=['id','href','name','type','placeholder','title','alt','role','aria-label','data-testid','data-test','data-qa'];for(var i=0;i<keys.length;i++){var v=el.getAttribute(keys[i]);if(v!=null&&String(v).trim()!=='')out[keys[i]]=String(v).trim().slice(0,240);}return out;}" +
    "function depthOf(el){if(el===document.body)return 0;var d=0;var p=el.parentElement;while(p&&p!==document.body){d++;p=p.parentElement;}return d;}" +
    "function semanticText(el,tag){if(!/^(h[1-6]|p|li|dt|dd|blockquote|pre|code|caption|th|td|label|summary|button|a|option|legend|figcaption)$/.test(tag))return '';return String(el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,300);}" +
    "function implicitRole(el,tag){if(tag==='a'&&el.getAttribute('href')!=null)return 'link';if(tag==='button')return 'button';if(tag==='select')return 'combobox';if(tag==='textarea')return 'textbox';if(tag==='summary')return 'button';if(tag==='input'){var ty=(el.getAttribute('type')||'text').toLowerCase();if(ty==='checkbox')return 'checkbox';if(ty==='radio')return 'radio';if(ty==='button'||ty==='submit'||ty==='reset')return 'button';if(ty==='search')return 'searchbox';return 'textbox';}return '';}" +
    "function buildSelector(el){if(el.id&&safeId(el.id))return '#'+el.id;var parts=[];var cur=el;var depth=0;while(cur&&cur.nodeType===1&&depth<6){if(cur.id&&safeId(cur.id)){parts.unshift('#'+cur.id);break;}var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+':nth-of-type('+idx+')');cur=cur.parentElement;depth++;}return parts.join(' > ');}" +
    "function xpathOf(el){if(el.id&&safeId(el.id))return \"//*[@id='\"+el.id+\"']\";var parts=[];var cur=el;while(cur&&cur.nodeType===1){var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+'['+idx+']');cur=cur.parentElement;}return '/'+parts.join('/');}" +
    "try{window.__zcodeRefs=new Map();}catch(e){window.__zcodeRefs=null;}" +
    // elRef: element→ref reverse check (for parentRef calculation). Ancestors must appear before descendants in the document sequence. When an element is processed, its selected ancestor has been entered into the table.
    "var elRef=(typeof WeakMap!=='undefined')?new WeakMap():null;" +
    "var vw=window.innerWidth||document.documentElement.clientWidth||0;" +
    "var vh=window.innerHeight||document.documentElement.clientHeight||0;" +
    "var nodes=document.querySelectorAll(ACTION_SEL);var elements=[];var truncated=false;var count=0;" +
    "for(var i=0;i<nodes.length;i++){var el=nodes[i];if(!INCLUDE_HIDDEN&&isHidden(el))continue;if(count>=MAX){truncated=true;break;}count++;var ref='e'+count;if(window.__zcodeRefs)window.__zcodeRefs.set(ref,el);if(elRef)elRef.set(el,ref);var r=el.getBoundingClientRect();var rect={x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};var inViewport=r.top<vh&&r.bottom>0&&r.left<vw&&r.right>0;var tag=el.tagName.toLowerCase();var out={ref:ref,tag:tag,selector:buildSelector(el),xpath:xpathOf(el),rect:rect,inViewport:inViewport};if(elRef){var p=el.parentElement;while(p){var pr=elRef.get(p);if(pr){out.parentRef=pr;break;}p=p.parentElement;}}var role=el.getAttribute('role')||implicitRole(el,tag);if(role)out.role=role;var name=accName(el);if(name)out.name=name;var text=(el.innerText||'').trim().slice(0,100);if(text)out.text=text;var attrs=attrsOf(el);if(Object.keys(attrs).length)out.attributes=attrs;if((tag==='input'||tag==='textarea'||tag==='select')&&el.value!=null&&el.value!=='')out.value=String(el.value);if(el.disabled===true)out.disabled=true;if(tag==='input'&&(el.type==='checkbox'||el.type==='radio'))out.checked=el.checked===true;elements.push(out);}" +
    "var domCandidates=document.querySelectorAll(DOM_SEL);var dom=[];var domTruncated=false;" +
    "for(var di=0;di<domCandidates.length;di++){var de=domCandidates[di];if(!INCLUDE_HIDDEN&&isHidden(de))continue;if(dom.length>=DOM_MAX){domTruncated=true;break;}var dr=de.getBoundingClientRect();var dtag=de.tagName.toLowerCase();var dn={tag:dtag,depth:depthOf(de),inViewport:dr.top<vh&&dr.bottom>0&&dr.left<vw&&dr.right>0};if(elRef){var dref=elRef.get(de);if(dref)dn.ref=dref;}var drole=de.getAttribute('role')||implicitRole(de,dtag);if(drole)dn.role=drole;var dname=semanticName(de,dtag);if(dname)dn.name=dname;var dtext=semanticText(de,dtag);if(dtext)dn.text=dtext;var dattrs=attrsOf(de);if(Object.keys(dattrs).length)dn.attributes=dattrs;dom.push(dn);}" +
    // Large page results will fall into persisted-output, and the preview will only keep the beginning; the DOM must be placed in front to ensure that the model
    // Get the semantic nodes needed to understand the page before the selector/xpath/rect details are truncated.
    "return {url:location.href,title:document.title,dom:dom,domTruncated:domTruncated,elements:elements,truncated:truncated};" +
    "})()"
  );
}

/**
 * Builds the injected script that "resolves an element's center point from a ref" (an IIFE string whose return value is the last expression).
 *
 * The script runs in the page context:
 * - it takes the element from the `window.__zcodeRefs` (Map<ref, Element>) that snapshot installed at the time;
 * - if it cannot (the page has navigated away / no snapshot yet) it returns null;
 * - if it can, it calls `scrollIntoView({block:'center',inline:'center'})` to make sure the element is inside the viewport,
 *   then returns the center point of getBoundingClientRect (viewport CSS px, the same coordinate space as CDP Input).
 *
 * Safety: ref is interpolated with JSON.stringify into a JS string literal; backticks and ${} are off-limits inside the page script.
 */
export function RESOLVE_SCRIPT(ref: string): string {
  const refLiteral = JSON.stringify(ref);
  return (
    "(function(){" +
    "var m=window.__zcodeRefs;" +
    "var el=m&&m.get(" +
    refLiteral +
    ");" +
    "if(!el)return null;" +
    "el.scrollIntoView({block:'center',inline:'center'});" +
    "var b=el.getBoundingClientRect();" +
    "return {cx:Math.round(b.left+b.width/2),cy:Math.round(b.top+b.height/2)};" +
    "})()"
  );
}

/**
 * The script injected by getState to read scroll offsets / viewport size (an IIFE string).
 * Backticks and ${} are off-limits inside the page script; it is built by concatenating quoted strings only.
 */
export const VIEWPORT_SCRIPT =
  "(function(){return {scrollX:Math.round(window.scrollX||window.pageXOffset||0),scrollY:Math.round(window.scrollY||window.pageYOffset||0),innerWidth:window.innerWidth||document.documentElement.clientWidth||0,innerHeight:window.innerHeight||document.documentElement.clientHeight||0};})()";

/**
 * select: sets the selected state of the <select> that ref points at, according to values (matching option.value exactly first, then matching the visible text),
 * and dispatches input+change once a value hits. Returns {ok:true} / {error:'ref_not_found'|'not_select'|'no_match'}.
 * Safety: ref/values are interpolated via JSON.stringify; the page script forbids backticks and ${}.
 */
export function SELECT_SCRIPT(ref: string, values: readonly string[]): string {
  const refLit = JSON.stringify(ref);
  const valsLit = JSON.stringify(values);
  return (
    "(function(){" +
    "var m=window.__zcodeRefs;var el=m&&m.get(" +
    refLit +
    ");" +
    "if(!el)return {error:'ref_not_found'};" +
    "if(!el.tagName||el.tagName.toLowerCase()!=='select')return {error:'not_select'};" +
    "var values=" +
    valsLit +
    ";var matched=false;" +
    "for(var oi=0;oi<el.options.length;oi++){el.options[oi].selected=false;}" +
    "for(var vi=0;vi<values.length;vi++){var want=values[vi];var found=false;" +
    "for(var i=0;i<el.options.length;i++){if(el.options[i].value===want){el.options[i].selected=true;found=true;matched=true;break;}}" +
    "if(!found){for(var j=0;j<el.options.length;j++){if((el.options[j].text||'').trim()===String(want).trim()){el.options[j].selected=true;found=true;matched=true;break;}}}" +
    "}" +
    "if(!matched)return {error:'no_match'};" +
    "el.dispatchEvent(new Event('input',{bubbles:true}));" +
    "el.dispatchEvent(new Event('change',{bubbles:true}));" +
    "return {ok:true};" +
    "})()"
  );
}

/**
 * check: drives the checked state of the checkbox/radio that ref points at to want; when the state has to change it calls el.click() (which natively dispatches click/input/change).
 * Returns {ok:true,checked} / {error:'ref_not_found'|'not_checkable'}.
 */
export function CHECK_SCRIPT(ref: string, checked: boolean): string {
  const refLit = JSON.stringify(ref);
  const wantLit = checked ? "true" : "false";
  return (
    "(function(){" +
    "var m=window.__zcodeRefs;var el=m&&m.get(" +
    refLit +
    ");" +
    "if(!el)return {error:'ref_not_found'};" +
    "var tag=el.tagName?el.tagName.toLowerCase():'';" +
    "var ty=((el.getAttribute&&el.getAttribute('type'))||'').toLowerCase();" +
    "if(tag!=='input'||(ty!=='checkbox'&&ty!=='radio'))return {error:'not_checkable'};" +
    "var want=" +
    wantLit +
    ";if(el.checked!==want){el.click();}" +
    "return {ok:true,checked:el.checked===true};" +
    "})()"
  );
}

/**
 * elementInfo: given a viewport coordinate (x,y), it hits an element with document.elementFromPoint and builds a single element that reuses the snapshot structure.
 * It assigns a ref on the spot (p1,p2,...) and stores it in window.__zcodeRefs, so a later click can use that ref directly. Returns null when nothing is hit.
 * It reuses the very same selector/xpath/role/name construction logic as SNAPSHOT_SCRIPT.
 */
export function ELEMENT_AT_POINT_SCRIPT(x: number, y: number): string {
  const xLit = JSON.stringify(x);
  const yLit = JSON.stringify(y);
  return (
    "(function(){" +
    "var el=document.elementFromPoint(" +
    xLit +
    "," +
    yLit +
    ");" +
    "if(!el||el.nodeType!==1)return null;" +
    "function safeId(id){return /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);}" +
    "function accName(el){var n=el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('placeholder')||'';if(!n){n=(el.innerText||el.textContent||'');}n=(n||'').trim();return n.slice(0,120);}" +
    "function implicitRole(el,tag){if(tag==='a'&&el.getAttribute('href')!=null)return 'link';if(tag==='button')return 'button';if(tag==='select')return 'combobox';if(tag==='textarea')return 'textbox';if(tag==='summary')return 'button';if(tag==='input'){var ty=(el.getAttribute('type')||'text').toLowerCase();if(ty==='checkbox')return 'checkbox';if(ty==='radio')return 'radio';if(ty==='button'||ty==='submit'||ty==='reset')return 'button';if(ty==='search')return 'searchbox';return 'textbox';}return '';}" +
    "function buildSelector(el){if(el.id&&safeId(el.id))return '#'+el.id;var parts=[];var cur=el;var depth=0;while(cur&&cur.nodeType===1&&depth<6){if(cur.id&&safeId(cur.id)){parts.unshift('#'+cur.id);break;}var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+':nth-of-type('+idx+')');cur=cur.parentElement;depth++;}return parts.join(' > ');}" +
    "function xpathOf(el){if(el.id&&safeId(el.id))return \"//*[@id='\"+el.id+\"']\";var parts=[];var cur=el;while(cur&&cur.nodeType===1){var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+'['+idx+']');cur=cur.parentElement;}return '/'+parts.join('/');}" +
    "if(!window.__zcodeRefs){try{window.__zcodeRefs=new Map();}catch(e){window.__zcodeRefs=null;}}" +
    "window.__zcodePtSeq=(window.__zcodePtSeq||0)+1;var ref='p'+window.__zcodePtSeq;" +
    "if(window.__zcodeRefs)window.__zcodeRefs.set(ref,el);" +
    "var vw=window.innerWidth||document.documentElement.clientWidth||0;var vh=window.innerHeight||document.documentElement.clientHeight||0;" +
    "var r=el.getBoundingClientRect();var rect={x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};" +
    "var inViewport=r.top<vh&&r.bottom>0&&r.left<vw&&r.right>0;var tag=el.tagName.toLowerCase();" +
    "var out={ref:ref,tag:tag,selector:buildSelector(el),xpath:xpathOf(el),rect:rect,inViewport:inViewport};" +
    "var role=el.getAttribute('role')||implicitRole(el,tag);if(role)out.role=role;" +
    "var name=accName(el);if(name)out.name=name;" +
    "var text=(el.innerText||'').trim().slice(0,100);if(text)out.text=text;" +
    "if((tag==='input'||tag==='textarea'||tag==='select')&&el.value!=null&&el.value!=='')out.value=String(el.value);" +
    "if(el.disabled===true)out.disabled=true;" +
    "if(tag==='input'&&(el.type==='checkbox'||el.type==='radio'))out.checked=el.checked===true;" +
    "return out;" +
    "})()"
  );
}

/**
 * evaluate: wraps the expression in (function(){ return (EXPR); })() and JSON-serializes the result
 * safely. Serializable → {ok:true,kind:'json',data}; not serializable → {ok:true,kind:'str',data:String(v)};
 * threw → {ok:false,message}. Page scripts forbid backticks and ${}; EXPR is spliced in verbatim
 * (the evaluation semantics are the execution input).
 */
export function EVALUATE_SCRIPT(expression: string): string {
  return (
    "(function(){try{" +
    "var __v=(function(){ return (" +
    expression +
    "\n); })();" +
    "var __s;try{__s=JSON.stringify(__v);}catch(e){__s=undefined;}" +
    "if(typeof __s==='string')return {ok:true,kind:'json',data:__s};" +
    "return {ok:true,kind:'str',data:String(__v)};" +
    "}catch(err){return {ok:false,message:(err&&err.message)?String(err.message):String(err)};}})()"
  );
}
