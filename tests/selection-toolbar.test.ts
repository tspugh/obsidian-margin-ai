import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectionToolbar } from '../src/margin-ai/selection-ui';

describe('selection toolbar lifecycle',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  function setup() {
    class NodeStub { closest(){ return true; } }
    vi.stubGlobal('Element',NodeStub);
    const selection={isCollapsed:false,toString:()=> 'alpha',rangeCount:1,anchorNode:new NodeStub(),getRangeAt:()=>({getBoundingClientRect:()=>({})})};
    vi.stubGlobal('activeWindow',{getSelection:()=>selection});
    let finish!:(value:any)=>void;
    const capture={quote:'alpha',path:'a.md'};
    const controller:any={captureActive:vi.fn(()=>new Promise(resolve=>finish=resolve)),retainedCapture:{current:()=>capture}};
    const toolbar:any=new SelectionToolbar(controller); toolbar.show=vi.fn();
    return {toolbar,controller,selection,finish:(value:any=capture)=>finish(value)};
  }
  it('does not reopen after dismissal during capture',async()=>{
    const {toolbar,finish}=setup(); const updating=toolbar.update(); toolbar.hide(); finish(); await updating;
    expect(toolbar.show).not.toHaveBeenCalled();
  });
  it('observes source selection without replacing the selected conversation capture',async()=>{
    const {toolbar,controller,finish}=setup(); const updating=toolbar.update(); finish(); await updating;
    expect(controller.captureActive).toHaveBeenCalledWith(false,false);
  });
});
