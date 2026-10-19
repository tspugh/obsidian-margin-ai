import { describe, expect, it } from 'vitest';
import { PersonalizationStore, type PersonalizationVault } from '../src/margin-ai/personalization-store';
import { serializePersonalizationMarkdown, createDefaultPersonalization } from '../src/margin-ai/personalization';

class MemoryVault implements PersonalizationVault {
	files = new Map<string, string>();
	processCalls = 0;
	async read(path: string) { return this.files.get(path) ?? null; }
	async createFolder() {}
	async create(path: string, content: string) { if (this.files.has(path)) throw new Error('exists'); this.files.set(path, content); }
	async process(path: string, transform: (content: string) => string) {
		this.processCalls++;
		const current = this.files.get(path); if (current === undefined) throw new Error('missing');
		const next = transform(current); this.files.set(path, next); return next;
	}
}

describe('PersonalizationStore', () => {
	it('does not create a profile when settings only read it', async () => {
		const vault = new MemoryVault(); const store = new PersonalizationStore(vault, 'Annotations');
		expect(await store.load()).toEqual(createDefaultPersonalization());
		expect(vault.files.size).toBe(0);
	});

	it('creates the plugin-owned file only on an explicit mutation', async () => {
		const vault = new MemoryVault(); const store = new PersonalizationStore(vault, 'Annotations');
		await store.mutate(profile => { profile.memoryEnabled = true; });
		expect(vault.files.has('Annotations/Margin Profile.md')).toBe(true);
		expect((await store.load()).memoryEnabled).toBe(true);
	});

	it('serializes simultaneous mutations without losing either update', async () => {
		const vault = new MemoryVault(); vault.files.set('Annotations/Margin Profile.md', serializePersonalizationMarkdown(createDefaultPersonalization()));
		const store = new PersonalizationStore(vault, 'Annotations');
		await Promise.all([
			store.mutate(profile => { profile.memoryEnabled = true; }),
			store.mutate(profile => { profile.suggestionsEnabled = true; }),
		]);
		const profile = await store.load();
		expect(profile).toMatchObject({ memoryEnabled: true, suggestionsEnabled: true });
		expect(vault.processCalls).toBe(2);
	});

	it('surfaces malformed data and never overwrites it', async () => {
		const vault = new MemoryVault(); const malformed = '# Margin AI Profile\n```json\nbroken\n```'; vault.files.set('Annotations/Margin Profile.md', malformed);
		const store = new PersonalizationStore(vault, 'Annotations');
		await expect(store.load()).rejects.toThrow(/malformed/i);
		await expect(store.mutate(profile => { profile.memoryEnabled = true; })).rejects.toThrow(/malformed/i);
		expect(vault.files.get('Annotations/Margin Profile.md')).toBe(malformed);
	});

	it('rejects companion folders that could escape the vault', () => {
		expect(() => new PersonalizationStore(new MemoryVault(), '../Elsewhere')).toThrow(/vault-relative/i);
	});
});
