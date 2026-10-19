import { describe, expect, it, vi } from 'vitest';
import { NativePdfHighlightWriter } from '../src/margin-ai/native-pdf-highlight-writer';

const tuple: [number, number, number, number] = [3, 4, 7, 8];

function harness(overrides: Record<string, unknown> = {}) {
  const file = { path: 'Reading/Paper.pdf', name: 'Paper.pdf', extension: 'pdf', stat: { mtime: 11, size: 22 } };
  const pageView = { textLayer: {}, div: { dataset: { loaded: 'true' } } };
  const child = { file, pdfViewer: { pagesCount: 9 }, getPage: vi.fn(() => pageView) };
  const files = new Map<string, unknown>([[file.path, file]]);
  const calls: string[] = [];
  let activeWrites = 0;
  let maximumWrites = 0;
  const pdflib = {
	findAnnotationByContents: vi.fn(async () => null),
	getAnnotation: vi.fn(async () => ({})),
	setAnnotationColor: vi.fn(async (_file, _page, _id, _rgb, guard?:()=>void|Promise<void>)=>{ await guard?.(); }),
    addHighlightAnnotation: vi.fn(async (_file, _page, _rects, _color, _contents, preWriteGuard?: () => void | Promise<void>) => {
      activeWrites += 1;
      maximumWrites = Math.max(maximumWrites, activeWrites);
      await Promise.resolve();
      await preWriteGuard?.();
      activeWrites -= 1;
      return '42R0';
    }),
  };
  const addAnnotationToTextRange = vi.fn(async (annotator, passedChild, page, ...range) => ({
    annotationID: await annotator(passedChild.file, page, [{ left: 1, top: 2, right: 3, bottom: 4 }]),
    rects: [],
    range,
  }));
  const plugin = {
    settings: { author: 'Reader', marginAnnotationFolder: 'Margin Notes' },
    app: { vault: {
      getAbstractFileByPath: vi.fn((path: string) => files.get(path) ?? null),
      createFolder: vi.fn(async (path: string) => { files.set(path, { path }); calls.push(`mkdir:${path}`); }),
      copy: vi.fn(async (_source: unknown, path: string) => { files.set(path, { path }); calls.push(`copy:${path}`); }),
    } },
    lib: {
      getPDFViewerChild: vi.fn(() => child),
      highlight: { writeFile: { addAnnotationToTextRange, pdflib } },
    },
	domManager:{getRgb:vi.fn(()=>({r:255,g:0,b:0}))},
    ...overrides,
  };
  const writer = new NativePdfHighlightWriter(plugin as never, { now: () => new Date('2026-10-15T10:20:30Z') });
  const request = {
    annotationId: 'margin-1', source: { path: file.path, page: 2, pdfSelection: tuple },
    sourceVersion: { mtime: 11, size: 22 }, colorName: 'yellow',
  };
  return { writer, request, plugin, file, child, pageView, pdflib, addAnnotationToTextRange, calls, getMaximumWrites: () => maximumWrites };
}

