import * as path from "path";
import * as fs from "fs";
import {exec} from "child_process";
import {promisify} from "util";
import {App, FileSystemAdapter, Platform} from "obsidian";
import {validatePythonPath} from "./pythonPathUtils";

const execAsync = promisify(exec);

export type KernelType = "venv" | "conda" | "pyenv" | "system" | "other";

export type KernelInfo = {
	label: string;
	path: string;
	version: string;
	type: KernelType;
};

function getVaultBasePath(app: App): string | null {
	const adapter = app.vault.adapter;
	if (adapter instanceof FileSystemAdapter) {
		return adapter.getBasePath();
	}
	return null;
}

async function getPythonVersion(pythonPath: string): Promise<string> {
	try {
		const {stdout, stderr} = await execAsync(`"${pythonPath}" --version`, {timeout: 3000});
		const output = (stdout || stderr).trim();
		const match = output.match(/Python\s+(\S+)/i);
		return match ? match[1] : "unknown";
	} catch {
		return "unknown";
	}
}

async function globPaths(pattern: string): Promise<string[]> {
	// Simple glob that handles single '*' in path segments
	const parts = pattern.split(path.sep);
	const starIdx = parts.findIndex((p) => p === "*" || p.includes("*"));
	if (starIdx === -1) {
		return fs.existsSync(pattern) ? [pattern] : [];
	}

	const baseDir = parts.slice(0, starIdx).join(path.sep);
	if (!fs.existsSync(baseDir)) return [];

	try {
		const entries = fs.readdirSync(baseDir);
		const results: string[] = [];
		for (const entry of entries) {
			const remaining = parts.slice(starIdx + 1);
			const candidate = path.join(baseDir, entry, ...remaining);
			if (fs.existsSync(candidate)) {
				results.push(candidate);
			}
		}
		return results;
	} catch {
		return [];
	}
}

