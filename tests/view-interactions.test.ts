import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', () => ({
  Component: class {}, ItemView: class {}, MarkdownRenderer: {render: vi.fn(async()=>{})}, finishRenderMath: vi.fn(), setIcon: vi.fn(), WorkspaceLeaf: class {}, TFile: class {}, FuzzySuggestModal: class {app:any; constructor(app:any){this.app=app;} setPlaceholder(){return this;} open(){}},
  Menu: class { static last:any; items:any[]=[]; event:any; position:any; constructor(){(this.constructor as any).last=this;} addItem(configure:any){const item:any={setTitle(title:string){this.title=title;return this;},setIcon(icon:string){this.icon=icon;return this;},setChecked(checked:boolean){this.checked=checked;return this;},onClick(fn:Function){this.click=fn;return this;}};configure(item);this.items.push(item);return this;} addSeparator(){return this;} showAtMouseEvent(event:any){this.event=event;} showAtPosition(position:any){this.position=position;} },
}));
vi.mock('../src/margin-ai/message-format', () => ({ normalizeMathDelimiters: (value:string) => value }));
import { MarginView } from '../src/margin-ai/view';
import { MarkdownNotePickerModal } from '../src/margin-ai/context-note-picker';
import { Menu, setIcon } from 'obsidian';

