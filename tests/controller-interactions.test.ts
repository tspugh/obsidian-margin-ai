import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ shell: {} }));
vi.mock('../src/margin-ai/chatgpt-client', () => ({ChatGptClient: class {}}));
vi.mock('../src/margin-ai/obsidian-vault', () => ({ObsidianAnnotationVault: class {}}));
vi.mock('../src/margin-ai/vault-context-reader', () => ({ObsidianMarkdownContextReader: class { constructor(private vault:any) {} async listMarkdownPaths(){return this.vault.getMarkdownFiles().map((file:any)=>file.path)} async isSafeMarkdownPath(){return true} async readMarkdown(path:string){return this.vault.read(this.vault.getAbstractFileByPath(path))} }}));
vi.mock('../src/margin-ai/source-highlights', () => ({createMarkdownHighlightExtension() {},createMarkdownSelectionExtension() {}, refreshMarginHighlights:{of(){return {};}}}));
vi.mock('../src/margin-ai/selection-ui', () => ({SelectionToolbar:class {}}));
vi.mock('../src/margin-ai/pdf-source-highlights', () => ({PDFSourceHighlights:class {}}));
import { MarginController } from '../src/margin-ai/controller';
import { TFile } from 'obsidian';
import { captureMarkdown } from '../src/margin-ai/capture-domain';
import { capturePdf } from '../src/margin-ai/capture-domain';
import { createDefaultPersonalization } from '../src/margin-ai/personalization';
function setup() {
  const dispatch=vi.fn();
  const plugin:any={settings:{marginAnnotationFolder:'Annotations'},app:{vault:{},workspace:{getActiveViewOfType:()=>null,getLeavesOfType:()=>[{view:{editor:{cm:{dispatch}}}}]}}};
  const controller=new MarginController(plugin);
	vi.spyOn(controller.personalization, 'load').mockResolvedValue(createDefaultPersonalization());
  controller.capture=captureMarkdown('a.md','alpha',0,5);
  return {controller,plugin,dispatch};
}
describe('controller async identity',()=>{
	it('registers a native highlight-selection command without a preset hotkey', async () => {
		const {controller,plugin}=setup(); const commands:any[]=[];
		Object.assign(plugin,{registerView:vi.fn(),addRibbonIcon:vi.fn(),addChild:vi.fn(value=>value),registerEditorExtension:vi.fn(),addCommand:vi.fn(command=>commands.push(command)),registerEvent:vi.fn()});
		Object.assign(plugin.app.workspace,{on:vi.fn(),getActiveFile:vi.fn(()=>null)}); Object.assign(plugin.app.vault,{on:vi.fn()});
		(controller.chatgpt as any).subscribe=vi.fn();
		vi.spyOn(controller.repository,'recoverInterrupted').mockResolvedValue(undefined); vi.spyOn(controller as any,'onDocumentChanged').mockResolvedValue(undefined);
		await controller.initialize();
		const command=commands.find(item=>item.id==='highlight-margin-selection');
		expect(command).toMatchObject({name:'Highlight selection and start annotation'}); expect(command.hotkeys).toBeUndefined();
	});
	it('does not create a highlight command annotation without a selected passage', async () => {
		const {controller,plugin}=setup(); controller.capture=captureMarkdown('a.md','alpha',0,0);
		controller.retainedCapture.remember(captureMarkdown('a.md','alpha',0,5));
		plugin.app.workspace.getActiveViewOfType=()=>({file:{path:'a.md'},editor:{getValue:()=> 'alpha',getCursor:()=>({line:0,ch:0}),posToOffset:()=>0}});
		plugin.app.workspace.getActiveFile=()=>({path:'a.md',extension:'md'}); vi.stubGlobal('activeWindow',{getSelection:()=>null});
		const create=vi.spyOn(controller.repository,'create');
		expect(await (controller as any).highlightSelectionAndStartAnnotation()).toBe(false); expect(create).not.toHaveBeenCalled();
	});
	it('captures the current Markdown passage for the highlight command', async () => {
		const {controller,plugin}=setup(); plugin.app.workspace.getActiveViewOfType=()=>({file:{path:'note.md'},editor:{getValue:()=> 'zero alpha omega',getCursor:(which:string)=>which==='from'?{line:0,ch:5}:{line:0,ch:10},posToOffset:(pos:any)=>pos.ch}});
		plugin.app.workspace.getActiveFile=()=>({path:'note.md',extension:'md'}); vi.stubGlobal('activeWindow',{getSelection:()=>null});
		const start=vi.spyOn(controller as any,'startAnnotation').mockResolvedValue(true);
		expect(await (controller as any).highlightSelectionAndStartAnnotation()).toBe(true); expect(start).toHaveBeenCalledWith(expect.objectContaining({kind:'markdown',path:'note.md',quote:'alpha'}));
	});
	it('captures the current PDF passage for the highlight command', async () => {
		const {controller,plugin}=setup(); const selection:any={rangeCount:1,toString:()=> 'pdf words'}; vi.stubGlobal('activeWindow',{getSelection:()=>selection});
		plugin.app.workspace.getActiveFile=()=>({path:'paper.pdf',extension:'pdf'}); plugin.lib={getPDFViewerChildFromSelection:()=>({file:{path:'paper.pdf'}}),copyLink:{getPageAndTextRangeFromSelection:()=>({page:3,selection:{beginIndex:1,beginOffset:2,endIndex:3,endOffset:4}})},workspace:{getActivePDFView:()=>null}};
		const start=vi.spyOn(controller as any,'startAnnotation').mockResolvedValue(true);
		expect(await (controller as any).highlightSelectionAndStartAnnotation()).toBe(true); expect(start).toHaveBeenCalledWith(expect.objectContaining({kind:'pdf',path:'paper.pdf',quote:'pdf words',page:3,pdfSelection:[1,2,3,4]}));
	});
	it('focuses the saved annotation composer only after save and open complete', async () => {
		const {controller}=setup(); let finishSave!:(value:boolean)=>void; let finishOpen!:()=>void; const order:string[]=[];
		vi.spyOn(controller,'saveHighlight').mockImplementation(()=>new Promise(resolve=>finishSave=value=>{order.push('save');controller.active={path:'saved.md',annotation:{id:'saved',source:controller.capture,messages:[]}} as any;resolve(value);}));
		vi.spyOn(controller,'open').mockImplementation(()=>new Promise(resolve=>finishOpen=()=>{order.push('open');resolve(true);}));
		(controller as any).view={focusComposer:vi.fn(()=>order.push('focus'))};
		const running=(controller as any).startAnnotation(captureMarkdown('a.md','alpha',0,5)); await Promise.resolve(); expect(order).toEqual([]);
		finishSave(true); while (!finishOpen) await Promise.resolve(); expect(order).toEqual(['save']); finishOpen(); expect(await running).toBe(true); expect(order).toEqual(['save','open','focus']);
	});
	it('cancels deferred annotation focus after navigation to another thread', async () => {
		const {controller}=setup(); const saved:any={path:'one.md',annotation:{id:'one',source:controller.capture,messages:[]}};
		vi.spyOn(controller,'saveHighlight').mockImplementation(async()=>{controller.active=saved;return true;}); let finishOpen!:()=>void; vi.spyOn(controller,'open').mockImplementation(()=>new Promise(resolve=>finishOpen=()=>resolve(true)));
		const focusComposer=vi.fn(); (controller as any).view={focusComposer}; const running=(controller as any).startAnnotation(controller.capture!); await Promise.resolve();
		controller.active={path:'two.md',annotation:{id:'two',source:controller.capture,messages:[]}} as any; finishOpen(); await running; expect(focusComposer).not.toHaveBeenCalled();
	});
	it('does not open or focus a different conversation selected while the annotation is saving', async () => {
		const {controller}=setup(); let finishCreate!:(value:string)=>void;
		vi.spyOn(controller.repository,'create').mockImplementation(()=>new Promise(resolve=>finishCreate=resolve)); vi.spyOn(controller,'refresh').mockResolvedValue();
		const open=vi.spyOn(controller,'open').mockResolvedValue(true); const focusComposer=vi.fn(); (controller as any).view={focusComposer,render:vi.fn()};
		const running=controller.startAnnotation(captureMarkdown('a.md','alpha',0,5)); while (!finishCreate) await Promise.resolve();
		const other:any={path:'other.md',annotation:{id:'other',source:captureMarkdown('a.md','alpha',0,5),messages:[]}}; controller.selectAnnotation(other);
		finishCreate('new.md'); expect(await running).toBe(false); expect(controller.active).toBe(other); expect(open).not.toHaveBeenCalled(); expect(focusComposer).not.toHaveBeenCalled();
	});
	it('does not open or focus after same-source navigation to another leaf while saving', async () => {
		const {controller,plugin}=setup(); const sourceLeaf={id:'source'}; plugin.app.workspace.activeLeaf=sourceLeaf; let finishCreate!:(value:string)=>void;
		vi.spyOn(controller.repository,'create').mockImplementation(()=>new Promise(resolve=>finishCreate=resolve)); vi.spyOn(controller,'refresh').mockResolvedValue();
		const open=vi.spyOn(controller,'open').mockResolvedValue(true); (controller as any).view={focusComposer:vi.fn(),render:vi.fn()};
		const running=controller.startAnnotation(captureMarkdown('a.md','alpha',0,5)); while (!finishCreate) await Promise.resolve(); plugin.app.workspace.activeLeaf={id:'other-same-source'};
		finishCreate('new.md'); expect(await running).toBe(false); expect(open).not.toHaveBeenCalled(); expect((controller as any).view.focusComposer).not.toHaveBeenCalled();
	});
	it('does not reveal a sidebar whose initialization outlives its annotation operation', async () => {
		const {controller,plugin}=setup(); const expected=controller.capture; let finishView!:()=>void; const revealLeaf=vi.fn();
		const leaf={setViewState:vi.fn(()=>new Promise<void>(resolve=>finishView=resolve))}; plugin.app.workspace.getLeavesOfType=()=>[]; plugin.app.workspace.getRightLeaf=()=>leaf; plugin.app.workspace.revealLeaf=revealLeaf;
		const opening=controller.open(false,()=>controller.capture===expected); while (!finishView) await Promise.resolve(); controller.capture=captureMarkdown('b.md','beta',0,4); finishView();
		expect(await opening).toBe(false); expect(revealLeaf).not.toHaveBeenCalled();
	});
	it('does not reveal after same-source leaf navigation during sidebar initialization', async () => {
		const {controller,plugin}=setup(); const sourceLeaf={id:'source'}; plugin.app.workspace.activeLeaf=sourceLeaf; let finishView!:()=>void; const revealLeaf=vi.fn();
		const sidebarLeaf={setViewState:vi.fn(()=>new Promise<void>(resolve=>finishView=resolve))}; plugin.app.workspace.getLeavesOfType=()=>[]; plugin.app.workspace.getRightLeaf=()=>sidebarLeaf; plugin.app.workspace.revealLeaf=revealLeaf;
		const opening=controller.open(false,()=>true,true,sourceLeaf as any); while (!finishView) await Promise.resolve(); plugin.app.workspace.activeLeaf={id:'other-same-source'}; finishView();
		expect(await opening).toBe(false); expect(revealLeaf).not.toHaveBeenCalled();
	});
	it('does not grant final composer focus when the user changes focus during refresh', async () => {
		const {controller,plugin}=setup(); const leaf={}; plugin.app.workspace.getLeavesOfType=()=>[leaf]; plugin.app.workspace.revealLeaf=vi.fn().mockResolvedValue(undefined);
		const first={}; const second={}; vi.stubGlobal('activeWindow',{document:{activeElement:first}}); let finishRefresh!:()=>void; vi.spyOn(controller,'refresh').mockImplementation(()=>new Promise(resolve=>finishRefresh=resolve));
		const opening=controller.open(false,()=>true,true); while (!finishRefresh) await Promise.resolve(); (activeWindow.document as any).activeElement=second; finishRefresh();
		expect(await opening).toBe(false);
	});
	it('loads current approved personalization for every request and keeps pending/disabled memory out', async () => {
		const {controller,plugin}=setup(); const file=Object.assign(new TFile(),{path:'a.md',extension:'md',stat:{mtime:1,size:5}}); plugin.app.vault.getAbstractFileByPath=()=>file;
		const profile=createDefaultPersonalization(); profile.memoryEnabled=true; profile.memories=[{id:'active',text:'I know calculus.',enabled:true,createdAt:'now'},{id:'disabled',text:'SECRET DISABLED',enabled:false,createdAt:'now'}]; profile.pending=[{id:'p',text:'SECRET PENDING',evidenceQuote:'quote',createdAt:'now',source:{annotationPath:'Annotations/a.md',messageId:'u'}}];
		vi.spyOn(controller.personalization,'load').mockResolvedValue(profile); vi.spyOn(controller.repository,'replaceMessage').mockResolvedValue('companion.md'); vi.spyOn(controller.repository,'get').mockResolvedValue(null); vi.spyOn(controller,'refresh').mockResolvedValue();
		const pending:any={id:'pending',role:'assistant',content:'',status:'pending',createdAt:'now',requestContext:{sourcePath:'a.md',scope:{kind:'passage'},model:'gpt-test',companionFolder:'Annotations',excludedFolders:[]}}; const saved:any={path:'companion.md',annotation:{id:'ann',createdAt:'now',source:controller.capture,messages:[{id:'u',role:'user',content:'question',status:'complete',createdAt:'now'},pending]}};
		const respond=vi.fn().mockResolvedValue('answer'); (controller.chatgpt as any).respond=respond; await (controller as any).runRequest(saved,pending,'gpt-test');
		const instructions=respond.mock.calls[0][2]; expect(instructions).toContain('I know calculus.'); expect(instructions).not.toContain('SECRET DISABLED'); expect(instructions).not.toContain('SECRET PENDING');
	});
	it('stops before AI when the personalization file cannot be read safely', async () => {
		const {controller,plugin}=setup(); const file=Object.assign(new TFile(),{path:'a.md',extension:'md',stat:{mtime:1,size:5}}); plugin.app.vault.getAbstractFileByPath=()=>file;
		vi.spyOn(controller.personalization,'load').mockRejectedValue(new Error('profile malformed')); vi.spyOn(controller.repository,'replaceMessage').mockResolvedValue('companion.md'); vi.spyOn(controller,'refresh').mockResolvedValue();
		const pending:any={id:'pending',role:'assistant',content:'',status:'pending',createdAt:'now',requestContext:{sourcePath:'a.md',scope:{kind:'passage'},model:'gpt-test',companionFolder:'Annotations',excludedFolders:[]}}; const saved:any={path:'companion.md',annotation:{id:'ann',createdAt:'now',source:controller.capture,messages:[{id:'u',role:'user',content:'question',status:'complete',createdAt:'now'},pending]}}; const respond=vi.fn(); (controller.chatgpt as any).respond=respond;
		await (controller as any).runRequest(saved,pending,'gpt-test'); expect(respond).not.toHaveBeenCalled(); expect(controller.repository.replaceMessage).toHaveBeenCalledWith('companion.md','ann',expect.objectContaining({status:'error',content:expect.stringContaining('profile malformed')}));
	});
	it('generates pending memory suggestions from bounded complete conversation with verified user evidence', async () => {
		const {controller}=setup(); const profile=createDefaultPersonalization(); profile.suggestionsEnabled=true;
		(controller.models as any)=[{slug:'gpt-5-mini',displayName:'Mini'}]; vi.mocked(controller.personalization.load).mockResolvedValue(profile);
		const mutate=vi.spyOn(controller.personalization,'mutate').mockImplementation(async change=>{ change(profile); return profile; });
		const saved:any={path:'Annotations/thread.md',annotation:{id:'ann',createdAt:'now',source:controller.capture,messages:[{id:'u1',role:'user',content:'Please show the algebra.',status:'complete',createdAt:'now'},{id:'a1',role:'assistant',content:'Certainly.',status:'complete',createdAt:'now'}]}};
		vi.spyOn(controller.repository,'get').mockResolvedValue(saved); (controller.chatgpt as any).respond=vi.fn().mockResolvedValue('[{"text":"Prefers algebra shown.","evidenceQuote":"Please show the algebra."}]');
		await (controller as any).refreshMemorySuggestions(saved.path,saved.annotation.id);
		expect((controller.chatgpt as any).respond).toHaveBeenCalledWith('gpt-5-mini',expect.any(Array),expect.stringContaining('strict JSON'),expect.any(AbortSignal));
		expect(mutate).toHaveBeenCalledOnce(); expect(profile.pending[0]).toMatchObject({text:'Prefers algebra shown.',evidenceQuote:'Please show the algebra.',source:{annotationPath:'Annotations/thread.md',messageId:'u1'}});
	});
	it('cannot persist a late suggestion after generation is disabled', async () => {
		const {controller}=setup(); const profile=createDefaultPersonalization(); profile.suggestionsEnabled=true; (controller.models as any)=[{slug:'gpt-5-mini'}]; vi.mocked(controller.personalization.load).mockResolvedValue(profile);
		const saved:any={path:'Annotations/thread.md',annotation:{id:'ann',createdAt:'now',source:controller.capture,messages:[{id:'u1',role:'user',content:'I prefer examples.',status:'complete',createdAt:'now'},{id:'a1',role:'assistant',content:'Okay.',status:'complete',createdAt:'now'}]}}; vi.spyOn(controller.repository,'get').mockResolvedValue(saved);
		let finish!:(value:string)=>void; (controller.chatgpt as any).respond=vi.fn(()=>new Promise(resolve=>finish=resolve)); const mutate=vi.spyOn(controller.personalization,'mutate').mockImplementation(async change=>{change(profile);return profile;});
		const generating=(controller as any).refreshMemorySuggestions(saved.path,saved.annotation.id); await Promise.resolve(); await Promise.resolve();
		await controller.setMemorySuggestionsEnabled(false); finish('[{"text":"Prefers examples.","evidenceQuote":"I prefer examples."}]'); await generating;
		expect(mutate).toHaveBeenCalledOnce(); expect(profile.suggestionsEnabled).toBe(false); expect(profile.pending).toEqual([]);
	});
	it('aborts suggestion generation on destroy without persisting late output', async () => {
		const {controller}=setup(); const profile=createDefaultPersonalization(); profile.suggestionsEnabled=true; (controller.models as any)=[{slug:'gpt-5-mini'}]; vi.mocked(controller.personalization.load).mockResolvedValue(profile);
		const saved:any={path:'Annotations/thread.md',annotation:{id:'ann',createdAt:'now',source:controller.capture,messages:[{id:'u1',role:'user',content:'I prefer examples.',status:'complete',createdAt:'now'},{id:'a1',role:'assistant',content:'Okay.',status:'complete',createdAt:'now'}]}}; vi.spyOn(controller.repository,'get').mockResolvedValue(saved); const mutate=vi.spyOn(controller.personalization,'mutate');
		let signal!:AbortSignal; let finish!:(value:string)=>void; (controller.chatgpt as any).respond=vi.fn((_m:any,_i:any,_x:any,current:AbortSignal)=>{signal=current;return new Promise(resolve=>finish=resolve);}); (controller.chatgpt as any).cancelSignIn=vi.fn();
		const generating=(controller as any).refreshMemorySuggestions(saved.path,saved.annotation.id); while (!finish) await Promise.resolve(); controller.destroy(); expect(signal.aborted).toBe(true);
		finish('[{"text":"Prefers examples.","evidenceQuote":"I prefer examples."}]'); await generating; expect(mutate).not.toHaveBeenCalled(); expect(profile.pending).toEqual([]);
	});
	it('does not request suggestions when disabled while the completed conversation reloads', async () => {
		const {controller}=setup(); const profile=createDefaultPersonalization(); profile.suggestionsEnabled=true; (controller.models as any)=[{slug:'gpt-5-mini'}]; vi.mocked(controller.personalization.load).mockResolvedValue(profile);
		let finishRead!:(value:any)=>void; vi.spyOn(controller.repository,'get').mockImplementation(()=>new Promise(resolve=>finishRead=resolve)); const respond=vi.fn(); (controller.chatgpt as any).respond=respond; vi.spyOn(controller.personalization,'mutate').mockImplementation(async change=>{change(profile);return profile;});
		const generating=(controller as any).refreshMemorySuggestions('Annotations/thread.md','ann'); while (!finishRead) await Promise.resolve(); await controller.setMemorySuggestionsEnabled(false);
		finishRead({path:'Annotations/thread.md',annotation:{id:'ann',messages:[{id:'u',role:'user',content:'I prefer examples.',status:'complete'},{id:'a',role:'assistant',content:'Okay.',status:'complete'}]}}); await generating;
		expect(respond).not.toHaveBeenCalled();
	});
	it.each(['destroy','signOut'] as const)('does not launch follow-up suggestions when %s occurs during successful-answer persistence', async action => {
		const {controller,plugin}=setup(); const file=Object.assign(new TFile(),{path:'a.md',extension:'md',stat:{mtime:1,size:5}}); plugin.app.vault.getAbstractFileByPath=()=>file;
		const pending:any={id:'pending',role:'assistant',content:'',status:'pending',createdAt:'now',requestContext:{sourcePath:'a.md',scope:{kind:'passage'},model:'gpt-test',companionFolder:'Annotations',excludedFolders:[]}}; const saved:any={path:'companion.md',annotation:{id:'ann',source:controller.capture,messages:[{id:'u',role:'user',content:'q',status:'complete'},pending]}};
		(controller.chatgpt as any).respond=vi.fn().mockResolvedValue('answer'); (controller.chatgpt as any).cancelSignIn=vi.fn(); (controller.chatgpt as any).disconnect=vi.fn().mockResolvedValue({revocationConfirmed:true});
		let finishPersist!:(path:string)=>void; vi.spyOn(controller.repository,'replaceMessage').mockImplementation(()=>new Promise(resolve=>finishPersist=resolve)); vi.spyOn(controller,'refresh').mockResolvedValue(); const suggestions=vi.spyOn(controller as any,'refreshMemorySuggestions');
		const running=(controller as any).runRequest(saved,pending,'gpt-test'); while (!finishPersist) await Promise.resolve();
		if (action === 'destroy') controller.destroy(); else await controller.signOut();
		finishPersist('companion.md'); await running; expect(suggestions).not.toHaveBeenCalled();
	});
	it('does not start a suggestion job after the controller is destroyed', async () => {
		const {controller}=setup(); (controller.chatgpt as any).cancelSignIn=vi.fn(); controller.destroy(); const load=vi.mocked(controller.personalization.load); load.mockClear();
		await (controller as any).refreshMemorySuggestions('Annotations/thread.md','ann'); expect(load).not.toHaveBeenCalled();
	});
  it('retains the selected passage when sidebar focus collapses the editor cursor',async()=>{
    const {controller,plugin}=setup();
    controller.retainedCapture.remember(captureMarkdown('a.md','alpha beta',0,5));
    plugin.app.workspace.getActiveViewOfType=()=>({file:{path:'a.md'},editor:{getValue:()=> 'alpha beta',getCursor:()=>({line:0,ch:5}),posToOffset:()=>5}});
    plugin.app.workspace.getActiveFile=()=>({path:'a.md',extension:'md'});
    await controller.captureActive(false,false);
    expect(controller.retainedCapture.current()?.quote).toBe('alpha');
  });
  it('keeps the open conversation and captured passage on same-document file-open events',async()=>{
    const {controller,plugin}=setup();
    const selected=capturePdf('paper.pdf','selected passage',2,[0,0,0,8]);
    controller.capture=selected; controller.contextScope={kind:'passage'};
    controller.active={path:'companion.md',annotation:{id:'thread',source:selected,messages:[],createdAt:'now'}} as any;
    plugin.app.workspace.getActiveFile=()=>({path:'paper.pdf',extension:'pdf'});
    const capture=vi.spyOn(controller,'captureActive'); const refresh=vi.spyOn(controller,'refresh').mockResolvedValue();
    await (controller as any).onDocumentChanged();
    expect(capture).not.toHaveBeenCalled();
    expect(controller.capture).toEqual(selected);
    expect(controller.contextScope).toEqual({kind:'passage'});
    expect(controller.active?.annotation.id).toBe('thread');
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('recaptures and closes the conversation on deliberate cross-document navigation',async()=>{
    const {controller,plugin}=setup();
    controller.contextScope={kind:'passage'};
    controller.active={path:'companion.md',annotation:{id:'thread',source:controller.capture,messages:[],createdAt:'now'}} as any;
    plugin.app.workspace.getActiveFile=()=>({path:'b.md',extension:'md'});
    vi.spyOn(controller,'captureActive').mockImplementation(async()=>{ controller.capture=captureMarkdown('b.md','beta',0,0); controller.active=null; return controller.capture; });
    vi.spyOn(controller,'refresh').mockResolvedValue();
    await (controller as any).onDocumentChanged();
    expect(controller.capture?.path).toBe('b.md');
    expect(controller.contextScope).toEqual({kind:'document'});
    expect(controller.active).toBeNull();
  });
  it('hydrates the already-open source during startup document handling',async()=>{
    const {controller,plugin}=setup(); controller.capture=null;
    plugin.app.workspace.getActiveFile=()=>({path:'paper.pdf',extension:'pdf'});
    vi.spyOn(controller,'captureActive').mockImplementation(async()=>controller.capture=capturePdf('paper.pdf','',1));
    const refresh=vi.spyOn(controller,'refresh').mockResolvedValue();
    await (controller as any).onDocumentChanged();
    expect((controller.capture as any)?.path).toBe('paper.pdf');
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('discards stale document refreshes',async()=>{
    const {controller,plugin}=setup(); plugin.app.vault.getAbstractFileByPath=()=>new TFile(); plugin.app.vault.read=async()=>'';
    let doneA!:(value:any)=>void;
    vi.spyOn(controller.repository,'listForSource').mockImplementation(path=>path==='a.md'?new Promise(resolve=>doneA=resolve):Promise.resolve([{path:'b-companion',annotation:{id:'b'}}] as any));
    const old=controller.refresh(); await Promise.resolve();
    controller.capture=captureMarkdown('b.md','beta',0,4); await controller.refresh();
    doneA([{path:'a-companion',annotation:{id:'a'}}]); await old;
    expect(controller.annotations[0].annotation.id).toBe('b');
  });
  it('does not discard an open conversation when a same-source listing temporarily omits it',async()=>{
    const {controller,plugin}=setup(); plugin.app.vault.getAbstractFileByPath=()=>null;
    const active={path:'companion.md',annotation:{id:'thread',source:controller.capture,messages:[],createdAt:'now'}} as any;
    controller.active=active; vi.spyOn(controller.repository,'listForSource').mockResolvedValue([]);
    await controller.refresh();
    expect(controller.active).toBe(active);
  });
  it('clears an open conversation when its companion note is explicitly deleted',()=>{
    const {controller}=setup();
    controller.active={path:'Annotations/deleted.md',annotation:{id:'thread',source:controller.capture,messages:[],createdAt:'now'}} as any; controller.annotations=[controller.active!];
    (controller as any).onVaultDelete({path:'Annotations/deleted.md'});
    expect(controller.active).toBeNull();
    expect(controller.annotations).toEqual([]);
  });
  it('response completion does not steal a conversation selected while persistence reloads',async()=>{
    const {controller,plugin}=setup(); const file=Object.assign(new TFile(),{path:'a.md',extension:'md',stat:{mtime:1,size:5}}); plugin.app.vault.getAbstractFileByPath=()=>file; plugin.app.vault.read=async()=> 'alpha';
    const source=captureMarkdown('a.md','alpha',0,5); const pending:any={id:'pending',role:'assistant',content:'Thinking…',status:'pending',createdAt:'now',requestContext:{sourcePath:'a.md',scope:{kind:'passage'},model:'gpt-test',companionFolder:'Annotations',excludedFolders:[]}};
    const saved:any={path:'companion.md',annotation:{id:'old',createdAt:'now',source,messages:[{id:'u',role:'user',content:'question',status:'complete',createdAt:'now'},pending]}};
    controller.active=saved; (controller.chatgpt as any).respond=vi.fn().mockResolvedValue('answer'); vi.spyOn(controller.repository,'replaceMessage').mockResolvedValue('companion.md'); vi.spyOn(controller,'refresh').mockResolvedValue();
    let finish!:(value:any)=>void; vi.spyOn(controller.repository,'get').mockImplementation(()=>new Promise(resolve=>finish=resolve));
    const running=(controller as any).runRequest(saved,pending,'gpt-test'); while (!finish) await Promise.resolve();
    const newer:any={path:'new.md',annotation:{id:'new',source,messages:[],createdAt:'now'}}; controller.active=newer; finish(saved); await running;
    expect(controller.active).toBe(newer);
  });
	it('streams ephemeral deltas only into the still-active matching conversation', async () => {
		const {controller,plugin}=setup(); const file=Object.assign(new TFile(),{path:'a.md',extension:'md',stat:{mtime:1,size:5}}); plugin.app.vault.getAbstractFileByPath=()=>file;
		const source=captureMarkdown('a.md','alpha',0,5); const pending:any={id:'pending',role:'assistant',content:'',status:'pending',createdAt:'now',requestContext:{sourcePath:'a.md',scope:{kind:'passage'},model:'gpt-test',companionFolder:'Annotations',excludedFolders:[]}};
		const saved:any={path:'companion.md',annotation:{id:'ann',createdAt:'now',source,messages:[{id:'u',role:'user',content:'question',status:'complete',createdAt:'now'},pending]}}; controller.active=saved;
		const updateStreamingMessage=vi.fn(); (controller as any).view={updateStreamingMessage,render:vi.fn()};
		let contentWhileAway=''; (controller.chatgpt as any).respond=vi.fn(async (_m:any,_i:any,_x:any,_s:any,onDelta:(delta:string)=>void)=>{onDelta('Hel'); controller.active={path:'other',annotation:{id:'other'}} as any; onDelta('lo'); contentWhileAway=controller.streamingContent('ann','pending')!; return 'Hello';});
		const replace=vi.spyOn(controller.repository,'replaceMessage').mockResolvedValue('companion.md'); vi.spyOn(controller.repository,'get').mockResolvedValue(null); vi.spyOn(controller,'refresh').mockResolvedValue();
		await (controller as any).runRequest(saved,pending,'gpt-test');
		expect(updateStreamingMessage).toHaveBeenCalledTimes(1); expect(updateStreamingMessage).toHaveBeenCalledWith('ann','pending','Hel'); expect(contentWhileAway).toBe('Hello'); expect(controller.streamingContent('ann','pending')).toBeUndefined();
		expect(replace).toHaveBeenCalledTimes(1); expect(replace).toHaveBeenCalledWith('companion.md','ann',expect.objectContaining({status:'complete',content:'Hello'}));
	});
	it('renders a retry as pending before starting its request', async()=>{
		const {controller}=setup(); const failed:any={id:'failed',role:'assistant',content:'bad',status:'error',createdAt:'now'}; controller.active={path:'companion.md',annotation:{id:'ann',source:controller.capture,messages:[failed]}} as any;
		vi.spyOn(controller.repository,'replaceMessage').mockResolvedValue('companion.md'); vi.spyOn(controller.repository,'get').mockImplementation(async()=>controller.active); const run=vi.spyOn(controller as any,'runRequest').mockResolvedValue(undefined); const render=vi.spyOn(controller,'render');
		await controller.retry('failed'); expect(controller.active!.annotation.messages[0]).toMatchObject({status:'pending',content:''}); expect(render.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
	});
	it('lets Stop cancel a retry while pending persistence is still in flight', async()=>{
		const {controller}=setup(); const failed:any={id:'failed',role:'assistant',content:'bad',status:'error',createdAt:'now'}; controller.active={path:'companion.md',annotation:{id:'ann',source:controller.capture,messages:[failed]}} as any;
		let finish!:(value:string)=>void; vi.spyOn(controller.repository,'replaceMessage').mockImplementationOnce(()=>new Promise(resolve=>finish=resolve)).mockResolvedValue('companion.md'); const get=vi.spyOn(controller.repository,'get'); const run=vi.spyOn(controller as any,'runRequest');
		const retrying=controller.retry('failed'); controller.cancel('failed'); finish('companion.md'); await retrying;
		expect(run).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(controller.active!.annotation.messages[0].status).toBe('cancelled');
	});
	it('restores a terminal error UI when retry persistence fails', async()=>{
		const {controller}=setup(); const failed:any={id:'failed',role:'assistant',content:'bad',status:'error',createdAt:'now'}; controller.active={path:'companion.md',annotation:{id:'ann',source:controller.capture,messages:[failed]}} as any;
		vi.spyOn(controller.repository,'replaceMessage').mockRejectedValue(new Error('vault unavailable')); const render=vi.spyOn(controller,'render');
		await controller.retry('failed'); expect(controller.active!.annotation.messages[0]).toMatchObject({status:'error',content:'vault unavailable'}); expect(render).toHaveBeenCalled();
	});
	it('does not commit complete after cancellation wins the final-response race', async()=>{
		const {controller,plugin}=setup(); const file=Object.assign(new TFile(),{path:'a.md',extension:'md',stat:{mtime:1,size:5}}); plugin.app.vault.getAbstractFileByPath=()=>file; const pending:any={id:'pending',role:'assistant',content:'',status:'pending',createdAt:'now',requestContext:{sourcePath:'a.md',scope:{kind:'passage'},model:'gpt-test',companionFolder:'Annotations',excludedFolders:[]}}; const saved:any={path:'companion.md',annotation:{id:'ann',source:controller.capture,messages:[{id:'u',role:'user',content:'q',status:'complete'},pending]}};
		let finish!:(value:string)=>void; (controller.chatgpt as any).respond=()=>new Promise(resolve=>finish=resolve); const replace=vi.spyOn(controller.repository,'replaceMessage').mockResolvedValue('companion.md'); vi.spyOn(controller,'refresh').mockResolvedValue();
		const running=(controller as any).runRequest(saved,pending,'gpt-test'); await Promise.resolve(); controller.cancel('pending'); finish('late answer'); await running;
		expect(replace).not.toHaveBeenCalledWith('companion.md','ann',expect.objectContaining({status:'complete'})); expect(replace).toHaveBeenCalledWith('companion.md','ann',expect.objectContaining({status:'cancelled'}));
	});
  it('save completion does not replace a newer selected thread',async()=>{
    const {controller}=setup(); let done!:(value:string)=>void;
    vi.spyOn(controller.repository,'create').mockImplementation(()=>new Promise(resolve=>done=resolve));
    vi.spyOn(controller,'refresh').mockResolvedValue();
    const saving=controller.saveHighlight(); controller.active={path:'other',annotation:{id:'other'}} as any;
    done('new'); await saving; expect(controller.active?.annotation.id).toBe('other');
  });
  it('saving into an inactive source still adds its marker to the source cache',async()=>{
    const {controller}=setup(); let done!:(value:string)=>void;
    vi.spyOn(controller.repository,'create').mockImplementation(()=>new Promise(resolve=>done=resolve));
    vi.spyOn(controller,'refresh').mockResolvedValue();
    const saving=controller.saveHighlight(); controller.capture=captureMarkdown('b.md','beta',0,4);
    done('new'); await saving;
    expect((controller as any).sourceAnnotations.get('a.md')?.[0].annotation.source.quote).toBe('alpha');
  });
  it('refreshes inactive source editors after saving',async()=>{
    const {controller,plugin,dispatch}=setup(); plugin.app.vault.getAbstractFileByPath=()=>null;
    vi.spyOn(controller.repository,'listForSource').mockResolvedValue([]);
    await controller.refresh(); expect(dispatch).toHaveBeenCalled();
  });
  it('binds the model before asynchronous companion persistence',async()=>{
    const {controller,plugin}=setup(); plugin.settings.marginSelectedModel='original';
    (controller.chatgpt as any).getSession=()=>({sharing:true});
    let done!:(value:any)=>void;
    vi.spyOn(controller as any,'ensureConversation').mockImplementation(()=>new Promise(resolve=>done=resolve));
    const run=vi.spyOn(controller as any,'runRequest').mockResolvedValue(undefined);
    const sending=controller.ask('question'); plugin.settings.marginSelectedModel='later';
    const saved={annotation:{id:'a',source:controller.capture}}; const pending={id:'pending'};
    done({saved,pending}); await sending;
    expect(run).toHaveBeenCalledWith(saved,pending,'original');
  });
  it('freezes document scope and image policy before companion persistence awaits', async () => {
    const {controller,plugin}=setup(); controller.contextScope={kind:'document'}; plugin.settings.marginIncludePdfImages=true; plugin.settings.marginPdfImagePages='2, 7';
    let finish!:(path:string)=>void; vi.spyOn(controller.repository,'create').mockImplementation(()=>new Promise(resolve=>finish=resolve)); vi.spyOn(controller,'refresh').mockResolvedValue();
    const saving=(controller as any).ensureConversation('question',true,'gpt-test');
    controller.contextScope={kind:'passage'}; plugin.settings.marginIncludePdfImages=false; plugin.settings.marginPdfImagePages=''; finish('companion.md');
    vi.spyOn(controller.repository,'get').mockResolvedValue(null as any);
    const {pending}=await saving;
    expect(pending.requestContext).toMatchObject({scope:{kind:'document'},includePdfImages:true,imagePageOverride:'2, 7',model:'gpt-test'});
  });
  it('snapshots selected note paths and configured exclusions before persistence awaits', async () => {
    const {controller,plugin}=setup(); plugin.settings.marginExcludedFolders='Private, Archive'; controller.selectedNotePaths=['Other/chosen.md'];
    let finish!:(path:string)=>void; vi.spyOn(controller.repository,'create').mockImplementation(()=>new Promise(resolve=>finish=resolve)); vi.spyOn(controller,'refresh').mockResolvedValue();
    const saving=(controller as any).ensureConversation('question',true,'gpt-test');
    controller.selectedNotePaths.push('Later.md'); plugin.settings.marginExcludedFolders=''; finish('companion.md');
    const {pending}=await saving;
    expect(pending.requestContext).toMatchObject({selectedNotePaths:['Other/chosen.md'],excludedFolders:['Private','Archive']});
  });
  it('does not call OpenAI when a request is cancelled during document extraction', async () => {
    const {controller,plugin}=setup(); const file=Object.assign(new TFile(),{path:'a.md',extension:'md',stat:{mtime:1,size:5}}); plugin.app.vault.getAbstractFileByPath=()=>file;
    let finishRead!:(text:string)=>void; plugin.app.vault.read=()=>new Promise(resolve=>finishRead=resolve);
    const respond=vi.fn(); (controller.chatgpt as any).respond=respond;
    vi.spyOn(controller.repository,'replaceMessage').mockResolvedValue('companion.md'); vi.spyOn(controller,'refresh').mockResolvedValue();
    const source=captureMarkdown('a.md','alpha',0,5); const pending:any={id:'pending',role:'assistant',content:'Thinking…',status:'pending',createdAt:'now',requestContext:{sourcePath:'a.md',scope:{kind:'document'},model:'gpt-test',companionFolder:'Annotations',excludedFolders:[],includePdfImages:false}};
    const saved:any={path:'companion.md',annotation:{id:'ann',createdAt:'now',source,messages:[{id:'u',role:'user',content:'question',status:'complete',createdAt:'now'},pending]}};
    const running=(controller as any).runRequest(saved,pending,'gpt-test'); await Promise.resolve(); controller.cancel('pending'); finishRead('alpha'); await running;
    expect(respond).not.toHaveBeenCalled();
  });
  it('keeps the open conversation selected after cancelling its response', async () => {
    const {controller,plugin}=setup(); const file=Object.assign(new TFile(),{path:'a.md',extension:'md',stat:{mtime:1,size:5}}); plugin.app.vault.getAbstractFileByPath=()=>file;
    let finishRead!:(text:string)=>void; plugin.app.vault.read=()=>new Promise(resolve=>finishRead=resolve);
    const source=captureMarkdown('a.md','alpha',0,5); const pending:any={id:'pending',role:'assistant',content:'Thinking…',status:'pending',createdAt:'now',requestContext:{sourcePath:'a.md',scope:{kind:'document'},model:'gpt-test',companionFolder:'Annotations',excludedFolders:[],includePdfImages:false}};
    const saved:any={path:'companion.md',annotation:{id:'ann',createdAt:'now',source,messages:[{id:'u',role:'user',content:'question',status:'complete',createdAt:'now'},pending]}}; controller.active=saved;
    vi.spyOn(controller.repository,'replaceMessage').mockResolvedValue('companion.md'); vi.spyOn(controller,'refresh').mockResolvedValue();
    const running=(controller as any).runRequest(saved,pending,'gpt-test'); await Promise.resolve(); controller.cancel('pending'); finishRead('alpha'); await running;
    expect(controller.active).toBe(saved);
  });
  it('sends page-labelled multimodal document input and persists actual coverage', async () => {
    const {controller,plugin}=setup(); const file=Object.assign(new TFile(),{path:'paper.pdf',extension:'pdf',stat:{mtime:7,size:99}}); plugin.app.vault.getAbstractFileByPath=()=>file;
    const source=capturePdf('paper.pdf','anchor',2); const pending:any={id:'pending',role:'assistant',content:'Thinking…',status:'pending',createdAt:'now',requestContext:{sourcePath:'paper.pdf',scope:{kind:'document'},model:'gpt-test',companionFolder:'Annotations',excludedFolders:[],includePdfImages:true,imagePageOverride:'3'}};
    const saved:any={path:'companion.md',annotation:{id:'ann',createdAt:'now',source,messages:[{id:'u',role:'user',content:'Explain figure 1',status:'complete',createdAt:'now'},pending]}};
    vi.spyOn(controller as any,'extractDocument').mockResolvedValue({pages:['one','two','Figure 1 chart'],pageCount:3});
    vi.spyOn(controller as any,'pdfImages').mockResolvedValue([{type:'input_image',image_url:'data:image/jpeg;base64,abc',detail:'auto'}]);
    const replace=vi.spyOn(controller.repository,'replaceMessage').mockResolvedValue('companion.md'); vi.spyOn(controller.repository,'get').mockResolvedValue(null); vi.spyOn(controller,'refresh').mockResolvedValue();
    const respond=vi.fn().mockResolvedValue('answer'); (controller.chatgpt as any).respond=respond;
    await (controller as any).runRequest(saved,pending,'gpt-test');
    const body=respond.mock.calls[0][1]; const blocks=body.find((item:any)=>item.role==='user').content;
    expect(blocks).toEqual(expect.arrayContaining([expect.objectContaining({type:'input_text',text:'PDF source image: page 3'}),expect.objectContaining({type:'input_image',image_url:'data:image/jpeg;base64,abc'})]));
    expect(replace.mock.calls[0][2].requestContext).toMatchObject({actualTextPages:[1,2,3],actualImagePages:[3],partialDocumentCoverage:false});
  });
  it('keeps selected Markdown note excerpts in PDF requests that also include page images', async () => {
    const {controller,plugin}=setup(); const pdf=Object.assign(new TFile(),{path:'paper.pdf',extension:'pdf',stat:{mtime:7,size:99}}); const note=Object.assign(new TFile(),{path:'Notes/chosen.md',extension:'md',stat:{mtime:2,size:20}});
    plugin.app.vault.getAbstractFileByPath=(path:string)=>path===pdf.path?pdf:path===note.path?note:null; plugin.app.vault.getMarkdownFiles=()=>[note]; plugin.app.vault.read=async(file:any)=>file===note?'unrelated chosen note':'';
    const source=capturePdf('paper.pdf','anchor',2); const pending:any={id:'pending',role:'assistant',content:'Thinking…',status:'pending',createdAt:'now',requestContext:{sourcePath:'paper.pdf',scope:{kind:'document'},model:'gpt-test',companionFolder:'Annotations',excludedFolders:[],selectedNotePaths:[note.path],includePdfImages:true,imagePageOverride:'3'}};
    const saved:any={path:'companion.md',annotation:{id:'ann',createdAt:'now',source,messages:[{id:'u',role:'user',content:'Explain figure 1',status:'complete',createdAt:'now'},pending]}};
    vi.spyOn(controller as any,'extractDocument').mockResolvedValue({pages:['one','two','Figure 1 chart'],pageCount:3}); vi.spyOn(controller as any,'pdfImages').mockResolvedValue([{type:'input_image',image_url:'data:image/jpeg;base64,abc',detail:'auto'}]);
    vi.spyOn(controller.repository,'replaceMessage').mockResolvedValue('companion.md'); vi.spyOn(controller.repository,'get').mockResolvedValue(null); vi.spyOn(controller,'refresh').mockResolvedValue(); const respond=vi.fn().mockResolvedValue('answer'); (controller.chatgpt as any).respond=respond;
    await (controller as any).runRequest(saved,pending,'gpt-test');
    const blocks=respond.mock.calls[0][1].find((item:any)=>item.role==='user').content;
    expect(blocks[0].text).toContain('<note_excerpt path="Notes/chosen.md">'); expect(blocks[0].text).toContain('unrelated chosen note'); expect(blocks.some((item:any)=>item.type==='input_image')).toBe(true);
  });
  it('prevents a stale automatic summary job from persisting after a newer job starts', async () => {
    const {controller,plugin}=setup(); plugin.settings.marginAutoSummary=true; plugin.settings.marginSummaryModel=''; controller.models=[{slug:'gpt-mini',displayName:'Mini'} as any];
    const source=captureMarkdown('a.md','alpha',0,5); const saved:any={path:'companion.md',annotation:{id:'ann',createdAt:'now',source,messages:[{id:'u',role:'user',content:'question',status:'complete',createdAt:'now'}]}};
    vi.spyOn(controller.repository,'get').mockResolvedValue(saved); const mutate=vi.spyOn(controller.repository,'mutate').mockResolvedValue(undefined); vi.spyOn(controller,'refresh').mockResolvedValue();
    let finishOld!:(value:string)=>void; const respond=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>finishOld=resolve)).mockResolvedValueOnce('TITLE: New\nSUMMARY: New summary.'); (controller.chatgpt as any).respond=respond;
    const old=(controller as any).refreshSummary('companion.md','ann'); await Promise.resolve(); await Promise.resolve();
    const newer=(controller as any).refreshSummary('companion.md','ann'); await newer; finishOld('TITLE: Old\nSUMMARY: Old summary.'); await old;
    expect(mutate).toHaveBeenCalledTimes(1);
  });
  it('registers summary identity before repository reads can race', async () => {
    const {controller,plugin}=setup(); plugin.settings.marginAutoSummary=true; plugin.settings.marginSummaryModel=''; controller.models=[{slug:'gpt-mini',displayName:'Mini'} as any];
    const source=captureMarkdown('a.md','alpha',0,5); const saved:any={path:'companion.md',annotation:{id:'ann',createdAt:'now',source,messages:[{id:'u',role:'user',content:'newest',status:'complete',createdAt:'now'}]}};
    let finishOldGet!:(value:any)=>void; vi.spyOn(controller.repository,'get').mockImplementationOnce(()=>new Promise(resolve=>finishOldGet=resolve)).mockResolvedValueOnce(saved);
    const mutate=vi.spyOn(controller.repository,'mutate').mockResolvedValue(undefined); vi.spyOn(controller,'refresh').mockResolvedValue(); const respond=vi.fn().mockResolvedValue('TITLE: New\nSUMMARY: Current.'); (controller.chatgpt as any).respond=respond;
    const old=(controller as any).refreshSummary('companion.md','ann'); const newer=(controller as any).refreshSummary('companion.md','ann'); await newer; finishOldGet(saved); await old;
    expect(respond).toHaveBeenCalledTimes(1); expect(mutate).toHaveBeenCalledTimes(1);
  });
  it('aborts an automatic summary when the setting is disabled midflight', async () => {
    const {controller,plugin}=setup(); plugin.settings.marginAutoSummary=true; plugin.settings.marginSummaryModel=''; plugin.saveSettings=vi.fn(); controller.models=[{slug:'gpt-mini',displayName:'Mini'} as any];
    const source=captureMarkdown('a.md','alpha',0,5); const saved:any={path:'companion.md',annotation:{id:'ann',createdAt:'now',source,messages:[{id:'u',role:'user',content:'q',status:'complete',createdAt:'now'}]}};
    vi.spyOn(controller.repository,'get').mockResolvedValue(saved); const mutate=vi.spyOn(controller.repository,'mutate').mockResolvedValue(undefined); vi.spyOn(controller,'refresh').mockResolvedValue(); let finish!:(value:string)=>void; (controller.chatgpt as any).respond=()=>new Promise(resolve=>finish=resolve);
    const running=(controller as any).refreshSummary('companion.md','ann'); await Promise.resolve(); await Promise.resolve(); await controller.setAutoSummary(false); finish('TITLE: Old\nSUMMARY: Old.'); await running;
    expect(mutate).not.toHaveBeenCalled();
  });
});
