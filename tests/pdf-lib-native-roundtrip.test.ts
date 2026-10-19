import { describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber } from '@cantoo/pdf-lib';
vi.mock('lib/submodule',()=>({PDFPlusLibSubmodule:class { app:any; plugin:any; constructor(plugin:any){this.plugin=plugin;this.app=plugin.app;} get lib(){return this.plugin.lib;} }}));
vi.mock('utils',()=>({formatAnnotationID:(objectNumber:number,generationNumber:number)=>`${objectNumber}R${generationNumber}`,getBorderRadius:()=>0,hexToRgb:()=>({r:0,g:0,b:0})}));
import { PdfLibIO } from '../src/lib/highlights/write-file/pdf-lib';

describe('native PDF annotation roundtrip',()=>{
  it('creates one Highlight annotation and recolors its C array without duplication',async()=>{
    (globalThis as any).document={body:{}}; (globalThis as any).getComputedStyle=()=>({getPropertyValue:()=> '0px'});
    let bytes:Uint8Array; const initial=await PDFDocument.create(); initial.addPage([200,200]); bytes=await initial.save();
    const file:any={path:'synthetic.pdf'};
    const geometry={mergeRectangles:(...rects:number[][])=>rects[0],rectsToQuadPoints:(rects:number[][])=>{const [x1,y1,x2,y2]=rects[0];return [x1,y2,x2,y2,x1,y1,x2,y1];}};
    const plugin:any={manifest:{name:'Margin AI'},settings:{author:'Reader',writeHighlightToFileOpacity:.2},domManager:{getRgb:(name:string)=>name==='Red'?{r:234,g:82,b:82}:{r:255,g:208,b:0}},lib:{highlight:{geometry},loadPdfLibDocument:async()=>PDFDocument.load(bytes)},app:{vault:{modifyBinary:vi.fn(async(_file:any,next:Uint8Array)=>{bytes=next;})}}};
    const io=new PdfLibIO(plugin);
    const id=await io.addHighlightAnnotation(file,1,[[10,10,40,20]] as any,'Yellow','margin-ai:test');
    let reopened=await PDFDocument.load(bytes); let annots=reopened.getPage(0).node.Annots()!.asArray();
    expect(annots).toHaveLength(1); const created=reopened.context.lookup(annots[0],PDFDict); expect(created.get(PDFName.of('Subtype'))).toEqual(PDFName.of('Highlight'));
    expect((created.get(PDFName.of('QuadPoints')) as PDFArray).asArray()).toHaveLength(8);
    await io.setAnnotationColor(file,1,id,{r:234,g:82,b:82});
    reopened=await PDFDocument.load(bytes); annots=reopened.getPage(0).node.Annots()!.asArray();
    expect(annots).toHaveLength(1);
    const color=reopened.context.lookup(annots[0],PDFDict).get(PDFName.of('C')) as PDFArray;
    expect(color.asArray().map(value=>(value as PDFNumber).asNumber())).toEqual([234/255,82/255,82/255]);
  });

  it('runs the real PdfLibIO guard after serialization and before modifyBinary',async()=>{
    let bytes:Uint8Array; const initial=await PDFDocument.create(); initial.addPage([100,100]); bytes=await initial.save(); const original=bytes;
    const modifyBinary=vi.fn(); const plugin:any={manifest:{name:'Margin AI'},settings:{author:'Reader',writeHighlightToFileOpacity:.2},domManager:{getRgb:()=>({r:255,g:208,b:0})},lib:{highlight:{geometry:{mergeRectangles:(r:number[])=>r,rectsToQuadPoints:()=>[1,2,3,2,1,0,3,0]}},loadPdfLibDocument:async()=>PDFDocument.load(bytes)},app:{vault:{modifyBinary}}};
    const io=new PdfLibIO(plugin);
    await expect(io.addHighlightAnnotation({path:'synthetic.pdf'} as any,1,[[1,0,3,2]] as any,'Yellow','marker',()=>{throw new Error('version conflict');})).rejects.toThrow(/version conflict/);
    expect(modifyBinary).not.toHaveBeenCalled(); expect(bytes).toBe(original);
  });

	it.each([['','Margin'],['Custom reader','Custom reader']])('serializes author %j as %j without changing settings',async(author,expected)=>{
		let bytes:Uint8Array; const initial=await PDFDocument.create(); initial.addPage([100,100]); bytes=await initial.save();
		const plugin:any={manifest:{name:'Margin AI'},settings:{author,writeHighlightToFileOpacity:.2},domManager:{getRgb:()=>({r:255,g:208,b:0})},lib:{highlight:{geometry:{mergeRectangles:(r:number[])=>r,rectsToQuadPoints:()=>[1,2,3,2,1,0,3,0]}},loadPdfLibDocument:async()=>PDFDocument.load(bytes)},app:{vault:{modifyBinary:async(_f:any,next:Uint8Array)=>{bytes=next;}}}};
		await new PdfLibIO(plugin).addHighlightAnnotation({path:'synthetic.pdf'} as any,1,[[1,0,3,2]] as any,'Yellow','marker');
		const reopened=await PDFDocument.load(bytes); const ref=reopened.getPage(0).node.Annots()!.asArray()[0]; const dict=reopened.context.lookup(ref,PDFDict);
		expect((dict.get(PDFName.of('T')) as PDFHexString).decodeText()).toBe(expected); expect(plugin.settings.author).toBe(author);
	});
});
