// Run the Android Gradle wrapper from npm scripts on any OS/shell.
//   node scripts/gradle.cjs assembleRelease
const { spawnSync } = require('child_process');
const path = require('path');

const dir = path.join(__dirname, '..', 'android');
const win = process.platform === 'win32';
const wrapper = path.join(dir, win ? 'gradlew.bat' : 'gradlew');
// shell is needed for .bat on Windows; quote the path (it may contain spaces)
const result = spawnSync(win ? `"${wrapper}"` : wrapper, process.argv.slice(2), { cwd: dir, stdio: 'inherit', shell: win });
process.exit(result.status ?? 1);