function deduplicatePaths(kernels: KernelInfo[]): KernelInfo[] {
	const seen = new Set<string>();
	return kernels.filter((k) => {
		const key = fs.existsSync(k.path)
			? fs.realpathSync(k.path)
			: k.path;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function probeInterpreter(
	pythonPath: string,
	label: string,
	type: KernelType
): Promise<KernelInfo | null> {
	const valid = await validatePythonPath(pythonPath);
	if (!valid) return null;
	const version = await getPythonVersion(pythonPath);
	return {label, path: pythonPath, version, type};
}

async function discoverVaultVenv(app: App): Promise<KernelInfo[]> {
	const basePath = getVaultBasePath(app);
	if (!basePath) return [];

	const isWin = Platform.isWin;
	const pythonBin = isWin
		? path.join(basePath, ".jupymd", "Scripts", "python.exe")
		: path.join(basePath, ".jupymd", "bin", "python");

	const result = await probeInterpreter(pythonBin, ".jupymd (vault venv)", "venv");
	return result ? [result] : [];
}

async function discoverSystemPython(): Promise<KernelInfo[]> {
	const candidates: string[] = Platform.isWin
		? ["python", "python3"]
		: ["python3", "python"];

	// Also try python3.x variants
	for (let minor = 13; minor >= 8; minor--) {
		candidates.push(Platform.isWin ? `python3.${minor}` : `python3.${minor}`);
	}

	const results: KernelInfo[] = [];
	for (const candidate of candidates) {
		const result = await probeInterpreter(candidate, candidate, "system");
		if (result) results.push(result);
	}
	return results;
}

async function discoverPyenv(): Promise<KernelInfo[]> {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (!home) return [];

	const pyenvRoot = process.env.PYENV_ROOT || path.join(home, ".pyenv");
	const versionsDir = path.join(pyenvRoot, "versions");

	const pythonPaths = await globPaths(path.join(versionsDir, "*", "bin", "python"));

	const results: KernelInfo[] = [];
	for (const p of pythonPaths) {
		// Extract version name from path
		const parts = p.split(path.sep);
		const versionIdx = parts.indexOf("versions");
		const versionName = versionIdx !== -1 ? parts[versionIdx + 1] : path.basename(path.dirname(path.dirname(p)));
		const result = await probeInterpreter(p, `pyenv: ${versionName}`, "pyenv");
		if (result) results.push(result);
	}
	return results;
}

async function discoverConda(): Promise<KernelInfo[]> {
	const results: KernelInfo[] = [];
	const home = process.env.HOME || process.env.USERPROFILE || "";

	// Try `conda env list --json`
	try {
		const {stdout} = await execAsync("conda env list --json", {timeout: 5000});
		const data = JSON.parse(stdout);
		const envPaths: string[] = data.envs || [];
		for (const envPath of envPaths) {
			const pythonBin = Platform.isWin
				? path.join(envPath, "python.exe")
				: path.join(envPath, "bin", "python");
			const envName = path.basename(envPath);
			const result = await probeInterpreter(pythonBin, `conda: ${envName}`, "conda");
			if (result) results.push(result);
		}
		return results;
	} catch {
		// conda not in PATH, fall through to directory scanning
	}

	// Scan common conda base dirs
	const condaDirs = [
		path.join(home, "miniconda3", "envs"),
		path.join(home, "miniconda", "envs"),
		path.join(home, "anaconda3", "envs"),
		path.join(home, "anaconda", "envs"),
		path.join(home, "mambaforge", "envs"),
		path.join(home, "miniforge3", "envs"),
		// Also the base envs
		path.join(home, "miniconda3"),
		path.join(home, "anaconda3"),
		path.join(home, "mambaforge"),
		path.join(home, "miniforge3"),
	];

	for (const dir of condaDirs) {
		if (!fs.existsSync(dir)) continue;
		// If it's an envs directory, scan subdirs
		if (dir.endsWith("envs")) {
			const envPaths = await globPaths(
				path.join(dir, "*", Platform.isWin ? "python.exe" : path.join("bin", "python"))
			);
			for (const p of envPaths) {
				const envName = Platform.isWin
					? path.basename(path.dirname(p))
					: path.basename(path.dirname(path.dirname(p)));
				const result = await probeInterpreter(p, `conda: ${envName}`, "conda");
				if (result) results.push(result);
			}
		} else {
			// base conda env
			const pythonBin = Platform.isWin
				? path.join(dir, "python.exe")
				: path.join(dir, "bin", "python");
			const envName = `conda: ${path.basename(dir)} (base)`;
			const result = await probeInterpreter(pythonBin, envName, "conda");
			if (result) results.push(result);
		}
	}

	return results;
}

async function discoverVenvDirs(): Promise<KernelInfo[]> {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (!home) return [];

	const venvBaseDirs = [
		path.join(home, ".venvs"),
		path.join(home, ".virtualenvs"),
		path.join(home, "venvs"),
		path.join(home, "Envs"),
	];

	const results: KernelInfo[] = [];
	for (const baseDir of venvBaseDirs) {
		if (!fs.existsSync(baseDir)) continue;
		const pythonPaths = await globPaths(
			path.join(
				baseDir,
				"*",
				Platform.isWin ? "Scripts" : "bin",
				Platform.isWin ? "python.exe" : "python"
			)
		);
		for (const p of pythonPaths) {
			const parts = p.split(path.sep);
			const envName =
				Platform.isWin
					? parts[parts.length - 3]
					: parts[parts.length - 3];
			const result = await probeInterpreter(p, `venv: ${envName}`, "venv");
			if (result) results.push(result);
		}
	}
	return results;
}

async function discoverWindowsPython(): Promise<KernelInfo[]> {
	if (!Platform.isWin) return [];

	const results: KernelInfo[] = [];

	// py launcher
	try {
		const {stdout} = await execAsync("py -0p", {timeout: 5000});
		const lines = stdout.trim().split(/\r?\n/);
		for (const line of lines) {
			// Lines look like: "-3.11-64  C:\Python311\python.exe"
			const match = line.match(/^-?([\d.]+)(?:-\d+)?\s+(.+\.exe)/i);
			if (match) {
				const [, ver, exePath] = match;
				const result = await probeInterpreter(exePath.trim(), `Python ${ver}`, "system");
				if (result) results.push(result);
			}
		}
	} catch {
		// py launcher not available
	}

	// Scan %LOCALAPPDATA%\Programs\Python\*\python.exe
	const localAppData = process.env.LOCALAPPDATA || "";
	if (localAppData) {
		const pythonPaths = await globPaths(
			path.join(localAppData, "Programs", "Python", "*", "python.exe")
		);
		for (const p of pythonPaths) {
			const dirName = path.basename(path.dirname(p));
			const result = await probeInterpreter(p, dirName, "system");
			if (result) results.push(result);
		}
	}

	return results;
}

const TYPE_ORDER: Record<KernelType, number> = {
	venv: 0,
	conda: 1,
	pyenv: 2,
	system: 3,
	other: 4,
};

export async function discoverKernels(app: App): Promise<KernelInfo[]> {
	const [vaultVenv, system, pyenv, conda, venvDirs, winPython] = await Promise.all([
		discoverVaultVenv(app),
		discoverSystemPython(),
		discoverPyenv(),
		discoverConda(),
		discoverVenvDirs(),
		discoverWindowsPython(),
	]);

	const all = [...vaultVenv, ...conda, ...pyenv, ...venvDirs, ...winPython, ...system];
	const deduplicated = deduplicatePaths(all);

	// Vault venv always first, then sort by type then label
	return deduplicated.sort((a, b) => {
		const isVaultVenvA = a.label === ".jupymd (vault venv)";
		const isVaultVenvB = b.label === ".jupymd (vault venv)";
		if (isVaultVenvA && !isVaultVenvB) return -1;
		if (!isVaultVenvA && isVaultVenvB) return 1;
		const typeDiff = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
		if (typeDiff !== 0) return typeDiff;
		return a.label.localeCompare(b.label);
	});
}
