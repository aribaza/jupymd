import JupyMDPlugin from "./main";
import {KernelSelectorModal} from "./components/KernelSelector";

export function registerCommands(plugin: JupyMDPlugin) {
	plugin.addCommand({
		id: "select-kernel",
		name: "Select Python kernel",
		callback: () => new KernelSelectorModal(plugin.app, plugin).open(),
	});

	plugin.addCommand({
		id: "create-jupyter-notebook",
		name: "Create Jupyter notebook from note",
		callback: () => plugin.fileSync.createNotebook(),
	});

	plugin.addCommand({
		id: "create-note-from-jupyter-notebook",
		name: "Create note from Jupyter notebook",
		callback: () => plugin.fileSync.convertNotebookToNote(),
	});

	plugin.addCommand({
		id: "open-jupyter-notebook-editor",
		name: "Open Jupyter notebook in editor",
		callback: () => plugin.fileSync.openNotebookInEditor(plugin.settings.notebookEditorCommand),
	});

	plugin.addCommand({
		id: "force-sync",
		name: "Sync files",
		callback: () => plugin.fileSync.handleSync(undefined, true),
	});

	plugin.addCommand({
		id: "run-all-code-blocks",
		name: "Run all code blocks in current note",
		callback: async () => plugin.executor.executeAllCodeBlocksInCurrentFile(),
	});

	plugin.addCommand({
		id: "clear-all-code-block-outputs",
		name: "Clear all code block outputs in current note",
		callback: async () => plugin.executor.clearAllOutputsInCurrentFile(),
	});
}
