import { describe, expect, it, vi } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
vi.mock('obsidian', async () => {
  const { StateField } = await import('@codemirror/state');
  return { editorInfoField: StateField.define({create:()=>({file:{path:'Reading/n.md'}}),update:value=>value}) };
});
import { editorInfoField } from 'obsidian';
import { createMarkdownSelectionExtension } from '../src/margin-ai/source-highlights';

describe('native editor selection capture',()=>{
  it('captures exact editor offsets without a DOM selection event',()=>{
    const capture=vi.fn();
    const state=EditorState.create({doc:'alpha beta',selection:EditorSelection.single(6,10),extensions:[editorInfoField,createMarkdownSelectionExtension(capture)]});
    for(const listener of state.facet(EditorView.updateListener)) listener({state,view:{},selectionSet:true,docChanged:false} as any);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({path:'Reading/n.md',quote:'beta',startOffset:6,endOffset:10}),expect.anything());
  });
  it('does not replace retained selection with a collapsed cursor',()=>{
    const capture=vi.fn();
    const state=EditorState.create({doc:'alpha beta',selection:EditorSelection.single(6),extensions:[editorInfoField,createMarkdownSelectionExtension(capture)]});
    for(const listener of state.facet(EditorView.updateListener)) listener({state,selectionSet:true,docChanged:false} as any);
    expect(capture).not.toHaveBeenCalled();
  });
});
