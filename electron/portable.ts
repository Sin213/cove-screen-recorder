import { app } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';

export function setupPortableMode(): boolean {
    const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
    const portableDataDir = path.join(exeDir, 'cove-app-data');
    const markerFile = path.join(exeDir, 'portable.marker');

    if (!fs.existsSync(portableDataDir) && !fs.existsSync(markerFile)) {
        return false;
    }

    fs.mkdirSync(portableDataDir, { recursive: true });
    const appDataDir = path.join(portableDataDir, app.name);
    fs.mkdirSync(appDataDir, { recursive: true });

    app.setPath('userData', appDataDir);
    app.setPath('appData', portableDataDir);

    for (const sub of ['temp', 'cache', 'logs']) {
        fs.mkdirSync(path.join(appDataDir, sub), { recursive: true });
    }
    app.setPath('temp', path.join(appDataDir, 'temp'));
    app.setPath('sessionData', path.join(appDataDir, 'cache'));
    app.setPath('logs', path.join(appDataDir, 'logs'));

    return true;
}
