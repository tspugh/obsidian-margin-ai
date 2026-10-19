const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const bundleArgument = process.argv[2];
if (!bundleArgument) {
	console.error('Usage: electron tests/electron-node-fetch-smoke.cjs <node-fetch-bundle.cjs>');
	process.exit(2);
}
const bundlePath = path.resolve(bundleArgument);

app.whenReady().then(async () => {
	const window = new BrowserWindow({
		show: false,
		webPreferences: { nodeIntegration: true, contextIsolation: false },
	});
	await window.loadURL('data:text/html,<title>Margin AI transport smoke</title>');
	const result = await window.webContents.executeJavaScript(`(async () => {
		const { openAiNodeFetch } = require(${JSON.stringify(bundlePath)});
		try {
			const response = await openAiNodeFetch('https://auth.openai.com/.well-known/jwks.json');
			const data = await response.json();
			return {
				status: response.status,
				body: Array.isArray(data.keys) ? 'jwks' : 'unexpected',
				keyCount: Array.isArray(data.keys) ? data.keys.length : undefined,
			};
		} catch (error) {
			return { errorName: error?.name, errorCode: error?.code };
		}
	})()`);
	console.log(JSON.stringify(result));
	window.destroy();
	const passed = result.status === 200 && result.body === 'jwks' && result.keyCount > 0;
	app.exit(passed ? 0 : 1);
}).catch((error) => {
	console.error(JSON.stringify({ harnessError: error?.name, harnessCode: error?.code }));
	app.exit(1);
});
