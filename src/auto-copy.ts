import { PDFPlusComponent } from 'lib/component';


export class AutoCopyMode extends PDFPlusComponent {
    toggle(enable?: boolean) {
        enable = enable ?? !this.settings.autoCopy;
        enable ? this.enable() : this.disable();
    }

    enable() {
        this.settings.autoCopy = true;
        this.plugin.saveSettings();
        this.load();
    }

    disable() {
        this.settings.autoCopy = false;
        this.plugin.saveSettings();
        this.unload();
    }
}
