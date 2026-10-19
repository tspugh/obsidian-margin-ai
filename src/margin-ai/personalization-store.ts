import { createDefaultPersonalization, parsePersonalizationMarkdown, serializePersonalizationMarkdown, type PersonalizationProfile } from './personalization';

export interface PersonalizationVault {
	read(path: string): Promise<string | null>;
	createFolder(path: string): Promise<void>;
	create(path: string, content: string): Promise<void>;
	process(path: string, transform: (content: string) => string): Promise<string>;
}

export const PROFILE_FILENAME = 'Margin Profile.md';

function safeFolder(folder: string): string {
	const normalized = folder.trim().replace(/\/+$/g, '');
	const segments = normalized.split('/');
	if (!normalized || normalized.startsWith('/') || segments.some(segment => !segment || segment === '..' || segment.startsWith('.')) || normalized.includes('\\') || normalized.includes('\0')) throw new Error('Personalization folder must be a safe vault-relative path.');
	return normalized;
}

export class PersonalizationStore {
	readonly path: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly vault: PersonalizationVault, folder: string) {
		const safe = safeFolder(folder);
		this.path = `${safe}/${PROFILE_FILENAME}`;
	}

	async load(): Promise<PersonalizationProfile> {
		const content = await this.vault.read(this.path);
		return content === null ? createDefaultPersonalization() : parsePersonalizationMarkdown(content);
	}

	mutate(mutator: (profile: PersonalizationProfile) => void): Promise<PersonalizationProfile> {
		const operation = this.queue.then(async () => {
			const existing = await this.vault.read(this.path);
			if (existing === null) {
				const profile = createDefaultPersonalization(); mutator(profile);
				const slash = this.path.lastIndexOf('/'); if (slash > 0) await this.vault.createFolder(this.path.slice(0, slash));
				await this.vault.create(this.path, serializePersonalizationMarkdown(profile));
				return profile;
			}
			let result!: PersonalizationProfile;
			await this.vault.process(this.path, content => {
				const profile = parsePersonalizationMarkdown(content);
				mutator(profile);
				const serialized = serializePersonalizationMarkdown(profile);
				result = parsePersonalizationMarkdown(serialized);
				return serialized;
			});
			return result;
		});
		this.queue = operation.catch(() => undefined);
		return operation;
	}
}
