import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface MeidoVariable {
	name: string
	sourcePath: string
	destinationPath: string
	enforce?: boolean
}

interface MeidoConfig {
	variables: MeidoVariable[];
	strategy: string
	restoreAfterExit: boolean
}

interface B2KFsOperation {
	nodeType: "file" | "directory"
	operation: "copy" | "delete" | "create"
	sourcePath: string
	destinationPath: string
}


export function activate(context: vscode.ExtensionContext) {

	const absolutize = (targetPath: string, baseDir: string) => {
		return path.isAbsolute(targetPath) ? targetPath : path.join(baseDir, targetPath);
	};

	const collator = new Intl.Collator(undefined, {
		numeric: true,
		sensitivity: 'base'
	});

	let naturalOperationSort = (a: B2KFsOperation, b: B2KFsOperation) => {
		return collator.compare(a.sourcePath, b.sourcePath);
	};

	const pushRestoreOperation = (operation: B2KFsOperation) => {
		const _operations = context.workspaceState.get<B2KFsOperation[]>('meido.debugSession.operations');
		if (!_operations) {
			context.workspaceState.update('meido.debugSession.operations', []);
		}
		const operations = context.workspaceState.get<B2KFsOperation[]>('meido.debugSession.operations') || [];
		operations.push(operation);
		context.workspaceState.update('meido.debugSession.operations', operations);
	};


	const copyRecursiveSync = (src: string, dest: string, log = false) => {
		if (path.parse(src).ext) {
			const destinationExists = fs.existsSync(dest);
			const destinationIsFolder = destinationExists && fs.lstatSync(dest).isDirectory();
			const sourceExists = fs.existsSync(src);
			const sourceIsFolder = sourceExists && fs.lstatSync(src).isDirectory();
			if (sourceIsFolder) {
				if (log) { pushRestoreOperation({ operation: 'create', nodeType: "directory", sourcePath: src, destinationPath: dest }); };
				fs.mkdirSync(dest);
				fs.readdirSync(src).forEach((childItemName) => {
					copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
				});
			} else {
				if (sourceExists) {
					const destination = destinationIsFolder && !sourceIsFolder ? path.join(dest, path.basename(src)) : dest;
					if (log) { pushRestoreOperation({ operation: 'copy', nodeType: "file", sourcePath: src, destinationPath: destination }); };
					fs.copyFileSync(src, destination);
				}
			}
		};
	};

	const onDebugFinished = (listener: vscode.DebugSession | null, forced = false) => {
		const operations = context.workspaceState.get<B2KFsOperation[]>('meido.debugSession.operations');
		if (operations) {
			vscode.window.showInformationMessage(`Meido is reverting changes...`);
			console.log("Operation log exists. Reverting changes...");

			//for every operation in reverse order
			for (let i = operations.length - 1; i >= 0; i--) {
				const o = operations[i];

				// clean directories and files
				if (o.operation === 'delete') {
					console.log(`Deleting ${o.sourcePath}`);
					fs.existsSync(o.sourcePath) && fs.rmSync(o.sourcePath, { recursive: true, force: true });
				}
				// create directory structure
				else if (o.operation === 'create' && o.nodeType === 'directory') {
					console.log(`Creating directory ${o.destinationPath}`);
					fs.mkdirSync(o.sourcePath, { recursive: true });
				}
				// copy files
				else if (o.operation === 'copy' && o.nodeType === 'file') {
					console.log(`Copying file ${o.sourcePath} to ${o.destinationPath}`);
					try {
						copyRecursiveSync(o.destinationPath, o.sourcePath);
					} catch (e: any) {
						// print message
						vscode.window.showErrorMessage(`Meido: Error while reverting changes. ${e.message}`);
						console.log(e);
						return;
					}

				}
			}
			// clean up
			context.workspaceState.update('meido.debugSession.operations', undefined);
			if (!vscode.workspace.workspaceFolders) { return; }
			let workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
			const tempPath = path.join(workspaceRoot, '.tmp/meido/');
			fs.existsSync(tempPath) && fs.rmSync(tempPath, { recursive: true, force: true });
			vscode.window.showInformationMessage(`Meido has reverted your debug session.`);
			console.log('Finished restoring files');
		};
	};

	// const checkVariableOrRevert(variable: MeidoVariable, checkFile: string|null = null) {
	const checkFileOrRevert = (target: string | null = null, required: boolean = false, next: Function = () => { }) => {
		if (required && target && !fs.existsSync(target)) {
			// send message to user
			required && vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: "Yes", title: `File ${target} does not exist. Revert?` }).then(result => {
				if (result === 'Yes') {
					vscode.commands.executeCommand('extension.meido.forceRestore');
				}
			});
			return false;
		} else if (target && !fs.existsSync(target)) {
			return true;
		} else {
			next();
			return true;
		}
	};

	const onDebugStart = (listener: vscode.DebugSession | null, forced = false) => {
		// get workspace root folder
		vscode.window.showInformationMessage(`Meido has started a debug session.`);

		if (context.workspaceState.get<boolean>('meido.debugSession.inUse')) { onDebugFinished(listener); }

		if (!vscode.workspace.workspaceFolders) { return; }
		let workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath || ".";
		const configPath = path.join(workspaceRoot, '.vscode/meido.json');
		if (!fs.existsSync(configPath)) { return; }

		let configRaw = fs.readFileSync(configPath, 'utf8');
		let config = {} as MeidoConfig;
		try {
			config = JSON.parse(configRaw) as MeidoConfig;
		} catch (e) {
			// message that config is invalid
			vscode.window.showErrorMessage(`Invalid config file: ${configPath}`);
			return;
		}
		const tempFolderPath = path.join(workspaceRoot, '.tmp/meido/');

		fs.mkdirSync(tempFolderPath, { recursive: true });
		console.log(`Storing files in ${tempFolderPath}`);

		const envVars = listener?.configuration?.env || {};

		if (!forced) { config.variables = config.variables.filter(v => envVars[v.name]); }

		// backup variable contents
		if (config.restoreAfterExit) {
			for (const variable of config.variables) {
				const variableName = variable.name;
				// normalize as absolute
				let destinationPath = absolutize(variable.destinationPath, workspaceRoot);
				// copy directory
				fs.mkdirSync(path.join(tempFolderPath, variableName), { recursive: true });
				copyRecursiveSync(destinationPath, path.join(tempFolderPath, variable.name), true);
				console.log(`Copied ${variable.destinationPath} to ${path.join(tempFolderPath, variable.name)}`);
			}
		}

		// cleanup if needed
		if (config.strategy === 'replace') { // could also be "merge"
			for (const variable of config.variables) {
				let destinationPath = absolutize(variable.destinationPath, workspaceRoot);
				// stat destinationPath
				if (!fs.existsSync(destinationPath)) { continue; }
				let stats = fs.statSync(destinationPath);
				pushRestoreOperation({ operation: 'delete', nodeType: stats.isDirectory() ? "directory" : "file", sourcePath: destinationPath, destinationPath: '' });
				fs.rmSync(destinationPath, { recursive: true, force: true });
				console.log(`Removed ${destinationPath}`);
			}
		}

		// copy files
		for (const variable of config.variables) {
			// normalize as absolute
			let _sourcePath = absolutize(path.join(envVars[variable.name] || "./", variable.sourcePath), workspaceRoot);
			let destinationPath = absolutize(variable.destinationPath, workspaceRoot);
			// move from container copy to local
			if (!checkFileOrRevert(_sourcePath, variable.enforce, () => {
				pushRestoreOperation({ operation: 'delete', nodeType: 'directory', sourcePath: destinationPath, destinationPath: '' });
				fs.copyFileSync(_sourcePath, destinationPath);
				console.log(`Injected  ${_sourcePath} to ${destinationPath}`);
			})) { return; }
		}

		// message 
		vscode.window.showInformationMessage(`Meido has injected your debug files files successfully.`);
		console.log('Finished injecting files');
	};

	context.subscriptions.push(vscode.debug.onDidStartDebugSession(onDebugStart));
	context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(onDebugFinished));
	context.subscriptions.push(vscode.commands.registerCommand('extension.meido.forceInjection', () => { onDebugStart(null, true); }));
	context.subscriptions.push(vscode.commands.registerCommand('extension.meido.forceRestore', () => { onDebugFinished(null, true); }));


}
// this method is called when your extension is deactivated
export function deactivate() { }
