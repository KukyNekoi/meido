# Meido README

Swaps your files based on which environment variables are present when debugging. After debugging finishes, it restores everything as it was before. Kinda practical when using B2K, as it just copies the volume with the full path.

Rules example:

```json
{
	"variables": [
		{
      // if this envvar exists when debugging, it will execute this rule
      // and will use it as a base path for the source path
      // for example if LE_CONFIG is "/tmp/asdf45", then the source path will
      // be interpreted as "/tmp/asdf45/my/app/config/environment/env_name.js"
			"name": "LE_CONFIG",
			"sourcePath": "/my/app/config/environment/env_name.js", 
			"destinationPath": "./config/environment/env_name.js",
			"enforce": false // if true, then an alert for reversal will be issued if source not present
		},
		{
      // this rule will overwrite the contents of the previous file
			"name": "LE_CONFIG_2",
			"sourcePath": "/my/app/config/environment/env_name_2.js", 
			"destinationPath": "./config/environment/env_name.js",
			"enforce": true
		}
	],
	"strategy": "replace", // with "merge" replacements are made in place
	"restoreAfterExit": true // restore files after debugging
}

```
You can also force (both injection and restore) of your set of rules by issuing `extension.meido.forceInjection` and `extension.meido.forceRestore` commands.

Original files will be moved to a temporary directory on `${workspaceRoot}/.tmp/meido`, and they will be restored after debugging session finishes. In case of something, if you need to restore the session, you can use `extension.meido.forceRestore` to revert any changes made, in reverse order as they were made.