describe('NativePdfHighlightWriter', () => {
  it('writes a retained page and text tuple without consulting a live DOM selection', async () => {
    const h = harness();
    const result = await h.writer.write(h.request);
    expect(h.addAnnotationToTextRange).toHaveBeenCalledWith(expect.any(Function), h.child, 2, 3, 4, 7, 8);
    expect(h.pdflib.addHighlightAnnotation).toHaveBeenCalledWith(h.file, 2, expect.any(Array), 'yellow', 'margin-ai:margin-1', expect.any(Function));
    expect(result).toMatchObject({ status: 'created', annotationId: '42R0' });
  });

  it('creates a vault-relative backup before the first mutation of a source version', async () => {
    const h = harness();
    h.pdflib.addHighlightAnnotation.mockImplementation(async () => { h.calls.push('write'); return '42R0'; });
    await h.writer.write(h.request);
    expect(h.calls).toContain('mkdir:Margin Notes/PDF backups');
    expect(h.calls.findIndex((call) => call.startsWith('copy:'))).toBeLessThan(h.calls.indexOf('write'));
    expect(h.calls.find((call) => call.startsWith('copy:'))).toMatch(/Margin Notes\/PDF backups\/Paper-[a-f0-9]{8}\.before-margin-ai-11-22\.pdf/);
  });

  it('prevents duplicate writes for completed and concurrent retries', async () => {
    const h = harness();
    const [first, second] = await Promise.all([h.writer.write(h.request), h.writer.write(h.request)]);
    const third = await h.writer.write(h.request);
    expect(h.pdflib.addHighlightAnnotation).toHaveBeenCalledTimes(1);
    expect(first.annotationId).toBe('42R0');
    expect(second).toMatchObject({ status: 'existing', annotationId: '42R0' });
    expect(third).toMatchObject({ status: 'existing', annotationId: '42R0' });
  });

  it('uses a persisted native annotation id to recover without another PDF write', async () => {
    const h = harness();
    const result = await h.writer.write({ ...h.request, existingAnnotationId: '91R0' });
    expect(result).toEqual({ status: 'existing', annotationId: '91R0' });
    expect(h.addAnnotationToTextRange).not.toHaveBeenCalled();
  });

  it('recovers an existing marker after restart without another PDF write', async () => {
    const h = harness();
    h.pdflib.findAnnotationByContents.mockResolvedValue('92R0' as never);
    await expect(h.writer.write(h.request)).resolves.toEqual({ status: 'existing', annotationId: '92R0' });
    expect(h.pdflib.addHighlightAnnotation).not.toHaveBeenCalled();
  });

  it('serializes mutations to the same PDF', async () => {
    const h = harness();
    await Promise.all([
      h.writer.write(h.request),
      h.writer.write({ ...h.request, annotationId: 'margin-2', source: { ...h.request.source, pdfSelection: [1, 0, 1, 2] } }),
    ]);
    expect(h.getMaximumWrites()).toBe(1);
  });

  it('rejects a changed source immediately before the mutation', async () => {
    const h = harness();
    h.addAnnotationToTextRange.mockImplementation(async (annotator) => {
      h.file.stat.mtime = 12;
      const rects = [{ left: 1, top: 2, right: 3, bottom: 4 }];
      return { annotationID: await annotator(h.file, 2, rects), rects: rects as never[], range: [] };
    });
    await expect(h.writer.write(h.request)).rejects.toThrow(/changed.*reopen|reopen.*changed/i);
    expect(h.pdflib.addHighlightAnnotation).not.toHaveBeenCalled();
  });

  it('rejects a conflict that appears during PDF serialization before modifyBinary', async () => {
    const h = harness();
    let modified = false;
    h.pdflib.addHighlightAnnotation.mockImplementation(async (_file, _page, _rects, _color, _contents, preWriteGuard) => {
      await Promise.resolve(); // represents pdfDoc.save()
      h.file.stat.size = 23; // an external write lands while serialization is in flight
      await preWriteGuard?.();
      modified = true; // represents modifyBinary
      return '42R0';
    });
    await expect(h.writer.write(h.request)).rejects.toThrow(/changed.*reopen|reopen.*changed/i);
    expect(modified).toBe(false);
  });

  it('allows a blank configured author without changing the global setting', async () => {
	const h=harness(); h.plugin.settings.author=''; await expect(h.writer.write(h.request)).resolves.toMatchObject({status:'created'}); expect(h.plugin.settings.author).toBe('');
  });

  it.each([
    ['file', (h: ReturnType<typeof harness>) => { h.plugin.app.vault.getAbstractFileByPath.mockReturnValue(null); }, /PDF file.*not found/i],
    ['viewer', (h: ReturnType<typeof harness>) => { h.plugin.lib.getPDFViewerChild.mockReturnValue(null as never); }, /open.*PDF.*viewer/i],
    ['rendered page', (h: ReturnType<typeof harness>) => { h.pageView.textLayer = null as never; }, /page 2.*rendered/i],
  ])('reports an actionable missing %s error', async (_name, arrange, pattern) => {
    const h = harness(); arrange(h);
    await expect(h.writer.write(h.request)).rejects.toThrow(pattern);
  });

  it('reports encrypted PDFs and ordinary write failures actionably', async () => {
    const encrypted = harness();
    encrypted.pdflib.addHighlightAnnotation.mockRejectedValue(new Error('Input document is encrypted'));
    await expect(encrypted.writer.write(encrypted.request)).rejects.toThrow(/encrypted.*unlock/i);

    const failed = harness();
    failed.pdflib.addHighlightAnnotation.mockRejectedValue(new Error('disk full'));
    await expect(failed.writer.write(failed.request)).rejects.toThrow(/could not write.*disk full/i);
  });

  it('verifies and recolors an existing native highlight through the serialized writer',async()=>{
    const h=harness();
    await h.writer.recolor({...h.request,existingAnnotationId:'42R0',colorName:'red'});
    expect(h.pdflib.getAnnotation).toHaveBeenCalledWith(h.file,2,'42R0');
    expect(h.pdflib.setAnnotationColor).toHaveBeenCalledWith(h.file,2,'42R0',{r:255,g:0,b:0},expect.any(Function));
  });
});