class ElementStub {
  children: ElementStub[] = []; handlers: Record<string, Function> = {}; attrs:Record<string,string>={}; value = ''; text = ''; label = ''; tag = ''; title = ''; disabled = false; nestedInteractive=false; open=false; focused=false; selectionStart=0; selectionEnd=0;
  createEl(tag: string, options: any = {}) { const child = new ElementStub(); child.tag = tag; child.text = options.text; child.attrs=options.attr??{}; child.label = options.attr?.['aria-label']; child.title = options.attr?.title ?? ''; this.children.push(child); return child; }
  createDiv(options: any = {}) { return this.createEl('div', options); }
  createSpan(options: any = {}) { return this.createEl('span', options); }
	empty() { this.children=[]; }
	addClass() {}
  addEventListener(event: string, handler: Function) { this.handlers[event] = handler; }
  closest() { return this.nestedInteractive ? this : null; }
  querySelector(selector:string) { return selector==='summary' ? this.children.find(child=>child.tag==='summary') ?? null : null; }
  setText(text: string) { this.text = text; }
  all(): ElementStub[] { return [this, ...this.children.flatMap(c => c.all())]; }
  focus() { this.focused=true; (globalThis as any).document.activeElement=this; }
	setSelectionRange(start:number,end:number) { this.selectionStart=start; this.selectionEnd=end; }
  getBoundingClientRect() { return {left:12,bottom:34}; }
}
Object.defineProperty(globalThis,'Element',{configurable:true,value:ElementStub});
Object.defineProperty(globalThis,'document',{configurable:true,value:{activeElement:null}});
class KeyboardEventStub {
  preventDefault=vi.fn(); shiftKey=false; isComposing=false; keyCode=0; repeat=false;
  constructor(public key:string, public target:any, public currentTarget:any, init:Partial<KeyboardEventStub>={}) { Object.assign(this,init); }
}
Object.defineProperty(globalThis,'KeyboardEvent',{configurable:true,value:KeyboardEventStub});
function setup() {
  const controller: any = { capture: { kind: 'markdown', path: 'folder/a.md', quote: 'alpha', startOffset: 0, endOffset: 5, scopeLabel:'Lines 1–2' }, contextScope: {kind:'passage'}, active: {path:'annotation.md',annotation:{id:'a',source:{kind:'markdown',path:'folder/a.md',quote:'alpha',scopeLabel:'Lines 1–2'},messages:[]}}, models: [], plugin: {settings:{}}, chatgpt: {getSession:()=>({sharing:true})} };
  const view: any = new MarginView({} as any, controller); view.app={}; view.markdownRoot={}; const root = new ElementStub();
  view.compose(root); view.composer.value = 'original';
  return {view, controller, root};
}
describe('sidebar interactions', () => {
	it('opens the compact style menu and routes Add new style to settings', () => {
		const {controller,root}=setup(); const scrollToHeading=vi.fn(); controller.plugin.openSettingTab=vi.fn(()=>({scrollToHeading}));
		const button=root.all().find(el=>(el.label ?? '').startsWith('Output style:'))!; button.handlers.click({detail:1});
		const menu=(Menu as any).last; expect(menu.items.map((item:any)=>item.title)).toEqual(['Concise','Mathematical detail','Add new style…']); expect(menu.items[0].checked).toBe(true);
		menu.items[2].click(); expect(controller.plugin.openSettingTab).toHaveBeenCalled(); expect(scrollToHeading).toHaveBeenCalledWith('margin-memory-styles');
	});
  it('sends the composer draft with Enter', async () => {
    const {view,controller,root}=setup(); controller.ask=vi.fn(async()=>true); const composer=root.all().find(el=>el.tag==='textarea')!;
    const event=new KeyboardEventStub('Enter',composer,composer); await composer.handlers.keydown(event);
    expect(event.preventDefault).toHaveBeenCalled(); expect(controller.ask).toHaveBeenCalledWith('original'); expect(composer.value).toBe('');
  });
  it('leaves Shift+Enter as a native composer newline', () => {
    const {controller,root}=setup(); controller.ask=vi.fn(); const composer=root.all().find(el=>el.tag==='textarea')!;
    const event=new KeyboardEventStub('Enter',composer,composer,{shiftKey:true}); composer.handlers.keydown(event);
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(controller.ask).not.toHaveBeenCalled();
  });
  it.each([{isComposing:true},{keyCode:229}])('leaves composition Enter events untouched: %j', (init) => {
    const {controller,root}=setup(); controller.ask=vi.fn(); const composer=root.all().find(el=>el.tag==='textarea')!;
    const event=new KeyboardEventStub('Enter',composer,composer,init); composer.handlers.keydown(event);
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(controller.ask).not.toHaveBeenCalled();
  });
  it('suppresses repeated plain Enter without sending again', () => {
    const {controller,root}=setup(); controller.ask=vi.fn(); const composer=root.all().find(el=>el.tag==='textarea')!;
    const event=new KeyboardEventStub('Enter',composer,composer,{repeat:true}); composer.handlers.keydown(event);
    expect(event.preventDefault).toHaveBeenCalled(); expect(controller.ask).not.toHaveBeenCalled();
  });
  it('does not send an empty or disconnected composer draft', () => {
    const {view,controller,root}=setup(); controller.ask=vi.fn(); const composer=root.all().find(el=>el.tag==='textarea')!;
    composer.value='   '; const emptyEvent=new KeyboardEventStub('Enter',composer,composer); composer.handlers.keydown(emptyEvent);
    controller.chatgpt.getSession=()=>({sharing:false}); composer.value='kept\nexactly'; const disconnectedEvent=new KeyboardEventStub('Enter',composer,composer); composer.handlers.keydown(disconnectedEvent);
    expect(emptyEvent.preventDefault).toHaveBeenCalled(); expect(disconnectedEvent.preventDefault).toHaveBeenCalled();
    expect(controller.ask).not.toHaveBeenCalled(); expect(composer.value).toBe('kept\nexactly');
  });
  it('allows only one pending send for the same draft and preserves it on failure', async () => {
    const {view,controller,root}=setup(); let done!:(value:boolean)=>void; controller.ask=vi.fn(()=>new Promise<boolean>(resolve=>{done=resolve;})); const composer=root.all().find(el=>el.tag==='textarea')!;
    const first=composer.handlers.keydown(new KeyboardEventStub('Enter',composer,composer)); const second=composer.handlers.keydown(new KeyboardEventStub('Enter',composer,composer));
    expect(controller.ask).toHaveBeenCalledTimes(1); done(false); await first; await second;
    expect(composer.value).toBe('original'); expect(view.drafts.get(view.draftKey)).toBe('original');
  });
  it('advertises the composer keyboard shortcut without adding another control', () => {
    const {root}=setup(); const composer=root.all().find(el=>el.tag==='textarea')!;
    expect(composer.title).toContain('Enter to send'); expect(composer.title).toContain('Shift+Enter');
  });
	it('preserves composer focus and caret across a same-thread rerender', () => {
		const {view,root}=setup(); const before=root.all().find(el=>el.tag==='textarea')!; before.focus(); before.selectionStart=2; before.selectionEnd=5;
		const next=new ElementStub(); view.contentEl=next; view.markdownRoot=null; view.addChild=vi.fn(); view.removeChild=vi.fn(); view.render();
		const after=next.all().find(el=>el.tag==='textarea')!; expect((globalThis as any).document.activeElement).toBe(after); expect([after.selectionStart,after.selectionEnd]).toEqual([2,5]);
	});
	it('does not steal external focus during a same-thread rerender', () => {
		const {view}=setup(); const external=new ElementStub(); (globalThis as any).document.activeElement=external;
		const next=new ElementStub(); view.contentEl=next; view.markdownRoot=null; view.addChild=vi.fn(); view.removeChild=vi.fn(); view.render();
		expect((globalThis as any).document.activeElement).toBe(external); expect(next.all().find(el=>el.tag==='textarea')!.focused).toBe(false);
	});
  it('uses an octagonal Stop response control to cancel a pending response', () => {
    const {view,controller}=setup(); controller.cancel=vi.fn(); const root=new ElementStub();
    view.message(root,{id:'pending-message',role:'assistant',status:'pending',content:''});
    const stop=root.all().find(el=>el.label==='Stop response');
    expect(stop).toBeDefined();
    expect(setIcon).toHaveBeenCalledWith(stop,'octagon');
    expect(stop!.title).toBe('Stop response');
    stop!.handlers.click(); expect(controller.cancel).toHaveBeenCalledWith('pending-message');
  });
  it('updates only a matching pending message body without rebuilding the view', () => {
		const {view,controller}=setup(); const root=new ElementStub(); view.message(root,{id:'pending-message',role:'assistant',status:'pending',content:''});
		const render=vi.spyOn(view,'render');
		expect(view.updateStreamingMessage('a','pending-message','Hello')).toBe(true);
		expect(root.all().find(el=>el.attrs['data-margin-message-body']==='pending-message')?.text).toBe('Hello'); expect(render).not.toHaveBeenCalled();
		controller.active={path:'other',annotation:{id:'b'}};
		expect(view.updateStreamingMessage('a','pending-message','wrong')).toBe(false);
	});
  it('offers reconnect beside the composer when AI is signed out', () => {
    const {view,controller}=setup(); controller.chatgpt.getSession=()=>({status:'disconnected',sharing:false}); controller.signIn=vi.fn();
    const root=new ElementStub(); view.compose(root);
    const connect=root.all().find(el=>el.text==='Connect ChatGPT to send');
    expect(connect).toBeDefined(); connect!.handlers.click(); expect(controller.signIn).toHaveBeenCalled();
  });
	it('shows the generation indicator only while a response is pending', () => {
		const {view}=setup(); const pending=new ElementStub(); view.message(pending,{id:'p',role:'assistant',status:'pending',content:'Part'}); expect(pending.all().find(el=>el.label==='Generating response')).toBeDefined();
		const complete=new ElementStub(); view.message(complete,{id:'p',role:'assistant',status:'complete',content:'Done'}); expect(complete.all().find(el=>el.label==='Generating response')).toBeUndefined();
		const error=new ElementStub(); view.message(error,{id:'p',role:'assistant',status:'error',content:'Failed'}); expect(error.all().find(el=>el.label==='Generating response')).toBeUndefined();
	});
	it('restores ephemeral streamed content after an unrelated rerender', () => {
		const {view,controller}=setup(); controller.streamingContent=vi.fn(()=> 'Partial answer'); const root=new ElementStub(); view.message(root,{id:'p',role:'assistant',status:'pending',content:''});
		expect(root.all().find(el=>el.attrs['data-margin-message-body']==='p')?.text).toBe('Partial answer');
	});
  for (const [label, method] of [['Comment','saveComment'], ['Send to ChatGPT','ask']]) {
    it(`${label} completion preserves a different conversation draft`, async () => {
      const {view,controller,root} = setup(); let done!: (value:boolean)=>void;
      controller[method] = () => new Promise<boolean>(resolve => { done=resolve; });
      const running = root.all().find(el => el.text===label || el.label===label)!.handlers.click();
      view.draftKey='b'; view.composer=new ElementStub(); view.composer.value='destination'; view.drafts.set('b','destination');
      done(true); await running; await Promise.resolve();
      expect(view.composer.value).toBe('destination'); expect(view.drafts.get('b')).toBe('destination');
    });
  }
  it('plus opens the composer from highlights mode', () => {
    const {view,controller}=setup(); controller.active=null; controller.startNew=vi.fn();
    view.focusComposer=vi.fn(); const root=new ElementStub(); view.header(root);
    root.all().find(el=>el.label==='New from retained source selection')!.handlers.click();
    expect(view.mode).toBe('ask'); expect(controller.startNew).toHaveBeenCalled();
  });
  it('annotate uses retained capture instead of recapturing sidebar focus', async () => {
    const {view,controller}=setup(); controller.annotations=[]; controller.captureActive=vi.fn(async()=>null); controller.annotateRetainedSelection=vi.fn();
    const root=new ElementStub(); view.highlights(root);
    await root.all().find(el=>el.text==='Annotate selection')!.handlers.click();
    expect(controller.annotateRetainedSelection).toHaveBeenCalled(); expect(controller.captureActive).not.toHaveBeenCalled();
  });
  it('opens a conversation from the whole card without a separate Open button', () => {
    const {view,controller}=setup(); controller.active=null; controller.annotations=[{path:'ann.md',annotation:{id:'one',createdAt:'now',source:controller.capture,messages:[]}}]; controller.selectAnnotation=vi.fn(); controller.retainedCapture={current:()=>null};
    const root=new ElementStub(); view.highlights(root);
    const card=root.all().find(el=>el.attrs.role==='button')!;
    expect(card.attrs.tabindex).toBe('0');
    expect(root.all().some(el=>el.text==='Open conversation')).toBe(false);
    card.handlers.click({target:card,currentTarget:card});
    expect(controller.selectAnnotation).toHaveBeenCalledWith(controller.annotations[0]);
  });
  it.each(['Enter',' '])('opens a focused conversation card with %j', (key) => {
    const {view,controller}=setup(); controller.active=null; controller.annotations=[{path:'ann.md',annotation:{id:'one',createdAt:'now',source:controller.capture,messages:[]}}]; controller.selectAnnotation=vi.fn(); controller.retainedCapture={current:()=>null};
    const root=new ElementStub(); view.highlights(root); const card=root.all().find(el=>el.attrs.role==='button')!; const event=new KeyboardEventStub(key,card,card);
    card.handlers.keydown(event); expect(event.preventDefault).toHaveBeenCalled(); expect(controller.selectAnnotation).toHaveBeenCalledWith(controller.annotations[0]);
  });
  it('does not open a card from nested controls or while selecting text', () => {
    const {view,controller}=setup(); controller.active=null; controller.annotations=[{path:'ann.md',annotation:{id:'one',createdAt:'now',source:controller.capture,messages:[]}}]; controller.selectAnnotation=vi.fn(); controller.retainedCapture={current:()=>null};
    const root=new ElementStub(); view.highlights(root); const card=root.all().find(el=>el.attrs.role==='button')!; const nested=new ElementStub(); nested.nestedInteractive=true;
    Object.defineProperty(globalThis,'window',{configurable:true,value:{getSelection:()=>({toString:()=>''})}}); card.handlers.click({target:nested,currentTarget:card}); expect(controller.selectAnnotation).not.toHaveBeenCalled();
    Object.defineProperty(globalThis,'window',{configurable:true,value:{getSelection:()=>({toString:()=> 'selected words'})}}); card.handlers.click({target:card,currentTarget:card}); expect(controller.selectAnnotation).not.toHaveBeenCalled();
  });
  it('enables folder and vault scopes and renders removable selected-note chips', () => {
    const {view,controller}=setup(); controller.selectedNotePaths=['Other/chosen.md']; controller.detachNote=vi.fn(); controller.plugin.settings={marginAnnotationFolder:'Annotations',marginExcludedFolders:''}; view.app={vault:{getMarkdownFiles:()=>[]}};
    const root=new ElementStub(); view.renderScope(root); const folder=root.all().find(el=>el.tag==='option'&&el.text==='Folder'); const vault=root.all().find(el=>el.tag==='option'&&el.text==='Entire vault');
    expect(folder?.disabled).toBe(false); expect(vault?.disabled).toBe(false); root.all().find(el=>el.label==='Remove Other/chosen.md')!.handlers.click(); expect(controller.detachNote).toHaveBeenCalledWith('Other/chosen.md');
  });
  it('keeps context collapsed while summarizing its selected scope', () => {
    const {view,controller}=setup(); controller.contextScope={kind:'folder',ancestorDepth:0}; controller.selectedNotePaths=['Other/chosen.md']; controller.plugin.settings={marginAnnotationFolder:'Annotations',marginExcludedFolders:''}; view.app={vault:{getMarkdownFiles:()=>[]}};
    const root=new ElementStub(); view.compose(root); const context=root.all().find(el=>el.label==='Context and sharing')!;
    expect(context.open).toBe(false); expect(context.children[0].text).toContain('Current folder'); expect(context.children[0].text).toContain('1 note');
    expect(root.all().find(el=>el.label==='Remove Other/chosen.md')).toBeDefined();
  });
  it('preserves an opened context across rerenders but closes a new context', () => {
    const {view,controller}=setup(); const first=new ElementStub(); view.compose(first);
    const opened=first.all().find(el=>el.label==='Context and sharing')!; opened.open=true; opened.handlers.toggle();
    const rerendered=new ElementStub(); view.compose(rerendered);
    expect(rerendered.all().find(el=>el.label==='Context and sharing')!.open).toBe(true);
    controller.capture={...controller.capture,path:'folder/b.md'}; controller.active=null;
    const next=new ElementStub(); view.compose(next);
    expect(next.all().find(el=>el.label==='Context and sharing')!.open).toBe(false);
  });
  it('uses named, bounded folder ancestor choices instead of an unlabeled number', () => {
    const {view,controller}=setup(); controller.contextScope={kind:'folder',ancestorDepth:0}; controller.selectedNotePaths=[]; controller.plugin.settings={marginAnnotationFolder:'Annotations',marginExcludedFolders:''}; view.app={vault:{getMarkdownFiles:()=>[]}};
    const root=new ElementStub(); view.renderScope(root);
    expect(root.all().some(el=>el.tag==='input'&&el.attrs.type==='number')).toBe(false);
    const ancestor=root.all().find(el=>el.label==='Folder boundary')!;
    expect(ancestor.children.map(el=>el.text)).toEqual(['Current folder · folder','1 folder up · Vault root']);
  });
  it('opens a plus menu for note attachment, context controls, and suggestions', () => {
    const {root}=setup(); const plus=root.all().find(el=>el.label==='Composer options')!; plus.handlers.click({type:'click'});
    expect((Menu as any).last.items.map((item:any)=>item.title)).toEqual(['Attach note…','Context & sharing','Suggestions']);
  });
  it('anchors a keyboard-opened plus menu and focuses the context summary', () => {
    const {root}=setup(); const plus=root.all().find(el=>el.label==='Composer options')!; plus.handlers.click({type:'click',detail:0});
    const menu=(Menu as any).last; expect(menu.position).toEqual({x:12,y:34});
    menu.items.find((item:any)=>item.title==='Context & sharing').click();
    const context=root.all().find(el=>el.label==='Context and sharing')!;
    expect(context.open).toBe(true); expect(context.children[0].focused).toBe(true);
    menu.items.find((item:any)=>item.title==='Suggestions').click();
    const suggestions=root.all().find(el=>el.label==='Suggested prompts')!;
    expect(suggestions.open).toBe(true); expect(suggestions.children[0].focused).toBe(true);
  });
  it('keeps document extraction errors visible outside collapsed context', () => {
    const {view,controller}=setup(); controller.documentStatus={state:'error',detail:'OCR failed'};
    const root=new ElementStub(); view.compose(root); const context=root.all().find(el=>el.label==='Context and sharing')!;
    expect(context.all().some(el=>el.text==='Document extraction error: OCR failed')).toBe(false);
    expect(root.all().some(el=>el.text==='Document extraction error: OCR failed')).toBe(true);
  });
  it('shows one concise neutral on-Send sharing disclosure', () => {
    const {view,controller}=setup(); controller.contextScope={kind:'vault'}; controller.selectedNotePaths=[]; controller.plugin.settings={marginAnnotationFolder:'Annotations',marginExcludedFolders:''}; view.app={vault:{getMarkdownFiles:()=>[]}};
    const root=new ElementStub(); view.compose(root); const disclosures=root.all().filter(el=>el.text?.startsWith('On Send,'));
    expect(disclosures).toHaveLength(1); expect(disclosures[0].attrs['data-tone']).toBe('neutral');
  });
  it('keeps request coverage in collapsed diagnostics and PDF image policy out of the sidebar', () => {
    const {view,controller}=setup(); controller.requestCoverage='Text: all pages. Images: page 2.'; controller.selectedNotePaths=[]; controller.plugin.settings={marginAnnotationFolder:'Annotations',marginExcludedFolders:''}; view.app={vault:{getMarkdownFiles:()=>[]}};
    const root=new ElementStub(); view.renderScope(root);
    expect(root.all().find(el=>el.text==='Last request diagnostics')?.tag).toBe('summary'); expect(root.all().some(el=>el.label==='Include PDF page images'||el.label==='PDF image pages')).toBe(false);
  });
  it('keeps source text selectable and provides a separate open-source action', () => {
    const {view,controller}=setup(); controller.navigate=vi.fn(); const root=new ElementStub(); view.thread(root);
    const source=root.all().find(el=>el.label==='Source excerpt')!;
    expect(source.tag).toBe('details');
    expect(source.title).toBe('folder/a.md');
    const open=root.all().find(el=>el.label==='Open source')!;
    expect(open.tag).toBe('button'); open.handlers.click(); expect(controller.navigate).toHaveBeenCalledWith(controller.active);
  });
	it('keeps summaries quietly collapsed with a stable label and preserves disclosure state', () => {
		const {view,controller}=setup(); controller.active.annotation.summary={title:'Generated title',text:'Short recap'}; const first=new ElementStub(); view.thread(first);
		const summary=first.all().find(el=>el.label==='Conversation summary')!; expect(summary.open).toBe(false); expect(summary.children[0].text).toBe('Summary');
		summary.open=true; summary.handlers.toggle(); const second=new ElementStub(); view.thread(second); expect(second.all().find(el=>el.label==='Conversation summary')!.open).toBe(true);
	});
  it('puts suggestions and sharing scope information in collapsible details', () => {
    const {view}=setup(); const root=new ElementStub(); view.compose(root);
    expect(root.all().find(el=>el.label==='Suggested prompts')?.tag).toBe('details');
    expect(root.all().find(el=>el.label==='Context and sharing')?.tag).toBe('details');
  });
  it('copies the original response content', async () => {
    const {view}=setup(); const writeText=vi.fn(async()=>{}); Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText}}});
    const root=new ElementStub(); const message={id:'m',role:'assistant',status:'complete',content:'original $x$'}; view.message(root,message);
    await root.all().find(el=>el.label==='Copy response')!.handlers.click();
    expect(writeText).toHaveBeenCalledWith('original $x$');
    expect(root.all().some(el=>el.text==='Copied')).toBe(true);
  });
  it('shows a visible error when copying a response fails', async () => {
    const {view}=setup(); Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:vi.fn(async()=>{throw new Error('denied')})}}});
    const root=new ElementStub(); view.message(root,{id:'m',role:'assistant',status:'complete',content:'answer'});
    await root.all().find(el=>el.label==='Copy response')!.handlers.click();
    expect(root.all().some(el=>el.text==='Could not copy response.')).toBe(true);
  });
});

describe('Markdown note picker boundaries',()=>{
  it('filters the source, hidden, companion, and configured excluded notes',()=>{
    const files=['A/source.md','A/ok.md','A/.hidden.md','Annotations/thread.md','Private/no.md'].map(path=>({path})); const choose=vi.fn();
    const picker=new MarkdownNotePickerModal({vault:{getMarkdownFiles:()=>files}} as any,'A/source.md','Annotations',['Private'],choose);
    expect(picker.getItems().map(file=>file.path)).toEqual(['A/ok.md']); picker.onChooseItem(files[1] as any); expect(choose).toHaveBeenCalledWith('A/ok.md');
  });
});
