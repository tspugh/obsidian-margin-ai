// Obsidian provides these classes at runtime; its npm package is declarations only.
export class Component {}
export class ItemView {}
export class WorkspaceLeaf {}
export class MarkdownView {}
export class TFile {}
export class Notice {}
export class FuzzySuggestModal<T> { app:any; constructor(app:any){this.app=app;} setPlaceholder(){return this;} open(){} }
export const MarkdownRenderer = {};
export function setIcon() {}
