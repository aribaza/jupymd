import {App, FuzzySuggestModal, FuzzyMatch, Notice} from "obsidian";
import JupyMDPlugin from "../main";
import {discoverKernels, KernelInfo} from "../utils/kernelDiscovery";
import {validatePythonPath} from "../utils/pythonPathUtils";

const TYPE_BADGE: Record<KernelInfo["type"], string> = {
	venv: "venv",
	conda: "conda",
	pyenv: "pyenv",
	system: "system",
	other: "other",
};

export class KernelSelectorModal extends FuzzySuggestModal<KernelInfo> {
	private plugin: JupyMDPlugin;
	private kernels: KernelInfo[] = [];
	private isLoading = true;

	constructor(app: App, plugin: JupyMDPlugin) {
		super(app);
		this.plugin = plugin;
		this.setPlaceholder("Select a Python interpreter or type a custom path…");
		this.setInstructions([
			{command: "↑↓", purpose: "navigate"},
			{command: "↵", purpose: "select"},
			{command: "esc", purpose: "dismiss"},
		]);
	}

	onOpen() {
		super.onOpen();
		this.addLoadingHint();
		this.setupCustomPathHandler();
		this.loadKernels();
	}

	private addLoadingHint() {
		const promptEl = this.containerEl.querySelector(".prompt-results");
		if (promptEl) {
			const hint = promptEl.createEl("div", {
				cls: "suggestion-empty",
				text: "Discovering Python environments…",
			});
			hint.dataset.loadingHint = "true";
		}
	}

	private removeLoadingHint() {
		const hint = this.containerEl.querySelector('[data-loading-hint="true"]');
		hint?.remove();
	}

	private async loadKernels() {
		try {
			this.kernels = await discoverKernels(this.app);
		} catch (e) {
			console.error("Kernel discovery failed:", e);
			this.kernels = [];
		} finally {
			this.isLoading = false;
			this.removeLoadingHint();
			// Trigger re-render of the suggestion list
			// @ts-ignore – internal Obsidian API
			this.updateSuggestions();
		}
	}

	getItems(): KernelInfo[] {
		return this.kernels;
	}

	getItemText(item: KernelInfo): string {
		// Used for fuzzy matching – include label, path and type so all are searchable
		return `${item.label} ${item.version} ${item.path} ${item.type}`;
	}

	renderSuggestion(match: FuzzyMatch<KernelInfo>, el: HTMLElement) {
		const item = match.item;

		const wrapper = el.createDiv({cls: "kernel-suggestion"});

		const topRow = wrapper.createDiv({cls: "kernel-suggestion-top"});
		topRow.createSpan({cls: "kernel-suggestion-label", text: item.label});
		topRow.createSpan({cls: `kernel-suggestion-badge kernel-badge-${item.type}`, text: TYPE_BADGE[item.type]});

		const bottomRow = wrapper.createDiv({cls: "kernel-suggestion-bottom"});
		bottomRow.createSpan({cls: "kernel-suggestion-version", text: item.version});
		bottomRow.createSpan({cls: "kernel-suggestion-path", text: item.path});
	}

	async onChooseItem(item: KernelInfo) {
		await this.plugin.updateInterpreter(item.path);
		new Notice(`Python kernel set to: ${item.label} (${item.version})`);
	}

	// Hook into the input so pressing Enter with no matching suggestion
	// treats the typed value as a custom path
	private setupCustomPathHandler() {
		const inputEl = this.inputEl;
		inputEl.addEventListener("keydown", async (e: KeyboardEvent) => {
			if (e.key !== "Enter") return;
			// Only act when there are no visible suggestions
			const suggestions = this.containerEl.querySelectorAll(".suggestion-item");
			if (suggestions.length > 0) return;

			const typed = inputEl.value.trim();
			if (!typed) return;

			e.preventDefault();
			e.stopPropagation();

			const valid = await validatePythonPath(typed);
			if (!valid) {
				new Notice(`Invalid Python path: ${typed}`);
				return;
			}

			await this.plugin.updateInterpreter(typed);
			new Notice(`Python kernel set to: ${typed}`);
			this.close();
		});
	}

	// Override to handle custom path typed by the user when no match is selected
	onNoSuggestion() {
		// Handled via the input handler above
	}
}
